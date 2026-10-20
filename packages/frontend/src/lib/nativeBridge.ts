export type NativeBridgeVersion = '1.0'

export interface NativeBridgeRequest<T = unknown> {
  id: string
  version: NativeBridgeVersion
  module: string
  method: string
  params?: T
}

export interface NativeBridgeResponse<T = unknown> {
  id: string
  ok: boolean
  data?: T
  error?: {
    code: string
    message: string
    detail?: unknown
  }
}

export interface NativeBridgeEvent<T = unknown> {
  module: string
  event: string
  data?: T
}

export interface NativeBridgeReadyInfo {
  platform?: string
  version?: string
  bridgeVersion?: string
  appVersion?: string | null
  versionCode?: string | number
  modules?: Record<string, string[]>
  installId?: string | null
  appSessionId?: string | null
  buildNumber?: string | number | null
  channel?: string | null
}

declare global {
  interface Window {
    CXNative?: {
      invoke?: (requestJson: string) => string | void
      call?: (requestJson: string) => string | void
    }
    __CXNativeBridge__?: {
      ready?: boolean
      info?: NativeBridgeReadyInfo
      emit?: (event: NativeBridgeEvent | string) => void
      resolve?: (response: NativeBridgeResponse | string) => void
    }
  }
}

type PendingCall = {
  resolve: (value: unknown) => void
  reject: (reason?: unknown) => void
  timer: number
}

const BRIDGE_VERSION: NativeBridgeVersion = '1.0'
const DEFAULT_TIMEOUT_MS = 8_000
const pendingCalls = new Map<string, PendingCall>()
let responseListenerInstalled = false

export function hasNativeBridge(): boolean {
  return typeof window !== 'undefined' &&
    (typeof window.CXNative?.invoke === 'function' || typeof window.CXNative?.call === 'function')
}

export function ensureNativeBridgeBootstrap(): void {
  if (typeof window === 'undefined') return

  window.__CXNativeBridge__ = window.__CXNativeBridge__ || {}

  if (typeof window.__CXNativeBridge__.emit !== 'function') {
    window.__CXNativeBridge__.emit = (event) => {
      const detail = typeof event === 'string' ? safeJsonParse(event) : event
      window.dispatchEvent(new CustomEvent('cx-native-event', { detail }))
    }
  }

  if (typeof window.__CXNativeBridge__.resolve !== 'function') {
    window.__CXNativeBridge__.resolve = (response) => {
      const detail = typeof response === 'string' ? safeJsonParse(response) : response
      window.dispatchEvent(new CustomEvent('cx-native-response', { detail }))
    }
  }

  if (!responseListenerInstalled) {
    window.addEventListener('cx-native-response', handleNativeResponse as EventListener)
    responseListenerInstalled = true
  }
}

export async function nativeCall<T = unknown>(
  module: string,
  method: string,
  params?: unknown,
  options?: { timeoutMs?: number },
): Promise<T> {
  ensureNativeBridgeBootstrap()

  if (!hasNativeBridge()) {
    throw bridgeError('NATIVE_BRIDGE_UNAVAILABLE', 'Native bridge is not available')
  }

  const request: NativeBridgeRequest = {
    id: createRequestId(),
    version: BRIDGE_VERSION,
    module,
    method,
    params,
  }

  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS

  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      pendingCalls.delete(request.id)
      reject(bridgeError('NATIVE_BRIDGE_TIMEOUT', `Native bridge timeout: ${module}.${method}`))
    }, timeoutMs)

    pendingCalls.set(request.id, {
      resolve: (value) => resolve(value as T),
      reject,
      timer,
    })

    try {
      const bridgeMethod = window.CXNative!.invoke ?? window.CXNative!.call
      const raw = bridgeMethod!.call(window.CXNative, JSON.stringify(request))
      if (typeof raw === 'string' && raw.trim()) {
        settleResponse(parseBridgeResponse(raw))
      }
      // If native returns void/null, wait for window.__CXNativeBridge__.resolve(...)
    } catch (err) {
      clearPending(request.id)
      reject(err)
    }
  })
}

export function getNativeReadyInfo(): NativeBridgeReadyInfo | null {
  if (typeof window === 'undefined') return null
  return window.__CXNativeBridge__?.info ?? null
}

function handleNativeResponse(event: CustomEvent<NativeBridgeResponse | string>) {
  const detail = typeof event.detail === 'string'
    ? parseBridgeResponse(event.detail)
    : event.detail
  settleResponse(detail)
}

function settleResponse(response: NativeBridgeResponse<unknown>) {
  const pending = pendingCalls.get(response.id)
  if (!pending) return

  window.clearTimeout(pending.timer)
  pendingCalls.delete(response.id)

  if (response.ok) {
    pending.resolve(response.data)
    return
  }

  pending.reject(bridgeError(
    response.error?.code || 'NATIVE_BRIDGE_ERROR',
    response.error?.message || 'Native bridge error',
    response.error?.detail,
  ))
}

function clearPending(id: string) {
  const pending = pendingCalls.get(id)
  if (!pending) return
  window.clearTimeout(pending.timer)
  pendingCalls.delete(id)
}

function parseBridgeResponse(raw: string): NativeBridgeResponse {
  const parsed = JSON.parse(raw) as NativeBridgeResponse
  if (!parsed || typeof parsed !== 'object') {
    throw bridgeError('BAD_NATIVE_RESPONSE', 'Bad native bridge response')
  }
  return parsed
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

function createRequestId(): string {
  const rand = Math.random().toString(36).slice(2)
  return `req_${Date.now()}_${rand}`
}

function bridgeError(code: string, message: string, detail?: unknown): Error & { code: string; detail?: unknown } {
  const err = new Error(message) as Error & { code: string; detail?: unknown }
  err.code = code
  err.detail = detail
  return err
}
