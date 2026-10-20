import { eq, and, lt, desc, sql } from 'drizzle-orm'
import { getDb } from '../db/client.js'
import { chatSessions, messages, messageFeedback, messageFavorites, shareTokens } from '../db/schema/index.js'
import type { Logger } from '../lib/logger.js'
import {
  SYNTHETIC_SCHEDULED_TODO_TRIGGER_MARKER,
  SYNTHETIC_TOOL_ATTACHMENT_MARKER,
} from '../utils/repeated-user-message.js'

export async function createSession(
  userId: string,
  title: string | undefined,
  logger: Logger,
) {
  const db = getDb()

  const [session] = await db
    .insert(chatSessions)
    .values({ userId, title: title || null })
    .returning()

  logger.info({ sessionId: session.id, userId }, 'session created')
  return session
}

export interface ListSessionsOptions {
  /** 游标：只返回 updatedAt 严格早于该时间的会话 */
  before?: Date
  /** 单页条数，默认 30，上限 100 */
  limit?: number
}

/**
 * 按 updatedAt 倒序游标分页。
 * 多取一条判断 hasMore；nextCursor 为最后一条的 updatedAt ISO。
 */
export async function listSessions(
  userId: string,
  logger: Logger,
  opts: ListSessionsOptions = {},
) {
  const db = getDb()
  const start = performance.now()
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100)

  const whereClause = opts.before
    ? and(eq(chatSessions.userId, userId), lt(chatSessions.updatedAt, opts.before))
    : eq(chatSessions.userId, userId)

  const rows = await db.query.chatSessions.findMany({
    where: whereClause,
    orderBy: desc(chatSessions.updatedAt),
    limit: limit + 1,
    columns: {
      id: true,
      title: true,
      messageCount: true,
      updatedAt: true,
    },
  })

  const hasMore = rows.length > limit
  const items = hasMore ? rows.slice(0, limit) : rows

  const mapped = items.map((r) => ({
    id: r.id,
    title: r.title,
    messageCount: r.messageCount,
    updatedAt: r.updatedAt.toISOString(),
  }))

  const nextCursor = hasMore && mapped.length > 0 ? mapped[mapped.length - 1].updatedAt : null

  logger.info(
    {
      userId,
      count: mapped.length,
      hasMore,
      before: opts.before?.toISOString(),
      listMs: Math.round(performance.now() - start),
    },
    'sessions listed',
  )

  return { items: mapped, hasMore, nextCursor }
}

export async function getSession(sessionId: string, logger: Logger) {
  const db = getDb()

  const session = await db.query.chatSessions.findFirst({
    where: eq(chatSessions.id, sessionId),
  })

  logger.info({ sessionId, found: !!session }, 'session lookup')
  return session
}

export interface RecentSessionPromptSummaryItem {
  id: string
  title: string | null
  userTurnCount: number
  startedAt: string
}

export interface RecentSessionPromptStats {
  todayCount: number
  yesterdayCount: number
  thisWeekCount: number
}

export interface RecentSessionPromptSummary {
  sessions: RecentSessionPromptSummaryItem[]
  stats: RecentSessionPromptStats
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

export async function listRecentSessionsForPrompt(
  userId: string,
  currentSessionId: string,
  logger: Logger,
  limit = 5,
): Promise<RecentSessionPromptSummary> {
  const db = getDb()
  const start = performance.now()
  const safeLimit = Math.min(Math.max(Math.floor(limit), 1), 10)
  const syntheticToolPattern = `%${SYNTHETIC_TOOL_ATTACHMENT_MARKER}%`
  const syntheticTodoPattern = `%${SYNTHETIC_SCHEDULED_TODO_TRIGGER_MARKER}%`

  const [rows, statsRows] = await Promise.all([
    db.execute<{
      id: string
      title: string | null
      user_turn_count: number | string
      started_at: Date | string
    }>(sql`
    SELECT
      s.id,
      s.title,
      s.created_at AS started_at,
      COUNT(m.id) FILTER (
        WHERE m.role = 'user'
          AND m.content NOT LIKE ${syntheticToolPattern}
          AND m.content NOT LIKE ${syntheticTodoPattern}
      )::int AS user_turn_count
    FROM chat_sessions s
    LEFT JOIN messages m ON m.session_id = s.id
    WHERE s.user_id = ${userId}
      AND s.id <> ${currentSessionId}
      AND s.is_active = true
      AND EXISTS (
        SELECT 1
        FROM messages um
        WHERE um.session_id = s.id
          AND um.role = 'user'
          AND um.content NOT LIKE ${syntheticToolPattern}
          AND um.content NOT LIKE ${syntheticTodoPattern}
      )
    GROUP BY s.id
    ORDER BY s.updated_at DESC
    LIMIT ${safeLimit}
  `),
    db.execute<{
      today_count: number | string
      yesterday_count: number | string
      this_week_count: number | string
    }>(sql`
      WITH user_sessions AS (
        SELECT (s.created_at AT TIME ZONE 'Asia/Shanghai')::date AS local_date
        FROM chat_sessions s
        WHERE s.user_id = ${userId}
          AND s.id <> ${currentSessionId}
          AND s.is_active = true
          AND EXISTS (
            SELECT 1
            FROM messages um
            WHERE um.session_id = s.id
              AND um.role = 'user'
              AND um.content NOT LIKE ${syntheticToolPattern}
              AND um.content NOT LIKE ${syntheticTodoPattern}
          )
      ),
      shanghai_now AS (
        SELECT (now() AT TIME ZONE 'Asia/Shanghai') AS ts
      )
      SELECT
        COUNT(*) FILTER (WHERE local_date = ts::date)::int AS today_count,
        COUNT(*) FILTER (WHERE local_date = (ts::date - INTERVAL '1 day')::date)::int AS yesterday_count,
        COUNT(*) FILTER (WHERE local_date >= date_trunc('week', ts)::date AND local_date <= ts::date)::int AS this_week_count
      FROM user_sessions, shanghai_now
    `),
  ])

  const items = (rows as unknown as Array<{
    id: string
    title: string | null
    user_turn_count: number | string
    started_at: Date | string
  }>).map((row) => ({
    id: row.id,
    title: row.title,
    userTurnCount: Number(row.user_turn_count) || 0,
    startedAt: toIsoString(row.started_at),
  }))

  const statsRow = (statsRows as unknown as Array<{
    today_count: number | string
    yesterday_count: number | string
    this_week_count: number | string
  }>)[0]
  const stats = {
    todayCount: Number(statsRow?.today_count) || 0,
    yesterdayCount: Number(statsRow?.yesterday_count) || 0,
    thisWeekCount: Number(statsRow?.this_week_count) || 0,
  }

  logger.info(
    {
      userId,
      currentSessionId,
      count: items.length,
      ...stats,
      listMs: Math.round(performance.now() - start),
    },
    'recent sessions prepared for prompt',
  )

  return { sessions: items, stats }
}

export async function deleteSession(sessionId: string, userId: string, logger: Logger) {
  const db = getDb()

  // Verify ownership
  const session = await db.query.chatSessions.findFirst({
    where: eq(chatSessions.id, sessionId),
    columns: { userId: true },
  })
  if (!session || session.userId !== userId) {
    logger.warn({ sessionId, userId }, 'delete session: not found or not owner')
    return false
  }

  // Cascade: share_tokens → feedback → messages → session
  // share_tokens 必须先于 messages 删除（外键 up_to_message_id 指向 messages.id）
  await db.delete(shareTokens).where(eq(shareTokens.sessionId, sessionId))
  await db.delete(messageFeedback).where(eq(messageFeedback.sessionId, sessionId))
  await db.delete(messageFavorites).where(eq(messageFavorites.sessionId, sessionId))
  await db.delete(messages).where(eq(messages.sessionId, sessionId))
  await db.delete(chatSessions).where(eq(chatSessions.id, sessionId))

  logger.info({ sessionId }, 'session and messages deleted')
  return true
}
