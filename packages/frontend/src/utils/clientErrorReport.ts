import { useStore } from '../stores/index.js'
import { hasNativeBridge } from '../lib/nativeBridge.js'

interface ReportClientErrorOptions {
  phase: string
  stackOverride?: string
}

/**
 * 前端异常上报：fire-and-forget POST /api/client-error
 *
 * 用于补足 React 渲染异常 / window.onerror / SSE reader 异常等客户端盲区。
 * 失败静默，不影响用户侧体验。
 */
export function reportClientError(
  err: unknown,
  options: ReportClientErrorOptions,
) {
  const token = useStore.getState().token

  const error = err instanceof Error
    ? err
    : new Error(typeof err === 'string' ? err : JSON.stringify(err))

  const diagnostic = {
    sessionId: useStore.getState().currentSessionId || undefined,
    errorName: error.name || 'Unknown',
    errorMessage: error.message || 'Unknown error',
    errorStack: (options.stackOverride ?? error.stack)?.slice(0, 2048),
    phase: options.phase,
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
    url: typeof window !== 'undefined' ? window.location.href : undefined,
    nativeBridgeAvailable: hasNativeBridge(),
  }

  // eslint-disable-next-line no-console
  console.error('Client error diagnostic:', diagnostic)

  if (!token) return
  fetch('/api/client-error', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(diagnostic),
    keepalive: true,
  }).catch(() => { /* 静默 */ })
}
