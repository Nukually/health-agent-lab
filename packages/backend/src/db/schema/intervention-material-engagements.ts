import {
  pgTable,
  uuid,
  varchar,
  integer,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import type { InterventionEffectFollowupStatus } from '@health-agent/shared'
import { users } from './users.js'
import { chatSessions } from './sessions.js'
import { messages } from './messages.js'

export const interventionMaterialEngagements = pgTable(
  'intervention_material_engagements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id').notNull().references(() => chatSessions.id, { onDelete: 'cascade' }),
    toolCallId: varchar('tool_call_id', { length: 120 }).notNull(),
    materialId: varchar('material_id', { length: 120 }).notNull(),
    materialVersion: varchar('material_version', { length: 120 }).notNull(),
    materialCode: varchar('material_code', { length: 20 }).notNull(),
    materialDurationSec: integer('material_duration_sec').notNull().default(0),
    savedAt: timestamp('saved_at', { withTimezone: true }),
    viewedAt: timestamp('viewed_at', { withTimezone: true }),
    followStartedAt: timestamp('follow_started_at', { withTimezone: true }),
    followCompletedAt: timestamp('follow_completed_at', { withTimezone: true }),
    totalFollowSec: integer('total_follow_sec').notNull().default(0),
    completedStepCount: integer('completed_step_count').notNull().default(0),
    totalStepCount: integer('total_step_count').notNull().default(0),
    lastStepIndex: integer('last_step_index'),
    reminderConsumedAt: timestamp('reminder_consumed_at', { withTimezone: true }),
    effectFollowupDueAt: timestamp('effect_followup_due_at', { withTimezone: true }),
    effectFollowupStatus: varchar('effect_followup_status', { length: 20 })
      .$type<InterventionEffectFollowupStatus>()
      .notNull()
      .default('none'),
    effectFollowupSentAt: timestamp('effect_followup_sent_at', { withTimezone: true }),
    effectFollowupMessageId: uuid('effect_followup_message_id')
      .references(() => messages.id, { onDelete: 'set null' }),
    effectFollowupAttemptCount: integer('effect_followup_attempt_count').notNull().default(0),
    effectFollowupLastError: varchar('effect_followup_last_error', { length: 1000 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('idx_intervention_engagement_session_tool').on(table.sessionId, table.toolCallId),
    index('idx_intervention_engagement_user_saved').on(table.userId, table.savedAt),
    index('idx_intervention_engagement_user_updated').on(table.userId, table.updatedAt),
    index('idx_intervention_engagement_session_updated').on(table.sessionId, table.updatedAt),
    index('idx_intervention_effect_followup_due').on(table.effectFollowupStatus, table.effectFollowupDueAt),
  ],
)
