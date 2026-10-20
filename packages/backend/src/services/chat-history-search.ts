import { sql } from 'drizzle-orm'
import { getDb } from '../db/client.js'
import type { Logger } from '../lib/logger.js'
import {
  hasSyntheticHiddenUserMarker,
  SYNTHETIC_SCHEDULED_TODO_TRIGGER_MARKER,
  SYNTHETIC_TOOL_ATTACHMENT_MARKER,
} from '../utils/repeated-user-message.js'
import { stripSystemReminderText } from '../utils/system-reminder.js'

const DEFAULT_LIMIT = 5
const MAX_LIMIT = 10
const MAX_TURN_TEXT_CHARS = 2_000
const MAX_TOOL_OUTPUT_CHARS = 20_000
const STATEMENT_TIMEOUT_MS = 1_500
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/

export interface SearchChatHistoryTimeRange {
  startDate?: string
  endDate?: string
}

export interface SearchChatHistoryArgs {
  pattern: string
  timeRange?: SearchChatHistoryTimeRange
  title?: string
  limit?: number
}

export interface NormalizedSearchChatHistoryArgs {
  pattern: string
  timeRange?: SearchChatHistoryTimeRange
  title?: string
  limit: number
}

export interface TurnSearchRow extends Record<string, unknown> {
  session_id: string
  session_title: string | null
  session_started_at: Date
  session_updated_at: Date
  user_message_id: string
  user_content: string
  user_created_at: Date
  assistant_message_id: string
  assistant_content: string
  assistant_created_at: Date
}

export interface ChatHistorySessionMeta {
  sessionId: string
  title: string | null
  startedAt: Date
  updatedAt: Date
}

export interface ChatHistoryMessageForSearch {
  id: string
  sessionId: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  createdAt: Date
}

export interface ChatHistoryCandidateForSearch {
  messageId: string
  sessionId: string
  role: 'user' | 'assistant'
  matchedAt: Date
}

export interface SearchChatHistoryResult {
  sessionTitle: string | null
  sessionStartedAt: string
  sessionEndedAt: string
  turnTime: string
  user: string
  assistant: string
  truncated: boolean
}

export interface SearchChatHistoryResponse {
  output: string
  results: SearchChatHistoryResult[]
  truncated: boolean
}

export class SearchChatHistoryUserError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SearchChatHistoryUserError'
  }
}

function parseLimit(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return DEFAULT_LIMIT
  return Math.min(Math.max(Math.floor(parsed), 1), MAX_LIMIT)
}

function normalizeDateOnly(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' || !DATE_ONLY_PATTERN.test(value)) {
    throw new SearchChatHistoryUserError(`${field} 必须是 YYYY-MM-DD 格式。`)
  }
  const date = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new SearchChatHistoryUserError(`${field} 不是有效日期。`)
  }
  return value
}

export function normalizeSearchChatHistoryArgs(
  raw: SearchChatHistoryArgs,
): NormalizedSearchChatHistoryArgs {
  const pattern = String(raw?.pattern ?? '').trim()
  if (!pattern) {
    throw new SearchChatHistoryUserError('pattern 不能为空，请提供要搜索的关键词或正则表达式。')
  }

  const startDate = normalizeDateOnly(raw.timeRange?.startDate, 'timeRange.startDate')
  const endDate = normalizeDateOnly(raw.timeRange?.endDate, 'timeRange.endDate')
  if (startDate && endDate && startDate > endDate) {
    throw new SearchChatHistoryUserError('timeRange.startDate 不能晚于 endDate。')
  }

  const title = typeof raw.title === 'string' ? raw.title.trim() : ''
  return {
    pattern,
    limit: parseLimit(raw.limit),
    ...(title ? { title } : {}),
    ...(startDate || endDate ? { timeRange: { ...(startDate ? { startDate } : {}), ...(endDate ? { endDate } : {}) } } : {}),
  }
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`)
}

function truncateText(value: string, maxChars = MAX_TURN_TEXT_CHARS): { text: string; truncated: boolean } {
  if (value.length <= maxChars) return { text: value, truncated: false }
  return {
    text: `${value.slice(0, maxChars)}\n[内容过长，已截断]`,
    truncated: true,
  }
}

function cleanUserContentForSearchResult(content: string): string | null {
  let text = content
  let imageCount = 0

  if (content.startsWith('[')) {
    try {
      const parsed = JSON.parse(content)
      if (Array.isArray(parsed)) {
        const textPart = parsed.find((part: any) => part?.type === 'text')
        text = typeof textPart?.text === 'string' ? textPart.text : ''
        imageCount = parsed.filter((part: any) =>
          part?.type === 'image_url' && typeof part?.image_url?.url === 'string' && part.image_url.url.length > 0
        ).length
      }
    } catch {
      // keep raw text fallback
    }
  }

  if (hasSyntheticHiddenUserMarker(text)) return null

  const cleanedText = stripSystemReminderText(text).trim()
  const imagePlaceholders = Array.from({ length: imageCount }, () => '[image]')
  const parts = [...imagePlaceholders, cleanedText].filter(Boolean)
  return parts.length > 0 ? parts.join('\n') : null
}

function cleanAssistantContent(content: string): string {
  return stripSystemReminderText(content)
    .trim()
}

function toIso(value: Date): string {
  return value.toISOString()
}

function resultKey(sessionId: string, userId: string, assistantId: string | null): string {
  return `${sessionId}:${userId}:${assistantId ?? 'no-assistant'}`
}

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value)
}

export function buildChatHistorySearchResults(
  candidates: ChatHistoryCandidateForSearch[],
  messagesBySession: Map<string, ChatHistoryMessageForSearch[]>,
  sessionMetaById: Map<string, ChatHistorySessionMeta>,
  limit: number,
): SearchChatHistoryResult[] {
  const results: SearchChatHistoryResult[] = []
  const seen = new Set<string>()

  for (const candidate of candidates) {
    if (results.length >= limit) break
    const sessionMessages = [...(messagesBySession.get(candidate.sessionId) ?? [])]
      .sort((a, b) => asDate(a.createdAt).getTime() - asDate(b.createdAt).getTime())
    const meta = sessionMetaById.get(candidate.sessionId)
    if (!meta || sessionMessages.length === 0) continue

    const matched = sessionMessages.find((message) => message.id === candidate.messageId)
    if (!matched) continue

    let userMessage: ChatHistoryMessageForSearch | undefined
    let assistantMessage: ChatHistoryMessageForSearch | undefined

    if (candidate.role === 'user') {
      userMessage = matched.role === 'user' ? matched : undefined
      if (!userMessage || !cleanUserContentForSearchResult(userMessage.content)) continue
      assistantMessage = sessionMessages.find((message) =>
        message.role === 'assistant'
        && asDate(message.createdAt).getTime() > asDate(userMessage!.createdAt).getTime()
      )
      if (!assistantMessage) continue
    } else {
      assistantMessage = matched.role === 'assistant' ? matched : undefined
      if (!assistantMessage) continue
      for (let i = sessionMessages.indexOf(assistantMessage) - 1; i >= 0; i--) {
        const message = sessionMessages[i]
        if (message.role !== 'user') continue
        if (!cleanUserContentForSearchResult(message.content)) continue
        userMessage = message
        break
      }
      if (!userMessage) continue
    }

    const key = resultKey(candidate.sessionId, userMessage.id, assistantMessage.id)
    if (seen.has(key)) continue
    seen.add(key)

    const userText = cleanUserContentForSearchResult(userMessage.content)
    if (!userText) continue
    const assistantText = cleanAssistantContent(assistantMessage.content)
    const truncatedUser = truncateText(userText)
    const truncatedAssistant = truncateText(assistantText)

    results.push({
      sessionTitle: meta.title,
      sessionStartedAt: toIso(asDate(meta.startedAt)),
      sessionEndedAt: toIso(asDate(meta.updatedAt)),
      turnTime: toIso(asDate(userMessage.createdAt)),
      user: truncatedUser.text,
      assistant: truncatedAssistant.text,
      truncated: truncatedUser.truncated || truncatedAssistant.truncated,
    })
  }

  return results
}

export function buildChatHistorySearchResultsFromTurns(
  rows: TurnSearchRow[],
): SearchChatHistoryResult[] {
  const results: SearchChatHistoryResult[] = []

  for (const row of rows) {
    const userText = cleanUserContentForSearchResult(row.user_content)
    if (!userText) continue
    const assistantText = cleanAssistantContent(row.assistant_content)

    results.push({
      sessionTitle: row.session_title,
      sessionStartedAt: toIso(asDate(row.session_started_at)),
      sessionEndedAt: toIso(asDate(row.session_updated_at)),
      turnTime: toIso(asDate(row.user_created_at)),
      user: userText,
      assistant: assistantText,
      truncated: false,
    })
  }

  return results
}

function formatShanghaiDateTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function appendWithinBudget(
  parts: string[],
  chunk: string,
  state: { chars: number; truncated: boolean },
  maxChars: number,
): void {
  if (state.truncated) return
  const separatorChars = parts.length > 0 ? 2 : 0
  const nextChars = state.chars + separatorChars + chunk.length
  if (nextChars <= maxChars) {
    parts.push(chunk)
    state.chars = nextChars
    return
  }

  const remaining = maxChars - state.chars - separatorChars
  if (remaining > 0) {
    parts.push(`${chunk.slice(0, remaining)}\n[工具输出超过 ${maxChars} 字符，后续内容已截断]`)
  } else if (parts.length > 0) {
    parts[parts.length - 1] += `\n[工具输出超过 ${maxChars} 字符，后续内容已截断]`
  }
  state.truncated = true
  state.chars = maxChars
}

export function formatSearchChatHistoryOutput(
  results: SearchChatHistoryResult[],
  maxChars = MAX_TOOL_OUTPUT_CHARS,
): { output: string; truncated: boolean } {
  if (results.length === 0) {
    return { output: '没有找到匹配的历史对话。', truncated: false }
  }

  const parts: string[] = []
  const state = { chars: 0, truncated: false }

  for (let i = 0; i < results.length; i++) {
    const result = results[i]
    const title = result.sessionTitle?.trim() || '未命名会话'
    const block = [
      `【${i + 1}】`,
      `原始对话标题：${title}`,
      `原始对话时间：${formatShanghaiDateTime(result.turnTime)}`,
      `用户问题：\n${result.user}`,
      `AI回复：\n${result.assistant || '（空）'}`,
    ].join('\n')
    appendWithinBudget(parts, block, state, maxChars)
  }

  return {
    output: parts.join('\n\n'),
    truncated: state.truncated,
  }
}

function formatDbSearchError(err: any): string {
  const code = err?.code
  if (code === '2201B') {
    return 'pattern 不是有效的 PostgreSQL 正则表达式，请改用更简单的关键词或修正正则语法。'
  }
  if (code === '57014') {
    return '历史对话搜索超时，请缩小时间范围、标题范围，或使用更具体的关键词。'
  }
  return err?.message || '历史对话搜索失败。'
}

export async function searchChatHistory(
  userId: string,
  args: SearchChatHistoryArgs,
  logger: Logger,
): Promise<SearchChatHistoryResponse> {
  const normalized = normalizeSearchChatHistoryArgs(args)
  const db = getDb()
  const titlePattern = normalized.title ? `%${escapeLikePattern(normalized.title)}%` : null
  const syntheticToolPattern = `%${SYNTHETIC_TOOL_ATTACHMENT_MARKER}%`
  const syntheticTodoPattern = `%${SYNTHETIC_SCHEDULED_TODO_TRIGGER_MARKER}%`

  let rawRows: TurnSearchRow[]
  try {
    rawRows = await db.transaction(async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT_MS}ms'`))
      const rows = await tx.execute<TurnSearchRow>(sql`
        SELECT
          u.session_id,
          s.title AS session_title,
          s.created_at AS session_started_at,
          s.updated_at AS session_updated_at,
          u.id AS user_message_id,
          u.content AS user_content,
          u.created_at AS user_created_at,
          a.id AS assistant_message_id,
          a.content AS assistant_content,
          a.created_at AS assistant_created_at
        FROM messages u
        JOIN chat_sessions s ON s.id = u.session_id
        JOIN LATERAL (
          SELECT id, content, created_at
          FROM messages
          WHERE session_id = u.session_id
            AND role = 'assistant'
            AND created_at > u.created_at
          ORDER BY created_at ASC
          LIMIT 1
        ) a ON true
        WHERE s.user_id = ${userId}
          AND u.role = 'user'
          AND u.content NOT LIKE ${syntheticToolPattern}
          AND u.content NOT LIKE ${syntheticTodoPattern}
          AND (u.content || E'\n' || a.content) ~* ${normalized.pattern}
          ${normalized.timeRange?.startDate
            ? sql`AND u.created_at >= (${normalized.timeRange.startDate}::date::timestamp AT TIME ZONE 'Asia/Shanghai')`
            : sql``}
          ${normalized.timeRange?.endDate
            ? sql`AND u.created_at < ((${normalized.timeRange.endDate}::date + INTERVAL '1 day')::timestamp AT TIME ZONE 'Asia/Shanghai')`
            : sql``}
          ${titlePattern ? sql`AND COALESCE(s.title, '') ILIKE ${titlePattern} ESCAPE '\\'` : sql``}
        ORDER BY u.created_at DESC
        LIMIT ${normalized.limit}
      `)
      return rows as unknown as TurnSearchRow[]
    })
  } catch (err: any) {
    const message = formatDbSearchError(err)
    logger.warn({ code: err?.code, message }, 'chat history search query failed')
    throw new SearchChatHistoryUserError(message)
  }

  const results = buildChatHistorySearchResultsFromTurns(rawRows)
  const formatted = formatSearchChatHistoryOutput(results)

  return {
    output: formatted.output,
    results,
    truncated: formatted.truncated,
  }
}
