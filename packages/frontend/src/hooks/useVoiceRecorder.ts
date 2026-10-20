/**
 * useVoiceRecorder — real-time ASR via WebSocket + Web Audio capture
 *
 * AudioContext (16kHz PCM) → WebSocket → backend → DashScope qwen3-asr-flash-realtime
 */

import { useCallback, useRef, useState, useEffect } from 'react'
import { useStore } from '../stores/index.js'
import { api } from '../services/api.js'
import { ttsPlayer } from './useTTSPlayer.js'
import type { ClientASRMessage, ServerASRMessage } from '@health-agent/shared'

const MAX_DURATION_S = 60
const WORKLET_URL = new URL('../worklets/pcm-capture-processor.js', import.meta.url).href
const TARGET_SAMPLE_RATE = 16000
const CHUNK_SAMPLES = 1600 // 100ms at 16kHz

type AudioContextConstructor = typeof AudioContext

interface LegacyAudioWindow extends Window {
  AudioContext?: AudioContextConstructor
  webkitAudioContext?: AudioContextConstructor
}

function getAudioContextConstructor(): AudioContextConstructor | null {
  if (typeof window === 'undefined') return null
  const win = window as LegacyAudioWindow
  return win.AudioContext || win.webkitAudioContext || null
}

function isBrowserSecureContext(): boolean {
  if (typeof window === 'undefined') return true
  if (typeof window.isSecureContext === 'boolean') return window.isSecureContext
  const { protocol, hostname } = window.location
  return protocol === 'https:' || hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
}

function isIOSWebKit(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent
  return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

function encodePcm16(samples: Float32Array): ArrayBuffer {
  const pcm = new Int16Array(samples.length)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7FFF
  }
  return pcm.buffer
}

function downsampleTo16k(input: Float32Array, sourceSampleRate: number): Float32Array {
  const ratio = sourceSampleRate / TARGET_SAMPLE_RATE
  const outLen = Math.floor(input.length / ratio)
  const output = new Float32Array(outLen)
  for (let i = 0; i < outLen; i++) {
    const srcIdx = i * ratio
    const lo = Math.floor(srcIdx)
    const hi = Math.min(lo + 1, input.length - 1)
    const frac = srcIdx - lo
    output[i] = input[lo] * (1 - frac) + input[hi] * frac
  }
  return output
}

function createScriptProcessorPcmEmitter(sourceSampleRate: number, emit: (buffer: ArrayBuffer) => void) {
  let pending = new Float32Array(0)

  return (input: Float32Array) => {
    const resampled = downsampleTo16k(input, sourceSampleRate)
    const merged = new Float32Array(pending.length + resampled.length)
    merged.set(pending)
    merged.set(resampled, pending.length)
    pending = merged

    while (pending.length >= CHUNK_SAMPLES) {
      const chunk = pending.subarray(0, CHUNK_SAMPLES)
      pending = pending.slice(CHUNK_SAMPLES)
      emit(encodePcm16(chunk))
    }
  }
}

function getWsUrl(): string {
  const loc = window.location
  const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${loc.host}/api/chat/asr`
}

interface UseVoiceRecorderOptions {
  onTranscription: (text: string) => void
  onError: (error: string) => void
}

interface WsTicketResponse {
  success: boolean
  data: {
    ticket: string
    expiresInSec: number
  }
}

export function useVoiceRecorder({ onTranscription, onError }: UseVoiceRecorderOptions) {
  const [isRecording, setIsRecording] = useState(false)
  const [isTranscribing, setIsTranscribing] = useState(false)
  const [durationSeconds, setDurationSeconds] = useState(0)
  const [partialText, setPartialText] = useState('')

  const wsRef = useRef<WebSocket | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const captureNodeRef = useRef<AudioNode | null>(null)
  const mutedOutputRef = useRef<GainNode | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const readyRef = useRef(false)
  const abortedRef = useRef(false)
  const ignoreFinalRef = useRef(false)
  const callbacksRef = useRef({ onTranscription, onError })
  callbacksRef.current = { onTranscription, onError }

  const AudioContextCtor = getAudioContextConstructor()
  const hasAudioWorklet = typeof window !== 'undefined' && typeof AudioWorkletNode !== 'undefined'
  const hasScriptProcessor = !!AudioContextCtor?.prototype?.createScriptProcessor
  const canUseScriptProcessorFallback = isIOSWebKit() && hasScriptProcessor
  const isSecureContext = isBrowserSecureContext()
  const hasMediaDevices = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia
  const canProcessAudio = !!AudioContextCtor && (hasAudioWorklet || canUseScriptProcessorFallback)
  const isSupported = isSecureContext && hasMediaDevices && canProcessAudio
  const unsupportedReason = !isSecureContext
    ? '手机浏览器需要 HTTPS 或 localhost 才能使用语音输入'
    : !hasMediaDevices
      ? '当前浏览器不支持麦克风录音'
      : !canProcessAudio
        ? '当前浏览器不支持语音处理'
        : null

  const cleanup = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
    sourceRef.current?.disconnect()
    sourceRef.current = null
    captureNodeRef.current?.disconnect()
    captureNodeRef.current = null
    mutedOutputRef.current?.disconnect()
    mutedOutputRef.current = null
    if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') {
      audioCtxRef.current.close().catch(() => {})
    }
    audioCtxRef.current = null
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    readyRef.current = false
    setDurationSeconds(0)
    setPartialText('')
  }, [])

  const closeWs = useCallback(() => {
    const ws = wsRef.current
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      ws.close()
    }
    wsRef.current = null
  }, [])

  const stopRecording = useCallback((options?: { discardPartial?: boolean }) => {
    abortedRef.current = true
    if (options?.discardPartial) {
      ignoreFinalRef.current = true
      setPartialText('')
    }
    // Tell backend to finish the session
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) {
      const msg: ClientASRMessage = { type: 'session_finish' }
      ws.send(JSON.stringify(msg))
    }

    setIsRecording(false)

    // Cleanup audio resources but keep WS open for final result
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
    sourceRef.current?.disconnect()
    sourceRef.current = null
    captureNodeRef.current?.disconnect()
    captureNodeRef.current = null
    mutedOutputRef.current?.disconnect()
    mutedOutputRef.current = null
    if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') {
      audioCtxRef.current.close().catch(() => {})
    }
    audioCtxRef.current = null
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    readyRef.current = false
  }, [])

  const startRecording = useCallback(async () => {
    if (!isSupported) {
      onError(unsupportedReason || '您的浏览器不支持录音功能')
      return
    }

    ttsPlayer.stop()
    abortedRef.current = false
    ignoreFinalRef.current = false

    try {
      // 1. Get microphone
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      })
      if (abortedRef.current) { stream.getTracks().forEach((t) => t.stop()); return }
      streamRef.current = stream

      // Mark recording immediately so touchEnd can trigger stopRecording
      setIsRecording(true)
      setDurationSeconds(0)

      // 2. Open WebSocket
      const token = useStore.getState().token
      if (!token) {
        cleanup()
        setIsRecording(false)
        onError('请先登录')
        return
      }

      const ticketResp = await api.post<WsTicketResponse>('/chat/ws-ticket', { purpose: 'asr' })
      const ws = new WebSocket(`${getWsUrl()}?ticket=${encodeURIComponent(ticketResp.data.ticket)}`)
      wsRef.current = ws

      ws.onmessage = (event) => {
        try {
          const msg: ServerASRMessage = JSON.parse(event.data)
          switch (msg.type) {
            case 'ready':
              readyRef.current = true
              break
            case 'transcript_partial':
              if (!ignoreFinalRef.current) setPartialText(msg.text)
              break
            case 'transcript_final':
              if (!ignoreFinalRef.current) {
                callbacksRef.current.onTranscription(msg.text)
                setPartialText('')
              }
              break
            case 'done':
              setIsTranscribing(false)
              setPartialText('')
              closeWs()
              break
            case 'error':
              callbacksRef.current.onError(msg.message)
              setIsTranscribing(false)
              setPartialText('')
              cleanup()
              closeWs()
              break
            default:
              break
          }
        } catch { /* ignore malformed messages */ }
      }

      ws.onerror = () => {
        callbacksRef.current.onError('语音识别连接失败')
        setIsRecording(false)
        setIsTranscribing(false)
        cleanup()
        closeWs()
      }

      ws.onclose = (event) => {
        if (wsRef.current === ws) {
          setIsRecording(false)
          setIsTranscribing(false)
          cleanup()
          wsRef.current = null
        }
      }

      // 3. Set up audio capture
      const CurrentAudioContext = getAudioContextConstructor()
      if (!CurrentAudioContext) throw new Error('当前浏览器不支持语音处理')

      const audioCtx = new CurrentAudioContext()
      audioCtxRef.current = audioCtx
      // iOS Safari: getUserMedia await 导致后续 AudioContext 丢失用户手势上下文
      if (audioCtx.state === 'suspended') await audioCtx.resume()
      const sendAudioBuffer = (buffer: ArrayBuffer) => {
        if (!readyRef.current || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return
        const msg: ClientASRMessage = { type: 'audio_append', audio: arrayBufferToBase64(buffer) }
        wsRef.current.send(JSON.stringify(msg))
      }

      const source = audioCtx.createMediaStreamSource(stream)
      sourceRef.current = source

      if (typeof AudioWorkletNode !== 'undefined' && audioCtx.audioWorklet) {
        await audioCtx.audioWorklet.addModule(WORKLET_URL)

        // If stopRecording was called during await, bail out
        if (abortedRef.current) return

        const worklet = new AudioWorkletNode(audioCtx, 'pcm-capture-processor')
        captureNodeRef.current = worklet

        worklet.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
          sendAudioBuffer(e.data)
        }

        source.connect(worklet)
        worklet.connect(audioCtx.destination)
      } else if (isIOSWebKit() && audioCtx.createScriptProcessor) {
        const processor = audioCtx.createScriptProcessor(4096, 1, 1)
        const emitPcm = createScriptProcessorPcmEmitter(audioCtx.sampleRate, sendAudioBuffer)
        const mutedOutput = audioCtx.createGain()
        mutedOutput.gain.value = 0

        captureNodeRef.current = processor
        mutedOutputRef.current = mutedOutput

        processor.onaudioprocess = (event) => {
          if (abortedRef.current) return
          emitPcm(event.inputBuffer.getChannelData(0))
        }

        source.connect(processor)
        processor.connect(mutedOutput)
        mutedOutput.connect(audioCtx.destination)
      } else {
        throw new Error('当前浏览器不支持语音处理')
      }

      // 4. Start timer
      let seconds = 0
      timerRef.current = setInterval(() => {
        seconds++
        setDurationSeconds(seconds)
        if (seconds >= MAX_DURATION_S) {
          stopRecording()
        }
      }, 1000)
    } catch (err: any) {
      cleanup()
      closeWs()
      setIsRecording(false)
      if (err.name === 'NotAllowedError') {
        onError('请允许麦克风访问权限')
      } else if (err instanceof Error && err.message && err.message !== 'Unauthorized') {
        onError(err.message)
      } else {
        onError('无法启动录音')
      }
    }
  }, [isSupported, unsupportedReason, onError, cleanup, closeWs, stopRecording])

  const toggleRecording = useCallback(() => {
    if (isRecording) stopRecording()
    else startRecording()
  }, [isRecording, startRecording, stopRecording])

  // Cleanup on unmount
  useEffect(() => () => {
    cleanup()
    closeWs()
  }, [cleanup, closeWs])

  return {
    startRecording,
    stopRecording,
    toggleRecording,
    isRecording,
    isTranscribing,
    isSupported,
    unsupportedReason,
    durationSeconds,
    partialText,
  }
}
