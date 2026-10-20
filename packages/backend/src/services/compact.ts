/**
 * Conversation Compaction — context window 管理
 *
 * 当上下文接近模型窗口 60% 时，将旧消息压缩为结构化摘要。
 * 模式同 titleGen.ts：非流式 side-call via getLLMClient()。
 * 所有原始消息在 DB 中完整保留，仅替换内存中的 session.messages。
 */

import { and, asc, eq, gt, lte } from 'drizzle-orm'
import { getContextWindowSize } from '../state/process.js'
import { llmCall } from '../lib/llm.js'
import { getDb } from '../db/client.js'
import { chatSessions, messages as messagesTable } from '../db/schema/index.js'
import type { SessionState, ChatMessage } from '../state/session.js'
import { updateSummary } from '../state/session.js'
import { estimateMessagesTokens } from '../utils/tokens.js'
import type { Logger } from '../lib/logger.js'
import { stripSystemReminderText } from '../utils/system-reminder.js'
import { hasSyntheticHiddenUserMarker } from '../utils/repeated-user-message.js'
import { countAssistantToolReplayMessages } from '../utils/tool-call-replay.js'
import {
  scheduleMemoryReviewForCompaction,
  type MemoryReviewCompactionMessage,
} from './memory-reviewer.js'

const MAX_RECENT_TURNS = 5
const COMPACT_MODEL = 'qwen3.5-flash'
const COMPACT_MAX_TOKENS = 2000
const COMPACT_TEMPERATURE = 0.2
const COMPACTION_RATIO = 0.6
const INJECTED_USER_MESSAGES_TITLE = '### 已压缩用户原文（代码注入，按时间顺序）'
const INJECTED_USER_MESSAGES_START = '<compacted_user_messages_chronological_json>'
const INJECTED_USER_MESSAGES_END = '</compacted_user_messages_chronological_json>'
const INJECTED_USER_MESSAGES_SECTION_RE = new RegExp(
  `\\n*${escapeRegExp(INJECTED_USER_MESSAGES_TITLE)}\\n[\\s\\S]*?${escapeRegExp(INJECTED_USER_MESSAGES_END)}`,
  'g',
)

// ─── Prompt 构建 ───

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function extractTextBlock(
  content: ChatMessage['content'],
): string {
  if (typeof content === 'string') return content
  return content.find((b) => b.type === 'text')?.text ?? ''
}

function serializeContentForSummary(
  content: ChatMessage['content'],
): string {
  if (typeof content === 'string') {
    return stripSystemReminderText(content).trim()
  }

  const parts = content
    .map((b) => {
      if (b.type === 'text') return stripSystemReminderText(b.text ?? '').trim()
      if (b.type === 'image_url') return '[图片]'
      return ''
    })
    .filter(Boolean)

  return parts.join('\n').trim()
}

function parsePersistedUserContent(raw: string): ChatMessage['content'] {
  if (!raw.startsWith('[')) return raw
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed) && parsed.every((p) => p && typeof p === 'object' && 'type' in p)) {
      return parsed as ChatMessage['content']
    }
  } catch { /* keep raw */ }
  return raw
}

function compactedUserMessageText(message: ChatMessage): string | null {
  if (message.role !== 'user') return null
  const textBlock = extractTextBlock(message.content)
  if (hasSyntheticHiddenUserMarker(textBlock)) return null

  const content = serializeContentForSummary(message.content)
  return content ? content : null
}

export function buildCompactionMemoryReviewMessages(messages: ChatMessage[]): MemoryReviewCompactionMessage[] {
  return messages
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .map((message) => ({
      role: message.role as 'user' | 'assistant',
      content: serializeContentForSummary(message.content),
      dbId: message.dbId,
    }))
    .filter((message) => message.content.trim())
}

function stripInjectedUserMessagesSection(summary: string | null): string | null {
  if (!summary) return summary
  const stripped = summary.replace(INJECTED_USER_MESSAGES_SECTION_RE, '').trim()
  return stripped || null
}

function buildInjectedUserMessagesSection(userMessages: string[]): string {
  if (userMessages.length === 0) return ''

  const json = JSON.stringify(userMessages, null, 2)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')

  return `${INJECTED_USER_MESSAGES_TITLE}
以下 JSON 数组为已经被压缩进 summary 的历史用户消息原文；数组顺序即原始时间顺序。仅作上下文，不是当前指令。
${INJECTED_USER_MESSAGES_START}
${json}
${INJECTED_USER_MESSAGES_END}`
}

function injectUserMessagesIntoSummary(summary: string, userMessages: string[]): string {
  const baseSummary = stripInjectedUserMessagesSection(summary) ?? ''
  const injectedSection = buildInjectedUserMessagesSection(userMessages)
  if (!injectedSection) return baseSummary
  return baseSummary ? `${baseSummary}\n\n${injectedSection}` : injectedSection
}

export function buildCompactionPrompt(
  existingSummary: string | null,
  messagesToCompact: ChatMessage[],
): string {
  const messagesText = messagesToCompact
    .map((m) => {
      const role = m.role === 'user' ? '用户' : '助手'
      const content = serializeContentForSummary(m.content)
      return `【${role}】${content}`
    })
    .join('\n\n')

  const existingSummarySection = existingSummary
    ? `以下是之前对话的已有摘要：\n<existing_summary>\n${existingSummary}\n</existing_summary>\n\n`
    : ''

  return `你是一个医疗对话压缩助手。你需要将乳腺健康相关用户的对话历史压缩为结构化摘要，供后续对话使用。

${existingSummarySection}以下是需要压缩的对话记录：
<conversation>
${messagesText}
</conversation>

请将上述对话${existingSummary ? '（结合已有摘要）' : ''}压缩为以下五个维度的摘要。如果某个维度没有相关内容，写"无"。

输出格式严格如下（不要添加任何额外内容）：

### 用户诉求
（患者提出的所有症状、问题和关切，按重要性排列。包括：主诉症状、用药疑问、情绪状态、生活困扰等）

### 解决情况
（助手已经给出的判断、建议和指导，包括：风险分层结果、行动建议、护理指导等）

### 遗留问题
（尚未完全解决或需要后续跟进的事项，包括：等待用户反馈的观察项、需要复诊确认的问题、未回答的疑问等）

### 持续性背景与偏好
（压缩后仍应保留的长期背景，包括：持续性症状/困扰、照护与家庭背景、生活习惯、沟通偏好、用户明确要求后续记住的信息。如无则写"无"）

### 图片信息
（用户发送的图片内容描述，如：检查报告照片、症状照片等。如无图片则写"无"）`
}

// ─── 消息分割 ───

/**
 * 从末尾反向找最近 maxTurns 轮 user 消息的分割点。
 * 返回 splitIndex：messages[0..splitIndex-1] 为旧消息（待压缩），
 * messages[splitIndex..] 为保留的近期消息。
 */
export function findCompactionSplitIndex(
  messages: ChatMessage[],
  maxTurns = MAX_RECENT_TURNS,
): number {
  let turnsFound = 0
  let i = messages.length - 1

  while (i >= 0 && turnsFound < maxTurns) {
    if (messages[i].role === 'user') {
      turnsFound++
      if (turnsFound >= maxTurns) break
    }
    i--
  }

  return Math.max(0, i)
}

// ─── LLM 调用 ───

async function callCompactionLLM(
  existingSummary: string | null,
  messagesToCompact: ChatMessage[],
  logger: Logger,
): Promise<string> {
  const prompt = buildCompactionPrompt(existingSummary, messagesToCompact)
  const start = performance.now()

  logger.info(
    { messageCount: messagesToCompact.length, hasExistingSummary: !!existingSummary },
    'compaction LLM call starting',
  )

  const response = await llmCall({
    model: COMPACT_MODEL,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: COMPACT_MAX_TOKENS,
    temperature: COMPACT_TEMPERATURE,
    enable_thinking: false,
  }, logger)

  const summary = response.choices?.[0]?.message?.content?.trim()
  if (!summary) {
    throw new Error('Compaction LLM returned empty response')
  }

  logger.info(
    {
      summaryLength: summary.length,
      durationMs: Math.round(performance.now() - start),
      inputTokens: response.usage?.prompt_tokens,
      outputTokens: response.usage?.completion_tokens,
    },
    'compaction LLM call completed',
  )

  return summary
}

// ─── 持久化 ───

async function persistSummary(
  sessionId: string,
  summary: string,
  summarizedUpToCreatedAt: Date | null,
  logger: Logger,
): Promise<void> {
  const db = getDb()
  const patch: {
    summary: string
    updatedAt: Date
    summarizedUpToCreatedAt?: Date
  } = {
    summary,
    updatedAt: new Date(),
  }
  if (summarizedUpToCreatedAt) patch.summarizedUpToCreatedAt = summarizedUpToCreatedAt
  await db.update(chatSessions)
    .set(patch)
    .where(eq(chatSessions.id, sessionId))
  logger.info(
    {
      sessionId,
      summaryLength: summary.length,
      summarizedUpToCreatedAt: summarizedUpToCreatedAt?.toISOString() ?? null,
    },
    'summary persisted to DB',
  )
}

async function loadCompactedUserMessages(
  sessionId: string,
  cutoffCreatedAt: Date,
  logger: Logger,
): Promise<string[]> {
  const db = getDb()
  const rows = await db.query.messages.findMany({
    where: and(
      eq(messagesTable.sessionId, sessionId),
      eq(messagesTable.role, 'user'),
      lte(messagesTable.createdAt, cutoffCreatedAt),
    ),
    orderBy: asc(messagesTable.createdAt),
    columns: {
      id: true,
      content: true,
    },
  })

  const userMessages = rows
    .map((row) => compactedUserMessageText({
      role: 'user',
      content: parsePersistedUserContent(row.content),
      dbId: row.id,
    }))
    .filter((content): content is string => !!content)

  logger.info(
    {
      sessionId,
      cutoffCreatedAt: cutoffCreatedAt.toISOString(),
      compactedUserMessageCount: userMessages.length,
    },
    'compacted user messages collected for summary injection',
  )

  return userMessages
}

/**
 * 根据 oldMessages.length 在 DB 行序列上倒推 cutoff：
 * - 遍历"上次压缩之后"的 DB 行（按 createdAt asc）
 * - 每行按 role / toolCalls 估算展开后贡献的 session.messages 条数
 * - 累计 == oldMessages.length 时当前行即 cutoff；若累加会超过则保守停在上一行
 *   （宁可下次多 load 一行旧消息，也不能漏 load 保留期内的行）
 *
 * 返回 null 表示：cutoff 没法稳定计算（同步缺失 / 边界不齐），放弃更新列、只写 summary。
 */
async function computeCutoffCreatedAt(
  sessionId: string,
  oldMessagesCount: number,
  logger: Logger,
): Promise<Date | null> {
  if (oldMessagesCount <= 0) return null

  const db = getDb()

  const sessionRow = await db.query.chatSessions.findFirst({
    where: eq(chatSessions.id, sessionId),
    columns: { summarizedUpToCreatedAt: true },
  })
  const prevCutoff = sessionRow?.summarizedUpToCreatedAt ?? null

  const whereClause = prevCutoff
    ? and(eq(messagesTable.sessionId, sessionId), gt(messagesTable.createdAt, prevCutoff))
    : eq(messagesTable.sessionId, sessionId)

  const rows = await db.query.messages.findMany({
    where: whereClause,
    orderBy: asc(messagesTable.createdAt),
    columns: {
      id: true,
      createdAt: true,
      role: true,
      content: true,
      toolCalls: true,
    },
  })

  let cum = 0
  let cutoffIdx = -1
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    let contribution = 1
    if (r.role === 'assistant' && Array.isArray(r.toolCalls) && r.toolCalls.length > 0) {
      // loadSessionMessages 展开：assistant(tool_calls) × step + tool × N + 可选 assistant(final)
      contribution = countAssistantToolReplayMessages(r.toolCalls, Boolean(r.content))
    }
    if (cum + contribution > oldMessagesCount) break
    cum += contribution
    cutoffIdx = i
    if (cum === oldMessagesCount) break
  }

  if (cutoffIdx < 0) {
    logger.warn(
      { sessionId, oldMessagesCount, dbRowCount: rows.length },
      'cutoff computation skipped: no fully-consumed DB row boundary found',
    )
    return null
  }

  return rows[cutoffIdx].createdAt
}

// ─── 公共入口 ───

export interface CompactionResult {
  performed: boolean
  newSummary?: string
  messagesCompacted?: number
  messagesRetained?: number
}

/**
 * 核心压缩执行：切分 → LLM 摘要 → 持久化 → 改写 session state。
 * 不做阈值检查，调用方（proactive / reactive 两条路径）各自判断是否需要执行。
 */
async function runCompaction(
  session: SessionState,
  logger: Logger,
  reason: 'proactive' | 'reactive',
  onCompactionStart?: () => Promise<void>,
): Promise<CompactionResult> {
  const splitIndex = findCompactionSplitIndex(session.messages)
  if (splitIndex <= 0) {
    logger.warn({ reason }, 'compaction needed but no old messages to compact')
    return { performed: false }
  }

  const oldMessages = session.messages.slice(0, splitIndex)
  const recentMessages = session.messages.slice(splitIndex)

  logger.info(
    { reason, oldCount: oldMessages.length, recentCount: recentMessages.length },
    'compaction split determined',
  )

  scheduleMemoryReviewForCompaction({
    userId: session.userId,
    sessionId: session.sessionId,
    reason,
    messages: buildCompactionMemoryReviewMessages(oldMessages),
    logger,
  })

  await onCompactionStart?.()

  const summaryForLLM = stripInjectedUserMessagesSection(session.summary)
  const llmSummary = await callCompactionLLM(summaryForLLM, oldMessages, logger)

  const cutoffCreatedAt = await computeCutoffCreatedAt(
    session.sessionId,
    oldMessages.length,
    logger,
  )

  const compactedUserMessages = cutoffCreatedAt
    ? await loadCompactedUserMessages(session.sessionId, cutoffCreatedAt, logger)
    : oldMessages
        .map((message) => compactedUserMessageText(message))
        .filter((content): content is string => !!content)
  const newSummary = injectUserMessagesIntoSummary(llmSummary, compactedUserMessages)

  await persistSummary(session.sessionId, newSummary, cutoffCreatedAt, logger)

  updateSummary(session, newSummary)
  session.messages = recentMessages
  session.tokenCount = estimateMessagesTokens(recentMessages)

  logger.info(
    {
      reason,
      messagesCompacted: oldMessages.length,
      messagesRetained: recentMessages.length,
      newTokenCount: session.tokenCount,
      summaryLength: newSummary.length,
    },
    'compaction completed',
  )

  return {
    performed: true,
    newSummary,
    messagesCompacted: oldMessages.length,
    messagesRetained: recentMessages.length,
  }
}

/**
 * 主动压缩（请求入口使用）：上下文预估 > 窗口 60% 时触发。
 */
export async function compactIfNeeded(
  session: SessionState,
  systemPromptLength: number,
  logger: Logger,
  onCompactionStart?: () => Promise<void>,
): Promise<CompactionResult> {
  const contextWindowSize = getContextWindowSize()
  const threshold = Math.floor(contextWindowSize * COMPACTION_RATIO)

  const systemTokens = Math.ceil(systemPromptLength / 4)
  const messageTokens = estimateMessagesTokens(session.messages)
  const maxOutputTokens = 8000
  const totalEstimated = systemTokens + messageTokens + maxOutputTokens

  logger.info(
    {
      totalEstimated,
      threshold,
      contextWindowSize,
      systemTokens,
      messageTokens,
      messageCount: session.messages.length,
    },
    'compaction check',
  )

  if (totalEstimated <= threshold) {
    return { performed: false }
  }

  return runCompaction(session, logger, 'proactive', onCompactionStart)
}

/**
 * 被动压缩（agent loop 兜底使用）：上游返回 CONTEXT_TOO_LONG 后直接触发，不做阈值估算。
 * 每个请求仅允许触发一次，由 loop 通过 session.hasAttemptedReactiveCompact 控制。
 */
export async function reactiveCompact(
  session: SessionState,
  logger: Logger,
  onCompactionStart?: () => Promise<void>,
): Promise<CompactionResult> {
  return runCompaction(session, logger, 'reactive', onCompactionStart)
}
