/**
 * Session State — 每会话实例
 *
 * 参考 claude-code ch03: AppState 模式
 * - 每个聊天请求创建一个实例
 * - 管理当前会话的消息历史、token 计数、abort 控制
 * - updater function 模式修改状态
 */

import type { Logger } from '../lib/logger.js'
import { getContextWindowSize } from './process.js'

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string | Array<{ type: string; text?: string; image_url?: { url: string; detail?: 'low' | 'high' | 'auto' | 'original' } }>
  /** 仅内存用：tool role 对前端展示的结构化结果；不单独落库 */
  displayOutput?: unknown
  thinking?: string
  toolCalls?: unknown[]
  rawResponse?: unknown
  tokenCount?: number
  /** 本 assistant turn 聚合后的上游输入 token 数。 */
  llmInputTokens?: number
  /** 本 assistant turn 聚合后的上游 Context/KV Cache 命中输入 token 数。 */
  llmCachedInputTokens?: number
  /** 本 assistant turn 聚合后的上游缓存创建输入 token 数。 */
  llmCacheCreationInputTokens?: number
  toolCallId?: string
  processDurationMs?: number
  /** 输出 token per second，排除首 chunk 前等待时间；仅 assistant role 语义有效。 */
  outputTps?: number
  /** 该条消息是被用户手动中断的部分结果；仅 assistant role 语义有效 */
  interrupted?: boolean
  /** DB 行 id（仅内存用）：reminder 首次注入后回写 content，保证跨轮 prefix 稳定 */
  dbId?: string
  /** 仅内存/持久化辅助用：真实用户上传图片的资产 ID；图片本体不写入 messages.content。 */
  imageAssetIds?: string[]
  /** 仅内存用：按真实上传图片分组后的模型图片块；长图切片仍归属同一组。 */
  imageBlockGroups?: Array<{
    assetId?: string
    imageBlocks: Array<{ type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'auto' | 'original' } }>
  }>
  /** 仅内存用：本条消息来自真实用户原始输入，pre_model_call sanitization hook 可处理内部控制标记。 */
  untrustedInput?: boolean
}

export interface SessionState {
  sessionId: string
  userId: string
  messages: ChatMessage[]
  tokenCount: number
  summary: string | null
  abortController: AbortController
  logger: Logger
  /**
   * 本请求生命周期内是否已经触发过 reactive compact（被动压缩）。
   * 用于 agent loop 在 CONTEXT_TOO_LONG 时做一次性兜底重试，避免无限循环。
   */
  hasAttemptedReactiveCompact?: boolean
  /** 本次 chat 请求内额外发起的 LLM 请求数（API retry/fallback + 协议恢复重试）。 */
  llmRetryCount?: number
  /**
   * 压缩刚发生、下一次 LLM 调用预期 prefix 合理变化的原因。
   * 由 compact 路径设置，由 prefix-tracker 在下一轮检查时消费并清空。
   * 目的：把"压缩导致的 prefix 变化"标成黄灯而不是红灯告警。
   */
  prefixChangeExpected?: 'reactive' | 'proactive' | 'protocol_retry' | 'prompt_expired' | null
}

export function createSessionState(params: {
  sessionId: string
  userId: string
  logger: Logger
  existingMessages?: ChatMessage[]
  summary?: string | null
  tokenCount?: number
}): SessionState {
  const state: SessionState = {
    sessionId: params.sessionId,
    userId: params.userId,
    messages: params.existingMessages ?? [],
    tokenCount: params.tokenCount ?? 0,
    summary: params.summary ?? null,
    abortController: new AbortController(),
    logger: params.logger.child({ module: 'session', sessionId: params.sessionId }),
  }

  state.logger.info(
    { messageCount: state.messages.length, tokenCount: state.tokenCount },
    'session state created',
  )

  return state
}

// === Mutation helpers (updater pattern) ===

export function addMessage(state: SessionState, message: ChatMessage): void {
  state.messages.push(message)
  if (message.tokenCount) {
    state.tokenCount += message.tokenCount
  }

  state.logger.debug(
    { role: message.role, tokenCount: message.tokenCount, totalTokens: state.tokenCount },
    'message added to session',
  )
}

export function updateSummary(state: SessionState, summary: string): void {
  state.summary = summary
  state.logger.info('session summary updated')
}

export function abortSession(state: SessionState): void {
  if (state.abortController.signal.aborted) return
  state.abortController.abort()
  state.logger.info('session aborted')
}

export function needsCompression(state: SessionState): boolean {
  const threshold = Math.floor(getContextWindowSize() * 0.6)
  return state.tokenCount > threshold
}
