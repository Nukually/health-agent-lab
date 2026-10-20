/**
 * Message persistence — trajectory storage
 * Save/load messages for multi-turn conversations
 */

import { eq, and, or, lt, gt, asc, desc, inArray, like, sql } from 'drizzle-orm'
import type {
  ToolCallRecord,
  SyntheticDocPreview,
  SyntheticCommunicationCardPreview,
} from '@health-agent/shared'
import { getDb } from '../db/client.js'
import { messages, chatSessions, messageFeedback, messageFavorites } from '../db/schema/index.js'
import type { Logger } from '../lib/logger.js'
import type { ChatMessage } from '../state/session.js'
import { clearPrefixBaseline } from './prefix-tracker.js'
import { stripSystemReminderText } from '../utils/system-reminder.js'
import { estimateMessageTokens, estimateTextTokens } from '../utils/tokens.js'
import { sanitizeToolCallsForClient } from '../utils/tool-call-client.js'
import {
  getProcessTimelineForClient,
  hydrateProcessTimelineToolOutputs,
} from '../utils/process-timeline-client.js'
import {
  SYNTHETIC_TOOL_ATTACHMENT_MARKER,
  LEGACY_SYNTHETIC_TOOL_ATTACHMENT_MARKER,
  hasSyntheticHiddenUserMarker,
  hasSyntheticToolAttachmentMarker,
} from '../utils/repeated-user-message.js'
import { pruneSyntheticMedicalDocumentAttachmentContent } from './synthetic-attachments.js'
import {
  attachInterventionDiscomfortFeedbackToToolCalls,
  buildInterventionDiscomfortFeedbackMapFromSnapshot,
  listInterventionDiscomfortFeedbackSnapshot,
} from './intervention-discomfort-feedback.js'
import {
  getClientImageAttachmentsForMessages,
  getModelImageBlocksForMessages,
} from './image-asset.js'
import { groupToolCallsForReplay } from '../utils/tool-call-replay.js'

// 与 agent/loop.ts SYNTHETIC_TOOL_ATTACHMENT_MARKER / metadata 片段保持一致
const SYNTHETIC_MARKER = SYNTHETIC_TOOL_ATTACHMENT_MARKER
const SYNTHETIC_META_PATTERN = /<tool-attachment-meta>([\s\S]*?)<\/tool-attachment-meta>/
const SYNTHETIC_ATTACHMENT_TOOL_NAMES = new Set(['saved_content', 'read_medical_documents'])

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function serializeMessageContent(msg: ChatMessage): string {
  if (msg.role === 'user' && msg.imageAssetIds?.length) {
    if (typeof msg.content === 'string') return msg.content
    const text = msg.content
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text ?? '')
      .join('\n')
      .trim()
    return text
  }
  return typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
}

function getFinalAssistantContentForReplay(rawResponse: unknown, fallback: string): string {
  if (rawResponse && typeof rawResponse === 'object' && !Array.isArray(rawResponse)) {
    const content = (rawResponse as { finalAssistantContent?: unknown }).finalAssistantContent
    if (typeof content === 'string') return content
  }
  return fallback
}

function parseSyntheticAttachmentMeta(text: string): Record<string, unknown> | null {
  const metaMatch = text.match(SYNTHETIC_META_PATTERN)
  if (!metaMatch) return null
  try {
    const parsed = JSON.parse(metaMatch[1])
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

export function parseSyntheticDocPreviews(
  text: string,
  images?: string[],
): SyntheticDocPreview[] | undefined {
  const imageList = (images ?? []).filter(Boolean)
  const parsed = parseSyntheticAttachmentMeta(text) as {
    docs?: Array<{
      docId?: string
      shortId?: string | number
      title?: string | null
      imageCount?: number
    }>
  } | null

  if (parsed && Array.isArray(parsed.docs) && parsed.docs.length > 0) {
    let cursor = 0
    const docs = parsed.docs
      .map((doc) => {
        const imageCount = Number.isFinite(doc.imageCount)
          ? Math.max(0, Math.floor(Number(doc.imageCount)))
          : 0
        const imageUrls = imageCount > 0 ? imageList.slice(cursor, cursor + imageCount) : undefined
        cursor += imageCount

        return {
          docId: typeof doc.docId === 'string' ? doc.docId : null,
          shortId: typeof doc.shortId === 'string'
            ? doc.shortId
            : typeof doc.shortId === 'number'
              ? String(doc.shortId)
              : null,
          title: typeof doc.title === 'string' || doc.title === null ? doc.title : null,
          imageUrls,
        } satisfies SyntheticDocPreview
      })
      .filter((doc) => doc.docId || doc.shortId != null || doc.title || doc.imageUrls?.length)

    if (docs.length > 0) {
      if (cursor < imageList.length) {
        const last = docs[docs.length - 1]
        last.imageUrls = [...(last.imageUrls ?? []), ...imageList.slice(cursor)]
      }
      return docs
    }
  }

  if (imageList.length > 0) {
    return [{ docId: null, shortId: null, title: null, imageUrls: imageList }]
  }

  return undefined
}


export function parseSyntheticCommunicationCardPreviews(
  text: string,
): SyntheticCommunicationCardPreview[] | undefined {
  const parsed = parseSyntheticAttachmentMeta(text) as {
    communicationCards?: Array<{
      cardId?: string
      shortId?: string
      title?: string | null
    }>
  } | null

  if (!parsed || !Array.isArray(parsed.communicationCards)) return undefined

  const cards = parsed.communicationCards
    .map((card) => ({
      cardId: typeof card.cardId === 'string' ? card.cardId : null,
      shortId: typeof card.shortId === 'string' ? card.shortId : null,
      title: typeof card.title === 'string' || card.title === null ? card.title : null,
    }) satisfies SyntheticCommunicationCardPreview)
    .filter((card) => card.cardId || card.shortId || card.title)

  return cards.length > 0 ? cards : undefined
}

export async function saveMessage(
  sessionId: string,
  msg: ChatMessage,
  logger: Logger,
) {
  const db = getDb()
  const start = performance.now()

  const content = serializeMessageContent(msg)

  const [saved] = await db.insert(messages).values({
    sessionId,
    role: msg.role,
    content,
    thinking: msg.thinking || null,
    toolCalls: msg.toolCalls || null,
    rawResponse: msg.rawResponse || null,
    tokenCount: msg.tokenCount || null,
    llmInputTokens: msg.llmInputTokens ?? null,
    llmCachedInputTokens: msg.llmCachedInputTokens ?? null,
    llmCacheCreationInputTokens: msg.llmCacheCreationInputTokens ?? null,
    processDurationMs: msg.processDurationMs || null,
    outputTps: msg.outputTps ?? null,
    interrupted: msg.interrupted ?? false,
  }).returning({ id: messages.id })

  // Update session message count
  const session = await db.query.chatSessions.findFirst({
    where: eq(chatSessions.id, sessionId),
    columns: { messageCount: true, tokenCount: true },
  })

  if (session) {
    await db.update(chatSessions).set({
      messageCount: session.messageCount + 1,
      tokenCount: session.tokenCount + (msg.tokenCount || 0),
      updatedAt: new Date(),
    }).where(eq(chatSessions.id, sessionId))
  }

  logger.info(
    { sessionId, messageId: saved.id, role: msg.role, saveMs: Math.round(performance.now() - start) },
    'message saved',
  )

  if (msg.role === 'assistant' && msg.interrupted) {
    await clearPrefixBaseline(sessionId, logger, 'interrupted_assistant_persisted')
  }

  return saved.id
}

/**
 * 复用当前会话最新一条真实 user 消息做 retry/edit retry：
 * - 用新的 content/images 覆盖这条 user 消息
 * - 删除它之后尾部的 synthetic user / interrupted assistant 残留
 * - 不新建第二条 user 消息，避免 reload 后出现重复提问
 */
export async function reuseLatestUserMessageForRetry(
  sessionId: string,
  userMessage: ChatMessage,
  logger: Logger,
): Promise<string> {
  const db = getDb()
  const rows = await db.query.messages.findMany({
    where: eq(messages.sessionId, sessionId),
    orderBy: asc(messages.createdAt),
    columns: {
      id: true,
      role: true,
      content: true,
      interrupted: true,
      tokenCount: true,
    },
  })

  let targetIdx = -1
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]
    if (row.role !== 'user') continue
    if (hasSyntheticHiddenUserMarker(row.content)) continue
    targetIdx = i
    break
  }

  if (targetIdx < 0) {
    throw Object.assign(new Error('当前会话没有可重试的用户消息'), { status: 409 })
  }

  const trailingRows = rows.slice(targetIdx + 1)
  const hasNonRetryableTrailingRows = trailingRows.some((row) => {
    if (row.role === 'user' && hasSyntheticHiddenUserMarker(row.content)) return false
    if (row.role === 'assistant' && row.interrupted) return false
    return true
  })

  if (hasNonRetryableTrailingRows) {
    throw Object.assign(new Error('当前消息已不可编辑重试，请刷新后再试'), { status: 409 })
  }

  const targetRow = rows[targetIdx]
  const trailingIds = trailingRows.map((row) => row.id)
  const removedTokens = trailingRows.reduce((sum, row) => sum + (row.tokenCount ?? 0), 0)
  const nextMessageCount = rows.length - trailingRows.length

  await db.transaction(async (tx) => {
    const retrySentAt = new Date()

    await tx
      .update(messages)
      .set({
        content: serializeMessageContent(userMessage),
        thinking: null,
        toolCalls: null,
        rawResponse: null,
        tokenCount: null,
        processDurationMs: null,
        interrupted: false,
        createdAt: retrySentAt,
      })
      .where(eq(messages.id, targetRow.id))

    if (trailingIds.length > 0) {
      await tx.delete(messageFeedback).where(inArray(messageFeedback.messageId, trailingIds))
      await tx.delete(messageFavorites).where(inArray(messageFavorites.messageId, trailingIds))
      await tx.delete(messages).where(inArray(messages.id, trailingIds))
    }

    const sessionRow = await tx.query.chatSessions.findFirst({
      where: eq(chatSessions.id, sessionId),
      columns: { tokenCount: true },
    })

    await tx
      .update(chatSessions)
      .set({
        messageCount: nextMessageCount,
        tokenCount: sessionRow
          ? Math.max((sessionRow.tokenCount ?? 0) - removedTokens, 0)
          : 0,
        updatedAt: retrySentAt,
      })
      .where(eq(chatSessions.id, sessionId))
  })

  await clearPrefixBaseline(sessionId, logger, 'retry_latest_user_message')

  logger.info(
    {
      sessionId,
      targetMessageId: targetRow.id,
      trailingRemovedCount: trailingIds.length,
      editedContentLength: serializeMessageContent(userMessage).length,
    },
    'latest user message reused for retry',
  )
  return targetRow.id
}

/**
 * 从末尾倒序计数真实 user 消息（跳过 synthetic），命中第 N 条作为截断起点（含该条）。
 * 返回该条在 rows 中的下标；不足 N 条真实 user 消息时返回 -1。
 */
export function findEditTruncationCutoffIndex(
  rows: Array<{ role: string; content: string }>,
  discardUserTurnsFromEnd: number,
): number {
  if (discardUserTurnsFromEnd < 1) return -1
  let realUserSeen = 0
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]
    if (row.role !== 'user' || hasSyntheticToolAttachmentMarker(row.content)) continue
    realUserSeen += 1
    if (realUserSeen === discardUserTurnsFromEnd) return i
  }
  return -1
}

/**
 * 编辑历史 user 消息：在追加新 user 消息之前，丢弃 DB 里从末尾往前数第 N 条
 * 真实 user 消息（含该条）开始到结尾的全部消息。N=1 即编辑最新一轮。
 *
 * 与 reuseLatestUserMessageForRetry 不同：允许删除已完成的 assistant 与后续整轮，
 * 不做 in-place 覆盖。删完后由调用方走普通 saveMessage 追加新 user 消息。
 * 若截断点落入已 summarize 区间（cutoff <= summarizedUpToCreatedAt），summary 覆盖的
 * 旧消息正在被丢弃，summary 失效，连同 summarizedUpToCreatedAt 一并清空做 baseline reset。
 */
export async function truncateSessionForEdit(
  sessionId: string,
  discardUserTurnsFromEnd: number,
  logger: Logger,
): Promise<{ summaryReset: boolean }> {
  const db = getDb()
  const rows = await db.query.messages.findMany({
    where: eq(messages.sessionId, sessionId),
    orderBy: asc(messages.createdAt),
    columns: {
      id: true,
      role: true,
      content: true,
      tokenCount: true,
      createdAt: true,
    },
  })

  const cutoffIdx = findEditTruncationCutoffIndex(rows, discardUserTurnsFromEnd)

  if (cutoffIdx < 0) {
    throw Object.assign(
      new Error('编辑目标消息不存在或会话历史不一致，请刷新后再试'),
      { status: 409 },
    )
  }

  const cutoffCreatedAt = rows[cutoffIdx].createdAt
  const removedRows = rows.slice(cutoffIdx)
  const removedIds = removedRows.map((row) => row.id)
  const removedTokens = removedRows.reduce((sum, row) => sum + (row.tokenCount ?? 0), 0)

  const sessionRow = await db.query.chatSessions.findFirst({
    where: eq(chatSessions.id, sessionId),
    columns: { tokenCount: true, messageCount: true, summarizedUpToCreatedAt: true },
  })
  const summarizedCutoff = sessionRow?.summarizedUpToCreatedAt ?? null
  const resetSummary = summarizedCutoff != null && cutoffCreatedAt <= summarizedCutoff

  await db.transaction(async (tx) => {
    await tx.delete(messageFeedback).where(inArray(messageFeedback.messageId, removedIds))
    await tx.delete(messageFavorites).where(inArray(messageFavorites.messageId, removedIds))
    await tx.delete(messages).where(inArray(messages.id, removedIds))

    await tx
      .update(chatSessions)
      .set({
        messageCount: Math.max((sessionRow?.messageCount ?? removedIds.length) - removedIds.length, 0),
        tokenCount: Math.max((sessionRow?.tokenCount ?? 0) - removedTokens, 0),
        ...(resetSummary ? { summary: null, summarizedUpToCreatedAt: null } : {}),
        updatedAt: new Date(),
      })
      .where(eq(chatSessions.id, sessionId))
  })

  await clearPrefixBaseline(sessionId, logger, 'edit_user_message_truncate')

  logger.info(
    {
      sessionId,
      discardUserTurnsFromEnd,
      removedCount: removedIds.length,
      summaryReset: resetSummary,
    },
    'session truncated for user message edit',
  )

  return { summaryReset: resetSummary }
}

/**
 * 回写消息 content —— 专用于 agent loop 首次注入 <system-reminder> 后的固化。
 * 除此场景外禁止调用；更改已发送消息会破坏 LLM 多轮 prefix 稳定性。
 */
export async function updateMessageContent(
  messageId: string,
  content: string,
  logger: Logger,
): Promise<void> {
  const db = getDb()
  await db.update(messages).set({ content }).where(eq(messages.id, messageId))
  logger.debug({ messageId, contentLen: content.length }, 'message content rewritten (reminder inject)')
}

/**
 * 把 schedule 确认卡的终态（confirmed/rejected）写进该 assistant 消息 processTimeline 里
 * 对应 toolCallId 的 tool_call 步骤，使历史页/分享页可重放只读终态。
 * 仅改 rawResponse.processTimeline（前端展示用），不动 content/toolCalls，不影响 LLM prefix。
 * 找不到消息或步骤时返回 false（调用方据此记 warn，不阻断主流程）。
 */
export async function applyScheduleConfirmationToMessage(
  params: {
    sessionId: string
    messageId: string
    toolCallId: string
    status: 'confirmed' | 'rejected'
    /** 提醒真实 UUID，仅供前端结果卡深链跳转；不进 LLM 上下文。delete 时为 undefined */
    scheduledTaskId?: string
  },
  logger: Logger,
): Promise<boolean> {
  const db = getDb()
  const [row] = await db
    .select({ id: messages.id, rawResponse: messages.rawResponse })
    .from(messages)
    .where(and(eq(messages.id, params.messageId), eq(messages.sessionId, params.sessionId)))
    .limit(1)
  if (!row) {
    logger.warn({ messageId: params.messageId }, 'schedule confirmation patch skipped: message not found in session')
    return false
  }

  const raw = row.rawResponse && typeof row.rawResponse === 'object' && !Array.isArray(row.rawResponse)
    ? row.rawResponse as Record<string, unknown>
    : null
  const timeline = raw && Array.isArray(raw.processTimeline) ? raw.processTimeline as Record<string, unknown>[] : null
  if (!timeline) {
    logger.warn({ messageId: params.messageId }, 'schedule confirmation patch skipped: no processTimeline')
    return false
  }

  let patched = false
  const nextTimeline = timeline.map((step) => {
    if (!patched && step && step.type === 'tool_call' && step.toolCallId === params.toolCallId) {
      patched = true
      return {
        ...step,
        scheduleConfirmation: params.status,
        ...(params.scheduledTaskId ? { scheduledTaskId: params.scheduledTaskId } : {}),
      }
    }
    return step
  })
  if (!patched) {
    logger.warn({ messageId: params.messageId, toolCallId: params.toolCallId }, 'schedule confirmation patch skipped: tool_call step not found')
    return false
  }

  await db
    .update(messages)
    .set({ rawResponse: { ...raw, processTimeline: nextTimeline } })
    .where(eq(messages.id, params.messageId))
  logger.info({ messageId: params.messageId, toolCallId: params.toolCallId, status: params.status }, 'schedule confirmation persisted to processTimeline')
  return true
}

export async function pruneSyntheticMedicalDocumentContext(
  userId: string,
  docId: string,
  logger: Logger,
  opts: { imageIndex?: number } = {},
): Promise<{
  updated: number
  deleted: number
  toolResultsUpdated: number
  removedImages: number
  affectedSessionIds: string[]
}> {
  const db = getDb()
  const rows = await db
    .select({
      id: messages.id,
      sessionId: messages.sessionId,
      content: messages.content,
      tokenCount: messages.tokenCount,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .innerJoin(chatSessions, eq(messages.sessionId, chatSessions.id))
    .where(
      and(
        eq(chatSessions.userId, userId),
        eq(messages.role, 'user'),
        or(
          like(messages.content, `%${SYNTHETIC_MARKER}%`),
          like(messages.content, `%${LEGACY_SYNTHETIC_TOOL_ATTACHMENT_MARKER}%`),
        ),
      ),
    )
    .orderBy(asc(messages.createdAt))

  const updates: Array<{ id: string; sessionId: string; content: string; tokenDelta: number }> = []
  const deleteIds: string[] = []
  const changedSyntheticRows: Array<{ sessionId: string; createdAt: Date }> = []
  const sessionDeltas = new Map<string, { tokenDelta: number; messageDelta: number }>()
  let removedImages = 0

  const addSessionDelta = (sessionId: string, tokenDelta: number, messageDelta: number) => {
    const prev = sessionDeltas.get(sessionId) ?? { tokenDelta: 0, messageDelta: 0 }
    prev.tokenDelta += tokenDelta
    prev.messageDelta += messageDelta
    sessionDeltas.set(sessionId, prev)
  }

  for (const row of rows) {
    const result = pruneSyntheticMedicalDocumentAttachmentContent(row.content, { docId, imageIndex: opts.imageIndex })
    if (!result.changed) continue

    const oldTokenCount = row.tokenCount ?? estimateMessageTokens({ role: 'user', content: row.content })
    changedSyntheticRows.push({ sessionId: row.sessionId, createdAt: row.createdAt })
    removedImages += result.removedImageCount
    if (result.removeMessage) {
      deleteIds.push(row.id)
      addSessionDelta(row.sessionId, oldTokenCount, 1)
      continue
    }

    if (!result.content) continue
    const newTokenCount = estimateMessageTokens({ role: 'user', content: result.content })
    updates.push({
      id: row.id,
      sessionId: row.sessionId,
      content: result.content,
      tokenDelta: Math.max(oldTokenCount - newTokenCount, 0),
    })
    addSessionDelta(row.sessionId, Math.max(oldTokenCount - newTokenCount, 0), 0)
  }

  if (updates.length === 0 && deleteIds.length === 0) {
    return { updated: 0, deleted: 0, toolResultsUpdated: 0, removedImages: 0, affectedSessionIds: [] }
  }

  const toolResultNote = opts.imageIndex == null
    ? '[上下文更新] 用户已删除这份病历文档；本次历史 saved_content 读取结果中的相关病历原图已从后续 LLM 上下文移除。不要再依据被删除病历作答。'
    : `[上下文更新] 用户已删除这份病历文档中的第 ${opts.imageIndex + 1} 张图片；本次历史 saved_content 读取结果中的对应图片已从后续 LLM 上下文移除。不要再依据被删除图片作答。`
  const toolCallUpdates = new Map<string, ToolCallRecord[]>()

  for (const row of changedSyntheticRows) {
    const assistantRow = await db.query.messages.findFirst({
      where: (t, { and, eq: e, gt: g }) => and(
        e(t.sessionId, row.sessionId),
        e(t.role, 'assistant'),
        g(t.createdAt, row.createdAt),
      ),
      orderBy: (t, { asc: a }) => [a(t.createdAt)],
      columns: { id: true, toolCalls: true },
    })
    const toolCalls = (assistantRow?.toolCalls as ToolCallRecord[] | null) ?? null
    if (!assistantRow || !Array.isArray(toolCalls)) continue

    let changed = false
    const nextToolCalls = toolCalls.map((toolCall) => {
      if (!SYNTHETIC_ATTACHMENT_TOOL_NAMES.has(toolCall.name)) return toolCall
      const currentOutput = typeof toolCall.llmOutput === 'string'
        ? toolCall.llmOutput
        : typeof toolCall.output === 'string'
          ? toolCall.output
          : ''
      if (currentOutput.includes(toolResultNote)) return toolCall
      changed = true
      return {
        ...toolCall,
        llmOutput: currentOutput ? `${currentOutput}\n\n${toolResultNote}` : toolResultNote,
      }
    })

    if (changed) toolCallUpdates.set(assistantRow.id, nextToolCalls)
  }

  await db.transaction(async (tx) => {
    for (const update of updates) {
      await tx
        .update(messages)
        .set({
          content: update.content,
          tokenCount: estimateMessageTokens({ role: 'user', content: update.content }),
        })
        .where(eq(messages.id, update.id))
    }

    for (const [messageId, toolCalls] of toolCallUpdates) {
      await tx
        .update(messages)
        .set({ toolCalls })
        .where(eq(messages.id, messageId))
    }

    if (deleteIds.length > 0) {
      await tx.delete(messageFavorites).where(inArray(messageFavorites.messageId, deleteIds))
      await tx.delete(messages).where(inArray(messages.id, deleteIds))
    }

    for (const [sessionId, delta] of sessionDeltas) {
      await tx
        .update(chatSessions)
        .set({
          tokenCount: sql`GREATEST(${chatSessions.tokenCount} - ${delta.tokenDelta}, 0)`,
          messageCount: sql`GREATEST(${chatSessions.messageCount} - ${delta.messageDelta}, 0)`,
          updatedAt: new Date(),
        })
        .where(eq(chatSessions.id, sessionId))
    }
  })

  const affectedSessionIds = Array.from(sessionDeltas.keys())
  await Promise.all(
    affectedSessionIds.map((sessionId) => clearPrefixBaseline(sessionId, logger, 'medical_document_context_pruned')),
  )

  logger.info(
    {
      userId,
      docId,
      imageIndex: opts.imageIndex ?? null,
      updated: updates.length,
      deleted: deleteIds.length,
      toolResultsUpdated: toolCallUpdates.size,
      removedImages,
      affectedSessions: affectedSessionIds.length,
    },
    'synthetic medical document context pruned',
  )

  return {
    updated: updates.length,
    deleted: deleteIds.length,
    toolResultsUpdated: toolCallUpdates.size,
    removedImages,
    affectedSessionIds,
  }
}

export async function loadSessionMessages(
  sessionId: string,
  logger: Logger,
): Promise<ChatMessage[]> {
  const db = getDb()
  const start = performance.now()

  // compaction 后写入的 summarizedUpToCreatedAt 游标：只加载游标之后的消息，
  // 已被 summary 吸收的旧消息由 prompt section sessionSummary 注入，不再重载。
  const sessionRow = await db.query.chatSessions.findFirst({
    where: eq(chatSessions.id, sessionId),
    columns: { summarizedUpToCreatedAt: true },
  })
  const cutoff = sessionRow?.summarizedUpToCreatedAt ?? null

  const whereClause = cutoff
    ? and(eq(messages.sessionId, sessionId), gt(messages.createdAt, cutoff))
    : eq(messages.sessionId, sessionId)

  const rows = await db.query.messages.findMany({
    where: whereClause,
    orderBy: asc(messages.createdAt),
  })
  const modelImageBlocksByMessageId = await getModelImageBlocksForMessages(
    rows.filter((row) => row.role === 'user').map((row) => row.id),
  )

  // DB 中每轮仅保存一行 assistant：content=最终答复，toolCalls=该轮聚合的归一化
  // ToolCallRecord[]。回放给 LLM 时必须展开为原生 OpenAI sequence：
  //   assistant(tool_calls=[...原生形状], content="")
  //   tool(tool_call_id, content=output) × N
  //   user(synthetic with images, <system-reminder>)  // 若本轮有 saved_content 读取病历
  //   assistant(content=最终答复)                      // 仅当非空
  // 否则 DashScope 报 "required: input.messages.N.tool_calls.0.function"
  //
  // 中断消息：DB 只存原始截断文本（不给用户看 marker），回放给 LLM 时动态注入
  // [用户手动中断] 前后缀，让模型知道上一轮被用户打断。
  //
  // synthetic user（saved_content 工具读取的病历原图）按 createdAt 落在
  // 本轮 assistant 行之前（mid-loop saveMessage），但 LLM prefix 必须夹在 tool 和
  // final 中间。做法：遇到 synthetic user 先缓冲，等见到同轮 assistant 时再按
  // 正确顺序 emit。
  const INTERRUPT_MARKER = '[用户手动中断]'
  const result: ChatMessage[] = []
  let needsPrefixBaselineReset = false
  const pendingSynthetic: ChatMessage[] = []

  const parseUserContent = (raw: string): ChatMessage['content'] => {
    if (!raw.startsWith('[')) return raw
    try {
      const arr = JSON.parse(raw)
      if (Array.isArray(arr) && arr.every((p) => p && typeof p === 'object' && 'type' in p)) {
        return arr
      }
    } catch { /* keep raw */ }
    return raw
  }
  for (const row of rows) {
    const toolCalls = (row.toolCalls as ToolCallRecord[] | null) || null
    const wrapIfInterrupted = (text: string) => {
      if (!row.interrupted) return text
      return text.trim() ? `${INTERRUPT_MARKER}\n${text}\n${INTERRUPT_MARKER}` : INTERRUPT_MARKER
    }

    // synthetic user：缓冲，待本轮 assistant(toolCalls) 展开时 emit 到 tool 和 final 之间
    if (row.role === 'user' && hasSyntheticToolAttachmentMarker(row.content)) {
      pendingSynthetic.push({
        role: 'user',
        content: parseUserContent(row.content),
        dbId: row.id,
      })
      continue
    }

    // user 多模态消息落库时被 JSON.stringify 成字符串；回放给 LLM 必须解析回数组，
    // 否则模型看到的是一坨裸 JSON（含 base64 图片字节）而不是真正的 image_url，
    // 轻则答非所问，重则只输出 provider reasoning 而没有可见 content。
    let userContent: ChatMessage['content'] = row.role === 'user'
      ? parseUserContent(row.content)
      : row.content
    const attachedImageBlocks = row.role === 'user'
      ? modelImageBlocksByMessageId.get(row.id) ?? []
      : []
    const hasExistingImageBlocks = Array.isArray(userContent) &&
      userContent.some((block) => block.type === 'image_url')
    if (attachedImageBlocks.length > 0 && !hasExistingImageBlocks) {
      const baseBlocks = Array.isArray(userContent)
        ? userContent
        : userContent
          ? [{ type: 'text', text: userContent }]
          : []
      userContent = [...baseBlocks, ...attachedImageBlocks]
    }

    if (row.role === 'assistant' && toolCalls?.length) {
      // 只校验"回放给 LLM 的字段"是否字节稳定：toolCallId / rawArguments /
      // assistantToolCallContent / llmOutput 全是字符串才能保证上一轮发给 LLM 的
      // tool_calls 段 byte-for-byte 一致。output 的 shape 是 `unknown`（UI 展示层
      // 用，干预材料/卡片是对象合法），不参与 prefix 稳定性判定。
      if (
        toolCalls.some(
          (tc, i) =>
            !tc.toolCallId ||
            typeof tc.rawArguments !== 'string' ||
            typeof tc.llmOutput !== 'string' ||
            typeof tc.assistantToolCallContent !== 'string' ||
            tc.toolCallId === `call_${row.id}_${i}`,
        )
      ) {
        needsPrefixBaselineReset = true
      }

      for (const group of groupToolCallsForReplay(toolCalls)) {
        const assistantToolCallContent = group[0]?.toolCall.assistantToolCallContent ?? ''
        const nativeToolCalls = group.map(({ toolCall: tc, index: i }) => ({
          id: tc.toolCallId ?? `call_${row.id}_${i}`,
          type: 'function' as const,
          function: {
            name: tc.name,
            arguments:
              typeof tc.rawArguments === 'string'
                ? tc.rawArguments
                : JSON.stringify(tc.input ?? {}),
          },
        }))

        result.push({
          role: 'assistant',
          content: assistantToolCallContent,
          toolCalls: nativeToolCalls,
        })

        for (const { toolCall: tc, index: i } of group) {
          const toolCallId = tc.toolCallId ?? `call_${row.id}_${i}`
          const output = typeof tc.llmOutput === 'string'
            ? tc.llmOutput
            : typeof tc.output === 'string'
              ? tc.output
              : tc.output == null ? '' : JSON.stringify(tc.output)
          // 虚拟 tool 行不独立落库，tokenCount 在这里显式赋值；否则下游估算 fallback 到
          // content.length/4，OCR 全文 / 干预材料 payload 会被放大成上万 token，触发假压缩。
          result.push({
            role: 'tool',
            content: output,
            toolCallId,
            tokenCount: estimateTextTokens(output),
          })
        }

        // saved_content/read_medical_documents 会在 tool 后追加 synthetic user；
        // 若一轮内还有后续 assistant(tool_calls)，synthetic 必须插回对应工具之后。
        if (pendingSynthetic.length && group.some(({ toolCall }) => SYNTHETIC_ATTACHMENT_TOOL_NAMES.has(toolCall.name))) {
          for (const s of pendingSynthetic) result.push(s)
          pendingSynthetic.length = 0
        }
      }

      // 把本轮 buffered synthetic 插在 tool 和 final 之间（顺序与 tool 一致）
      if (pendingSynthetic.length) {
        for (const s of pendingSynthetic) result.push(s)
        pendingSynthetic.length = 0
      }

      const finalAssistantContent = getFinalAssistantContentForReplay(row.rawResponse, row.content)
      if (finalAssistantContent || row.interrupted) {
        result.push({
          role: 'assistant',
          content: wrapIfInterrupted(finalAssistantContent),
          tokenCount: row.tokenCount || undefined,
          llmInputTokens: row.llmInputTokens || undefined,
          llmCachedInputTokens: row.llmCachedInputTokens || undefined,
          llmCacheCreationInputTokens: row.llmCacheCreationInputTokens || undefined,
        })
      }
      continue
    }

    result.push({
      role: row.role,
      content: row.role === 'assistant' ? wrapIfInterrupted(row.content) : userContent,
      thinking: row.thinking || undefined,
      rawResponse: row.rawResponse || undefined,
      tokenCount: row.tokenCount || undefined,
      llmInputTokens: row.llmInputTokens || undefined,
      llmCachedInputTokens: row.llmCachedInputTokens || undefined,
      llmCacheCreationInputTokens: row.llmCacheCreationInputTokens || undefined,
      dbId: row.role === 'user' ? row.id : undefined,
    })
  }

  // 兜底：synthetic 缓冲未被配对消费（比如该轮 assistant 根本没落库成功）。
  // 按原始顺序补到末尾，保证消息不丢；LLM 侧这是稀有情况，尽量不影响 prefix。
  if (pendingSynthetic.length) {
    logger.warn(
      { sessionId, orphanCount: pendingSynthetic.length },
      'synthetic user rows unpaired with assistant; appended at tail as fallback',
    )
    for (const s of pendingSynthetic) result.push(s)
    pendingSynthetic.length = 0
  }

  logger.info(
    {
      sessionId,
      messageCount: result.length,
      loadMs: Math.round(performance.now() - start),
      summarizedCutoff: cutoff?.toISOString() ?? null,
    },
    'messages loaded',
  )

  if (needsPrefixBaselineReset) {
    await clearPrefixBaseline(sessionId, logger, 'legacy_tool_replay')
  }

  return result
}

export interface GetSessionMessagesOptions {
  /** 游标：只返回 createdAt 严格早于该时间的消息 */
  before?: Date
  /** 单页条数，默认 30，上限 100 */
  limit?: number
  /** 目标消息：提供时返回目标消息附近的窗口，方便前端直接定位收藏消息 */
  focusMessageId?: string
  /** 当前会话所属用户；传入后会把干预反馈的最新可编辑状态附到卡片资源上 */
  userId?: string
}

type SessionMessageClientRow = {
  id: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  thinking: string | null
  toolCalls: unknown[] | null
  rawResponse: unknown
  llmInputTokens: number | null
  llmCachedInputTokens: number | null
  llmCacheCreationInputTokens: number | null
  processDurationMs: number | null
  outputTps: number | null
  interrupted: boolean
  createdAt: Date
}

export function selectFocusedMessageWindow<T extends { id: string; createdAt: Date | string }>(
  rows: T[],
  focusMessageId: string,
  limit: number,
): {
  rows: T[]
  focusFound: boolean
  hasMoreBefore: boolean
  hasMoreAfter: boolean
  oldestCreatedAt: string | null
} {
  const safeLimit = Math.min(Math.max(Math.floor(limit), 1), 100)
  const focusIndex = rows.findIndex((row) => row.id === focusMessageId)
  if (focusIndex < 0) {
    return {
      rows: [],
      focusFound: false,
      hasMoreBefore: false,
      hasMoreAfter: false,
      oldestCreatedAt: null,
    }
  }

  const beforeCount = Math.floor((safeLimit - 1) / 2)
  let start = Math.max(0, focusIndex - beforeCount)
  let end = Math.min(rows.length, start + safeLimit)
  start = Math.max(0, end - safeLimit)
  const windowRows = rows.slice(start, end)
  const oldest = windowRows[0]?.createdAt
  return {
    rows: windowRows,
    focusFound: true,
    hasMoreBefore: start > 0,
    hasMoreAfter: end < rows.length,
    oldestCreatedAt: oldest ? toIsoString(oldest) : null,
  }
}

/**
 * 按游标倒序分页取会话消息，反转为 ASC 返回给 UI。
 * 多取一条判断 hasMore；oldestCreatedAt 可作为下一页 cursor。
 */
export async function getSessionMessages(
  sessionId: string,
  logger: Logger,
  opts: GetSessionMessagesOptions = {},
) {
  const db = getDb()
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100)

  let hasMore: boolean
  let page: SessionMessageClientRow[]
  let focusedOldestCreatedAt: string | null = null

  if (opts.focusMessageId && !opts.before) {
    const indexRows = await db.query.messages.findMany({
      where: eq(messages.sessionId, sessionId),
      orderBy: asc(messages.createdAt),
      columns: {
        id: true,
        createdAt: true,
      },
    })
    const window = selectFocusedMessageWindow(indexRows, opts.focusMessageId, limit)
    if (window.focusFound && window.rows.length > 0) {
      const ids = window.rows.map((row) => row.id)
      page = await db.query.messages.findMany({
        where: and(eq(messages.sessionId, sessionId), inArray(messages.id, ids)),
        orderBy: asc(messages.createdAt),
      })
      hasMore = window.hasMoreBefore
      focusedOldestCreatedAt = window.oldestCreatedAt
    } else {
      page = []
      hasMore = false
    }
  } else {
    const whereClause = opts.before
      ? and(eq(messages.sessionId, sessionId), lt(messages.createdAt, opts.before))
      : eq(messages.sessionId, sessionId)

    // 倒序取 limit+1 条，多出的那条用来判断是否还有更早的历史
    const rows = await db.query.messages.findMany({
      where: whereClause,
      orderBy: desc(messages.createdAt),
      limit: limit + 1,
      columns: {
        id: true,
        role: true,
        content: true,
        thinking: true,
        toolCalls: true,
        rawResponse: true,
        llmInputTokens: true,
        llmCachedInputTokens: true,
        llmCacheCreationInputTokens: true,
        processDurationMs: true,
        outputTps: true,
        interrupted: true,
        createdAt: true,
      },
    })

    hasMore = rows.length > limit
    page = hasMore ? rows.slice(0, limit) : rows
    // DB 是 DESC，给 UI 反转成 ASC
    page.reverse()
  }

  const discomfortFeedbackMap = opts.userId
    ? buildInterventionDiscomfortFeedbackMapFromSnapshot(
      await listInterventionDiscomfortFeedbackSnapshot(sessionId, opts.userId),
    )
    : null
  const clientImageAttachmentsByMessageId = await getClientImageAttachmentsForMessages(
    page.filter((row) => row.role === 'user').map((row) => row.id),
  )

  logger.info(
    {
      sessionId,
      messageCount: page.length,
      hasMore,
      before: opts.before?.toISOString(),
      focusMessageId: opts.focusMessageId ?? null,
    },
    'session messages fetched',
  )

  const mapped = page.map((r) => {
    let content = r.content
    let rawTextContent = r.content
    let images: string[] | undefined
    let synthetic = false
    let syntheticDocs: SyntheticDocPreview[] | undefined
    let syntheticCommunicationCards: SyntheticCommunicationCardPreview[] | undefined

    const imageAttachments = clientImageAttachmentsByMessageId.get(r.id)

    // Parse multimodal content: [{type:"text",...},{type:"image_url",...}]
    if (r.role === 'user' && content.startsWith('[')) {
      try {
        const parsed = JSON.parse(content)
        if (Array.isArray(parsed)) {
          const textPart = parsed.find((p: any) => p.type === 'text')
          rawTextContent = textPart?.text || ''
          content = rawTextContent
          const urls = parsed
            .filter((p: any) => p.type === 'image_url')
            .map((p: any) => p.image_url?.url)
            .filter(Boolean)
          if (urls.length > 0) images = urls
        }
      } catch { /* keep raw content */ }
    } else {
      rawTextContent = content
    }
    if (imageAttachments?.length) {
      images = imageAttachments.map((attachment) => attachment.thumbUrl)
    }

    // 标记合成 user 消息：content 含 marker（比 stripSystemReminderText 早，保证标签还在）
    if (r.role === 'user' && hasSyntheticHiddenUserMarker(rawTextContent)) {
      synthetic = true
      if (hasSyntheticToolAttachmentMarker(rawTextContent)) {
        syntheticDocs = parseSyntheticDocPreviews(rawTextContent, images)
        syntheticCommunicationCards = parseSyntheticCommunicationCardPreviews(rawTextContent)
      }
    }

    // 对外不暴露 <system-reminder> 注入块（UI / 分享 / 导出均 strip）
    if (r.role === 'user' && content) {
      content = stripSystemReminderText(content)
    }

    const toolCalls = attachInterventionDiscomfortFeedbackToToolCalls(
      sanitizeToolCallsForClient(r.toolCalls as ToolCallRecord[] | null),
      discomfortFeedbackMap ?? new Map(),
    )

    return {
      id: r.id,
      role: r.role,
      content,
      images,
      imageAttachments,
      thinking: r.thinking,
      toolCalls,
      processTimeline: hydrateProcessTimelineToolOutputs(getProcessTimelineForClient(r.rawResponse), toolCalls),
      processDurationMs: r.processDurationMs ?? undefined,
      outputTps: r.outputTps ?? undefined,
      interrupted: r.interrupted || undefined,
      synthetic: synthetic || undefined,
      syntheticDocs,
      syntheticCommunicationCards,
      createdAt: r.createdAt.toISOString(),
    }
  })

  return {
    messages: mapped,
    hasMore,
    oldestCreatedAt: focusedOldestCreatedAt ?? (mapped.length > 0 ? mapped[0].createdAt : null),
  }
}
