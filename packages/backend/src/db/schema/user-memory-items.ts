import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, varchar, vector } from 'drizzle-orm/pg-core'
import { users } from './users.js'
import { chatSessions } from './sessions.js'
import { messages } from './messages.js'

export const userMemoryItems = pgTable(
  'user_memory_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    memoryType: varchar('memory_type', { length: 40 }).notNull(),
    content: text('content').notNull(),
    source: varchar('source', { length: 40 }).notNull().default('reviewer'),
    sourceSessionId: uuid('source_session_id').references(() => chatSessions.id, { onDelete: 'set null' }),
    sourceMessageId: uuid('source_message_id').references(() => messages.id, { onDelete: 'set null' }),
    importance: integer('importance').notNull().default(1),
    confidence: integer('confidence').notNull().default(100),
    status: varchar('status', { length: 20 }).notNull().default('active'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (table) => ({
    userStatusUpdatedIdx: index('idx_user_memory_items_user_status_updated').on(table.userId, table.status, table.updatedAt),
    userTypeStatusIdx: index('idx_user_memory_items_user_type_status').on(table.userId, table.memoryType, table.status),
    sourceMessageIdx: index('idx_user_memory_items_source_message').on(table.sourceMessageId),
  }),
)

export const userMemoryEmbeddings = pgTable(
  'user_memory_embeddings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    memoryItemId: uuid('memory_item_id').notNull().references(() => userMemoryItems.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    embeddingModel: varchar('embedding_model', { length: 120 }).notNull(),
    embedding: vector('embedding', { dimensions: 1536 }).notNull(),
    contentHash: varchar('content_hash', { length: 64 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    itemModelIdx: uniqueIndex('idx_user_memory_embeddings_item_model').on(table.memoryItemId, table.embeddingModel),
    userIdx: index('idx_user_memory_embeddings_user').on(table.userId),
    vectorIdx: index('idx_user_memory_embeddings_vector').using('ivfflat', table.embedding.op('vector_cosine_ops')).with({ lists: 100 }),
  }),
)
