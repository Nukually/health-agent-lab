import { pgTable, uuid, text, varchar, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core'
import { users } from './users.js'
import { chatSessions } from './sessions.js'
import { messages } from './messages.js'

export const messageFavorites = pgTable(
  'message_favorites',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id').notNull().references(() => chatSessions.id, { onDelete: 'cascade' }),
    messageId: uuid('message_id').notNull().references(() => messages.id, { onDelete: 'cascade' }),
    userMessageId: uuid('user_message_id').references(() => messages.id, { onDelete: 'set null' }),
    userContentSnapshot: text('user_content_snapshot'),
    contentSnapshot: text('content_snapshot').notNull(),
    contentPreview: varchar('content_preview', { length: 240 }).notNull(),
    sessionTitleSnapshot: varchar('session_title_snapshot', { length: 200 }),
    messageCreatedAt: timestamp('message_created_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('uniq_message_favorites_user_message').on(table.userId, table.messageId),
    index('idx_message_favorites_user_created').on(table.userId, table.createdAt.desc()),
    index('idx_message_favorites_session').on(table.sessionId),
    index('idx_message_favorites_message').on(table.messageId),
  ],
)
