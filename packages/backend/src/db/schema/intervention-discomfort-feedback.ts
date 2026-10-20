import {
  index,
  integer,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import type {
  InterventionDiscomfortFeedbackResourceKind,
  InterventionDiscomfortFeedbackTiming,
  InterventionMaterialInteractionSource,
} from '@health-agent/shared'
import { users } from './users.js'
import { chatSessions } from './sessions.js'
import { interventionMaterialEngagements } from './intervention-material-engagements.js'

export const interventionDiscomfortFeedback = pgTable(
  'intervention_discomfort_feedback',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id').notNull().references(() => chatSessions.id, { onDelete: 'cascade' }),
    resourceKind: varchar('resource_kind', { length: 40 })
      .$type<InterventionDiscomfortFeedbackResourceKind>()
      .notNull(),
    resourceId: varchar('resource_id', { length: 160 }).notNull(),
    resourceTitle: varchar('resource_title', { length: 240 }),
    resourceContext: varchar('resource_context', { length: 160 }),
    toolCallId: varchar('tool_call_id', { length: 120 }),
    engagementId: uuid('engagement_id')
      .references(() => interventionMaterialEngagements.id, { onDelete: 'set null' }),
    timing: varchar('timing', { length: 10 })
      .$type<InterventionDiscomfortFeedbackTiming>()
      .notNull(),
    score: integer('score').notNull(),
    source: varchar('source', { length: 20 })
      .$type<InterventionMaterialInteractionSource>()
      .notNull()
      .default('chat_inline'),
    totalFollowSec: integer('total_follow_sec'),
    materialDurationSec: integer('material_duration_sec'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('uniq_intervention_discomfort_feedback_resource_timing')
      .on(table.userId, table.sessionId, table.resourceKind, table.resourceId, table.timing),
    index('idx_intervention_discomfort_feedback_session_created').on(table.sessionId, table.createdAt),
    index('idx_intervention_discomfort_feedback_user_created').on(table.userId, table.createdAt),
  ],
)
