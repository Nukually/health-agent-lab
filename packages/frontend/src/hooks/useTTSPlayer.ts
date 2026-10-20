/**
 * useTTSPlayer —— TTS 流式播放器
 *
 * 单例挂在模块级，一个标签页共享一条 /api/chat/tts WS，避免切路由重建。
 *
 * 播放路径两种：
 *  1) 流式（MSE + SourceBuffer 追加 MP3）——支持 MSE MP3 的浏览器优先走这条，含 iOS。
 *  2) 缓冲播放（收齐后 Blob + <audio>.src）——MSE 不支持或 iOS MSE 运行时失败后的兜底。
 *     历史消息手动朗读会按句预合成 + 队列播放，避免等完整长段落合成完才出声。
 *
 * iOS 关键：audio 元素必须在用户手势栈里 play() 过一次才能获得后续程序化 play 权限。
 *   handleToggleTTS(onClick) -> ttsPlayer.primeAudioUnlock() -> 静音 WAV play 一下 -> 解锁。
 *
 * 两种使用姿势：
 *   一次性（历史消息点喇叭）：playText(text)
 *   流式对接（新消息）：startStream() → pushDelta(text)... → endStream()
 *
 * 中断：stop() 关 WS + pause audio + 清队列，但保留单例 audio 元素的解锁态。
 */

import { useEffect, useState } from 'react'
import type { ClientTTSMessage, ServerTTSMessage } from '@health-agent/shared'
import { TtsTagStripper } from '../lib/a2ui/ttsSanitizer.js'
import { TtsMarkdownStripper } from '../lib/a2ui/markdownStripper.js'
import { api } from '../services/api.js'

type Phase = 'idle' | 'connecting' | 'playing' | 'error'
type NativeTTSEvent =
  | { type: 'phase'; phase: Phase; runId?: number }
  | { type: 'error'; message: string; runId?: number }

type NativeLifecycleEvent = {
  module?: string
  event?: string
  data?: unknown
}

declare global {
  interface Window {
    webkit?: {
      messageHandlers?: {
        cxTTS?: {
          postMessage: (message: unknown) => void
        }
        cxAppReady?: {
          postMessage: (message: unknown) => void
        }
      }
    }
    __cxNativeTTSOnEvent?: (event: NativeTTSEvent) => void
  }
}

interface WsTicketResponse {
  success: boolean
  data: {
    ticket: string
    expiresInSec: number
  }
}

// 44 字节 8kHz 8bit mono 0-sample WAV，用于用户手势里静音解锁 audio 元素
const SILENT_WAV =
  'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA='

const IS_IOS =
  typeof navigator !== 'undefined' &&
  (/iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && (navigator as { maxTouchPoints?: number }).maxTouchPoints! > 1))

const SUPPORTS_MSE_MP3 =
  typeof MediaSource !== 'undefined' &&
  typeof MediaSource.isTypeSupported === 'function' &&
  MediaSource.isTypeSupported('audio/mpeg')

// 支持 MSE MP3 时优先流式播放；iOS 上如 MSE 运行时失败，再退回缓冲播放。
const USE_BUFFERED = !SUPPORTS_MSE_MP3
const PROTECTED_H5_TTS_CONTAINER_RE = /MicroMessenger|Feishu|Lark/i

const TTS_FIRST_SEGMENT_MAX_CHARS = 140
const TTS_SEGMENT_MAX_CHARS = 260
const TTS_SEGMENT_MIN_CHARS = 90
const TTS_NATIVE_STREAM_SEGMENT_MAX_CHARS = 120
const TTS_REPLAY_DELTA_CHARS = 16
const SENTENCE_END_CHARS = new Set(['。', '！', '？', '!', '?', '；', ';'])
const CLOSING_QUOTE_CHARS = new Set(['”', '’', '"', '\'', '」', '』', '）', ')', '】', ']'])
const SOFT_BREAK_CHARS = new Set(['，', ',', '、', '：', ':', ' '])

function splitTTSIntoSegments(text: string): string[] {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (!normalized) return []

  const sentences: string[] = []
  let start = 0
  for (let i = 0; i < normalized.length; i += 1) {
    if (!SENTENCE_END_CHARS.has(normalized[i])) continue

    let end = i + 1
    while (end < normalized.length && CLOSING_QUOTE_CHARS.has(normalized[end])) {
      end += 1
    }
    const sentence = normalized.slice(start, end).trim()
    if (sentence) sentences.push(sentence)
    start = end
    i = end - 1
  }

  const tail = normalized.slice(start).trim()
  if (tail) sentences.push(tail)

  const pieces = sentences.flatMap((sentence) => splitLongTTSSegment(sentence))
  const segments: string[] = []
  let current = ''

  for (const piece of pieces) {
    if (!current) {
      current = piece
      continue
    }
    const joined = joinTTSPieces(current, piece)
    const maxChars = segments.length === 0 ? TTS_FIRST_SEGMENT_MAX_CHARS : TTS_SEGMENT_MAX_CHARS
    if (current.length < TTS_SEGMENT_MIN_CHARS || joined.length <= maxChars) {
      current = joined
      continue
    }
    segments.push(current)
    current = piece
  }
  if (current) segments.push(current)

  return segments.length > 0 ? segments : [normalized]
}

function splitLongTTSSegment(text: string): string[] {
  const result: string[] = []
  let rest = text.trim()

  while (rest.length > TTS_SEGMENT_MAX_CHARS) {
    let cut = -1
    const minCut = Math.floor(TTS_SEGMENT_MAX_CHARS * 0.5)

    for (let i = TTS_SEGMENT_MAX_CHARS; i >= minCut; i -= 1) {
      if (SOFT_BREAK_CHARS.has(rest[i])) {
        cut = i + 1
        break
      }
    }

    if (cut <= 0) cut = TTS_SEGMENT_MAX_CHARS
    const head = rest.slice(0, cut).trim()
    if (head) result.push(head)
    rest = rest.slice(cut).trim()
  }

  if (rest) result.push(rest)
  return result
}

async function issueTtsTicket(): Promise<string> {
  const resp = await api.post<WsTicketResponse>('/chat/ws-ticket', { purpose: 'tts' })
  return resp.data.ticket
}

function joinTTSPieces(left: string, right: string): string {
  if (/[A-Za-z0-9]$/.test(left) && /^[A-Za-z0-9]/.test(right)) {
    return `${left} ${right}`
  }
  return `${left}${right}`
}

function isProtectedH5TTSContainer(): boolean {
  if (typeof navigator === 'undefined') return false
  return PROTECTED_H5_TTS_CONTAINER_RE.test(navigator.userAgent)
}

function sanitizeTTSForBuffered(text: string): string {
  const tag = new TtsTagStripper()
  const md = new TtsMarkdownStripper()
  const afterTag = tag.feed(text) + tag.flushFinal()
  return md.feed(afterTag) + md.flushFinal()
}

function splitTextIntoReplayDeltas(text: string): string[] {
  const deltas: string[] = []
  let current = ''

  for (const char of text) {
    current += char
    if (current.length < TTS_REPLAY_DELTA_CHARS && !SENTENCE_END_CHARS.has(char)) continue
    deltas.push(current)
    current = ''
  }

  if (current) deltas.push(current)
  return deltas
}

class TTSPlayer {
  private ws: WebSocket | null = null
  private audio: HTMLAudioElement | null = null
  private audioPrimed = false

  // MSE 模式状态
  private mediaSource: MediaSource | null = null
  private sourceBuffer: SourceBuffer | null = null
  private pendingChunks: Uint8Array[] = []
  private sourceOpenResolve: (() => void) | null = null
  private sourceOpenReject: ((err: Error) => void) | null = null
  private sourceOpenPromise: Promise<void> | null = null
  private usingMse = false

  // 缓冲模式状态
  private bufferedChunks: Uint8Array[] = []
  private currentBlobUrl: string | null = null
  private segmentedBufferedPlayback = false
  private playbackRunId = 0
  private stopWaiters = new Set<() => void>()

  private phase: Phase = 'idle'
  private streamOpen = false
  private pendingText = ''
  private pendingTextEnd = false
  private pendingNativeText = ''
  private nativeActive = false
  private activeStreamOwnerKey: string | null = null
  private ignoreNextUnscopedNativeIdle = false
  private appBackgrounded = false
  private lifecycleAutoPaused = false
  private lifecyclePausedRunId = 0
  // 统一处理 <final_answer> + A2UI 语义标签的流式 TTS 过滤器
  private tagStripper = new TtsTagStripper()
  // 剥离 markdown 记号（**加粗** / *斜体* / `code` / # 标题 / - 列表），避免 TTS 念出 "星星"
  private markdownStripper = new TtsMarkdownStripper()
  private listeners = new Set<(p: Phase) => void>()
  private errorCb: ((msg: string) => void) | null = null

  // 单条消息手动朗读时用来标识"哪条消息在播"，组件据此切图标
  // 流式自动播（startStream 路径）不设 owner，owner 为 null
  private activeOwnerId: string | null = null
  private ownerListeners = new Set<(id: string | null) => void>()

  private get tokenFromStore(): string | null {
    try {
      return localStorage.getItem('cx-token')
    } catch {
      return null
    }
  }

  constructor() {
    this.registerNativeBridgeCallback()
    this.registerNativeLifecycleCallback()
  }

  setPhase(phase: Phase) {
    this.phase = phase
    for (const cb of this.listeners) cb(phase)
    // idle / error 时释放 owner，组件图标自动回落到 idle 态
    if (phase === 'idle' || phase === 'error') this.setActiveOwner(null)
  }

  onPhaseChange(cb: (p: Phase) => void): () => void {
    this.listeners.add(cb)
    cb(this.phase)
    return () => this.listeners.delete(cb)
  }

  getActiveOwnerId(): string | null {
    return this.activeOwnerId
  }

  onActiveOwnerChange(cb: (id: string | null) => void): () => void {
    this.ownerListeners.add(cb)
    cb(this.activeOwnerId)
    return () => this.ownerListeners.delete(cb)
  }

  private setActiveOwner(id: string | null) {
    if (this.activeOwnerId === id) return
    this.activeOwnerId = id
    for (const cb of this.ownerListeners) cb(id)
  }

  setErrorHandler(cb: ((msg: string) => void) | null) {
    this.errorCb = cb
  }

  getPhase(): Phase {
    return this.phase
  }

  isOwnerActive(ownerId: string): boolean {
    return this.activeOwnerId === ownerId && (this.phase === 'connecting' || this.phase === 'playing')
  }

  toggleText(text: string, ownerId: string): { action: 'started' | 'stopped'; playback: Promise<void> } {
    if (this.isOwnerActive(ownerId)) {
      this.stop()
      return { action: 'stopped', playback: Promise.resolve() }
    }

    this.primeAudioUnlock()
    return { action: 'started', playback: this.playText(text, ownerId) }
  }

  /**
   * 必须在 onClick 等用户手势的同步调用栈里执行，才能解锁 iOS 的 audio 播放权限。
   * 原理：一旦 audio 元素在 user gesture 里被 play 过一次（哪怕播放静音），
   * 该元素后续程序化 play() 就不会被 autoplay policy 拦。
   */
  primeAudioUnlock() {
    this.ensureAudio()
    if (this.audioPrimed) return
    const a = this.audio!
    try {
      a.muted = true
      a.src = SILENT_WAV
      const p = a.play()
      const finish = () => {
        try { a.pause() } catch { /* ignore */ }
        try { a.currentTime = 0 } catch { /* ignore */ }
        a.muted = false
        this.audioPrimed = true
      }
      if (p && typeof p.then === 'function') {
        p.then(finish).catch(() => { a.muted = false })
      } else {
        finish()
      }
    } catch {
      // ignore
    }
  }

  /**
   * 一次性播放 —— 关闭任何正在进行的播放，合成并播放文本。
   * - MSE 模式：同一条 TTS 连接内按句发送 text_delta，浏览器边收边播。
   * - 缓冲模式：按句单独合成 Blob，当前句播放时预合成下一句，降低 iOS/微信首响等待。
   * @param ownerId 可选，用于标识"正在播放的归属"（例如消息 id），组件据此高亮本条喇叭
   */
  async playText(text: string, ownerId?: string) {
    if (!text) return
    this.resetForNewPlayback()
    const runId = this.playbackRunId
    // 历史消息存库时可能含 A2UI 标签 + markdown 记号。先做一次静态清洗判空；
    // 真正的流式路径仍重放原始 delta，让清洗逻辑与右上角自动播报保持一致。
    const clean = sanitizeTTSForBuffered(text)
    if (!clean) return
    // 在 ensureConnection 之前就 set owner，方便连接阶段的 UI 也能跟踪
    if (ownerId) this.setActiveOwner(ownerId)
    this.setPhase('connecting')

    if (this.shouldReplayTextAsStream()) {
      await this.playTextAsReplayStream(text, runId)
      return
    }

    const segments = splitTTSIntoSegments(clean)
    if (segments.length === 0) return

    if (USE_BUFFERED && segments.length > 1) {
      await this.playBufferedSegments(segments, runId)
      return
    }

    await this.ensureConnection()
    if (runId !== this.playbackRunId) return
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    for (const segment of segments) {
      this.send({ type: 'text_delta', text: segment })
    }
    this.send({ type: 'text_end' })
  }

  async startStream(ownerKey?: string) {
    this.stop()
    this.activeStreamOwnerKey = ownerKey ?? null
    this.streamOpen = true
    this.pendingNativeText = ''
    this.tagStripper.reset()
    this.markdownStripper.reset()
    if (this.hasNativeBridge()) {
      const started = await this.startNativeSession(this.playbackRunId)
      if (started) this.flushPendingNativeMessages()
      return
    }
    await this.ensureConnection()
  }

  pushDelta(delta: string, ownerKey?: string) {
    if (!this.isStreamOwner(ownerKey)) return
    if (!this.streamOpen || !delta) return
    const afterTag = this.tagStripper.feed(delta)
    if (!afterTag) return
    const out = this.markdownStripper.feed(afterTag)
    if (!out) return
    if (this.nativeActive) {
      this.queueNativeText(out)
      return
    }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.pendingText += out
      return
    }
    this.send({ type: 'text_delta', text: out })
  }

  endStream(ownerKey?: string) {
    if (!this.isStreamOwner(ownerKey)) return
    if (!this.streamOpen) return
    this.streamOpen = false
    // 把两层 stripper 的残余文本依次送出
    const tagTail = this.tagStripper.flushFinal()
    const mdMid = tagTail ? this.markdownStripper.feed(tagTail) : ''
    const mdTail = this.markdownStripper.flushFinal()
    const tail = mdMid + mdTail
    if (tail) {
      if (this.nativeActive) {
        this.queueNativeText(tail)
      } else if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.send({ type: 'text_delta', text: tail })
      } else {
        this.pendingText += tail
      }
    }
    if (this.nativeActive) {
      this.flushNativeText()
      this.postNative({ type: 'text_end' })
      return
    }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.pendingTextEnd = true
      return
    }
    this.send({ type: 'text_end' })
  }

  rebindStreamOwner(from: string, to: string) {
    if (this.activeStreamOwnerKey !== from) return
    this.activeStreamOwnerKey = to
  }

  /** 同步中断：关 WS + pause audio + 清队列。audio 单例保留解锁态 */
  stop() {
    this.playbackRunId += 1
    this.streamOpen = false
    this.activeStreamOwnerKey = null
    this.pendingText = ''
    this.pendingTextEnd = false
    this.pendingNativeText = ''
    this.ignoreNextUnscopedNativeIdle = false
    this.lifecycleAutoPaused = false
    const shouldCancelNative = this.hasNativeBridge()
    if (shouldCancelNative) {
      this.postNative({ type: 'cancel', runId: this.playbackRunId })
    }
    if (this.nativeActive) {
      this.nativeActive = false
    }
    this.tagStripper.reset()
    this.markdownStripper.reset()
    this.pendingChunks = []
    this.bufferedChunks = []
    this.segmentedBufferedPlayback = false

    const waiters = [...this.stopWaiters]
    this.stopWaiters.clear()
    for (const waiter of waiters) waiter()

    if (this.ws) {
      try {
        if (this.ws.readyState === WebSocket.OPEN) this.send({ type: 'cancel' })
        this.ws.close()
      } catch {
        // ignore
      }
      this.ws = null
    }

    if (this.audio) {
      try {
        this.audio.pause()
      } catch {
        // ignore
      }
      this.audio.onended = null
      // 不清 src / 不销毁元素，保留 iOS 解锁态
    }
    if (this.currentBlobUrl) {
      try { URL.revokeObjectURL(this.currentBlobUrl) } catch { /* ignore */ }
      this.currentBlobUrl = null
    }

    this.mediaSource = null
    this.sourceBuffer = null
    this.sourceOpenResolve = null
    this.sourceOpenReject = null
    this.sourceOpenPromise = null
    this.usingMse = false

    this.setPhase('idle')
  }

  private resetForNewPlayback() {
    this.playbackRunId += 1
    this.streamOpen = false
    this.activeStreamOwnerKey = null
    this.pendingText = ''
    this.pendingTextEnd = false
    this.pendingNativeText = ''
    this.ignoreNextUnscopedNativeIdle = false
    this.lifecycleAutoPaused = false
    this.nativeActive = false
    this.tagStripper.reset()
    this.markdownStripper.reset()
    this.pendingChunks = []
    this.bufferedChunks = []
    this.segmentedBufferedPlayback = false

    const waiters = [...this.stopWaiters]
    this.stopWaiters.clear()
    for (const waiter of waiters) waiter()

    if (this.ws) {
      try {
        if (this.ws.readyState === WebSocket.OPEN) this.send({ type: 'cancel' })
        this.ws.close()
      } catch {
        // ignore
      }
      this.ws = null
    }

    if (this.audio) {
      try {
        this.audio.pause()
      } catch {
        // ignore
      }
      this.audio.onended = null
    }
    if (this.currentBlobUrl) {
      try { URL.revokeObjectURL(this.currentBlobUrl) } catch { /* ignore */ }
      this.currentBlobUrl = null
    }

    this.mediaSource = null
    this.sourceBuffer = null
    this.sourceOpenResolve = null
    this.sourceOpenReject = null
    this.sourceOpenPromise = null
    this.usingMse = false
  }

  /** ---------- private ---------- */

  private ensureAudio() {
    if (this.audio) return
    const a = new Audio()
    a.preload = 'auto'
    // iOS 有些版本需要 audio 挂到 DOM 才能被 user gesture 正确授权
    a.style.position = 'fixed'
    a.style.left = '-9999px'
    a.style.width = '1px'
    a.style.height = '1px'
    try { document.body.appendChild(a) } catch { /* ignore */ }
    // MSE 模式下播完时 direct a.onended 不一定有人赋值，用 listener 兜底
    // 缓冲模式里仍会额外 direct assignment（含 revoke），两处幂等
    a.addEventListener('ended', () => {
      if (this.phase === 'playing' && !this.segmentedBufferedPlayback) this.setPhase('idle')
    })
    this.audio = a
  }

  private send(msg: ClientTTSMessage) {
    try {
      this.ws!.send(JSON.stringify(msg))
    } catch {
      // ignore
    }
  }

  private hasNativeBridge(): boolean {
    return typeof window !== 'undefined'
      && typeof window.webkit?.messageHandlers?.cxTTS?.postMessage === 'function'
  }

  private shouldReplayTextAsStream(): boolean {
    if (this.hasNativeBridge()) return true
    // 微信 / 飞书 H5 的音频流式能力差异较大，气泡喇叭保持原缓冲分段路径。
    if (isProtectedH5TTSContainer()) return false
    return !USE_BUFFERED
  }

  private registerNativeBridgeCallback() {
    if (typeof window === 'undefined') return
    window.__cxNativeTTSOnEvent = (event: NativeTTSEvent) => {
      if (typeof event.runId === 'number' && event.runId !== this.playbackRunId) return
      if (event.type === 'phase') {
        if (event.runId == null && event.phase === 'idle' && this.ignoreNextUnscopedNativeIdle) {
          this.ignoreNextUnscopedNativeIdle = false
          return
        }
        if (event.phase !== 'idle') this.ignoreNextUnscopedNativeIdle = false
        this.setPhase(event.phase)
        return
      }
      if (event.type === 'error') {
        this.emitError(event.message || '语音合成失败')
      }
    }
  }

  private registerNativeLifecycleCallback() {
    if (typeof window === 'undefined') return
    window.addEventListener('cx-native-event', (event) => {
      const detail = (event as CustomEvent<NativeLifecycleEvent>).detail
      if (!detail || detail.module !== 'lifecycle') return
      if (detail.event === 'pause') {
        this.pauseForNativeLifecycle()
        return
      }
      if (detail.event === 'resume') {
        this.resumeForNativeLifecycle()
      }
    })
  }

  private pauseForNativeLifecycle() {
    this.appBackgrounded = true
    if (this.phase !== 'connecting' && this.phase !== 'playing') return

    this.lifecycleAutoPaused = true
    this.lifecyclePausedRunId = this.playbackRunId
    if (!this.audio || this.audio.paused || this.audio.ended) return
    try {
      this.audio.pause()
    } catch {
      // ignore
    }
  }

  private resumeForNativeLifecycle() {
    this.appBackgrounded = false
    if (!this.lifecycleAutoPaused) return

    const runId = this.lifecyclePausedRunId
    this.lifecycleAutoPaused = false
    if (runId !== this.playbackRunId) return
    if (this.phase !== 'playing') return
    if (!this.audio || !this.audio.paused || this.audio.ended) return

    this.audio.play().catch((err) => {
      console.warn('[TTS] resume after background rejected:', err)
      this.emitError('语音播放恢复失败，请再次点击喇叭按钮')
    })
  }

  private deferPlaybackWhileBackgrounded(runId: number = this.playbackRunId): boolean {
    if (!this.appBackgrounded) return false
    this.lifecycleAutoPaused = true
    this.lifecyclePausedRunId = runId
    return true
  }

  private postNative(message: unknown) {
    try {
      window.webkit?.messageHandlers?.cxTTS?.postMessage(message)
    } catch (err) {
      console.warn('[TTS] native bridge post failed:', err)
      this.emitError('语音桥接调用失败')
    }
  }

  private flushPendingNativeMessages() {
    if (!this.nativeActive) return
    if (this.pendingText) {
      this.queueNativeText(this.pendingText)
      this.pendingText = ''
    }
    if (this.pendingTextEnd) {
      this.flushNativeText()
      this.postNative({ type: 'text_end' })
      this.pendingTextEnd = false
    }
  }

  private queueNativeText(text: string) {
    if (!this.nativeActive || !text) return
    this.pendingNativeText += text
    if (!this.shouldFlushNativeText()) return
    this.flushNativeText()
  }

  private shouldFlushNativeText(): boolean {
    const text = this.pendingNativeText.trim()
    if (!text) return false
    const last = text[text.length - 1]
    return SENTENCE_END_CHARS.has(last) || text.length >= TTS_NATIVE_STREAM_SEGMENT_MAX_CHARS
  }

  private flushNativeText() {
    if (!this.nativeActive) return
    const text = this.pendingNativeText.trim()
    this.pendingNativeText = ''
    if (!text) return
    for (const segment of splitTTSIntoSegments(text)) {
      this.postNative({ type: 'text_delta', text: segment })
    }
  }

  private isStreamOwner(ownerKey?: string): boolean {
    const key = ownerKey ?? null
    return this.activeStreamOwnerKey === key
  }

  private async startNativeSession(runId: number): Promise<boolean> {
    const token = this.tokenFromStore
    if (!token) {
      this.emitError('未登录，无法播放语音')
      return false
    }
    this.registerNativeBridgeCallback()
    this.setPhase('connecting')
    let ticket: string
    try {
      ticket = await issueTtsTicket()
    } catch (err) {
      this.emitError((err as Error).message || '语音服务鉴权失败')
      return false
    }
    if (runId !== this.playbackRunId) return false
    this.nativeActive = true
    const loc = window.location
    const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:'
    const url = `${proto}//${loc.host}/api/chat/tts?ticket=${encodeURIComponent(ticket)}`
    this.ignoreNextUnscopedNativeIdle = true
    this.postNative({ type: 'start', url, runId })
    return true
  }

  private async playTextAsReplayStream(text: string, runId: number): Promise<void> {
    this.streamOpen = true
    this.tagStripper.reset()
    this.markdownStripper.reset()

    if (this.hasNativeBridge()) {
      if (!await this.startNativeSession(runId)) return
      for (const segment of splitTTSIntoSegments(sanitizeTTSForBuffered(text))) {
        if (runId !== this.playbackRunId) return
        this.postNative({ type: 'text_delta', text: segment })
      }
      if (runId !== this.playbackRunId) return
      this.postNative({ type: 'text_end' })
      this.streamOpen = false
      return
    } else {
      await this.ensureConnection()
    }

    if (runId !== this.playbackRunId) return
    for (const delta of splitTextIntoReplayDeltas(text)) {
      if (runId !== this.playbackRunId) return
      this.pushDelta(delta)
    }
    if (runId !== this.playbackRunId) return
    this.endStream()
  }

  private async ensureConnection(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return
    const token = this.tokenFromStore
    if (!token) {
      this.emitError('未登录，无法播放语音')
      return
    }

    this.setPhase('connecting')
    this.ensureAudio()
    let ticket: string
    try {
      ticket = await issueTtsTicket()
    } catch (err) {
      this.emitError((err as Error).message || '语音服务鉴权失败')
      return
    }

    if (!USE_BUFFERED) {
      this.usingMse = true
      this.mediaSource = new MediaSource()
      this.audio!.src = URL.createObjectURL(this.mediaSource)
      this.sourceOpenPromise = new Promise((resolve, reject) => {
        this.sourceOpenResolve = resolve
        this.sourceOpenReject = reject
      })
      this.mediaSource.addEventListener(
        'sourceopen',
        () => {
          try {
            const sb = this.mediaSource!.addSourceBuffer('audio/mpeg')
            sb.mode = 'sequence'
            sb.addEventListener('updateend', () => this.flushPending())
            this.sourceBuffer = sb
            this.sourceOpenResolve?.()
          } catch (err) {
            this.sourceOpenReject?.(err as Error)
          }
        },
        { once: true }
      )
    }

    const loc = window.location
    const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:'
    const url = `${proto}//${loc.host}/api/chat/tts?ticket=${encodeURIComponent(ticket)}`
    const ws = new WebSocket(url)
    ws.binaryType = 'arraybuffer'
    this.ws = ws

    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve()
      ws.onerror = () => reject(new Error('TTS WebSocket connection failed'))
    }).catch((err) => {
      console.warn('[TTS] WebSocket open failed:', err)
      this.emitError(err.message || '语音服务连接失败')
      throw err
    })

    ws.onmessage = (ev) => {
      if (this.ws !== ws) return
      this.onMessage(ev)
    }
    ws.onclose = (ev) => {
      if (this.ws !== ws) return
      console.debug('[TTS] WebSocket closed', { code: ev.code, reason: ev.reason })
      // WS 只代表合成完成；已开始播放时等 audio ended 再回 idle，避免按钮提前变灰。
      if (USE_BUFFERED || this.phase === 'error' || this.phase === 'idle') return
      if (this.phase === 'playing') {
        if (this.usingMse) this.finalizeSourceBuffer()
        return
      }
      this.setPhase('idle')
    }
    ws.onerror = (ev) => {
      if (this.ws !== ws) return
      console.warn('[TTS] WebSocket error', ev)
      this.emitError('语音服务连接异常')
    }

    if (this.usingMse) {
      await this.sourceOpenPromise?.catch((err) => {
        if (this.fallbackToBuffered('mse_init_failed', err as Error)) return
        this.emitError((err as Error).message || '音频解码初始化失败')
      })
    }

    if (this.pendingText) {
      this.send({ type: 'text_delta', text: this.pendingText })
      this.pendingText = ''
    }
    if (this.pendingTextEnd) {
      this.send({ type: 'text_end' })
      this.pendingTextEnd = false
    }
  }

  private onMessage(ev: MessageEvent) {
    if (typeof ev.data === 'string') {
      let msg: ServerTTSMessage
      try { msg = JSON.parse(ev.data) } catch { return }
      switch (msg.type) {
        case 'audio_start':
          if (this.usingMse) {
            this.setPhase('playing')
            if (this.deferPlaybackWhileBackgrounded()) return
            this.audio?.play().catch((err) => {
              console.warn('[TTS] audio.play() rejected:', err)
              if (!this.fallbackToBuffered('mse_play_rejected', err as Error)) {
                this.emitError('浏览器自动播放被拦截，请再次点击喇叭按钮')
              }
            })
          }
          break
        case 'audio_end':
          if (this.usingMse) {
            this.finalizeSourceBuffer()
          } else {
            this.playBufferedBlob()
          }
          break
        case 'error':
          this.emitError(msg.message || '语音合成失败')
          break
      }
      return
    }

    const chunk = ev.data instanceof ArrayBuffer ? new Uint8Array(ev.data) : new Uint8Array()
    if (chunk.length === 0) return
    if (this.usingMse) {
      if (IS_IOS) this.bufferedChunks.push(chunk.slice())
      this.pendingChunks.push(chunk)
      this.flushPending()
    } else {
      this.bufferedChunks.push(chunk)
    }
  }

  private fallbackToBuffered(reason: string, err?: Error): boolean {
    if (!IS_IOS || !this.usingMse) return false
    console.warn('[TTS] falling back to buffered playback', { reason, err })
    this.usingMse = false
    this.pendingChunks = []
    this.sourceBuffer = null
    this.mediaSource = null
    this.sourceOpenResolve = null
    this.sourceOpenReject = null
    this.sourceOpenPromise = null
    if (this.phase === 'playing') this.setPhase('connecting')
    return true
  }

  private playBufferedBlob() {
    if (!this.audio || this.bufferedChunks.length === 0) {
      this.setPhase('idle')
      return
    }
    const blob = new Blob(this.bufferedChunks as BlobPart[], { type: 'audio/mpeg' })
    this.bufferedChunks = []
    if (this.currentBlobUrl) {
      try { URL.revokeObjectURL(this.currentBlobUrl) } catch { /* ignore */ }
    }
    this.currentBlobUrl = URL.createObjectURL(blob)
    const a = this.audio
    a.onended = null
    a.src = this.currentBlobUrl
    this.setPhase('playing')
    if (this.deferPlaybackWhileBackgrounded()) {
      a.onended = () => {
        this.setPhase('idle')
        if (this.currentBlobUrl) {
          try { URL.revokeObjectURL(this.currentBlobUrl) } catch { /* ignore */ }
          this.currentBlobUrl = null
        }
      }
      return
    }
    a.play().catch((err) => {
      console.warn('[TTS] buffered audio.play() rejected:', err)
      this.emitError('浏览器自动播放被拦截，请再次点击喇叭按钮')
    })
    a.onended = () => {
      this.setPhase('idle')
      if (this.currentBlobUrl) {
        try { URL.revokeObjectURL(this.currentBlobUrl) } catch { /* ignore */ }
        this.currentBlobUrl = null
      }
    }
  }

  private async playBufferedSegments(segments: string[], runId: number) {
    this.ensureAudio()
    this.segmentedBufferedPlayback = true

    try {
      let nextAudioUrl = this.synthesizeBufferedSegment(segments[0], runId)

      for (let i = 0; i < segments.length; i += 1) {
        const audioUrl = await nextAudioUrl
        if (runId !== this.playbackRunId) return
        if (!audioUrl) {
          if (this.phase !== 'error') this.setPhase('idle')
          return
        }

        nextAudioUrl = i + 1 < segments.length
          ? this.synthesizeBufferedSegment(segments[i + 1], runId)
          : Promise.resolve(null)

        await this.playBlobUrl(audioUrl, runId)
        if (runId !== this.playbackRunId) return
      }

      if (runId === this.playbackRunId) this.setPhase('idle')
    } finally {
      if (runId === this.playbackRunId) this.segmentedBufferedPlayback = false
    }
  }

  private async synthesizeBufferedSegment(text: string, runId: number): Promise<string | null> {
    const token = this.tokenFromStore
    if (!token) {
      this.emitError('未登录，无法播放语音')
      return Promise.resolve(null)
    }
    if (runId !== this.playbackRunId) return Promise.resolve(null)

    if (this.phase !== 'playing') this.setPhase('connecting')
    let ticket: string
    try {
      ticket = await issueTtsTicket()
    } catch (err) {
      if (runId === this.playbackRunId) this.emitError((err as Error).message || '语音服务鉴权失败')
      return null
    }
    if (runId !== this.playbackRunId) return null

    const loc = window.location
    const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:'
    const url = `${proto}//${loc.host}/api/chat/tts?ticket=${encodeURIComponent(ticket)}`
    const ws = new WebSocket(url)
    ws.binaryType = 'arraybuffer'
    this.ws = ws

    const chunks: Uint8Array[] = []

    return new Promise((resolve) => {
      let settled = false
      let stopWaiter: (() => void) | null = null

      const cleanup = () => {
        try {
          if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) ws.close()
        } catch { /* ignore */ }
        if (this.ws === ws) this.ws = null
        if (stopWaiter) {
          this.stopWaiters.delete(stopWaiter)
          stopWaiter = null
        }
      }

      const finish = (audioUrl: string | null) => {
        if (settled) return
        settled = true
        cleanup()
        resolve(audioUrl)
      }

      const fail = (message: string) => {
        if (settled) return
        finish(null)
        if (runId === this.playbackRunId) this.emitError(message)
      }

      stopWaiter = () => {
        try { ws.close() } catch { /* ignore */ }
        finish(null)
      }
      this.stopWaiters.add(stopWaiter)

      ws.onopen = () => {
        if (runId !== this.playbackRunId) {
          try { ws.close() } catch { /* ignore */ }
          finish(null)
          return
        }
        try {
          ws.send(JSON.stringify({ type: 'text_delta', text } satisfies ClientTTSMessage))
          ws.send(JSON.stringify({ type: 'text_end' } satisfies ClientTTSMessage))
        } catch {
          fail('语音文本发送失败')
        }
      }

      ws.onmessage = (ev) => {
        if (runId !== this.playbackRunId) {
          try { ws.close() } catch { /* ignore */ }
          finish(null)
          return
        }

        if (typeof ev.data === 'string') {
          let msg: ServerTTSMessage
          try { msg = JSON.parse(ev.data) } catch { return }
          switch (msg.type) {
            case 'audio_start':
              return
            case 'audio_end': {
              if (chunks.length === 0) {
                finish(null)
                return
              }
              const blob = new Blob(chunks as BlobPart[], { type: 'audio/mpeg' })
              finish(URL.createObjectURL(blob))
              return
            }
            case 'error':
              fail(msg.message || '语音合成失败')
              return
          }
        }

        const chunk = ev.data instanceof ArrayBuffer ? new Uint8Array(ev.data) : new Uint8Array()
        if (chunk.length > 0) chunks.push(chunk)
      }

      ws.onerror = () => fail('语音服务连接异常')
      ws.onclose = () => {
        if (!settled) {
          if (runId === this.playbackRunId) fail('语音连接已关闭')
          else finish(null)
        }
      }
    })
  }

  private playBlobUrl(url: string, runId: number): Promise<void> {
    this.ensureAudio()
    if (!this.audio || runId !== this.playbackRunId) {
      try { URL.revokeObjectURL(url) } catch { /* ignore */ }
      return Promise.resolve()
    }

    return new Promise((resolve) => {
      const a = this.audio!
      let settled = false
      let stopWaiter: (() => void) | null = null

      const cleanup = () => {
        a.removeEventListener('ended', onEnded)
        a.removeEventListener('error', onError)
        if (stopWaiter) {
          this.stopWaiters.delete(stopWaiter)
          stopWaiter = null
        }
        if (this.currentBlobUrl === url) {
          try { URL.revokeObjectURL(url) } catch { /* ignore */ }
          this.currentBlobUrl = null
        }
      }

      const finish = () => {
        if (settled) return
        settled = true
        cleanup()
        resolve()
      }

      const onEnded = () => finish()
      const onError = () => {
        finish()
        if (runId === this.playbackRunId) this.emitError('音频播放失败')
      }

      stopWaiter = finish
      this.stopWaiters.add(stopWaiter)

      if (this.currentBlobUrl && this.currentBlobUrl !== url) {
        try { URL.revokeObjectURL(this.currentBlobUrl) } catch { /* ignore */ }
      }
      this.currentBlobUrl = url
      a.onended = null
      a.addEventListener('ended', onEnded)
      a.addEventListener('error', onError)
      a.src = url
      this.setPhase('playing')
      if (this.deferPlaybackWhileBackgrounded(runId)) return
      a.play().catch((err) => {
        console.warn('[TTS] segmented buffered audio.play() rejected:', err)
        finish()
        if (runId === this.playbackRunId) {
          this.emitError('浏览器自动播放被拦截，请再次点击喇叭按钮')
        }
      })
    })
  }

  private flushPending() {
    if (!this.sourceBuffer || this.sourceBuffer.updating) return
    const next = this.pendingChunks.shift()
    if (!next) return
    try {
      const buf = next.buffer.slice(next.byteOffset, next.byteOffset + next.byteLength) as ArrayBuffer
      this.sourceBuffer.appendBuffer(buf)
    } catch (err) {
      if (!this.fallbackToBuffered('mse_append_failed', err as Error)) {
        this.emitError((err as Error).message || '音频缓冲失败')
      }
    }
  }

  private finalizeSourceBuffer() {
    if (!this.mediaSource) return
    const tryEnd = () => {
      if (this.pendingChunks.length > 0 || (this.sourceBuffer && this.sourceBuffer.updating)) {
        setTimeout(tryEnd, 50)
        return
      }
      try {
        if (this.mediaSource && this.mediaSource.readyState === 'open') {
          this.mediaSource.endOfStream()
        }
      } catch {
        // ignore
      }
    }
    tryEnd()
  }

  private emitError(msg: string) {
    this.setPhase('error')
    this.errorCb?.(msg)
    setTimeout(() => this.stop(), 0)
  }
}

export const ttsPlayer = new TTSPlayer()

/** 轻量 React hook —— 订阅 phase 状态，供 UI 渲染播放态 */
export function useTTSPlayerPhase(): Phase {
  const [phase, setPhase] = useState<Phase>(ttsPlayer.getPhase())
  useEffect(() => ttsPlayer.onPhaseChange(setPhase), [])
  return phase
}

/** 订阅"当前正在播哪条消息"（playText(ownerId) 设置）；idle/error 会回落 null */
export function useTTSOwner(): string | null {
  const [owner, setOwner] = useState<string | null>(ttsPlayer.getActiveOwnerId())
  useEffect(() => ttsPlayer.onActiveOwnerChange(setOwner), [])
  return owner
}
