/**
 * Error codes shared between backend and frontend
 *
 * Backend classifies LLM / middleware errors into one of these codes,
 * frontend maps code → 可爱文案 + 图标
 */

export const ERROR_CODES = {
  RATE_LIMITED: 'RATE_LIMITED',
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  NETWORK_ERROR: 'NETWORK_ERROR',
  /** LLM 流式响应长时间无 chunk，后端 watchdog 主动终止 */
  LLM_STREAM_TIMEOUT: 'LLM_STREAM_TIMEOUT',
  USER_RATE_LIMITED: 'USER_RATE_LIMITED',
  /** 请求上下文超过模型窗口；loop 会尝试 reactive compact + 重试 1 次 */
  CONTEXT_TOO_LONG: 'CONTEXT_TOO_LONG',
  /** 输出因 max_tokens 被截断；不自动重试 */
  OUTPUT_TRUNCATED: 'OUTPUT_TRUNCATED',
  UNKNOWN_ERROR: 'UNKNOWN_ERROR',
} as const

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES]
