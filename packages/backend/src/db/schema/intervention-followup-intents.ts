import { pgTable, uuid, varchar, timestamp, jsonb, index } from 'drizzle-orm/pg-core'
import type {
  InterventionFollowupIntentKind,
  InterventionFollowupIntentStatus,
} from '@health-agent/shared'
import { users } from './users.js'
import { chatSessions } from './sessions.js'
import { messages } from './messages.js'
import { interventionMaterialEngagements } from './intervention-material-engagements.js'

export const interventionFollowupIntents = pgTable(
  'intervention_followup_intents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id').notNull().references(() => chatSessions.id, { onDelete: 'cascade' }),
    engagementId: uuid('engagement_id').references(() => interventionMaterialEngagements.id, { onDelete: 'cascade' }),
    kind: varchar('kind', { length: 40 }).$type<InterventionFollowupIntentKind>().notNull(),
    status: varchar('status', { length: 40 }).$type<InterventionFollowupIntentStatus>().notNull().default('pending'),
    claimToken: varchar('claim_token', { length: 120 }),
    generatedMessageId: uuid('generated_message_id').references(() => messages.id, { onDelete: 'set null' }),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_intervention_followup_intents_session_status').on(table.sessionId, table.status, table.createdAt),
    index('idx_intervention_followup_intents_engagement_status').on(table.engagementId, table.status, table.createdAt),
  ],
)
