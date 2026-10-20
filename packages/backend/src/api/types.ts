/**
 * API Layer Types — Provider-agnostic interface
 *
 * 参考 claude-code ch04: 统一 LLM 接口
 * 当前只有智谱一个 provider，但接口设计支持后续切换
 */

import type { StreamEventType, ToolUiMeta } from '@health-agent/shared'
import type { LangfuseAgentTrace, LangfusePromptRef } from '../observability/langfuse.js'

export interface ChatParams {
  model: string
  system: string
  systemCachePrefixLength?: number
  messages: LLMMessage[]
  maxTokens?: number
  temperature?: number
  tools?: ToolDefinition[]
  signal?: AbortSignal
  enableThinking?: boolean
  langfuseTrace?: LangfuseAgentTrace
  langfusePrompt?: LangfusePromptRef | null
  langfuseMetadata?: Record<string, unknown>
}

export interface LLMMessage {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string | ContentBlock[]
  tool_call_id?: string
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'auto' | 'original' } }

export interface ToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
  /**
   * 前端展示相关元数据，供本地 UI / debug 使用。
   * 绝对不可序列化进发送给 LLM 的 tool schema。
   */
  uiMeta?: ToolUiMeta
  /**
   * 内部元数据 — 仅 harness 本地使用，绝对不可序列化进发送给 LLM 的 tool schema。
   * 发送前用 toLLMToolSchema() 剥离。
   */
  isReadOnly?: boolean
  /**
   * 给定解析后的工具 input，返回需要用户审批的字段名列表。
   * 返回 null 或空数组表示本次调用全部字段均可直接执行。
   * 仅供 executor 决定"走审批卡片"还是"直接落库"，不会影响 LLM 可见行为。
   */
  requiresApproval?: (input: unknown) => string[] | null
  /** 本地工具结果写回 LLM 上下文的最大字符数；超限由 executor/loop 截断或返回错误。 */
  maxResultSizeChars?: number
}

export interface LLMStreamEvent {
  type: StreamEventType
  data: string
}

export interface LLMUsage {
  inputTokens: number
  outputTokens: number
  totalTokens?: number
  promptTokensDetails?: Record<string, number>
  completionTokensDetails?: Record<string, number>
  /** 上游 Context Cache 命中的输入 token 数。 */
  cachedTokens?: number
  /** 上游显式缓存本次创建的输入 token 数。 */
  cacheCreationInputTokens?: number
}

export interface LLMUpstreamRetryAttempt {
  reason: string
  retryAttempt: number
  provider?: string
  model?: string
  status?: number
  fallback?: boolean
}

export interface LLMResponse {
  content: string
  thinking?: string
  toolCalls?: unknown[]
  usage: LLMUsage
  /** 输出 token per second，排除首 chunk 前等待时间。 */
  outputTps?: number
  stopReason: string
  rawResponse: unknown
  /** 是否检测到文本字面量 <final_answer>；tool_calls 轮次可为 false */
  finalAnswerDetected?: boolean
  /** 上游 API 层额外发起的 LLM 请求，例如 429/5xx retry 或 fallback。 */
  upstreamRetryAttempts?: LLMUpstreamRetryAttempt[]
  /** 客户端主动中断（AbortSignal）时置 true，content/thinking/toolCalls 可能不完整 */
  interrupted?: boolean
}
