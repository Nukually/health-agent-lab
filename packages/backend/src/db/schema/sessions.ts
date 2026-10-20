import { sql } from 'drizzle-orm'
import { pgTable, uuid, varchar, text, boolean, integer, timestamp, index, jsonb } from 'drizzle-orm/pg-core'
import { users } from './users.js'

export const chatSessions = pgTable(
  'chat_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id),
    title: varchar('title', { length: 200 }),
    summary: text('summary'),
    isActive: boolean('is_active').notNull().default(true),
    messageCount: integer('message_count').notNull().default(0),
    tokenCount: integer('token_count').notNull().default(0),
    // 会话级冻结的 system prompt 快照。除 compaction 外，不允许在会话内漂移。
    promptSnapshot: text('prompt_snapshot'),
    // promptSnapshot 的伴随元数据（当前仅存文档短 ID 顺序 + 干预资料库分组快照）。
    promptSnapshotMeta: jsonb('prompt_snapshot_meta'),
    // 最后一次 compaction 吸收进 summary 的最后一条消息 createdAt。
    // loadSessionMessages 只返回 createdAt > 该值 的消息，防止"压缩 → 下一请求全量重载 → 再压缩"死循环。
    summarizedUpToCreatedAt: timestamp('summarized_up_to_created_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_chat_sessions_user_updated').on(table.userId, table.updatedAt.desc()),
    index('idx_chat_sessions_title_trgm').using('gin', sql`${table.title} gin_trgm_ops`),
  ],
)
