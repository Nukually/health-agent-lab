import { jsonb, pgTable, uuid, timestamp } from 'drizzle-orm/pg-core'
import type { InterventionDiscomfortFeedbackSnapshotItem } from '@health-agent/shared'
import { chatSessions } from './sessions.js'
import { messages } from './messages.js'

export const shareTokens = pgTable(
  'share_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id').notNull().references(() => chatSessions.id, { onDelete: 'cascade' }),
    upToMessageId: uuid('up_to_message_id').notNull().references(() => messages.id, { onDelete: 'cascade' }),
    token: uuid('token').notNull().defaultRandom().unique(),
    feedbackSnapshot: jsonb('feedback_snapshot').$type<InterventionDiscomfortFeedbackSnapshotItem[]>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
)
