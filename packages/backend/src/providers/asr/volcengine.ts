/**
 * 火山引擎流式 ASR 客户端（sauc bigmodel）
 *
 * 协议要点（与官方 Python demo 对齐）：
 *   URL：wss://openspeech.bytedance.com/api/v3/sauc/bigmodel
 *   Headers：X-Api-Resource-Id / X-Api-App-Key / X-Api-Access-Key / X-Api-Request-Id
 *
 *   1. FullClientRequest（seq=1, JSON+gzip, POS_SEQUENCE）携带 user/audio/request 参数
 *   2. AudioOnlyClient（seq++, Raw+gzip, POS_SEQUENCE）陆续上传 PCM 片段
 *   3. 最后一包使用 NegativeSeq + seq=-seq 标记结束
 *   4. 下行 FullServerResponse 携带 JSON payload，含 result.text / utterances
 */

import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import { getEnv } from '../../env.js'
import { rootLogger, type Logger } from '../../lib/logger.js'
import type { ASRProvider, ASRSession, ASRSessionOptions } from '../types.js'
import {
  Message,
  MsgFlag,
  MsgType,
  asrAudioOnly,
  asrFullClientRequest,
} from '../volcengine/protocol.js'

const CONNECT_TIMEOUT_MS = 10_000

export class VolcengineASRProvider implements ASRProvider {
  readonly name = 'volcengine' as const

  async openSession(opts: ASRSessionOptions): Promise<ASRSession> {
    const env = getEnv()
    const requestId = opts.requestId || randomUUID()
    const sampleRate = opts.sampleRate ?? 16000
    const log = rootLogger.child({ module: 'asr/volcengine', requestId })

    const session = new VolcengineASRSession({
      endpoint: env.VOLCENGINE_ASR_ENDPOINT,
      resourceId: env.VOLCENGINE_ASR_RESOURCE_ID,
      appId: env.VOLCENGINE_APP_ID!,
      apiKey: env.VOLCENGINE_API_KEY ?? null,
      accessToken: env.VOLCENGINE_ACCESS_TOKEN ?? null,
      boostingTableId: env.VOLCENGINE_ASR_BOOSTING_TABLE_ID ?? null,
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
  resourceId: string
  appId: string
  apiKey: string | null
  accessToken: string | null
  boostingTableId: string | null
  sampleRate: number
  requestId: string
  log: Logger
}

class VolcengineASRSession implements ASRSession {
  private ws: WebSocket | null = null
  private readonly args: SessionCtorArgs

  private seq = 1
  private fullText = ''
  private finished = false
  private closed = false

  private partialCb: ((text: string) => void) | null = null
  private finalCb: ((text: string) => void) | null = null
  private doneCb: ((fullText: string) => void) | null = null
  private errorCb: ((err: Error) => void) | null = null
  private readyCb: (() => void) | null = null

  constructor(args: SessionCtorArgs) {
    this.args = args
  }

  async connect(): Promise<void> {
    const { endpoint, resourceId, appId, apiKey, accessToken, log } = this.args
    if (!apiKey && !accessToken) {
      throw new Error('VOLCENGINE_API_KEY 或 VOLCENGINE_ACCESS_TOKEN 至少配一个')
    }
    const headers: Record<string, string> = {
      'X-Api-Resource-Id': resourceId,
      'X-Api-Request-Id': this.args.requestId,
      'X-Api-App-Key': appId,
    }
    if (apiKey) headers['X-Api-Key'] = apiKey
    if (accessToken) headers['X-Api-Access-Key'] = accessToken

    log.debug({ endpoint, auth: apiKey ? 'X-Api-Key' : 'X-Api-Access-Key' }, 'opening asr websocket')

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(endpoint, { headers })
      this.ws = ws

      const connectTimer = setTimeout(() => {
        reject(new Error('ASR websocket connect timeout'))
        ws.terminate()
      }, CONNECT_TIMEOUT_MS)

      ws.once('open', () => {
        clearTimeout(connectTimer)
        log.info('asr websocket open')
        resolve()
      })

      ws.once('error', (err) => {
        clearTimeout(connectTimer)
        reject(err)
      })
    })

    this.ws!.on('message', (data) => this.onRawMessage(data as Buffer))
    this.ws!.on('close', (code, reason) => this.onClose(code, reason.toString()))
    this.ws!.on('error', (err) => this.emitError(err))

    const payload = {
      user: { uid: this.args.requestId },
      audio: {
        format: 'pcm',
        codec: 'raw',
        rate: this.args.sampleRate,
        bits: 16,
        channel: 1,
      },
      request: {
        model_name: 'bigmodel',
        enable_itn: true,
        enable_punc: true,
        enable_ddc: true,
        show_utterances: true,
        enable_nonstream: false,
        ssd_version: '200',
        // 热词词表（控制台预先创建）：仅在配置了词表 ID 时引用，提升乳腺癌药名识别准确率
        ...(this.args.boostingTableId
          ? { corpus: { boosting_table_id: this.args.boostingTableId } }
          : {}),
      },
    }
    this.ws!.send(asrFullClientRequest(this.seq, payload))
    this.seq += 1
  }

  appendAudio(base64Pcm: string): void {
    if (this.closed || this.finished) return
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    try {
      const pcm = Buffer.from(base64Pcm, 'base64')
      this.ws.send(asrAudioOnly(this.seq, pcm, false))
      this.seq += 1
    } catch (err) {
      this.emitError(err as Error)
    }
  }

  finish(): void {
    if (this.finished || this.closed) return
    this.finished = true
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    try {
      this.ws.send(asrAudioOnly(this.seq, Buffer.alloc(0), true))
    } catch (err) {
      this.emitError(err as Error)
    }
  }

  async cancel(): Promise<void> {
    if (this.closed) return
    this.closed = true
    try {
      this.ws?.close()
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
    // 火山 ASR 没有显式 ready 事件，连接建立 + 发送 FullClientRequest 后即认为 ready
    queueMicrotask(() => {
      if (!this.closed) cb()
    })
  }

  private onRawMessage(data: Buffer): void {
    let msg: Message
    try {
      msg = Message.unmarshal(data)
    } catch (err) {
      this.emitError(err as Error)
      return
    }

    if (msg.type === MsgType.Error) {
      this.emitError(
        new Error(`ASR error ${msg.errorCode}: ${msg.payload.toString('utf-8')}`)
      )
      return
    }

    if (msg.type !== MsgType.FullServerResponse) return

    const json = msg.payloadAsJson<{
      result?: { text?: string; utterances?: Array<{ text?: string; definite?: boolean }> }
    }>()
    if (!json) return

    const text = json.result?.text || ''
    // NegativeSeq 即最后一包
    const isLast = (msg.flag & MsgFlag.LastNoSeq) === MsgFlag.LastNoSeq

    // 火山 sauc 的 result.text 是累计全量（含所有 definite + 未 definite 段）。
    // 对齐 DashScope 语义：流式过程只发 partial（全量替换），在最后一包一次性发 final。
    // 这样前端 InputBar 的 `text + partialText` 拼接不会把已 final 段重复显示。
    if (text && !isLast) {
      this.partialCb?.(text)
    }

    if (isLast) {
      this.fullText = text
      this.args.log.debug({ len: this.fullText.length }, 'asr done')
      if (text) this.finalCb?.(text)
      this.doneCb?.(this.fullText)
      this.cancel()
    }
  }

  private onClose(code: number, reason: string): void {
    this.args.log.info({ code, reason }, 'asr websocket closed')
    const wasClosed = this.closed
    this.closed = true
    if (!wasClosed && !this.finished && code !== 1000) {
      this.emitError(new Error(`ASR websocket closed unexpectedly: ${code} ${reason}`))
    }
  }

  private emitError(err: Error): void {
    this.args.log.error({ err: err.message }, 'asr error')
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
