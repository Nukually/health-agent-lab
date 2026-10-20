import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { getDb } from '../db/client.js'
import { userMemoryEmbeddings, userMemoryItems } from '../db/schema/index.js'
import { MemoryContentRejectedError, scanMemoryContentForStorage } from './memory.js'
import { createMemoryEmbedding, getMemoryEmbeddingModel } from './embeddings.js'
import type { Logger } from '../lib/logger.js'

export type UserMemoryItem = typeof userMemoryItems.$inferSelect
export type UserMemorySearchHit = UserMemoryItem & { score: number }
export type UserMemoryTemporalScope =
  | 'stable'
  | 'current_state'
  | 'episodic'
  | 'scheduled'
  | 'historical'

export type UserMemoryItemType =
  | 'communication_preference'
  | 'caregiver_context'
  | 'treatment_experience'
  | 'symptom_pattern'
  | 'emotional_pattern'
  | 'life_context'
  | 'other'

export interface CreateUserMemoryItemInput {
  userId: string
  memoryType: UserMemoryItemType
  content: string
  source?: string
  sourceSessionId?: string | null
  sourceMessageId?: string | null
  importance?: number
  confidence?: number
  metadata?: Record<string, unknown>
}

export interface UpdateUserMemoryItemInput {
  userId: string
  memoryItemId: string
  content: string
  importance?: number
  confidence?: number
  metadata?: Record<string, unknown>
}

export async function createUserMemoryItem(
  input: CreateUserMemoryItemInput,
  logger: Logger,
): Promise<UserMemoryItem> {
  const content = input.content.trim()
  const scanned = scanMemoryContentForStorage(content)
  if (!scanned.ok) throw new MemoryContentRejectedError(scanned.reasons)

  const [row] = await getDb().insert(userMemoryItems).values({
    userId: input.userId,
    memoryType: input.memoryType,
    content,
    source: input.source ?? 'reviewer',
    sourceSessionId: input.sourceSessionId ?? null,
    sourceMessageId: input.sourceMessageId ?? null,
    importance: input.importance ?? 1,
    confidence: input.confidence ?? 100,
    metadata: input.metadata ?? {},
  }).returning()

  logger.info({ userId: input.userId, memoryItemId: row.id, memoryType: input.memoryType }, 'user memory item created')
  return row
}

export async function updateUserMemoryItem(
  input: UpdateUserMemoryItemInput,
  logger: Logger,
): Promise<UserMemoryItem | null> {
  const content = input.content.trim()
  const scanned = scanMemoryContentForStorage(content)
  if (!scanned.ok) throw new MemoryContentRejectedError(scanned.reasons)

  const [row] = await getDb()
    .update(userMemoryItems)
    .set({
      content,
      importance: input.importance,
      confidence: input.confidence,
      metadata: input.metadata
        ? sql`${userMemoryItems.metadata} || ${JSON.stringify(input.metadata)}::jsonb`
        : undefined,
      updatedAt: new Date(),
    })
    .where(and(
      eq(userMemoryItems.id, input.memoryItemId),
      eq(userMemoryItems.userId, input.userId),
      eq(userMemoryItems.status, 'active'),
    ))
    .returning()

  if (row) {
    logger.info({ userId: input.userId, memoryItemId: row.id }, 'user memory item updated')
  }
  return row ?? null
}

export async function archiveUserMemoryItems(input: {
  userId: string
  memoryItemIds: string[]
  reason: string
  metadata?: Record<string, unknown>
}, logger: Logger): Promise<number> {
  const ids = [...new Set(input.memoryItemIds)].filter(Boolean)
  if (ids.length === 0) return 0

  const archivedAt = new Date()
  const archiveMetadata = {
    archivedReason: input.reason,
    archivedAt: archivedAt.toISOString(),
    ...input.metadata,
  }

  const rows = await getDb()
    .update(userMemoryItems)
    .set({
      status: 'archived',
      archivedAt,
      updatedAt: archivedAt,
      metadata: sql`${userMemoryItems.metadata} || ${JSON.stringify(archiveMetadata)}::jsonb`,
    })
    .where(and(
      eq(userMemoryItems.userId, input.userId),
      eq(userMemoryItems.status, 'active'),
      inArray(userMemoryItems.id, ids),
    ))
    .returning({ id: userMemoryItems.id })

  logger.info(
    { userId: input.userId, archivedCount: rows.length, reason: input.reason },
    'user memory items archived',
  )
  return rows.length
}

export async function listActiveUserMemoryItems(
  userId: string,
  opts: { memoryType?: UserMemoryItemType; limit?: number } = {},
): Promise<UserMemoryItem[]> {
  const where = opts.memoryType
    ? and(
        eq(userMemoryItems.userId, userId),
        eq(userMemoryItems.status, 'active'),
        eq(userMemoryItems.memoryType, opts.memoryType),
      )
    : and(
        eq(userMemoryItems.userId, userId),
        eq(userMemoryItems.status, 'active'),
      )

  return getDb().query.userMemoryItems.findMany({
    where,
    orderBy: desc(userMemoryItems.updatedAt),
    limit: opts.limit ?? 20,
  })
}

export async function upsertUserMemoryEmbedding(input: {
  userId: string
  memoryItemId: string
  embeddingModel: string
  embedding: number[]
  contentHash: string
}): Promise<void> {
  if (input.embedding.length !== 1536) {
    throw new Error(`memory embedding dimension mismatch: expected 1536, got ${input.embedding.length}`)
  }

  const now = new Date()
  await getDb().insert(userMemoryEmbeddings).values({
    userId: input.userId,
    memoryItemId: input.memoryItemId,
    embeddingModel: input.embeddingModel,
    embedding: input.embedding,
    contentHash: input.contentHash,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: [userMemoryEmbeddings.memoryItemId, userMemoryEmbeddings.embeddingModel],
    set: {
      embedding: input.embedding,
      contentHash: input.contentHash,
      updatedAt: now,
    },
  })
}

export async function ensureUserMemoryItemEmbedding(
  item: UserMemoryItem,
  logger: Logger,
): Promise<void> {
  const embedding = await createMemoryEmbedding(item.content, logger)
  await upsertUserMemoryEmbedding({
    userId: item.userId,
    memoryItemId: item.id,
    embeddingModel: embedding.embeddingModel,
    embedding: embedding.embedding,
    contentHash: embedding.contentHash,
  })
}

export async function listActiveUserMemoryItemsMissingEmbedding(
  opts: { embeddingModel?: string; limit?: number } = {},
): Promise<UserMemoryItem[]> {
  const embeddingModel = opts.embeddingModel ?? getMemoryEmbeddingModel()
  const rows = await getDb()
    .select({ item: userMemoryItems })
    .from(userMemoryItems)
    .leftJoin(
      userMemoryEmbeddings,
      and(
        eq(userMemoryEmbeddings.memoryItemId, userMemoryItems.id),
        eq(userMemoryEmbeddings.embeddingModel, embeddingModel),
      ),
    )
    .where(and(
      eq(userMemoryItems.status, 'active'),
      isNull(userMemoryEmbeddings.id),
    ))
    .orderBy(asc(userMemoryItems.createdAt))
    .limit(opts.limit ?? 100)

  return rows.map((row) => row.item)
}

export async function backfillMissingUserMemoryEmbeddings(
  opts: { limit?: number } = {},
  logger: Logger,
): Promise<{ scanned: number; created: number; failed: number }> {
  const log = logger.child({ module: 'memory-embedding-backfill' })
  const items = await listActiveUserMemoryItemsMissingEmbedding({ limit: opts.limit })
  let created = 0
  let failed = 0

  for (const item of items) {
    try {
      await ensureUserMemoryItemEmbedding(item, log)
      created++
    } catch (err) {
      failed++
      log.warn(
        {
          memoryItemId: item.id,
          userId: item.userId,
          error: err instanceof Error ? err.message : String(err),
        },
        'memory embedding backfill failed for item',
      )
    }
  }

  log.info({ scanned: items.length, created, failed }, 'memory embedding backfill completed')
  return { scanned: items.length, created, failed }
}

export async function searchActiveUserMemoryItemsByEmbedding(input: {
  userId: string
  embeddingModel: string
  embedding: number[]
  limit?: number
  minScore?: number
  now?: Date
}): Promise<UserMemorySearchHit[]> {
  if (input.embedding.length !== 1536) {
    throw new Error(`memory embedding dimension mismatch: expected 1536, got ${input.embedding.length}`)
  }

  const vectorText = `[${input.embedding.join(',')}]`
  const distance = sql<number>`${userMemoryEmbeddings.embedding} <=> ${vectorText}::vector`

  const limit = input.limit ?? 6
  const rows = await getDb()
    .select({
      item: userMemoryItems,
      score: sql<number>`1 - (${distance})`,
    })
    .from(userMemoryItems)
    .innerJoin(
      userMemoryEmbeddings,
      and(
        eq(userMemoryEmbeddings.memoryItemId, userMemoryItems.id),
        eq(userMemoryEmbeddings.embeddingModel, input.embeddingModel),
      ),
    )
    .where(and(
      eq(userMemoryItems.userId, input.userId),
      eq(userMemoryItems.status, 'active'),
    ))
    .orderBy(distance)
    .limit(limit * 3)

  const minScore = input.minScore ?? 0.2
  return rows
    .map((row) => ({ ...row.item, score: Number(row.score) }))
    .filter((row) => !isUserMemoryItemExpired(row, input.now ?? new Date()))
    .filter((row) => Number.isFinite(row.score) && row.score >= minScore)
    .slice(0, limit)
}

export function isUserMemoryItemExpired(
  item: Pick<UserMemoryItem, 'metadata'>,
  now: Date = new Date(),
): boolean {
  const expiresAt = metadataString(item, 'expiresAt')
  if (!expiresAt) return false
  const expires = Date.parse(expiresAt)
  return Number.isFinite(expires) && expires <= now.getTime()
}

function metadataString(item: Pick<UserMemoryItem, 'metadata'>, key: string): string | null {
  const value = item.metadata?.[key]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}
