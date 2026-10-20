import { pgTable, uuid, varchar, timestamp, index } from 'drizzle-orm/pg-core'
import { messages } from './messages.js'
import { chatSessions } from './sessions.js'
import { users } from './users.js'

export const messageFeedback = pgTable(
  'message_feedback',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    messageId: uuid('message_id').notNull().references(() => messages.id),
    sessionId: uuid('session_id').notNull().references(() => chatSessions.id),
    userId: uuid('user_id').notNull().references(() => users.id),
    rating: varchar('rating', { length: 10 }).notNull(), // 'like' | 'dislike'
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_feedback_message').on(table.messageId),
    index('idx_feedback_session').on(table.sessionId),
    index('idx_feedback_user').on(table.userId),
  ],
)
