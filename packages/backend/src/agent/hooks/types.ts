/**
 * Hook 系统 — 类型定义
 *
 * 参考 claude-code 的 hook 机制，精简为 7 个事件。
 * 目标：剥离 loop.ts / executor.ts 里的横切关注点（打点、脱敏、合规提醒、审批路由），
 * 后续新增行为只加 hook，不动 core。
 *
 * 关键原则：
 * - 同进程 TypeScript 函数，零延迟、类型安全（不走 subprocess 协议）。
 * - 按注册顺序串行执行，避免改写冲突。
 * - 单个 hook throw 被隔离：记 error log 后继续执行剩余 hook；不影响主流程。
 */

import type { ChatMessage, SessionState } from '../../state/session.js'
import type { Logger } from '../../lib/logger.js'
import type { MedicalProfileData } from '@health-agent/shared'

export type HookEvent =
  | 'pre_model_call'
  | 'post_model_response'
  | 'pre_tool_use'
  | 'post_tool_use'
  | 'pre_compact'
  | 'post_compact'
  | 'message_end'

interface BaseContext {
  session: SessionState
  logger: Logger
}

// ─── pre_model_call ─────────────────────────────────────────────────
// 每轮 LLM 调用前触发。hook 可返回 reminders[]，由 loop 合并为
// <system-reminder> 块追加到最后一条 user 消息。
export interface PreModelCallContext extends BaseContext {
  iteration: number
  profileData?: MedicalProfileData | null
  /** 最近一条 user 消息；pre_model_call 的 sanitization hook 可在 reminder 注入前改写它。 */
  lastUserMessage?: ChatMessage
}
export interface PreModelCallResult {
  reminders?: string[]
  /** 改写最近一条 user 消息 content。调用方负责持久化，避免 prefix 漂移。 */
  rewriteLastUserContent?: ChatMessage['content']
}
export interface PreModelCallRunResult {
  reminders: string[]
  lastUserContentRewritten: boolean
}

// ─── post_model_response ────────────────────────────────────────────
// 每轮模型返回后、写入 session 前触发。用于拦截明显泄露内部协议/系统规则等输出。
export interface PostModelResponseContext extends BaseContext {
  iteration: number
  content: string
  thinking?: string
  stopReason: string
  toolCalls?: unknown[]
}
export interface PostModelResponseResult {
  deny?: {
    reason: string
    userMessage?: string
  }
}

// ─── pre_tool_use ───────────────────────────────────────────────────
// 工具执行前触发。hook 可拒绝（把 reason 作为 tool_result 回注给模型）
// 或改写 input（后续 hook 与 executor 看到改写后的 input）。
export interface PreToolUseContext extends BaseContext {
  iteration: number
  toolName: string
  toolCallId: string
  input: unknown
}
export interface PreToolUseResult {
  deny?: { reason: string }
  rewrite?: unknown
}

// ─── post_tool_use ──────────────────────────────────────────────────
// 工具执行后触发。仅观察，不能改 result。
export interface PostToolUseContext extends BaseContext {
  iteration: number
  toolName: string
  toolCallId: string
  input: unknown
  output: string
  durationMs: number
}

// ─── pre_compact / post_compact ─────────────────────────────────────
export interface PreCompactContext extends BaseContext {
  reason: 'proactive' | 'reactive'
}
export interface PostCompactContext extends BaseContext {
  reason: 'proactive' | 'reactive'
  messagesCompacted: number
  messagesRetained: number
}

// ─── message_end ────────────────────────────────────────────────────
// agent loop 结束（正常/异常/中断）时触发。供 trace summary 消费。
export interface IterationMetric {
  iter: number
  /** 首个 thinking/text delta；保留用于排查模型是否开始输出。 */
  ttftMs: number | null
  /** <final_answer> 后首个 text_delta；用户看到正式回答首字的 TTFT。 */
  finalAnswerTtftMs: number | null
  ttltMs: number | null
  tokensIn: number
  tokensOut: number
  /** 上游 Context/KV Cache 命中的输入 token 数。 */
  cachedTokens: number
  /** 上游显式缓存本次创建的输入 token 数。 */
  cacheCreationInputTokens: number
  /** 当前 iteration 产出的 <thinking> 内容估算 token 数，不含外层标签。 */
  thinkingTokens: number
  outputTps?: number | null
  toolCalls: Array<{ name: string; durationMs: number; ok: boolean }>
}
export interface LLMRetryMetric {
  reason: string
  retryAttempt: number
  loopCount: number
  source?: 'api' | 'protocol'
  provider?: string
  model?: string
  status?: number
  fallback?: boolean
}
export interface MessageEndContext extends BaseContext {
  totalIterations: number
  success: boolean
  interrupted?: boolean
  error?: unknown
  iterationMetrics?: IterationMetric[]
  llmRetryAttempts?: LLMRetryMetric[]
}

// Event → (context, result) 映射
export interface HookContexts {
  pre_model_call: PreModelCallContext
  post_model_response: PostModelResponseContext
  pre_tool_use: PreToolUseContext
  post_tool_use: PostToolUseContext
  pre_compact: PreCompactContext
  post_compact: PostCompactContext
  message_end: MessageEndContext
}
export interface HookResults {
  pre_model_call: PreModelCallResult | void
  post_model_response: PostModelResponseResult | void
  pre_tool_use: PreToolUseResult | void
  post_tool_use: void
  pre_compact: void
  post_compact: void
  message_end: void
}

export type HookHandler<E extends HookEvent> = (
  ctx: HookContexts[E],
) => HookResults[E] | Promise<HookResults[E]>
