/**
 * 火山引擎语音协议 v3 —— 二进制消息编解码
 *
 * 协议规范与官方 Python demo 对齐（protocols.py）：
 * - 4 字节定长 header，支持 JSON/Raw payload 序列化，可选 GZIP 压缩
 * - TTS 双向流式：WithEvent flag，payload 前附 event(int32) + session_id(len+utf8)
 * - ASR 流式识别：PositiveSeq / NegativeSeq flag，payload 前附 sequence(int32)
 * - Error 帧：flag=NoSeq, type=Error，payload 前附 error_code(uint32)
 *
 * 本实现是我们独立编写的 TS 版本，仅以协议规范为准。
 */

import { gzipSync, gunzipSync } from 'node:zlib'

export enum MsgType {
  Invalid = 0,
  FullClientRequest = 0b0001,
  AudioOnlyClient = 0b0010,
  FullServerResponse = 0b1001,
  AudioOnlyServer = 0b1011,
  FrontEndResultServer = 0b1100,
  Error = 0b1111,
}

export enum MsgFlag {
  NoSeq = 0b0000,
  PositiveSeq = 0b0001,
  LastNoSeq = 0b0010,
  NegativeSeq = 0b0011,
  WithEvent = 0b0100,
}

export enum Serialization {
  Raw = 0b0000,
  JSON = 0b0001,
}

export enum Compression {
  None = 0b0000,
  Gzip = 0b0001,
}

export enum EventType {
  None = 0,

  // Upstream connection
  StartConnection = 1,
  FinishConnection = 2,

  // Downstream connection
  ConnectionStarted = 50,
  ConnectionFailed = 51,
  ConnectionFinished = 52,

  // Upstream session
  StartSession = 100,
  CancelSession = 101,
  FinishSession = 102,

  // Downstream session
  SessionStarted = 150,
  SessionCanceled = 151,
  SessionFinished = 152,
  SessionFailed = 153,
  UsageResponse = 154,

  // Upstream general
  TaskRequest = 200,
  UpdateConfig = 201,

  // Downstream TTS
  TTSSentenceStart = 350,
  TTSSentenceEnd = 351,
  TTSResponse = 352,
  TTSEnded = 359,

  // Downstream ASR
  ASRInfo = 450,
  ASRResponse = 451,
  ASREnded = 459,
}

const CONN_ONLY_EVENTS = new Set<EventType>([
  EventType.StartConnection,
  EventType.FinishConnection,
  EventType.ConnectionStarted,
  EventType.ConnectionFailed,
  EventType.ConnectionFinished,
])

export interface MessageInit {
  type: MsgType
  flag?: MsgFlag
  serialization?: Serialization
  compression?: Compression
  event?: EventType
  sessionId?: string
  connectId?: string
  sequence?: number
  errorCode?: number
  payload?: Buffer
}

export class Message {
  type: MsgType
  flag: MsgFlag
  serialization: Serialization
  compression: Compression
  event: EventType
  sessionId: string
  connectId: string
  sequence: number
  errorCode: number
  payload: Buffer

  constructor(init: MessageInit) {
    this.type = init.type
    this.flag = init.flag ?? MsgFlag.NoSeq
    this.serialization = init.serialization ?? Serialization.JSON
    this.compression = init.compression ?? Compression.None
    this.event = init.event ?? EventType.None
    this.sessionId = init.sessionId ?? ''
    this.connectId = init.connectId ?? ''
    this.sequence = init.sequence ?? 0
    this.errorCode = init.errorCode ?? 0
    this.payload = init.payload ?? Buffer.alloc(0)
  }

  /**
   * Encode to binary wire format.
   *
   * header(4) + [event(4) + sessionIdLen(4) + sessionIdBytes] (if WithEvent)
   *           + [sequence(4)] (if PositiveSeq/NegativeSeq on *Request/*Response/*AudioOnly*)
   *           + [errorCode(4)] (if type=Error)
   *           + payloadLen(4) + payloadBytes
   */
  marshal(): Buffer {
    const chunks: Buffer[] = []

    // Header: 4 bytes fixed
    //   byte0 = version(4) | headerSize(4) = 0x11  (V1, 4-byte header)
    //   byte1 = msgType(4) | flag(4)
    //   byte2 = serialization(4) | compression(4)
    //   byte3 = reserved = 0
    const header = Buffer.alloc(4)
    header[0] = (1 << 4) | 1
    header[1] = ((this.type & 0x0f) << 4) | (this.flag & 0x0f)
    header[2] = ((this.serialization & 0x0f) << 4) | (this.compression & 0x0f)
    header[3] = 0
    chunks.push(header)

    // WithEvent: event + session_id
    if (this.flag === MsgFlag.WithEvent) {
      const ev = Buffer.alloc(4)
      ev.writeInt32BE(this.event, 0)
      chunks.push(ev)

      if (!CONN_ONLY_EVENTS.has(this.event)) {
        const sid = Buffer.from(this.sessionId, 'utf-8')
        const sidLen = Buffer.alloc(4)
        sidLen.writeUInt32BE(sid.length, 0)
        chunks.push(sidLen, sid)
      }
    }

    // Sequence (for *Request/*Response/AudioOnly* with Pos/Neg flag)
    const seqTypes: MsgType[] = [
      MsgType.FullClientRequest,
      MsgType.FullServerResponse,
      MsgType.FrontEndResultServer,
      MsgType.AudioOnlyClient,
      MsgType.AudioOnlyServer,
    ]
    if (
      seqTypes.includes(this.type) &&
      (this.flag === MsgFlag.PositiveSeq || this.flag === MsgFlag.NegativeSeq)
    ) {
      const seqBuf = Buffer.alloc(4)
      seqBuf.writeInt32BE(this.sequence, 0)
      chunks.push(seqBuf)
    }

    // Error code
    if (this.type === MsgType.Error) {
      const ec = Buffer.alloc(4)
      ec.writeUInt32BE(this.errorCode, 0)
      chunks.push(ec)
    }

    // Payload (optionally gzipped). 即便 payload 为空也必须 gzip，否则 header 声明 Gzip、
    // body 为 0 字节会让服务端 ungzip EOF（ASR finish 空包踩过这个坑）。
    let payload: Buffer = this.payload
    if (this.compression === Compression.Gzip) {
      payload = Buffer.from(gzipSync(new Uint8Array(payload)))
    }
    const payloadLen = Buffer.alloc(4)
    payloadLen.writeUInt32BE(payload.length, 0)
    chunks.push(payloadLen, payload)

    return Buffer.concat(chunks.map((c) => new Uint8Array(c)))
  }

  static unmarshal(data: Buffer): Message {
    if (data.length < 4) throw new Error(`message too short: ${data.length}`)

    const version = data[0] >> 4
    const headerSize = data[0] & 0x0f
    const type = (data[1] >> 4) as MsgType
    const flag = (data[1] & 0x0f) as MsgFlag
    const serialization = (data[2] >> 4) as Serialization
    const compression = (data[2] & 0x0f) as Compression
    void version

    const msg = new Message({ type, flag, serialization, compression })

    let offset = headerSize * 4

    const seqTypes: MsgType[] = [
      MsgType.FullClientRequest,
      MsgType.FullServerResponse,
      MsgType.FrontEndResultServer,
      MsgType.AudioOnlyClient,
      MsgType.AudioOnlyServer,
    ]

    // Sequence first (per demo's reader order for non-WithEvent flags)
    if (
      seqTypes.includes(type) &&
      (flag === MsgFlag.PositiveSeq || flag === MsgFlag.NegativeSeq)
    ) {
      msg.sequence = data.readInt32BE(offset)
      offset += 4
    }

    if (type === MsgType.Error) {
      msg.errorCode = data.readUInt32BE(offset)
      offset += 4
    }

    // WithEvent: event + session_id (+ connect_id for connection-scoped events)
    if (flag === MsgFlag.WithEvent) {
      msg.event = data.readInt32BE(offset) as EventType
      offset += 4

      if (!CONN_ONLY_EVENTS.has(msg.event)) {
        const sidLen = data.readUInt32BE(offset)
        offset += 4
        if (sidLen > 0) {
          msg.sessionId = data.subarray(offset, offset + sidLen).toString('utf-8')
          offset += sidLen
        }
      } else if (
        msg.event === EventType.ConnectionStarted ||
        msg.event === EventType.ConnectionFailed ||
        msg.event === EventType.ConnectionFinished
      ) {
        // connect_id string
        if (offset + 4 <= data.length) {
          const cidLen = data.readUInt32BE(offset)
          offset += 4
          if (cidLen > 0 && offset + cidLen <= data.length) {
            msg.connectId = data.subarray(offset, offset + cidLen).toString('utf-8')
            offset += cidLen
          }
        }
      }
    }

    // Payload
    if (offset + 4 <= data.length) {
      const payloadLen = data.readUInt32BE(offset)
      offset += 4
      if (payloadLen > 0) {
        let payload: Buffer = data.subarray(offset, offset + payloadLen)
        if (compression === Compression.Gzip) {
          payload = Buffer.from(gunzipSync(new Uint8Array(payload)))
        }
        msg.payload = Buffer.from(payload)
      }
    }

    return msg
  }

  /** 便捷：JSON payload 解析 */
  payloadAsJson<T = unknown>(): T | null {
    if (this.payload.length === 0) return null
    try {
      return JSON.parse(this.payload.toString('utf-8')) as T
    } catch {
      return null
    }
  }
}

/** ---------- TTS bidirection helpers（WithEvent flag） ---------- */

export function ttsStartConnection(): Buffer {
  return new Message({
    type: MsgType.FullClientRequest,
    flag: MsgFlag.WithEvent,
    event: EventType.StartConnection,
    payload: Buffer.from('{}'),
  }).marshal()
}

export function ttsFinishConnection(): Buffer {
  return new Message({
    type: MsgType.FullClientRequest,
    flag: MsgFlag.WithEvent,
    event: EventType.FinishConnection,
    payload: Buffer.from('{}'),
  }).marshal()
}

export function ttsStartSession(sessionId: string, payload: object): Buffer {
  return new Message({
    type: MsgType.FullClientRequest,
    flag: MsgFlag.WithEvent,
    event: EventType.StartSession,
    sessionId,
    payload: Buffer.from(JSON.stringify(payload)),
  }).marshal()
}

export function ttsTaskRequest(sessionId: string, payload: object): Buffer {
  return new Message({
    type: MsgType.FullClientRequest,
    flag: MsgFlag.WithEvent,
    event: EventType.TaskRequest,
    sessionId,
    payload: Buffer.from(JSON.stringify(payload)),
  }).marshal()
}

export function ttsFinishSession(sessionId: string): Buffer {
  return new Message({
    type: MsgType.FullClientRequest,
    flag: MsgFlag.WithEvent,
    event: EventType.FinishSession,
    sessionId,
    payload: Buffer.from('{}'),
  }).marshal()
}

/** ---------- ASR sauc helpers（PositiveSeq flag + gzip） ---------- */

export function asrFullClientRequest(seq: number, payload: object): Buffer {
  return new Message({
    type: MsgType.FullClientRequest,
    flag: MsgFlag.PositiveSeq,
    serialization: Serialization.JSON,
    compression: Compression.Gzip,
    sequence: seq,
    payload: Buffer.from(JSON.stringify(payload)),
  }).marshal()
}

export function asrAudioOnly(seq: number, pcm: Buffer, isLast: boolean): Buffer {
  return new Message({
    type: MsgType.AudioOnlyClient,
    flag: isLast ? MsgFlag.NegativeSeq : MsgFlag.PositiveSeq,
    serialization: Serialization.Raw,
    compression: Compression.Gzip,
    sequence: isLast ? -Math.abs(seq) : seq,
    payload: pcm,
  }).marshal()
}
