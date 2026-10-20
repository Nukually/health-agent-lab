import { and, desc, eq, lt } from 'drizzle-orm'
import type {
  MessageFavoriteListResponse,
  MessageFavoriteRecord,
} from '@health-agent/shared'
import { getDb } from '../db/client.js'
import { chatSessions, messageFavorites, messages } from '../db/schema/index.js'
import type { Logger } from '../lib/logger.js'
import { stripSystemReminderText } from '../utils/system-reminder.js'
import { hasSyntheticToolAttachmentMarker } from '../utils/repeated-user-message.js'

const DEFAULT_FAVORITE_LIST_LIMIT = 30
const MAX_FAVORITE_LIST_LIMIT = 100
const DEFAULT_PREVIEW_CHARS = 80

type CreateMessageFavoriteResult =
  | { status: 'created' | 'exists'; favorite: MessageFavoriteRecord }
  | { status: 'not_found' | 'invalid_target' }

interface FavoriteRow {
  id: string
  sessionId: string
  messageId: string
  userMessageId: string | null
  userContentSnapshot: string | null
  contentSnapshot: string
  contentPreview: string
  sessionTitleSnapshot: string | null
  messageCreatedAt: Date
  createdAt: Date
  updatedAt: Date
}

export function buildMessageFavoritePreview(content: string, maxChars = DEFAULT_PREVIEW_CHARS): string {
  const normalized = stripXmlLikeTags(stripAnswerTags(content))
    .replace(/\s+/g, '')
    .trim()
  if (!normalized) return '这条回复暂无可预览内容'
  const chars = Array.from(normalized)
  if (chars.length <= maxChars) return normalized
  return `${chars.slice(0, Math.max(maxChars - 1, 1)).join('')}…`
}

export function extractFavoriteUserQuestionSnapshot(content: string): string | null {
  if (!content || hasSyntheticToolAttachmentMarker(content)) return null
  let text = content
  if (content.trim().startsWith('[')) {
    try {
      const parsed = JSON.parse(content)
      if (Array.isArray(parsed)) {
        const textPart = parsed.find((part) => (
          part &&
          typeof part === 'object' &&
          (part as { type?: unknown }).type === 'text' &&
          typeof (part as { text?: unknown }).text === 'string'
        )) as { text: string } | undefined
        text = textPart?.text ?? ''
      }
    } catch {
      text = content
    }
  }

  const stripped = stripSystemReminderText(text)
    .replace(/\s+/g, '')
    .trim()
  return stripped || null
}

export async function createMessageFavorite(
  userId: string,
  sessionId: string,
  messageId: string,
  logger: Logger,
): Promise<CreateMessageFavoriteResult> {
  const db = getDb()
  const existing = await db.query.messageFavorites.findFirst({
    where: and(
      eq(messageFavorites.userId, userId),
      eq(messageFavorites.messageId, messageId),
    ),
  })
  if (existing) {
    return { status: 'exists', favorite: serializeFavorite(existing) }
  }

  const [target] = await db
    .select({
      messageId: messages.id,
      sessionId: messages.sessionId,
      role: messages.role,
      content: messages.content,
      interrupted: messages.interrupted,
      messageCreatedAt: messages.createdAt,
      sessionTitle: chatSessions.title,
    })
    .from(messages)
    .innerJoin(chatSessions, eq(messages.sessionId, chatSessions.id))
    .where(
      and(
        eq(messages.id, messageId),
        eq(messages.sessionId, sessionId),
        eq(chatSessions.userId, userId),
      ),
    )
    .limit(1)

  if (!target) {
    logger.warn({ userId, sessionId, messageId }, 'message favorite target not found')
    return { status: 'not_found' }
  }
  if (target.role !== 'assistant' || target.interrupted || target.content.trim().length === 0) {
    logger.warn({ userId, sessionId, messageId, role: target.role, interrupted: target.interrupted }, 'invalid message favorite target')
    return { status: 'invalid_target' }
  }

  const userQuestion = await findPreviousRealUserMessageSnapshot(sessionId, target.messageCreatedAt)
  const now = new Date()
  const [inserted] = await db
    .insert(messageFavorites)
    .values({
      userId,
      sessionId,
      messageId,
      userMessageId: userQuestion?.id ?? null,
      userContentSnapshot: userQuestion?.content ?? null,
      contentSnapshot: target.content,
      contentPreview: buildMessageFavoritePreview(target.content),
      sessionTitleSnapshot: target.sessionTitle,
      messageCreatedAt: target.messageCreatedAt,
      createdAt: now,
      updatedAt: now,
    })
    .returning()

  logger.info({ userId, sessionId, messageId, favoriteId: inserted.id }, 'message favorite created')
  return { status: 'created', favorite: serializeFavorite(inserted) }
}

export async function deleteMessageFavorite(
  userId: string,
  sessionId: string,
  messageId: string,
  logger: Logger,
): Promise<boolean> {
  const db = getDb()
  const deleted = await db
    .delete(messageFavorites)
    .where(
      and(
        eq(messageFavorites.userId, userId),
        eq(messageFavorites.sessionId, sessionId),
        eq(messageFavorites.messageId, messageId),
      ),
    )
    .returning({ id: messageFavorites.id })

  logger.info({ userId, sessionId, messageId, deleted: deleted.length > 0 }, 'message favorite deleted')
  return deleted.length > 0
}

export async function listMessageFavorites(
  userId: string,
  logger: Logger,
  opts: { before?: Date; limit?: number } = {},
): Promise<MessageFavoriteListResponse> {
  const db = getDb()
  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_FAVORITE_LIST_LIMIT, 1), MAX_FAVORITE_LIST_LIMIT)
  const whereClause = opts.before
    ? and(eq(messageFavorites.userId, userId), lt(messageFavorites.createdAt, opts.before))
    : eq(messageFavorites.userId, userId)
  const rows = await db.query.messageFavorites.findMany({
    where: whereClause,
    orderBy: desc(messageFavorites.createdAt),
    limit: limit + 1,
  })
  const hasMore = rows.length > limit
  const items = (hasMore ? rows.slice(0, limit) : rows).map(serializeFavorite)
  const nextCursor = hasMore && items.length > 0 ? items[items.length - 1].createdAt : null

  logger.info({ userId, count: items.length, hasMore }, 'message favorites listed')
  return { items, hasMore, nextCursor }
}

export async function getSessionMessageFavoriteIds(
  userId: string,
  sessionId: string,
  logger: Logger,
): Promise<string[]> {
  const db = getDb()
  const rows = await db.query.messageFavorites.findMany({
    where: and(
      eq(messageFavorites.userId, userId),
      eq(messageFavorites.sessionId, sessionId),
    ),
    columns: { messageId: true },
  })

  logger.info({ userId, sessionId, count: rows.length }, 'session message favorites fetched')
  return rows.map((row) => row.messageId)
}

async function findPreviousRealUserMessageSnapshot(
  sessionId: string,
  before: Date,
): Promise<{ id: string; content: string } | null> {
  const rows = await getDb().query.messages.findMany({
    where: and(
      eq(messages.sessionId, sessionId),
      eq(messages.role, 'user'),
      lt(messages.createdAt, before),
    ),
    orderBy: desc(messages.createdAt),
    limit: 20,
    columns: {
      id: true,
      content: true,
    },
  })

  for (const row of rows) {
    const content = extractFavoriteUserQuestionSnapshot(row.content)
    if (content) return { id: row.id, content }
  }
  return null
}

function serializeFavorite(row: FavoriteRow): MessageFavoriteRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    messageId: row.messageId,
    userMessageId: row.userMessageId,
    userContentSnapshot: row.userContentSnapshot,
    contentSnapshot: row.contentSnapshot,
    contentPreview: row.contentPreview,
    sessionTitle: row.sessionTitleSnapshot,
    messageCreatedAt: row.messageCreatedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

function stripAnswerTags(text: string): string {
  return text.replace(/<\/?final_answer>/g, '').replace(/<\/?response>/g, '')
}

function stripXmlLikeTags(text: string): string {
  return text.replace(
    /<\/?[A-Za-z][A-Za-z0-9:_-]*(?:\s+[A-Za-z_:][\w:.-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|“[^”]*”|‘[^’]*’|[^\s"'=<>`]+))?)*\s*\/?>/g,
    '',
  )
}
