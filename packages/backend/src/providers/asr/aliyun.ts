/**
 * 阿里云 DashScope 流式 ASR（qwen3-asr-flash-realtime）
 *
 * 迁移自原 src/routes/asr.ts，对外协议与现行 ClientASRMessage/ServerASRMessage 保持一致。
 *
 * 流程：
 *   1. 建立到 wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=... 的连接
 *   2. 收到 session.created 后回发 session.update（pcm/16k/server_vad）
 *   3. 收到 session.updated 视为 ready
 *   4. 上行 input_audio_buffer.append（base64 PCM）
 *   5. 下行 conversation.item.input_audio_transcription.text（partial）
 *      与 conversation.item.input_audio_transcription.completed（final）
 *   6. session.finish → session.finished → done
 */

import WebSocket from 'ws'
import { randomUUID } from 'node:crypto'
import { getEnv } from '../../env.js'
import { rootLogger, type Logger } from '../../lib/logger.js'
import type { ASRProvider, ASRSession, ASRSessionOptions } from '../types.js'

const DASHSCOPE_URL = 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen3-asr-flash-realtime'

let evtCounter = 0
function nextEventId(): string {
  return `evt_${++evtCounter}_${Date.now()}`
}

export class AliyunASRProvider implements ASRProvider {
  readonly name = 'aliyun' as const

  async openSession(opts: ASRSessionOptions): Promise<ASRSession> {
    const env = getEnv()
    const requestId = opts.requestId || randomUUID()
    const log = rootLogger.child({ module: 'asr/aliyun', requestId })
    const session = new AliyunASRSession({
      apiKey: env.LLM_API_KEY,
      sampleRate: opts.sampleRate ?? 16000,
      language: opts.language ?? 'zh',
      log,
    })
    await session.connect()
    return session
  }
}

interface SessionCtorArgs {
  apiKey: string
  sampleRate: number
  language: string
  log: Logger
}

class AliyunASRSession implements ASRSession {
  private ws: WebSocket | null = null
  private readonly args: SessionCtorArgs

  private partialCb: ((text: string) => void) | null = null
  private finalCb: ((text: string) => void) | null = null
  private doneCb: ((fullText: string) => void) | null = null
  private errorCb: ((err: Error) => void) | null = null
  private readyCb: (() => void) | null = null

  private fullText = ''
  private ready = false
  private finished = false
  private closed = false

  constructor(args: SessionCtorArgs) {
    this.args = args
  }

  async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(DASHSCOPE_URL, {
        headers: {
          Authorization: `Bearer ${this.args.apiKey}`,
          'OpenAI-Beta': 'realtime=v1',
        },
      })
      this.ws = ws

      ws.once('open', () => {
        this.args.log.info('dashscope asr open')
        resolve()
      })
      ws.once('error', (err) => reject(err))
    })

    this.ws!.on('message', (raw) => this.onRaw(raw.toString()))
    this.ws!.on('close', (code, reason) => this.onClose(code, reason.toString()))
    this.ws!.on('error', (err) => this.emitError(err))
  }

  appendAudio(base64Pcm: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    if (!this.ready || this.finished || this.closed) return
    try {
      this.ws.send(
        JSON.stringify({
          event_id: nextEventId(),
          type: 'input_audio_buffer.append',
          audio: base64Pcm,
        })
      )
    } catch (err) {
      this.emitError(err as Error)
    }
  }

  finish(): void {
    if (this.finished || this.closed) return
    this.finished = true
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    try {
      this.ws.send(JSON.stringify({ event_id: nextEventId(), type: 'session.finish' }))
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
          this.ws.send(JSON.stringify({ event_id: nextEventId(), type: 'session.finish' }))
        } catch {
          // ignore
        }
        this.ws.close()
      }
    } finally {
      this.ws = null
    }
  }

  onPartial(cb: (text: string) => void): void {
    this.partialCb = cb
  }
  onFinal(cb: (text: string) => void): void {
    this.finalCb = cb
  }
  onDone(cb: (fullText: string) => void): void {
    this.doneCb = cb
  }
  onError(cb: (err: Error) => void): void {
    this.errorCb = cb
  }
  onReady(cb: () => void): void {
    this.readyCb = cb
    if (this.ready) cb()
  }

  private onRaw(raw: string): void {
    let msg: {
      type?: string
      text?: string
      stash?: string
      transcript?: string
      error?: { message?: string }
    }
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }

    switch (msg.type) {
      case 'session.created':
        this.ws?.send(
          JSON.stringify({
            event_id: nextEventId(),
            type: 'session.update',
            session: {
              modalities: ['text'],
              input_audio_format: 'pcm',
              sample_rate: this.args.sampleRate,
              input_audio_transcription: { language: this.args.language },
              turn_detection: {
                type: 'server_vad',
                threshold: 0.0,
                silence_duration_ms: 400,
              },
            },
          })
        )
        break

      case 'session.updated':
        this.ready = true
        this.readyCb?.()
        break

      case 'conversation.item.input_audio_transcription.text': {
        const partial = (msg.text || '') + (msg.stash || '')
        if (partial) this.partialCb?.(partial)
        break
      }

      case 'conversation.item.input_audio_transcription.completed': {
        const text = msg.transcript || ''
        if (text) {
          this.fullText += text
          this.finalCb?.(text)
        }
        break
      }

      case 'session.finished':
        this.doneCb?.(this.fullText)
        this.cancel()
        break

      case 'error':
        this.emitError(new Error(msg.error?.message || '语音识别服务异常'))
        break
    }
  }

  private onClose(code: number, reason: string): void {
    this.args.log.warn({ code, reason }, 'dashscope asr closed')
    const wasClosed = this.closed
    this.closed = true
    // 未收到 session.finished 就断开 → 触发 done 避免上层等待
    if (!wasClosed && !this.finished) {
      this.doneCb?.(this.fullText)
    }
  }

  private emitError(err: Error): void {
    this.args.log.error({ err: err.message }, 'aliyun asr error')
    this.errorCb?.(err)
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.close()
      } catch {
        // ignore
      }
    }
  }
}
