import { pgTable, uuid, varchar, integer, timestamp, jsonb, index, uniqueIndex, text } from 'drizzle-orm/pg-core'
import type {
  RecommendedQuestionBatchStatus,
  RecommendedQuestionItemStatus,
  RecommendedQuestionRiskLevel,
  RecommendedQuestionSource,
  RecommendedQuestionTrigger,
} from '@health-agent/shared'
import { users } from './users.js'
import { userProfilesMemory } from './user-profiles-memory.js'

export const recommendedQuestionBatches = pgTable(
  'recommended_question_batches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    sourceDate: varchar('source_date', { length: 10 }).notNull(),
    trigger: varchar('trigger', { length: 40 }).$type<RecommendedQuestionTrigger>().notNull().default('profile_generation'),
    sourceProfileMemoryId: uuid('source_profile_memory_id').references(() => userProfilesMemory.id, { onDelete: 'set null' }),
    sourceHash: varchar('source_hash', { length: 80 }).notNull(),
    status: varchar('status', { length: 24 }).$type<RecommendedQuestionBatchStatus>().notNull().default('failed'),
    model: varchar('model', { length: 120 }),
    candidateCount: integer('candidate_count').notNull().default(0),
    selectedCount: integer('selected_count').notNull().default(0),
    fallbackCount: integer('fallback_count').notNull().default(0),
    errorCode: varchar('error_code', { length: 80 }),
    errorMessage: text('error_message'),
    generatedAt: timestamp('generated_at', { withTimezone: true }).notNull().defaultNow(),
    finalizedAt: timestamp('finalized_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('uniq_recommended_question_batches_user_date_trigger').on(table.userId, table.sourceDate, table.trigger),
    index('idx_recommended_question_batches_user_status_expires').on(table.userId, table.status, table.expiresAt),
    index('idx_recommended_question_batches_profile_memory').on(table.sourceProfileMemoryId),
  ],
)

export const recommendedQuestionItems = pgTable(
  'recommended_question_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    batchId: uuid('batch_id').notNull().references(() => recommendedQuestionBatches.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    itemStatus: varchar('item_status', { length: 24 }).$type<RecommendedQuestionItemStatus>().notNull(),
    source: varchar('source', { length: 20 }).$type<RecommendedQuestionSource>().notNull(),
    text: varchar('text', { length: 120 }).notNull(),
    normalizedText: varchar('normalized_text', { length: 160 }).notNull(),
    textHash: varchar('text_hash', { length: 80 }).notNull(),
    semanticKey: varchar('semantic_key', { length: 240 }).notNull(),
    topic: varchar('topic', { length: 80 }).notNull(),
    intent: varchar('intent', { length: 80 }).notNull(),
    keywords: jsonb('keywords').$type<string[] | null>(),
    reason: varchar('reason', { length: 500 }),
    rawRank: integer('raw_rank'),
    rank: integer('rank'),
    confidence: integer('confidence'),
    riskLevel: varchar('risk_level', { length: 20 }).$type<RecommendedQuestionRiskLevel | null>(),
    finalScore: integer('final_score'),
    qualityScore: integer('quality_score'),
    riskFlags: jsonb('risk_flags').$type<string[] | null>(),
    filterReason: varchar('filter_reason', { length: 80 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_recommended_question_items_batch_status_rank').on(table.userId, table.batchId, table.itemStatus, table.rank),
    index('idx_recommended_question_items_text_hash').on(table.userId, table.textHash, table.createdAt),
    index('idx_recommended_question_items_semantic').on(table.userId, table.semanticKey, table.createdAt),
    index('idx_recommended_question_items_topic').on(table.userId, table.topic, table.createdAt),
  ],
)
