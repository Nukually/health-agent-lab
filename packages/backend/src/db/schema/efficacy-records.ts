import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core'
import type {
  EfficacyAdoptionStatus,
  EfficacyCadence,
  EfficacyEvidence,
  EfficacyOutcome,
  EfficacyStatus,
} from '@health-agent/shared'
import { users } from './users.js'
import { chatSessions } from './sessions.js'
import { messages } from './messages.js'

/** 干预方案疗效档案：按"问题维度"记录 AI 方案的采纳与疗效，可跨 session 更新。 */
export const interventionEfficacyRecords = pgTable(
  'intervention_efficacy_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    problem: text('problem').notNull(),
    finalPlan: text('final_plan').notNull(),
    cadence: varchar('cadence', { length: 20 }).$type<EfficacyCadence>().notNull().default('oneshot'),
    expectedEndAt: timestamp('expected_end_at', { withTimezone: true }),
    adoptionStatus: varchar('adoption_status', { length: 20 }).$type<EfficacyAdoptionStatus>().notNull().default('unknown'),
    outcome: varchar('outcome', { length: 20 }).$type<EfficacyOutcome>().notNull().default('no_feedback'),
    status: varchar('status', { length: 20 }).$type<EfficacyStatus>().notNull().default('active'),
    evidence: jsonb('evidence').$type<EfficacyEvidence>().notNull().default({}),
    confidence: integer('confidence').notNull().default(70),
    sourceSessionIds: uuid('source_session_ids').array().notNull().default([]),
    firstSourceMessageId: uuid('first_source_message_id').references(() => messages.id, { onDelete: 'set null' }),
    lastSourceMessageId: uuid('last_source_message_id').references(() => messages.id, { onDelete: 'set null' }),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userStatusUpdatedIdx: index('idx_efficacy_records_user_status_updated').on(table.userId, table.status, table.updatedAt),
    userAdoptionIdx: index('idx_efficacy_records_user_adoption').on(table.userId, table.adoptionStatus),
    userOutcomeIdx: index('idx_efficacy_records_user_outcome').on(table.userId, table.outcome),
  }),
)

/** 每个 session 的疗效分析水位线与状态（增量分析只看水位线之后的新消息）。 */
export const efficacySessionAnalysisState = pgTable(
  'efficacy_session_analysis_state',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id').notNull().references(() => chatSessions.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    analyzedUpToCreatedAt: timestamp('analyzed_up_to_created_at', { withTimezone: true }),
    lastAnalyzedAt: timestamp('last_analyzed_at', { withTimezone: true }),
    analysisCount: integer('analysis_count').notNull().default(0),
    lastError: varchar('last_error', { length: 1000 }),
    failureCount: integer('failure_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sessionIdx: uniqueIndex('idx_efficacy_analysis_state_session').on(table.sessionId),
  }),
)
