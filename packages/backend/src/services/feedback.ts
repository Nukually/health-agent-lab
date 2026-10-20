import { eq, and } from 'drizzle-orm'
import { getDb } from '../db/client.js'
import { chatSessions, messageFeedback, messages } from '../db/schema/index.js'
import type { Logger } from '../lib/logger.js'

type FeedbackUpsertResult = 'like' | 'dislike' | null | 'not_found'

export async function upsertFeedback(
  messageId: string,
  sessionId: string,
  userId: string,
  rating: 'like' | 'dislike',
  logger: Logger,
): Promise<FeedbackUpsertResult> {
  const db = getDb()

  const [target] = await db
    .select({ messageId: messages.id })
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
    logger.warn({ messageId, sessionId, userId }, 'feedback target message not found')
    return 'not_found'
  }

  const existing = await db.query.messageFeedback.findFirst({
    where: and(
      eq(messageFeedback.messageId, messageId),
      eq(messageFeedback.userId, userId),
    ),
  })

  if (existing) {
    if (existing.rating === rating) {
      // Same rating → toggle off
      await db.delete(messageFeedback).where(eq(messageFeedback.id, existing.id))
      logger.info({ messageId, userId, action: 'removed' }, 'feedback removed')
      return null
    }
    // Different rating → update
    await db.update(messageFeedback)
      .set({ rating, createdAt: new Date() })
      .where(eq(messageFeedback.id, existing.id))
    logger.info({ messageId, userId, rating, action: 'updated' }, 'feedback updated')
    return rating
  }

  // New feedback
  await db.insert(messageFeedback).values({ messageId, sessionId, userId, rating })
  logger.info({ messageId, userId, rating, action: 'created' }, 'feedback created')
  return rating
}

export async function getSessionFeedback(sessionId: string, userId: string, logger: Logger) {
  const db = getDb()

  const rows = await db.query.messageFeedback.findMany({
    where: and(
      eq(messageFeedback.sessionId, sessionId),
      eq(messageFeedback.userId, userId),
    ),
    columns: {
      messageId: true,
      rating: true,
      createdAt: true,
    },
  })

  logger.info({ sessionId, userId, count: rows.length }, 'session feedback fetched')
  return rows.map((r) => ({
    messageId: r.messageId,
    rating: r.rating as 'like' | 'dislike',
    createdAt: r.createdAt.toISOString(),
  }))
}
