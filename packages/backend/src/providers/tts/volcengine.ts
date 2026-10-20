/**
 * 火山引擎双向流式 TTS 客户端
 *
 * 协议流程（与官方 Python demo 对齐）：
 *   StartConnection ─┐
 *                    ↓
 *           ConnectionStarted
 *                    ↓
 *           StartSession(sessionId, req_params)
 *                    ↓
 *           SessionStarted
 *                    ↓
 *   TaskRequest(text) ... TaskRequest(text)      ← sendText() 多次
 *                    ↓
 *           FinishSession                         ← finish()
 *                    ↓
 *           SessionFinished   (中间收到若干 AudioOnlyServer MP3 片段)
 *                    ↓
 *           FinishConnection
 *                    ↓
 *           ConnectionFinished
 *
 * URL：wss://openspeech.bytedance.com/api/v3/tts/bidirection
 * Headers（新版控制台）：
 *   X-Api-App-Key       AppID
 *   X-Api-Key           ark-xxx 形式新版 key（旧版走 X-Api-Access-Key，这里兼容两套）
 *   X-Api-Resource-Id   seed-tts-2.0 / seed-tts-1.0 / seed-icl-2.0（通过 env 配置）
 *   X-Api-Connect-Id    每次握手随机 uuid
 */

import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import { getEnv } from '../../env.js'
import { rootLogger, type Logger } from '../../lib/logger.js'
import type { TTSProvider, TTSSession, TTSSessionOptions } from '../types.js'
import {
  EventType,
  Message,
  MsgType,
  ttsFinishConnection,
  ttsFinishSession,
  ttsStartConnection,
  ttsStartSession,
  ttsTaskRequest,
} from '../volcengine/protocol.js'

const CONNECT_TIMEOUT_MS = 10_000
const HANDSHAKE_TIMEOUT_MS = 10_000

function resourceIdForVoice(voice: string, defaultResourceId: string): string {
  // S_ 开头的音色是声音复刻，走独立资源；否则用 env 配置的默认（seed-tts-2.0 / 1.0）
  return voice.startsWith('S_') ? 'seed-icl-2.0' : defaultResourceId
}

export class VolcengineTTSProvider implements TTSProvider {
  readonly name = 'volcengine' as const

  async openSession(opts: TTSSessionOptions): Promise<TTSSession> {
    const env = getEnv()
    const voice = opts.voice || env.VOLCENGINE_TTS_VOICE
    const sampleRate = opts.sampleRate ?? 24000
    const requestId = opts.requestId || randomUUID()
    const log = rootLogger.child({ module: 'tts/volcengine', requestId })

    const session = new VolcengineTTSSession({
      endpoint: env.VOLCENGINE_TTS_ENDPOINT,
      appId: env.VOLCENGINE_APP_ID!,
      apiKey: env.VOLCENGINE_API_KEY ?? null,
      accessToken: env.VOLCENGINE_ACCESS_TOKEN ?? null,
      resourceId: resourceIdForVoice(voice, env.VOLCENGINE_TTS_RESOURCE_ID),
      voice,
      sampleRate,
      requestId,
      log,
    })

    await session.connect()
    return session
  }
}

interface SessionCtorArgs {
  endpoint: string
  appId: string
  apiKey: string | null
  accessToken: string | null
  resourceId: string
  voice: string
  sampleRate: number
  requestId: string
  log: Logger
}

class VolcengineTTSSession implements TTSSession {
  private ws: WebSocket | null = null
  private readonly args: SessionCtorArgs
  private readonly sessionId = randomUUID()
  private readonly connectId = randomUUID()

  private audioCb: ((chunk: Buffer) => void) | null = null
  private endCb: (() => void) | null = null
  private errorCb: ((err: Error) => void) | null = null

  private sessionStarted = false
  private finished = false // 已调过 finish()
  private closed = false
  private pendingTexts: string[] = []

  constructor(args: SessionCtorArgs) {
    this.args = args
  }

  async connect(): Promise<void> {
    const { endpoint, appId, apiKey, accessToken, resourceId, voice, log } = this.args
    if (!apiKey && !accessToken) {
      throw new Error('VOLCENGINE_API_KEY 或 VOLCENGINE_ACCESS_TOKEN 至少配一个')
    }
    const headers: Record<string, string> = {
      'X-Api-App-Key': appId,
      'X-Api-Resource-Id': resourceId,
      'X-Api-Connect-Id': this.connectId,
    }
    // 新版控制台用 X-Api-Key；旧版用 X-Api-Access-Key。两个头如果都传，火山会取新版。
    if (apiKey) headers['X-Api-Key'] = apiKey
    if (accessToken) headers['X-Api-Access-Key'] = accessToken

    log.debug({ endpoint, voice, resourceId, auth: apiKey ? 'X-Api-Key' : 'X-Api-Access-Key' }, 'opening tts websocket')

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(endpoint, { headers })
      this.ws = ws

      const connectTimer = setTimeout(() => {
        reject(new Error('TTS websocket connect timeout'))
        ws.terminate()
      }, CONNECT_TIMEOUT_MS)

      ws.once('open', () => {
        clearTimeout(connectTimer)
        const logid = (ws as unknown as { _req?: { res?: { headers?: Record<string, string> } } })._req?.res?.headers?.['x-tt-logid']
        log.info({ logid }, 'tts websocket open')
        resolve()
      })

      ws.once('error', (err) => {
        clearTimeout(connectTimer)
        // 拿响应头里的 x-tt-logid，排错必须
        const resHeaders = (ws as unknown as { _req?: { res?: { headers?: Record<string, string>; statusCode?: number } } })._req?.res?.headers
        const statusCode = (ws as unknown as { _req?: { res?: { statusCode?: number } } })._req?.res?.statusCode
        log.error({ err: (err as Error).message, statusCode, logid: resHeaders?.['x-tt-logid'], resHeaders }, 'tts websocket connect failed')
        reject(err)
      })
    })

    this.ws!.on('message', (data) => this.onRawMessage(data as Buffer))
    this.ws!.on('close', (code, reason) => this.onClose(code, reason.toString()))
    this.ws!.on('error', (err) => this.emitError(err))

    this.ws!.send(ttsStartConnection())

    await this.waitForEvent(EventType.ConnectionStarted, HANDSHAKE_TIMEOUT_MS, 'ConnectionStarted')

    const startPayload = {
      user: { uid: this.args.requestId },
      namespace: 'BidirectionalTTS',
      req_params: {
        speaker: this.args.voice,
        audio_params: {
          format: 'mp3',
          sample_rate: this.args.sampleRate,
          enable_timestamp: false,
        },
        additions: JSON.stringify({ disable_markdown_filter: false }),
      },
      event: EventType.StartSession,
    }
    this.ws!.send(ttsStartSession(this.sessionId, startPayload))
    await this.waitForEvent(EventType.SessionStarted, HANDSHAKE_TIMEOUT_MS, 'SessionStarted')

    this.sessionStarted = true
    this.args.log.debug({ sessionId: this.sessionId }, 'tts session started')

    if (this.pendingTexts.length) {
      for (const t of this.pendingTexts) this.doSendText(t)
      this.pendingTexts = []
    }
  }

  sendText(delta: string): void {
    if (!delta) return
    if (this.closed || this.finished) return
    if (!this.sessionStarted) {
      this.pendingTexts.push(delta)
      return
    }
    this.doSendText(delta)
  }

  private doSendText(text: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    const payload = {
      user: { uid: this.args.requestId },
      namespace: 'BidirectionalTTS',
      req_params: {
        speaker: this.args.voice,
        audio_params: {
          format: 'mp3',
          sample_rate: this.args.sampleRate,
          enable_timestamp: false,
        },
        additions: JSON.stringify({ disable_markdown_filter: false }),
        text,
      },
      event: EventType.TaskRequest,
    }
    try {
      this.ws.send(ttsTaskRequest(this.sessionId, payload))
    } catch (err) {
      this.emitError(err as Error)
    }
  }

  finish(): void {
    if (this.finished || this.closed) return
    this.finished = true
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    try {
      this.ws.send(ttsFinishSession(this.sessionId))
    } catch (err) {
      this.emitError(err as Error)
    }
  }

  async cancel(): Promise<void> {
    if (this.closed) return
    this.closed = true
    try {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          this.ws.send(ttsFinishConnection())
        } catch {
          // ignore
        }
        this.ws.close()
      }
    } finally {
      this.ws = null
    }
  }

  onAudio(cb: (chunk: Buffer) => void): void {
    this.audioCb = cb
  }
  onEnd(cb: () => void): void {
    this.endCb = cb
  }
  onError(cb: (err: Error) => void): void {
    this.errorCb = cb
  }

  private onRawMessage(data: Buffer): void {
    let msg: Message
    try {
      msg = Message.unmarshal(data)
    } catch (err) {
      this.emitError(err as Error)
      return
    }

    if (msg.type === MsgType.AudioOnlyServer) {
      if (msg.payload.length > 0 && this.audioCb) {
        this.audioCb(msg.payload)
      }
      return
    }

    if (msg.type === MsgType.FullServerResponse) {
      switch (msg.event) {
        case EventType.ConnectionStarted:
        case EventType.SessionStarted:
          this.resolveEvent(msg.event)
          return
        case EventType.SessionFinished:
          this.args.log.debug({ sessionId: this.sessionId }, 'tts session finished')
          this.endCb?.()
          // 让上层先处理 end，再关 ws
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            try {
              this.ws.send(ttsFinishConnection())
            } catch {
              // ignore
            }
          }
          return
        case EventType.SessionFailed: {
          const err = new Error(`TTS session failed: ${msg.payload.toString('utf-8')}`)
          this.emitError(err)
          return
        }
        case EventType.ConnectionFinished:
          this.args.log.debug('tts connection finished')
          try {
            this.ws?.close()
          } catch {
            // ignore
          }
          return
        case EventType.ConnectionFailed: {
          const err = new Error(`TTS connection failed: ${msg.payload.toString('utf-8')}`)
          this.emitError(err)
          return
        }
        default:
          this.args.log.debug({ event: msg.event }, 'tts unhandled server event')
          return
      }
    }

    if (msg.type === MsgType.Error) {
      const err = new Error(
        `TTS error ${msg.errorCode}: ${msg.payload.toString('utf-8')}`
      )
      this.emitError(err)
    }
  }

  private onClose(code: number, reason: string): void {
    this.args.log.info({ code, reason }, 'tts websocket closed')
    this.closed = true
    // 如果还没触发过 end，且不是异常关闭，补一次
    if (!this.finished && code !== 1000) {
      this.emitError(new Error(`TTS websocket closed unexpectedly: ${code} ${reason}`))
    }
    this.rejectAllWaits(new Error(`websocket closed: ${code}`))
  }

  private emitError(err: Error): void {
    this.args.log.error({ err: err.message }, 'tts error')
    this.errorCb?.(err)
    this.rejectAllWaits(err)
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.close()
      } catch {
        // ignore
      }
    }
  }

  /** ---------- Event wait helper ---------- */

  private waiters = new Map<EventType, { resolve: () => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()

  private waitForEvent(event: EventType, timeoutMs: number, label: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(event)
        reject(new Error(`timeout waiting for ${label}`))
      }, timeoutMs)
      this.waiters.set(event, { resolve, reject, timer })
    })
  }

  private resolveEvent(event: EventType): void {
    const w = this.waiters.get(event)
    if (w) {
      clearTimeout(w.timer)
      this.waiters.delete(event)
      w.resolve()
    }
  }

  private rejectAllWaits(err: Error): void {
    for (const w of this.waiters.values()) {
      clearTimeout(w.timer)
      w.reject(err)
    }
    this.waiters.clear()
  }
}
