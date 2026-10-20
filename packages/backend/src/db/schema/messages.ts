import { sql } from 'drizzle-orm'
import { pgTable, uuid, text, integer, jsonb, timestamp, pgEnum, index, boolean, doublePrecision } from 'drizzle-orm/pg-core'
import { chatSessions } from './sessions.js'

export const messageRoleEnum = pgEnum('message_role', ['user', 'assistant', 'system', 'tool'])

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id').notNull().references(() => chatSessions.id),
    role: messageRoleEnum('role').notNull(),
    content: text('content').notNull(),
    thinking: text('thinking'),
    toolCalls: jsonb('tool_calls').$type<unknown[]>(),
    rawResponse: jsonb('raw_response'),
    tokenCount: integer('token_count'),
    llmInputTokens: integer('llm_input_tokens'),
    llmCachedInputTokens: integer('llm_cached_input_tokens'),
    llmCacheCreationInputTokens: integer('llm_cache_creation_input_tokens'),
    processDurationMs: integer('process_duration_ms'),
    outputTps: doublePrecision('output_tps'),
    interrupted: boolean('interrupted').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_messages_session_created').on(table.sessionId, table.createdAt),
    index('idx_messages_content_trgm').using('gin', sql`${table.content} gin_trgm_ops`),
  ],
)
