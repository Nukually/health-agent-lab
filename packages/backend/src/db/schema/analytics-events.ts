import { pgTable, uuid, varchar, integer, timestamp, jsonb, index, uniqueIndex } from 'drizzle-orm/pg-core'
import type { AnalyticsEventName } from '@health-agent/shared'
import { users } from './users.js'
import { chatSessions } from './sessions.js'

export const analyticsEvents = pgTable(
  'analytics_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    eventName: varchar('event_name', { length: 80 }).$type<AnalyticsEventName>().notNull(),
    dedupeKey: varchar('dedupe_key', { length: 160 }),
    sessionId: uuid('session_id').references(() => chatSessions.id, { onDelete: 'cascade' }),
    entityType: varchar('entity_type', { length: 80 }),
    entityId: varchar('entity_id', { length: 160 }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    durationMs: integer('duration_ms'),
    properties: jsonb('properties').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('uniq_analytics_events_user_name_dedupe').on(table.userId, table.eventName, table.dedupeKey),
    index('idx_analytics_events_user_created').on(table.userId, table.createdAt),
    index('idx_analytics_events_name_created').on(table.eventName, table.createdAt),
    index('idx_analytics_events_session_created').on(table.sessionId, table.createdAt),
  ],
)
