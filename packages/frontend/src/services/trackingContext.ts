import { getNativeReadyInfo } from '../lib/nativeBridge.js'
import { createClientId } from '../utils/id.js'

const WEB_SESSION_ID = `ws_${createClientId('web-session')}`
const W3C_TRACE_ID_PATTERN = /^[0-9a-f]{32}$/
const W3C_SPAN_ID_PATTERN = /^[0-9a-f]{16}$/

export function getCurrentWebSessionId(): string {
  return WEB_SESSION_ID
}

function isAllZeroHex(value: string): boolean {
  return /^0+$/.test(value)
}

function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength)
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes)
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256)
    }
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function createNonZeroHex(byteLength: number): string {
  let value = randomHex(byteLength)
  while (isAllZeroHex(value)) {
    value = randomHex(byteLength)
  }
  return value
}

export function createTrackingTraceId(): string {
  return createNonZeroHex(16)
}

export function createTrackingSpanId(): string {
  return createNonZeroHex(8)
}

export function normalizeTrackingTraceId(traceId: string | null | undefined): string {
  const normalized = traceId?.trim().toLowerCase()
  if (normalized && W3C_TRACE_ID_PATTERN.test(normalized) && !isAllZeroHex(normalized)) {
    return normalized
  }
  return createTrackingTraceId()
}

export function createTraceparent(traceId: string, spanId = createTrackingSpanId()): string {
  const normalizedTraceId = normalizeTrackingTraceId(traceId)
  const normalizedSpanId = spanId.trim().toLowerCase()
  const safeSpanId = W3C_SPAN_ID_PATTERN.test(normalizedSpanId) && !isAllZeroHex(normalizedSpanId)
    ? normalizedSpanId
    : createTrackingSpanId()
  return `00-${normalizedTraceId}-${safeSpanId}-01`
}

export function getTrackingCommonContext() {
  const native = getNativeReadyInfo()
  return {
    installId: native?.installId ?? null,
    appSessionId: native?.appSessionId ?? null,
    webSessionId: WEB_SESSION_ID,
    route: typeof window === 'undefined' ? null : window.location.pathname || '/',
    platform: native?.platform ?? 'h5',
    appVersion: native?.appVersion ?? null,
    buildNumber: native?.buildNumber ?? null,
    channel: native?.channel ?? null,
  }
}

export function getTrackingContextHeaders(traceId = createTrackingTraceId()): Record<string, string> {
  const normalizedTraceId = normalizeTrackingTraceId(traceId)
  const common = getTrackingCommonContext()
  const headers: Record<string, string> = {
    'X-Web-Session-Id': common.webSessionId,
    'X-Tracking-Trace-Id': normalizedTraceId,
    traceparent: createTraceparent(normalizedTraceId),
  }
  if (common.installId) headers['X-Install-Id'] = common.installId
  if (common.appSessionId) headers['X-App-Session-Id'] = common.appSessionId
  return headers
}
