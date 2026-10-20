/**
 * Agent Loop — 主循环 (async generator)
 *
 * 支持工具调用循环：LLM 调用 → 执行工具 → 追加 tool_result → 继续循环
 * 当前工具集合由 BASE_AGENT_TOOLS 提供；历史工具分支仅用于回放和兼容执行。
 */

import { queryModel } from '../api/client.js'
import type { SessionState, ChatMessage } from '../state/session.js'
import { addMessage } from '../state/session.js'
import type { LLMStreamEvent, LLMMessage, ContentBlock, LLMUpstreamRetryAttempt } from '../api/types.js'
import type { Logger } from '../lib/logger.js'
import type { MedicalProfileData } from '@health-agent/shared'
import { SSE_EVENTS, ERROR_CODES } from '@health-agent/shared'
import {
  BASE_AGENT_TOOLS,
  executeToolCall,
  shouldPauseForAskUserQuestion,
  toLLMToolSchema,
  type ToolCallInput,
  type ToolCallResult,
} from './tools/index.js'
import type { ToolDefinition } from '../api/types.js'
import type { AgentRequestContext } from './types.js'
import type { TrackingRequestContext } from '../services/tracking.js'
// reminder 注入策略（KV cache prefix 稳定原则）：
// - 每条 user 消息在"首次发送给 LLM 时"被注入 runtime context 并固化到 DB；
// - 下一轮加载该 user 时已自带 system-reminder，跳过注入；
// - 同请求内多 iteration 也共享首次注入后的结果，不会重复组装；
// - memory recall 是否固化由 MEMORY_ENABLE_PERSIST feature AB 控制；
// - 仅在 compaction 时 prefix 才允许变化。
import { updateMessageContent, saveMessage } from '../services/message.js'
import { applyReminderToContent, contentHasReminder, hasSystemReminder, stripSystemReminderText } from '../utils/system-reminder.js'
import {
  extractLatestRealUserMessageText,
  extractMessageTextContent,
  findLatestRealUserMessageIndex,
  isSyntheticToolAttachmentUserMessage,
  SYNTHETIC_TOOL_ATTACHMENT_MARKER,
} from '../utils/repeated-user-message.js'
import {
  getPendingSystemReminders,
  clearPendingSystemReminders,
} from '../services/pending-system-reminders.js'
import { estimateMessageTokens, estimateTextTokens } from '../utils/tokens.js'
import { getEnv } from '../env.js'
import { getClientToolInput, getClientToolOutput } from '../utils/tool-call-client.js'
import { buildMedicalDocumentSaveSuggestion } from '../services/medical-document-save-job.js'
import type { ResolvedClientEnvironment } from '../services/client-environment.js'
import {
  appendEphemeralContextsToLatestUser,
  prependContextsToUserContent,
  shouldAppendMemoryRecallEphemerally,
  shouldPersistMemoryRecallContext,
} from './ephemeral-context.js'

/**
 * 合成 user 消息（saved_content 工具读取病历原图）的识别标签。
 * 前端据此过滤气泡、历史回放据此打 synthetic 标记。
 * 放在 <system-reminder> body 首行，不影响 KV cache（固化后不再变）。
 */
export { SYNTHETIC_TOOL_ATTACHMENT_MARKER }
import {
  runPreModelCall,
  runPostModelResponse,
  runPreToolUse,
  runPostToolUse,
  runPreCompact,
  runPostCompact,
  runMessageEnd,
} from './hooks/index.js'
import type { IterationMetric, LLMRetryMetric } from './hooks/index.js'
import { reactiveCompact } from '../services/compact.js'
import { beforeLLMCall as prefixBeforeLLMCall, afterLLMCall as prefixAfterLLMCall } from '../services/prefix-tracker.js'
import type { SessionEvent } from '../services/session-events.js'
import {
  XmlToolCallDetector,
  XML_TOOL_CALL_VIOLATION_REASON,
  type XmlToolCallViolation,
} from './tools/xml-tool-detector.js'
import {
  contentHasTrustedReminder,
  hasUntrustedUserControlMarkers,
  neutralizeUntrustedUserContentPreservingTrustedReminder,
} from '../utils/untrusted-user-content.js'
import { sanitizeLLMPayloadMessages } from './llm-payload-sanitizer.js'
import {
  finishLangfuseTool,
  startLangfuseTool,
  type LangfuseAgentTrace,
  type LangfusePromptRef,
} from '../observability/langfuse.js'

export const MAX_TOOL_ITERATIONS = 99
const MAX_XML_TOOL_CALL_RETRY_ATTEMPTS = 1
const MAX_DUPLICATE_ANSWER_PREFIX_RETRY_ATTEMPTS = 1
const DANGLING_REFERENCE_REASON = 'dangling_reference' as const
const DUPLICATE_ANSWER_PREFIX_CHARS = 10
const SYSTEM_REMINDER_CLOSE_TAG = '</system-reminder>'
const XML_TOOL_CALL_PROTOCOL_CORRECTION_MARKER = '[protocol-correction:xml_tool_call_in_final_answer]'
const DUPLICATE_ANSWER_PREFIX_REASON = 'duplicate_answer_prefix' as const
const CONTEXT_TOO_LONG_REACTIVE_RETRY_REASON = 'context_too_long_reactive_compact' as const
const TOOL_ATTACHED_MEDICAL_IMAGE_READING_BOUNDARY = `病历原图解读边界：
- 涉及诊断时长、用药时长、治疗阶段、报告新旧、"最近/既往/术后多久"等时间判断时，必须和本轮上下文里的"当前时间(今天)"对比；不要使用模型内置日期，也不要只凭报告模板或上传时间推断。
- 图片里模糊、遮挡、反光、裁切不完整或手写体难以辨认的内容，要坦诚说明"这部分看不清/无法确认"，不要猜测、补全或把不确定内容说成事实；不影响回答的模糊内容可以省略。
- 若图片里有明显异常、少见或疑似录入错误的数字、单位、阳性/阴性或结论，必须按图片可见原文转述，并提醒用户和医生/报告出具方核对；不要擅自改成你认为正确或常见的值，也不要让回复与病历原文冲突。`

/**
 * 把完整的 reminder body 注入到最后一条 user 消息前，形成 <system-reminder> 块。
 * body 由调用方（runtime / debug）负责组装（时间、协议、session-events 增量等）。
 * body 为空字符串时不注入。
 * 幂等：last user 已带 <system-reminder> 块时原样返回，防重复组装。
 */
export function injectSystemReminder(
  messages: LLMMessage[],
  body: string,
): LLMMessage[] {
  if (!body) return messages

  let lastUserIdx = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      lastUserIdx = i
      break
    }
  }
  if (lastUserIdx === -1) return messages

  const original = messages[lastUserIdx]
  if (contentHasReminder(original.content as any)) return messages

  const reminder = `<system-reminder>\n${body}\n</system-reminder>\n\n`
  const result = [...messages]

  if (typeof original.content === 'string') {
    result[lastUserIdx] = { ...original, content: reminder + original.content }
  } else if (Array.isArray(original.content)) {
    const blocks = [...original.content] as ContentBlock[]
    const firstText = blocks.findIndex((b) => b.type === 'text')
    if (firstText >= 0) {
      const textBlock = blocks[firstText] as { type: 'text'; text: string }
      blocks[firstText] = { type: 'text', text: reminder + textBlock.text }
    } else {
      blocks.unshift({ type: 'text', text: reminder })
    }
    result[lastUserIdx] = { ...original, content: blocks }
  }

  return result
}

/** 过滤空串并按 \n\n 拼接为 <system-reminder> body */
export function buildReminderBody(parts: Array<string | null | undefined>): string {
  return parts.filter((s): s is string => typeof s === 'string' && s.length > 0).join('\n\n')
}

function prependReminderToContent(
  content: ChatMessage['content'],
  reminderBody: string,
): ChatMessage['content'] {
  const wrapper = `<system-reminder>\n${reminderBody}\n</system-reminder>\n\n`
  if (typeof content === 'string') return wrapper + content

  const blocks = [...content]
  const firstTextIdx = blocks.findIndex((b) => b.type === 'text')
  if (firstTextIdx >= 0) {
    const text = blocks[firstTextIdx].text ?? ''
    blocks[firstTextIdx] = { ...blocks[firstTextIdx], text: wrapper + text }
    return blocks
  }
  return [{ type: 'text', text: wrapper }, ...blocks]
}

function createAttemptSignal(parent: AbortSignal): {
  signal: AbortSignal
  abort: (reason?: unknown) => void
  cleanup: () => void
} {
  const controller = new AbortController()
  const onAbort = () => {
    if (!controller.signal.aborted) controller.abort(parent.reason)
  }

  if (parent.aborted) {
    controller.abort(parent.reason)
  } else {
    parent.addEventListener('abort', onAbort, { once: true })
  }

  return {
    signal: controller.signal,
    abort: (reason?: unknown) => {
      if (!controller.signal.aborted) controller.abort(reason)
    },
    cleanup: () => parent.removeEventListener('abort', onAbort),
  }
}

function parseTextDeltaContent(data: string): string {
  try {
    const parsed = JSON.parse(data) as { content?: unknown; text?: unknown }
    if (typeof parsed.content === 'string') return parsed.content
    if (typeof parsed.text === 'string') return parsed.text
  } catch {
    // keep fallback below
  }
  return ''
}

function buildXmlToolCallCorrectionReminder(toolName: string): string {
  return `${XML_TOOL_CALL_PROTOCOL_CORRECTION_MARKER}
上一轮模型回答用普通文本/XML/函数式标签形式输出了工具调用，违规工具名：${toolName}。
请重新处理用户本轮请求：如果确实需要使用 ${toolName}，必须先按照正确方式调用 ${toolName}（原生 tool call 通道），工具完成后再输出给用户看的正文；禁止在回答正文中手写 ${toolName}({...})、<tool>${toolName}(...)</tool>、<${toolName}>...</${toolName}>、<${toolName}(...)>、JSON 参数或任何工具 XML/HTML 文本。`
}

function normalizeAnswerPrefix(text: string): string {
  return text
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, '')
    .slice(0, DUPLICATE_ANSWER_PREFIX_CHARS)
}

function extractTextContent(content: ChatMessage['content']): string {
  return extractMessageTextContent(content)
}

function extractPreviousAssistantPrefix(session: SessionState): string | null {
  let lastRealUserIdx = session.messages.length
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const m = session.messages[i]
    if (m.role !== 'user') continue
    if (isSyntheticToolAttachmentUserMessage(m)) continue
    lastRealUserIdx = i
    break
  }

  for (let i = lastRealUserIdx - 1; i >= 0; i--) {
    const m = session.messages[i]
    if (m.role !== 'assistant') continue
    const prefix = normalizeAnswerPrefix(extractTextContent(m.content))
    if (prefix.length >= DUPLICATE_ANSWER_PREFIX_CHARS) return prefix
  }

  return null
}

function buildDuplicateAnswerPrefixCorrectionReminder(originalQuestion: string): string {
  return `[protocol-correction:duplicate_answer_prefix]
上一轮回答和本轮草稿的前 ${DUPLICATE_ANSWER_PREFIX_CHARS} 个可见字符完全相同，系统已撤回本轮草稿。
请重新完成用户本轮请求：严禁输出和上一轮相同或高度相似的开头/正文；每一轮回复都必须多样化，在确保医学准确、不编造新事实的前提下，调整表达、重点和结构。
必须回答用户本轮真实问题：
${originalQuestion}
如果仍需要使用工具，请先通过原生 tool call 调用对应工具；工具完成后再输出给用户看的完整中文答复。`
}

function extractLatestRealUserQuestion(session: SessionState): string {
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const m = session.messages[i]
    if (m.role !== 'user') continue

    if (isSyntheticToolAttachmentUserMessage(m)) continue

    const question = stripSystemReminderText(extractTextContent(m.content)).trim()
    if (question) return question
    if (Array.isArray(m.content) && m.content.some((b: any) => b?.type === 'image_url')) {
      return '（用户本轮包含图片，请结合图片内容回答用户问题）'
    }
  }

  return '（未能提取到用户原问题，请基于当前上下文完成上一轮未完成任务）'
}

function getToolInputCode(input: unknown): string | null {
  return input && typeof input === 'object' && 'code' in input && typeof (input as { code?: unknown }).code === 'string'
    ? (input as { code: string }).code.trim()
    : null
}

function getClientVisibleToolKey(toolName: string, input: unknown): string | null {
  if (toolName === 'generate_communication_card') return 'generate_communication_card'
  if (toolName === 'show_intervention_material') {
    const code = getToolInputCode(input)
    return code ? `show_intervention_material:${code}` : 'show_intervention_material'
  }
  return null
}

function isSingleTurnLimitedCardTool(toolName: string): boolean {
  return toolName === 'generate_communication_card' || toolName === 'show_intervention_material'
}

function buildSingleTurnToolLimitDenyReason(toolName: string): string {
  return `本工具单轮对话只能调用一次：${toolName} 已在本轮用户请求中执行过。后续调用不会生效，请直接基于第一次工具结果继续回复用户。`
}

function attachLLMRetryMetricsToRawResponse(
  rawResponse: unknown,
  attempts: LLMRetryMetric[],
): unknown {
  if (attempts.length === 0) return rawResponse
  const metrics = {
    llmRetryCount: attempts.length,
    llmRetryAttempts: attempts,
  }
  if (rawResponse && typeof rawResponse === 'object' && !Array.isArray(rawResponse)) {
    return {
      ...(rawResponse as Record<string, unknown>),
      ...metrics,
    }
  }
  return metrics
}

function attachAbsorbedToolPlanToRawResponse(
  rawResponse: unknown,
  toolName: string,
  thinking?: string,
): unknown {
  const base = rawResponse && typeof rawResponse === 'object' && !Array.isArray(rawResponse)
    ? rawResponse as Record<string, unknown>
    : {}
  return {
    ...base,
    rawAssistantContent: thinking ? `<thinking>\n${thinking}\n</thinking>` : '',
    absorbedToolPlan: { toolName },
  }
}

function toolResultCountsAsVisible(toolName: string, output: string): boolean {
  if (output.startsWith('错误') || output.startsWith('Error') || output.startsWith('工具执行失败')) return false
  if (toolName === 'show_intervention_material' && output.startsWith('未找到编号')) return false
  return toolName === 'generate_communication_card' || toolName === 'show_intervention_material'
}

const TOOL_RESULT_LIMIT_BY_NAME = new Map(
  BASE_AGENT_TOOLS.map((tool) => [tool.function.name, tool.maxResultSizeChars] as const),
)

function enforceToolResultBudget(result: ToolCallResult, logger: Logger): ToolCallResult {
  const maxChars = TOOL_RESULT_LIMIT_BY_NAME.get(result.name)
  if (!maxChars || result.output.length <= maxChars) return result

  const omittedChars = result.output.length - maxChars
  logger.warn(
    { tool: result.name, maxChars, outputChars: result.output.length, omittedChars },
    'tool result exceeded maxResultSizeChars; truncating LLM-visible output',
  )
  return {
    ...result,
    output: `${result.output.slice(0, maxChars)}\n\n[tool_result_truncated: 已截断 ${omittedChars} 字符，请基于以上可见内容回答；如信息不足，请让用户缩小范围或重新指定资料。]`,
  }
}

function appendReminderText(text: string, addition: string): string {
  const normalized = addition.trim()
  if (!normalized || text.includes(normalized)) return text

  if (hasSystemReminder(text)) {
    return text.replace(
      SYSTEM_REMINDER_CLOSE_TAG,
      `\n\n${normalized}\n${SYSTEM_REMINDER_CLOSE_TAG}`,
    )
  }

  return applyReminderToContent(text, normalized) as string
}

function appendCorrectionReminderToContent(
  content: ChatMessage['content'],
  addition: string,
): ChatMessage['content'] {
  if (typeof content === 'string') return appendReminderText(content, addition)

  const blocks = [...content]
  const firstTextIdx = blocks.findIndex((b) => b.type === 'text')
  if (firstTextIdx >= 0) {
    const text = blocks[firstTextIdx].text ?? ''
    blocks[firstTextIdx] = {
      ...blocks[firstTextIdx],
      text: appendReminderText(text, addition),
    }
    return blocks
  }

  return applyReminderToContent(blocks, addition) as ChatMessage['content']
}

async function persistXmlToolCallCorrectionReminder(
  session: SessionState,
  toolName: string,
  logger: Logger,
): Promise<void> {
  const lastUserIdx = findLatestRealUserMessageIndex(session.messages)
  if (lastUserIdx < 0) {
    throw new Error('no user message found for XML tool-call correction reminder')
  }

  const lastUser = session.messages[lastUserIdx]
  if (!lastUser.dbId) {
    throw new Error('last user message missing dbId; cannot persist XML tool-call correction reminder')
  }

  const reminder = buildXmlToolCallCorrectionReminder(toolName)
  lastUser.content = appendCorrectionReminderToContent(lastUser.content, reminder) as any
  const persistedContent = typeof lastUser.content === 'string'
    ? lastUser.content
    : JSON.stringify(lastUser.content)
  await updateMessageContent(lastUser.dbId, persistedContent, logger)
}

async function persistDuplicateAnswerPrefixCorrectionReminder(
  session: SessionState,
  logger: Logger,
): Promise<void> {
  const reminder = buildDuplicateAnswerPrefixCorrectionReminder(
    extractLatestRealUserQuestion(session),
  )
  const lastUserIdx = findLatestRealUserMessageIndex(session.messages)
  if (lastUserIdx < 0) {
    throw new Error('no user message found for duplicate-answer correction reminder')
  }

  const lastUser = session.messages[lastUserIdx]
  if (!lastUser.dbId) {
    throw new Error('last user message missing dbId; cannot persist duplicate-answer correction reminder')
  }

  lastUser.content = appendCorrectionReminderToContent(lastUser.content, reminder) as any
  const persistedContent = typeof lastUser.content === 'string'
    ? lastUser.content
    : JSON.stringify(lastUser.content)
  await updateMessageContent(lastUser.dbId, persistedContent, logger)
}

interface UserInfo {
  nickname?: string | null
  birthday?: string | null
  gender?: string | null
  currentConcern?: import('@health-agent/shared').CurrentConcern | null
}

export interface AgentContext {
  session: SessionState
  userInfo: UserInfo | null
  profileData: MedicalProfileData | null
  /** 已装配好的 system prompt（由 routes 层做 cache-first 装配） */
  systemPrompt: string
  /** Cx Agent long-term memory as a second system message, kept out of static system for KV cache. */
  userProfileSystemPrompt?: string | null
  /** system prompt 中可跨用户复用的静态前缀长度，用于百炼显式 Context Cache marker。 */
  systemCachePrefixLength?: number
  /** 旧版病历文档短 ID → UUID 映射；仍用于 session-events 和历史上下文兼容 */
  docIdMap: Map<string, string>
  /** 旧版医患沟通卡片短 ID → UUID 映射；仍用于 session-events 和历史上下文兼容 */
  communicationCardIdMap: Map<string, string>
  /** 本会话冻结的干预资料库编号 → materialId/version 映射 */
  interventionCodeMap: import('../services/intervention-material-runtime.js').InterventionRuntimeCatalogSnapshot['codeMap']
  /** 本轮请求开始时读取到的会话增量事件，用于工具幂等/去重硬保护 */
  sessionEvents?: SessionEvent[]
  /** 写入当前 user 的 reminder 片段；用于首次激活等一次性场景 */
  requestReminders?: string[]
  /** Hermes 风格的召回上下文；默认仅本轮临时附加，MEMORY_ENABLE_PERSIST 打开时会固化到当前 user message。 */
  memoryPrefetchContext?: string | null
  /** Feature AB：true 时召回固化到当前 user message；false 时召回只进本轮 payload。 */
  memoryEnablePersist?: boolean
  /** 当前聊天请求的客户端环境，用于提醒安装/通知权限等平台差异 */
  clientEnvironment: ResolvedClientEnvironment
  /** 渲染后的 session-events reminder 片段（可能为空串） */
  eventsReminder: string
  /** 已被用户拒绝的结构化字段集合 */
  rejectedFields: Set<string>
  /** 当前 HTTP 请求注入的埋点串联上下文，透传给工具内部后端埋点。 */
  trackingContext?: TrackingRequestContext
  /** 本轮实际开放给模型的工具集合，已按 feature profile 裁剪 */
  tools: readonly ToolDefinition[]
  /** Langfuse agent trace，由 route 创建并在请求结束时关闭；未启用时为 no-op。 */
  langfuseTrace?: LangfuseAgentTrace
  langfusePrompt?: LangfusePromptRef | null
  logger: Logger
}

export async function* agentLoop(ctx: AgentContext): AsyncGenerator<LLMStreamEvent> {
  const {
    session,
    logger,
    systemPrompt,
    userProfileSystemPrompt,
    docIdMap,
    communicationCardIdMap,
    eventsReminder,
    rejectedFields,
    tools,
    requestReminders = [],
    memoryPrefetchContext,
    memoryEnablePersist = false,
  } = ctx
  let loopCount = 0
  let loopError: unknown = null
  let loopInterrupted = false
  let xmlToolCallRetryAttempts = 0
  let duplicateAnswerPrefixRetryAttempts = 0
  // 协议重试会撤回首轮草稿；若首轮只有 thinking、最终重试只补正文，仍要把这段 thinking
  // 归并到最终 assistant，否则“已思考”气泡会丢失。
  const protocolRetryThinkingParts: string[] = []
  const iterationMetrics: IterationMetric[] = []
  const llmRetryAttempts: LLMRetryMetric[] = []
  let currentMetric: IterationMetric | null = null
  type LLMToolSchema = ReturnType<typeof toLLMToolSchema>
  const llmTools: LLMToolSchema[] = tools.map(toLLMToolSchema)
  const visibleToolKeysExecutedThisTurn = new Set<string>()
  const singleTurnLimitedCardToolsExecuted = new Set<string>()

  // 把当前 session.messages 映射成 LLM 格式，用于 prefix-tracker 在每轮结束后
  // 记录"本轮发出去的 + 本轮新 append 的 assistant/tool_result"作为下一轮对比基线
  const sessionToLLMMessages = (): LLMMessage[] =>
    session.messages.map((m) => {
      const contentForModel = m.role === 'user'
        ? neutralizeUntrustedUserContentPreservingTrustedReminder(m.content)
        : m.content
      const msg: LLMMessage = {
        role: m.role,
        content: typeof contentForModel === 'string' ? contentForModel : (contentForModel as any),
      }
      if (m.role === 'tool' && m.toolCallId) msg.tool_call_id = m.toolCallId
      if (m.role === 'assistant' && m.toolCalls?.length) {
        msg.tool_calls = m.toolCalls as LLMMessage['tool_calls']
      }
      return msg
    })
  const systemContextMessages = (): LLMMessage[] =>
    userProfileSystemPrompt?.trim()
      ? [{ role: 'system', content: userProfileSystemPrompt.trim() }]
      : []
  const sanitizePayloadMessages = (
    messages: LLMMessage[],
    phase: 'before_model_call' | 'after_model_call',
  ): LLMMessage[] => {
    const result = sanitizeLLMPayloadMessages(messages)
    if (!result.changed) return result.messages

    logger.warn(
      {
        sessionId: session.sessionId,
        loopCount,
        phase,
        ...result.stats,
      },
      'LLM payload messages sanitized before prefix tracking/model call',
    )
    return result.messages
  }

  const recordAfterLLMCall = (toolsForPayload: LLMToolSchema[]) => {
    const sanitizedSnapshot = sanitizePayloadMessages(
      [...systemContextMessages(), ...sessionToLLMMessages()],
      'after_model_call',
    )
    prefixAfterLLMCall(session, systemPrompt, sanitizedSnapshot, toolsForPayload, loopCount, logger)
  }

  const toolCtx: AgentRequestContext = {
    userId: session.userId,
    sessionId: session.sessionId,
    session,
    logger,
    docIdMap,
    communicationCardIdMap,
    interventionCodeMap: ctx.interventionCodeMap,
    userInfo: ctx.userInfo,
    profileData: ctx.profileData,
    clientEnvironment: ctx.clientEnvironment,
    rejectedFields,
    trackingContext: ctx.trackingContext,
  }
  const toolNames = tools.map((tool) => tool.function.name)
  const previousAssistantPrefix = extractPreviousAssistantPrefix(session)
  const pushLLMRetryAttempt = (attempt: LLMRetryMetric) => {
    llmRetryAttempts.push(attempt)
    session.llmRetryCount = llmRetryAttempts.length
  }
  const recordLLMRetryAttempt = (reason: string, retryAttempt: number) => {
    pushLLMRetryAttempt({ reason, retryAttempt, loopCount, source: 'protocol' })
  }
  const recordUpstreamRetryAttempts = (attempts?: LLMUpstreamRetryAttempt[]) => {
    for (const attempt of attempts ?? []) {
      if (!attempt?.reason) continue
      pushLLMRetryAttempt({
        reason: attempt.reason,
        retryAttempt: attempt.retryAttempt,
        loopCount,
        source: 'api',
        provider: attempt.provider,
        model: attempt.model,
        status: attempt.status,
        fallback: attempt.fallback,
      })
    }
  }

  try {
  while (true) {
    loopCount++
    logger.info({ loopCount, messageCount: session.messages.length }, 'agent loop iteration')

    // 每轮度量起点；若 compact 后重试本轮，会 pop 掉本次预占的 slot
    const iterStartTs = performance.now()
    currentMetric = {
      iter: loopCount,
      ttftMs: null,
      finalAnswerTtftMs: null,
      ttltMs: null,
      tokensIn: 0,
      tokensOut: 0,
      thinkingTokens: 0,
      cachedTokens: 0,
      cacheCreationInputTokens: 0,
      outputTps: null,
      toolCalls: [],
    }
    iterationMetrics.push(currentMetric)

    // Notify frontend of new iteration
    yield {
      type: SSE_EVENTS.ITERATION_START as any,
      data: JSON.stringify({ iteration: loopCount }),
    }

    if (loopCount > MAX_TOOL_ITERATIONS) {
      logger.warn({ loopCount }, 'agent loop exceeded max tool iterations, forcing exit')
      const fallback = '已尝试多轮工具调用，仍未能完成您的请求。请简化问题或稍后重试。'
      yield { type: SSE_EVENTS.TEXT_DELTA, data: JSON.stringify({ text: fallback }) }
      addMessage(session, { role: 'assistant', content: fallback })
      return
    }

    // ─── 首次注入 runtime context 到 last user 并固化到 DB ───────────────
    // guard：可信 reminder 已存在时跳过注入；用户伪造的 <system-reminder> 不算可信。
    let lastUserIdx = -1
    for (let i = session.messages.length - 1; i >= 0; i--) {
      if (session.messages[i].role === 'user') {
        lastUserIdx = i
        break
      }
    }
    if (lastUserIdx >= 0) {
      const lastUser = session.messages[lastUserIdx]
      const shouldRunPreModelHooks =
        lastUser.untrustedInput ||
        !contentHasTrustedReminder(lastUser.content) ||
        hasUntrustedUserControlMarkers(lastUser.content, { preserveTrustedReminder: true })
      if (shouldRunPreModelHooks) {
        const preModelResult = await runPreModelCall({
          session,
          logger,
          iteration: loopCount,
          profileData: ctx.profileData,
          lastUserMessage: lastUser,
        })
        lastUser.untrustedInput = false
        const hookReminders = preModelResult.reminders
        const pendingReminders = await getPendingSystemReminders(session.sessionId, logger)
        const alreadyHasTrustedReminder = contentHasTrustedReminder(lastUser.content)
        const reminderBody = alreadyHasTrustedReminder
          ? ''
          : buildReminderBody([
              ...requestReminders,
              ...hookReminders,
              ...pendingReminders,
              eventsReminder,
            ])
        let shouldPersistLastUserContent = preModelResult.lastUserContentRewritten
        if (reminderBody) {
          lastUser.content = prependReminderToContent(lastUser.content, reminderBody) as any
          shouldPersistLastUserContent = true
        }
        if (
          !alreadyHasTrustedReminder &&
          shouldPersistMemoryRecallContext(memoryEnablePersist) &&
          memoryPrefetchContext?.trim()
        ) {
          lastUser.content = prependContextsToUserContent(lastUser.content as any, [memoryPrefetchContext]) as any
          shouldPersistLastUserContent = true
        }
        if (shouldPersistLastUserContent) {
          if (!lastUser.dbId) {
            throw new Error('last user message missing dbId; cannot persist reminder-injected content')
          }
          const persistedContent = typeof lastUser.content === 'string'
            ? lastUser.content
            : JSON.stringify(lastUser.content)
          await updateMessageContent(lastUser.dbId, persistedContent, logger)
          if (pendingReminders.length > 0) {
            await clearPendingSystemReminders(session.sessionId, logger)
          }
        } else if (reminderBody && pendingReminders.length > 0) {
          await clearPendingSystemReminders(session.sessionId, logger)
        }
      }
    }

    // Convert session messages to LLM format.
    // Long-term user memory lives in a second system message. Recalled memory
    // follows Hermes-style prefetch semantics inside <system-reminder>, above
    // the real user question. MEMORY_ENABLE_PERSIST controls whether that
    // recalled block is persisted to the user message or only added to payload.
    const llmMessages: LLMMessage[] = sanitizePayloadMessages([
      ...systemContextMessages(),
      ...sessionToLLMMessages(),
    ], 'before_model_call')
    const llmMessagesForModel = shouldAppendMemoryRecallEphemerally(memoryEnablePersist)
      ? appendEphemeralContextsToLatestUser(llmMessages, [memoryPrefetchContext])
      : llmMessages
    const toolsForAttempt: LLMToolSchema[] = llmTools

    // Prefix 稳定性打点：fire-and-forget，与 LLM 网络请求并行算 hash（见 services/prefix-tracker.ts）
    prefixBeforeLLMCall(session, systemPrompt, llmMessages, toolsForAttempt, loopCount, logger)

    // Call queryModel async generator. 每次 LLM attempt 使用局部 AbortController；
    // 协议违规重试时只中止当前上游流，不中止整个用户请求。
    const attemptSignal = createAttemptSignal(session.abortController.signal)
    const gen = queryModel(
      {
        model: '',
        system: systemPrompt,
        systemCachePrefixLength: ctx.systemCachePrefixLength,
        messages: llmMessagesForModel,
        signal: attemptSignal.signal,
        tools: toolsForAttempt,
        enableThinking: getEnv().LLM_ENABLE_THINKING,
        langfuseTrace: ctx.langfuseTrace,
        langfusePrompt: ctx.langfusePrompt,
        langfuseMetadata: {
          sessionId: session.sessionId,
          userId: session.userId,
          loopCount,
        },
      },
      logger,
    )

    let response: Awaited<ReturnType<typeof gen.next>>
    let suppressedContextTooLong: LLMStreamEvent | null = null
    let answerStartedForAttempt = false
    let xmlToolCallViolation: XmlToolCallViolation | null = null
    let duplicateAnswerPrefixViolation = false
    let duplicateAnswerPrefixAllowedAfterBudget = false
    let discardedContentChars = 0
    let answerPrefixProbe = ''
    const xmlToolCallDetector = new XmlToolCallDetector(toolNames)
    try {
      do {
        response = await gen.next()
        if (!response.done && response.value) {
          // duplicate prefix 仍然需要局部 abort；工具名泄漏则先吸收可见文本，
          // 继续等待同一 attempt 是否会正常进入原生 tool_call。
          if (duplicateAnswerPrefixViolation) continue
          if (xmlToolCallViolation) {
            if (response.value.type === SSE_EVENTS.TEXT_DELTA) {
              const textDelta = parseTextDeltaContent(response.value.data)
              discardedContentChars += textDelta?.length ?? 0
              continue
            }
            if (response.value.type !== SSE_EVENTS.TOOL_CALL_START) continue
          }

          if (response.value.type === SSE_EVENTS.ANSWER_START) {
            answerStartedForAttempt = true
          }

          if (response.value.type === SSE_EVENTS.TEXT_DELTA) {
            const textDelta = parseTextDeltaContent(response.value.data)
            if (textDelta) {
              discardedContentChars += textDelta.length
              const violation = xmlToolCallDetector.push(textDelta)
              if (violation) {
                xmlToolCallViolation = violation
                const retryAttempt = xmlToolCallRetryAttempts + 1
                logger.warn(
                  {
                    sessionId: session.sessionId,
                    loopCount,
                    toolName: violation.toolName,
                    retryAttempt,
                    reason: violation.reason,
                    discardedContentChars,
                  },
                  'LLM emitted tool name as visible text; absorbing as tool plan',
                )
                yield {
                  type: SSE_EVENTS.ASSISTANT_OUTPUT_RETRACTED as any,
                  data: JSON.stringify({
                    reason: XML_TOOL_CALL_VIOLATION_REASON,
                    toolName: violation.toolName,
                    displayAsToolPlan: true,
                    retryAttempt,
                  }),
                }
                continue
              }

              if (answerStartedForAttempt && previousAssistantPrefix && answerPrefixProbe.length < 200) {
                answerPrefixProbe += textDelta
                const currentPrefix = normalizeAnswerPrefix(answerPrefixProbe)
                if (
                  currentPrefix.length >= DUPLICATE_ANSWER_PREFIX_CHARS &&
                  currentPrefix === previousAssistantPrefix
                ) {
                  const retryAttempt = duplicateAnswerPrefixRetryAttempts + 1
                  if (duplicateAnswerPrefixRetryAttempts >= MAX_DUPLICATE_ANSWER_PREFIX_RETRY_ATTEMPTS) {
                    if (!duplicateAnswerPrefixAllowedAfterBudget) {
                      duplicateAnswerPrefixAllowedAfterBudget = true
                      logger.warn(
                        {
                          sessionId: session.sessionId,
                          loopCount,
                          retryAttempt,
                          reason: DUPLICATE_ANSWER_PREFIX_REASON,
                          prefixChars: DUPLICATE_ANSWER_PREFIX_CHARS,
                        },
                        'LLM answer prefix still duplicated previous assistant; retry budget exhausted, allowing output',
                      )
                    }
                  } else {
                    duplicateAnswerPrefixViolation = true
                    logger.warn(
                      {
                        sessionId: session.sessionId,
                        loopCount,
                        retryAttempt,
                        reason: DUPLICATE_ANSWER_PREFIX_REASON,
                        prefixChars: DUPLICATE_ANSWER_PREFIX_CHARS,
                      },
                      'LLM answer prefix duplicated previous assistant; retracting attempt',
                    )
                    yield {
                      type: SSE_EVENTS.ASSISTANT_OUTPUT_RETRACTED as any,
                      data: JSON.stringify({
                        reason: DUPLICATE_ANSWER_PREFIX_REASON,
                        retryAttempt,
                      }),
                    }
                    attemptSignal.abort(DUPLICATE_ANSWER_PREFIX_REASON)
                    continue
                  }
                }
              }
            }
          }

          // 拦截 CONTEXT_TOO_LONG：暂不转发给客户端，留到 gen 结束后决定重试或透传
          if (response.value.type === SSE_EVENTS.ERROR) {
            let code: string | undefined
            let sanitizedErrorEvent = response.value
            try {
              const payload = JSON.parse(response.value.data as string)
              code = payload?.code
              if (Array.isArray(payload?.upstreamRetryAttempts)) {
                recordUpstreamRetryAttempts(payload.upstreamRetryAttempts)
                delete payload.upstreamRetryAttempts
                sanitizedErrorEvent = {
                  ...response.value,
                  data: JSON.stringify(payload),
                }
                response.value = sanitizedErrorEvent
              }
            } catch {}
            if (code === ERROR_CODES.CONTEXT_TOO_LONG) {
              suppressedContextTooLong = sanitizedErrorEvent
              continue
            }
          }
          // Per-iteration TTFT/TTLT：ttftMs 以首个流式 token（thinking 或正文）为准，
          // finalAnswerTtftMs 只以用户可见正文为准。
          const t = response.value.type
          if (
            (t === SSE_EVENTS.THINKING_DELTA || t === SSE_EVENTS.TEXT_DELTA) &&
            currentMetric
          ) {
            const now = performance.now() - iterStartTs
            if (currentMetric.ttftMs === null) currentMetric.ttftMs = Math.round(now)
            if (
              t === SSE_EVENTS.TEXT_DELTA &&
              answerStartedForAttempt &&
              currentMetric.finalAnswerTtftMs === null
            ) {
              currentMetric.finalAnswerTtftMs = Math.round(now)
            }
            currentMetric.ttltMs = Math.round(now)
          }
          yield response.value
        }
      } while (!response.done)
    } finally {
      attemptSignal.cleanup()
    }

    const llmResponse = response.value
    recordUpstreamRetryAttempts(llmResponse?.upstreamRetryAttempts)

    // ─── 协议兜底：正文内工具名泄漏 → 优先吸收为工具规划；无原生 tool_call 才重试 ───
    if (xmlToolCallViolation) {
      const recoveredWithNativeToolCall =
        llmResponse?.stopReason === 'tool_calls' &&
        Array.isArray(llmResponse.toolCalls) &&
        llmResponse.toolCalls.length > 0

      if (recoveredWithNativeToolCall) {
        logger.info(
          {
            sessionId: session.sessionId,
            loopCount,
            toolName: xmlToolCallViolation.toolName,
            discardedContentChars,
          },
          'absorbed visible tool plan before native tool call',
        )
      } else {
        iterationMetrics.pop()

        if (session.abortController.signal.aborted) {
          loopInterrupted = true
          return
        }

        yield {
          type: SSE_EVENTS.ASSISTANT_OUTPUT_RETRACTED as any,
          data: JSON.stringify({
            reason: XML_TOOL_CALL_VIOLATION_REASON,
            toolName: xmlToolCallViolation.toolName,
            clearTransientToolPlan: true,
            retryAttempt: xmlToolCallRetryAttempts + 1,
          }),
        }

        if (xmlToolCallRetryAttempts < MAX_XML_TOOL_CALL_RETRY_ATTEMPTS) {
          xmlToolCallRetryAttempts++
          try {
            await persistXmlToolCallCorrectionReminder(
              session,
              xmlToolCallViolation.toolName,
              logger,
            )
          } catch (err) {
            loopError = err
            logger.error(
              {
                err,
                sessionId: session.sessionId,
                loopCount,
                toolName: xmlToolCallViolation.toolName,
                reason: XML_TOOL_CALL_VIOLATION_REASON,
              },
              'failed to persist XML tool-call correction reminder',
            )
            yield {
              type: SSE_EVENTS.ERROR,
              data: JSON.stringify({
                message: '模型输出格式异常，请重试',
                code: ERROR_CODES.UNKNOWN_ERROR,
              }),
            }
            return
          }

          // 撤回首轮草稿前，把已产生的 thinking 留存，重试只补正文时仍能展示“已思考”。
          const retryThinking = llmResponse?.thinking
          if (retryThinking?.trim() && !protocolRetryThinkingParts.includes(retryThinking)) {
            protocolRetryThinkingParts.push(retryThinking)
          }

          session.prefixChangeExpected = 'protocol_retry'
          recordLLMRetryAttempt(XML_TOOL_CALL_VIOLATION_REASON, xmlToolCallRetryAttempts)
          logger.info(
            {
              sessionId: session.sessionId,
              loopCount,
              toolName: xmlToolCallViolation.toolName,
              retryAttempt: xmlToolCallRetryAttempts,
              reason: XML_TOOL_CALL_VIOLATION_REASON,
            },
            'retrying LLM request after XML tool-call protocol violation',
          )
          loopCount--
          continue
        }

        loopError = new Error(XML_TOOL_CALL_VIOLATION_REASON)
        logger.error(
          {
            sessionId: session.sessionId,
            loopCount,
            toolName: xmlToolCallViolation.toolName,
            retryAttempt: xmlToolCallRetryAttempts + 1,
            reason: XML_TOOL_CALL_VIOLATION_REASON,
            discardedContentChars,
          },
          'LLM repeated XML-style tool call as visible text; giving up',
        )
        yield {
          type: SSE_EVENTS.ERROR,
          data: JSON.stringify({
            message: '模型输出格式异常，请重试',
            code: ERROR_CODES.UNKNOWN_ERROR,
          }),
        }
        return
      }
    }

    // ─── 协议兜底：本轮答案开头与上一轮重复 → 撤回草稿 + 注入多样化提醒重试一次 ───
    if (duplicateAnswerPrefixViolation) {
      iterationMetrics.pop()

      if (session.abortController.signal.aborted) {
        loopInterrupted = true
        return
      }

      if (duplicateAnswerPrefixRetryAttempts < MAX_DUPLICATE_ANSWER_PREFIX_RETRY_ATTEMPTS) {
        duplicateAnswerPrefixRetryAttempts++
        try {
          await persistDuplicateAnswerPrefixCorrectionReminder(session, logger)
        } catch (err) {
          loopError = err
          logger.error(
            {
              err,
              sessionId: session.sessionId,
              loopCount,
              reason: DUPLICATE_ANSWER_PREFIX_REASON,
            },
            'failed to persist duplicate-answer correction reminder',
          )
          yield {
            type: SSE_EVENTS.ERROR,
            data: JSON.stringify({
              message: '模型输出格式异常，请重试',
              code: ERROR_CODES.UNKNOWN_ERROR,
            }),
          }
          return
        }

        session.prefixChangeExpected = 'protocol_retry'
        recordLLMRetryAttempt(DUPLICATE_ANSWER_PREFIX_REASON, duplicateAnswerPrefixRetryAttempts)
        logger.info(
          {
            sessionId: session.sessionId,
            loopCount,
            retryAttempt: duplicateAnswerPrefixRetryAttempts,
            reason: DUPLICATE_ANSWER_PREFIX_REASON,
          },
          'retrying LLM request after duplicate answer prefix',
        )
        loopCount--
        continue
      }

      loopError = new Error(DUPLICATE_ANSWER_PREFIX_REASON)
      logger.error(
        {
          sessionId: session.sessionId,
          loopCount,
          retryAttempt: duplicateAnswerPrefixRetryAttempts + 1,
          reason: DUPLICATE_ANSWER_PREFIX_REASON,
        },
        'LLM repeated duplicate answer prefix; giving up',
      )
      yield {
        type: SSE_EVENTS.ERROR,
        data: JSON.stringify({
          message: '模型输出格式异常，请重试',
          code: ERROR_CODES.UNKNOWN_ERROR,
        }),
      }
      return
    }

    // ─── 兜底恢复：CONTEXT_TOO_LONG → reactive compact + 重试一次 ───
    if (suppressedContextTooLong) {
      if (session.hasAttemptedReactiveCompact) {
        logger.error(
          { loopCount, sessionId: session.sessionId },
          'reactive compact already attempted, surfacing CONTEXT_TOO_LONG error',
        )
        yield suppressedContextTooLong
        return
      }
      session.hasAttemptedReactiveCompact = true
      logger.warn(
        { loopCount, sessionId: session.sessionId },
        'prompt_too_long → reactive_compact → retry',
      )
      // 本次 iteration 作废（重试会重新预占 slot）
      iterationMetrics.pop()
      yield { type: SSE_EVENTS.COMPACTION_START, data: '{}' }
      try {
        await runPreCompact({ session, logger, reason: 'reactive' })
        const result = await reactiveCompact(session, logger)
        // 告知 prefix-tracker：下一轮 prefix 合理变化，标黄灯而不是红灯告警
        session.prefixChangeExpected = 'reactive'
        await runPostCompact({
          session,
          logger,
          reason: 'reactive',
          messagesCompacted: result.messagesCompacted ?? 0,
          messagesRetained: result.messagesRetained ?? 0,
        })
        yield {
          type: SSE_EVENTS.COMPACTION_END,
          data: JSON.stringify({
            messagesCompacted: result.messagesCompacted ?? 0,
            messagesRetained: result.messagesRetained ?? 0,
          }),
        }
        recordLLMRetryAttempt(CONTEXT_TOO_LONG_REACTIVE_RETRY_REASON, 1)
        // 重试当前 iteration：回退计数器，continue 外层 while
        loopCount--
        continue
      } catch (err) {
        logger.error({ err, loopCount }, 'reactive compact failed, surfacing error')
        yield {
          type: SSE_EVENTS.COMPACTION_END,
          data: JSON.stringify({ messagesCompacted: 0, messagesRetained: 0 }),
        }
        yield suppressedContextTooLong
        return
      }
    }

    if (!llmResponse) {
      const lastMsg = session.messages[session.messages.length - 1]
      logger.error(
        {
          loopCount,
          messageCount: session.messages.length,
          lastMessageRole: lastMsg?.role,
          sessionId: session.sessionId,
        },
        'agent loop aborted: LLM returned no response',
      )
      return
    }

    // 若本轮经历过协议重试，把被撤回草稿里的 thinking 与最终 thinking 归并，避免“已思考”气泡丢失。
    const combinedThinking = [
      ...protocolRetryThinkingParts,
      llmResponse.thinking,
    ]
      .filter((part): part is string => !!part && part.trim().length > 0)
      .join('\n\n') || undefined

    const absorbedToolPlanName =
      xmlToolCallViolation && llmResponse.stopReason === 'tool_calls'
        ? xmlToolCallViolation.toolName
        : null
    const assistantContent = absorbedToolPlanName ? '' : llmResponse.content
    const assistantRawResponse = absorbedToolPlanName
      ? attachAbsorbedToolPlanToRawResponse(llmResponse.rawResponse, absorbedToolPlanName, combinedThinking)
      : llmResponse.rawResponse

    if (
      !llmResponse.interrupted &&
      llmResponse.stopReason !== 'tool_calls' &&
      llmResponse.stopReason !== 'length'
    ) {
      const postModel = await runPostModelResponse({
        session,
        logger,
        iteration: loopCount,
        content: assistantContent,
        stopReason: llmResponse.stopReason,
        toolCalls: llmResponse.toolCalls,
      })
      if (postModel.deny) {
        loopError = new Error(postModel.deny.reason)
        yield {
          type: SSE_EVENTS.ASSISTANT_OUTPUT_RETRACTED as any,
          data: JSON.stringify({
            reason: postModel.deny.reason,
            retryAttempt: 0,
          }),
        }
        yield {
          type: SSE_EVENTS.ERROR,
          data: JSON.stringify({
            message: postModel.deny.userMessage ?? '模型输出被安全策略拦截，请重试',
            code: ERROR_CODES.UNKNOWN_ERROR,
          }),
        }
        recordAfterLLMCall(toolsForAttempt)
        return
      }
    }

    // Add assistant message to session state
    const assistantMessage: ChatMessage = {
      role: 'assistant',
      content: assistantContent,
      thinking: combinedThinking,
      toolCalls: llmResponse.toolCalls,
      rawResponse: attachLLMRetryMetricsToRawResponse(assistantRawResponse, llmRetryAttempts),
      tokenCount: llmResponse.usage.inputTokens + llmResponse.usage.outputTokens,
      llmInputTokens: llmResponse.usage.inputTokens,
      llmCachedInputTokens: llmResponse.usage.cachedTokens ?? 0,
      llmCacheCreationInputTokens: llmResponse.usage.cacheCreationInputTokens ?? 0,
      outputTps: llmResponse.outputTps,
    }
    addMessage(session, assistantMessage)

    if (currentMetric) {
      currentMetric.tokensIn = llmResponse.usage?.inputTokens ?? 0
      currentMetric.tokensOut = llmResponse.usage?.outputTokens ?? 0
      currentMetric.thinkingTokens = combinedThinking ? estimateTextTokens(combinedThinking) : 0
      currentMetric.cachedTokens = llmResponse.usage?.cachedTokens ?? 0
      currentMetric.cacheCreationInputTokens = llmResponse.usage?.cacheCreationInputTokens ?? 0
      currentMetric.outputTps = llmResponse.outputTps ?? null
    }
    protocolRetryThinkingParts.length = 0

    // 客户端中断：即使 stopReason=tool_calls 也不执行工具（args 可能不完整、或用户就是不想继续）
    // routes/chat.ts 聚合时会裁剪未配对的 tool_calls，保证下一轮 LLM 上下文自洽
    if (llmResponse.interrupted) {
      logger.info({ loopCount }, 'agent loop interrupted by client')
      loopInterrupted = true
      return
    }

    // 输出被 max_tokens 截断：医疗场景不自动续写，发 error 让用户自行决定
    if (llmResponse.stopReason === 'length') {
      logger.warn(
        { loopCount, outputTokens: llmResponse.usage?.outputTokens },
        'output truncated by max_tokens',
      )
      yield {
        type: SSE_EVENTS.ERROR,
        data: JSON.stringify({
          message: 'output truncated by max_tokens',
          code: ERROR_CODES.OUTPUT_TRUNCATED,
        }),
      }
      recordAfterLLMCall(toolsForAttempt)
      return
    }

    // Non-tool-call: loop exits
    if (llmResponse.stopReason !== 'tool_calls') {
      logger.info({ loopCount, totalTokens: session.tokenCount }, 'agent loop completed')
      recordAfterLLMCall(toolsForAttempt)
      return
    }

    // ─── Tool execution ─────────────────────────────────────────────
    const toolCalls = llmResponse.toolCalls as Array<{
      id: string
      function: { name: string; arguments: string }
    }> | undefined

    if (!toolCalls?.length) {
      logger.warn({ loopCount }, 'stop_reason=tool_calls but no tool calls found')
      recordAfterLLMCall(toolsForAttempt)
      return
    }

    let shouldPauseForUserQuestion = false

    for (const tc of toolCalls) {
      const toolInput: ToolCallInput = {
        id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
      }

      // 解析 input（失败则保持 null）
      let parsedInput: unknown = null
      try { parsedInput = JSON.parse(toolInput.arguments) } catch {}
      const langfuseTool = startLangfuseTool(ctx.langfuseTrace?.root, {
        name: `tool.${toolInput.name}`,
        input: parsedInput,
        metadata: {
          sessionId: session.sessionId,
          userId: session.userId,
          loopCount,
          toolCallId: toolInput.id,
          toolName: toolInput.name,
        },
      })

      const visibleToolKey = getClientVisibleToolKey(toolInput.name, parsedInput)
      let localDenyReason: string | null = null
      if (
        isSingleTurnLimitedCardTool(toolInput.name) &&
        singleTurnLimitedCardToolsExecuted.has(toolInput.name)
      ) {
        localDenyReason = buildSingleTurnToolLimitDenyReason(toolInput.name)
      } else if (visibleToolKey && visibleToolKeysExecutedThisTurn.has(visibleToolKey)) {
        localDenyReason = '本轮已经展示过相同的用户可见卡片/资料；不要重复生成，请直接用文字说明前面的卡片已经生成，并引导用户编辑、保存或补充信息。'
      }

      // pre_tool_use hook：可 deny（把 reason 当 tool_result 回注）或 rewrite（替换 input）
      const preResult = localDenyReason
        ? { deny: { reason: localDenyReason } }
        : await runPreToolUse({
            session,
            logger,
            iteration: loopCount,
            toolName: toolInput.name,
            toolCallId: toolInput.id,
            input: parsedInput,
          })

      if (preResult.deny) {
        if (localDenyReason) {
          logger.info(
            { tool: toolInput.name, toolCallId: toolInput.id, reason: localDenyReason },
            'tool denied by local idempotency policy',
          )
        }
        const denyOutput = `工具调用被策略拦截：${preResult.deny.reason}`
        yield {
          type: SSE_EVENTS.TOOL_CALL_START as any,
          data: JSON.stringify({
            toolCallId: toolInput.id,
            name: toolInput.name,
          }),
        }
        yield {
          type: SSE_EVENTS.TOOL_CALL_END as any,
          data: JSON.stringify({
            toolCallId: toolInput.id,
            name: toolInput.name,
            output: null,
            durationMs: 0,
          }),
        }
        addMessage(session, {
          role: 'tool',
          content: denyOutput,
          toolCallId: toolInput.id,
        })
        currentMetric?.toolCalls.push({ name: toolInput.name, durationMs: 0, ok: false })
        finishLangfuseTool(langfuseTool, {
          output: denyOutput,
          metadata: {
            denied: true,
            reason: preResult.deny.reason,
            durationMs: 0,
          },
        })
        continue
      }

      // 应用 rewrite（如果 hook 改了 input，则 executor 读到最新值）
      if (preResult.rewrite !== undefined && preResult.rewrite !== parsedInput) {
        parsedInput = preResult.rewrite
        try {
          toolInput.arguments = JSON.stringify(preResult.rewrite)
        } catch (err) {
          logger.error({ err, tool: toolInput.name }, 'pre_tool_use rewrite failed to serialize')
        }
      }

      if (isSingleTurnLimitedCardTool(toolInput.name)) {
        singleTurnLimitedCardToolsExecuted.add(toolInput.name)
      }

      // Yield tool_call_start SSE event
      yield {
        type: SSE_EVENTS.TOOL_CALL_START as any,
        data: JSON.stringify({
          toolCallId: toolInput.id,
          name: toolInput.name,
          input: getClientToolInput(toolInput.name, parsedInput),
        }),
      }

      if (toolInput.name === 'medical_report_consultation_board') {
        const suggestion = buildMedicalDocumentSaveSuggestion(session, toolInput.id)
        if (suggestion) {
          yield {
            type: SSE_EVENTS.MEDICAL_DOCUMENT_SAVE_SUGGESTION as any,
            data: JSON.stringify(suggestion),
          }
        }
      }

      // Execute the tool
      let result = await executeToolCall(toolInput, toolCtx)
      result = enforceToolResultBudget(result, logger)
      const toolOk = !result.output.startsWith('错误') && !result.output.startsWith('Error')
      currentMetric?.toolCalls.push({
        name: result.name,
        durationMs: result.durationMs,
        ok: toolOk,
      })
      finishLangfuseTool(langfuseTool, {
        output: result.displayOutput ?? result.output,
        metadata: {
          durationMs: result.durationMs,
          ok: toolOk,
          approvalCount: result.approvalPayloads?.length ?? 0,
          autoUpdatedCount: result.autoUpdatedPayloads?.length ?? 0,
          attachedDocumentCount: result.attachedDocuments?.length ?? 0,
          attachedCommunicationCardCount: result.attachedCommunicationCards?.length ?? 0,
        },
        error: toolOk ? undefined : new Error(result.output.slice(0, 300)),
      })
      const visibleToolKeyAfterRewrite = getClientVisibleToolKey(result.name, parsedInput)
      if (visibleToolKeyAfterRewrite && toolResultCountsAsVisible(result.name, result.output)) {
        visibleToolKeysExecutedThisTurn.add(visibleToolKeyAfterRewrite)
      }

      // 若工具产生了 approval 事件，先 yield（顺序：approvals → schedule confirmations → auto-updates → tool_call_end）
      if (result.approvalPayloads?.length) {
        for (const payload of result.approvalPayloads) {
          yield {
            type: SSE_EVENTS.TOOL_APPROVAL_REQUIRED as any,
            data: JSON.stringify(payload),
          }
        }
      }

      // 若 schedule 工具产生了确认卡 payload，yield SCHEDULE_CONFIRMATION_REQUIRED 事件
      if (result.scheduleConfirmations?.length) {
        for (const payload of result.scheduleConfirmations) {
          yield {
            type: SSE_EVENTS.SCHEDULE_CONFIRMATION_REQUIRED as any,
            data: JSON.stringify(payload),
          }
        }
      }

      // 若工具完成了 personal 字段自动落库，yield 通知事件让前端渲染轻量只读条
      if (result.autoUpdatedPayloads?.length) {
        for (const payload of result.autoUpdatedPayloads) {
          yield {
            type: SSE_EVENTS.PROFILE_AUTO_UPDATED as any,
            data: JSON.stringify(payload),
          }
        }
      }

      // post_tool_use hook（仅观察）
      await runPostToolUse({
        session,
        logger,
        iteration: loopCount,
        toolName: toolInput.name,
        toolCallId: toolInput.id,
        input: parsedInput,
        output: result.output,
        durationMs: result.durationMs,
      })

      // Yield tool_call_end SSE event
      yield {
        type: SSE_EVENTS.TOOL_CALL_END as any,
        data: JSON.stringify({
          toolCallId: result.toolCallId,
          name: result.name,
          output: getClientToolOutput(result.name, result.displayOutput ?? result.output),
          durationMs: result.durationMs,
        }),
      }

      // Append tool result to session messages for next LLM iteration
      // 显式算 tokenCount：否则 addMessage 不累加 session.tokenCount（低估本请求 context），
      // 且跨请求 loadSessionMessages 展开出的虚拟 tool 行也无 tokenCount，fallback 到 content.length/4
      // 会把 OCR 全文 / 干预材料 payload 按字符数爆算，触发假压缩。
      const toolResultMessage: ChatMessage = {
        role: 'tool',
        content: result.output,
        displayOutput: result.displayOutput,
        toolCallId: result.toolCallId,
      }
      toolResultMessage.tokenCount = estimateMessageTokens(toolResultMessage)
      addMessage(session, toolResultMessage)
      if (shouldPauseForAskUserQuestion(result)) {
        shouldPauseForUserQuestion = true
      }

      // ─── 合成 user 消息注入：saved_content 工具读取的病历原图 / 沟通卡片引用 ───
      // 要求：必须持久化到 DB，否则下一轮 loadSessionMessages 缺失，prefix 漂移（违反最高原则）
      const attachedDocuments = result.attachedDocuments ?? []
      const attachedCards = result.attachedCommunicationCards ?? []
      if (attachedDocuments.length || attachedCards.length) {
        const docTitles = attachedDocuments
          .map((d) => `[${d.shortId}] ${d.title ?? '未命名文档'}`)
          .join('、')
        const cardTitles = attachedCards
          .map((card) => `[${card.shortId}] ${card.title}`)
          .join('、')
        const attachmentMeta = JSON.stringify({
          docs: attachedDocuments.map((d) => ({
            docId: d.docId,
            shortId: d.shortId,
            title: d.title,
            imageCount: d.imageBlocks.length,
          })),
          communicationCards: attachedCards.map((card) => ({
            cardId: card.cardId,
            shortId: card.shortId,
            title: card.title,
          })),
        })

        // 把"真实用户原问题"直接嵌进 reminder body，模型不再需要从上文回溯"上一条"，
        // 多轮 / 多次 saved_content / 被 compaction 后都更稳。
        // 取回最近一条非 synthetic 的 user 消息文本，并剥掉其首次注入的 <system-reminder> 块。
        const originalQuestion = extractLatestRealUserMessageText(session.messages)

        const questionLine = originalQuestion
          ? `用户的原问题是：\n${originalQuestion}`
          : '请结合这些资料回答用户上一条问题。'
        const sourceLines = [
          attachedDocuments.length
            ? `以下 ${attachedDocuments.length} 张图片来自 saved_content 工具读取的病历原图（${docTitles}），由系统自动附加，不是用户主动发送的内容。请结合这些图片内容回答用户的问题。`
            : null,
          attachedCards.length
            ? `以下 ${attachedCards.length} 张医患沟通卡片引用来自 saved_content 工具（${cardTitles}），卡片 markdown 原文已在上一条 tool_result 中返回；这里的引用仅用于前端展示可点击卡片。`
            : null,
        ].filter(Boolean).join('\n')
        const readingBoundary = attachedDocuments.length
          ? `\n${TOOL_ATTACHED_MEDICAL_IMAGE_READING_BOUNDARY}\n`
          : ''
        const reminderBody = `${SYNTHETIC_TOOL_ATTACHMENT_MARKER}\n${sourceLines}${readingBoundary}\n<tool-attachment-meta>${attachmentMeta}</tool-attachment-meta>\n\n${questionLine}`
        const reminderBlock = `<system-reminder>\n${reminderBody}\n</system-reminder>`

        const imageBlocks = attachedDocuments.flatMap((d) => d.imageBlocks)
        const syntheticContent = imageBlocks.length > 0
          ? ([
              { type: 'text', text: reminderBlock },
              ...imageBlocks,
            ] as ChatMessage['content'])
          : reminderBlock

        const syntheticMessage: ChatMessage = {
          role: 'user',
          content: syntheticContent,
        }
        // 图片 block 固定 1600/张 + text 按 4 字符/token，提前算好让 session.tokenCount 累加正确；
        // saveMessage 会把这个 tokenCount 一并落库，下一请求 reload 不再按字符数高估。
        syntheticMessage.tokenCount = estimateMessageTokens(syntheticMessage)
        addMessage(session, syntheticMessage)

        try {
          syntheticMessage.dbId = await saveMessage(session.sessionId, syntheticMessage, logger)
        } catch (err) {
          logger.error(
            { err, sessionId: session.sessionId, toolCallId: result.toolCallId },
            'failed to persist synthetic user message (tool-attached resources); prefix may drift next turn',
          )
        }

        if (attachedDocuments.length) {
          yield {
            type: SSE_EVENTS.DOCUMENT_ATTACHED as any,
            data: JSON.stringify({
              docIds: attachedDocuments.map((d) => d.docId),
              shortIds: attachedDocuments.map((d) => d.shortId),
              titles: attachedDocuments.map((d) => d.title),
            }),
          }
        }

        if (attachedCards.length) {
          yield {
            type: SSE_EVENTS.COMMUNICATION_CARD_ATTACHED as any,
            data: JSON.stringify({
              cards: attachedCards,
            }),
          }
        }
      }
    }

    // 本轮 iter 结束：记录到 Redis，供下一轮 iter / 下次请求对比 prefix
    recordAfterLLMCall(toolsForAttempt)

    if (shouldPauseForUserQuestion) {
      logger.info({ loopCount, sessionId: session.sessionId }, 'agent loop paused for ask_user_question')
      yield {
        type: SSE_EVENTS.MESSAGE_END as any,
        data: JSON.stringify({
          messageId: crypto.randomUUID(),
          inputTokens: 0,
          outputTokens: 0,
          totalMs: 0,
        }),
      }
      return
    }

    // Loop continues — next iteration sends updated messages to LLM
  }
  } catch (err) {
    loopError = err
    logger.error(
      { err, loopCount, sessionId: session.sessionId },
      'agent loop crashed',
    )
    throw err
  } finally {
    // message_end hook：观察性汇总事件，任何退出路径都触发一次（不向上抛）
    try {
      const interrupted = loopInterrupted || session.abortController.signal.aborted
      await runMessageEnd({
        session,
        logger,
        totalIterations: loopCount,
        success: loopError === null && !interrupted,
        interrupted: interrupted || undefined,
        error: loopError ?? undefined,
        iterationMetrics,
        llmRetryAttempts,
      })
    } catch {
      /* runMessageEnd 内部已做 per-hook 错误隔离；此处兜底静默 */
    }
  }
}
