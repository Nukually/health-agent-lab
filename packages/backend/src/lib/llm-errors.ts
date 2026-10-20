/**
 * LLM 错误分类 — 将 SDK / 网络错误映射到语义化 error code
 *
 * 前端根据 code 渲染对应的文案 + 图标（见 @health-agent/shared ERROR_CODES）
 */

import { ERROR_CODES, type ErrorCode } from '@health-agent/shared'

export interface ClassifiedError {
  code: ErrorCode
  /** 用于日志，不直接暴露给用户 */
  debugMessage: string
}

/**
 * 根据错误对象推导语义化 error code
 *
 * 识别优先级：
 *   1. HTTP status code + 错误文本细分
 *   2. Node.js 网络错误码（ECONN*、ETIMEDOUT 等）
 *   3. 递归检查 err.cause
 *   4. fallback → UNKNOWN_ERROR
 */
export function classifyLLMError(err: unknown): ClassifiedError {
  const debugMessage = err instanceof Error ? err.message : String(err)

  const status = (err as any)?.status ?? (err as any)?.statusCode
  const message = typeof debugMessage === 'string' ? debugMessage.toLowerCase() : ''

  if (typeof status === 'number') {
    if (status === 400) {
      // 上下文超限：DashScope / OpenAI 兼容协议在 400 中返回 message 含 "context" / "maximum" / "token"
      if (
        message.includes('maximum context') ||
        message.includes('context length') ||
        message.includes('context_length') ||
        message.includes('prompt is too long') ||
        message.includes('range of input length') ||
        message.includes('too many tokens') ||
        (message.includes('token') && message.includes('limit'))
      ) {
        return { code: ERROR_CODES.CONTEXT_TOO_LONG, debugMessage }
      }
    }
    if (status === 429) {
      // 百炼 429 分两种：余额不足（quota）vs 频率超限（rate limit）
      if (message.includes('quota') || message.includes('billing') || message.includes('insufficient')) {
        return { code: ERROR_CODES.QUOTA_EXCEEDED, debugMessage }
      }
      return { code: ERROR_CODES.RATE_LIMITED, debugMessage }
    }
    if (status === 403) {
      const errType = (err as any)?.error?.type ?? (err as any)?.type ?? ''
      if (errType === 'exceeded_current_quota_error' || message.includes('quota')) {
        return { code: ERROR_CODES.QUOTA_EXCEEDED, debugMessage }
      }
    }
    if ([500, 502, 503, 504].includes(status)) {
      return { code: ERROR_CODES.SERVICE_UNAVAILABLE, debugMessage }
    }
    if (status === 408) {
      return { code: ERROR_CODES.NETWORK_ERROR, debugMessage }
    }
  }

  const netCode = (err as any)?.code
  if (typeof netCode === 'string') {
    if (['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN'].includes(netCode)) {
      return { code: ERROR_CODES.NETWORK_ERROR, debugMessage }
    }
  }

  if (err instanceof Error) {
    if (err.name === 'APIConnectionError' || err.name === 'APIConnectionTimeoutError') {
      return { code: ERROR_CODES.NETWORK_ERROR, debugMessage }
    }
    // watchdog 触发的 AbortError（空闲超时）
    if (err.name === 'AbortError' && message.includes('idle')) {
      return { code: ERROR_CODES.NETWORK_ERROR, debugMessage }
    }
  }

  const cause = (err as any)?.cause
  if (cause && cause !== err) {
    return classifyLLMError(cause)
  }

  return { code: ERROR_CODES.UNKNOWN_ERROR, debugMessage }
}
