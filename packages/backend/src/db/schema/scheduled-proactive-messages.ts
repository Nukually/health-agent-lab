import { pgTable, uuid, varchar, text, integer, timestamp, jsonb, index, uniqueIndex, boolean } from 'drizzle-orm/pg-core'
import type {
  PushPlatform,
  ScheduledProactiveMessageScheduleType,
  ScheduledProactiveMessagePurpose,
  ScheduledProactiveMessageStatus,
  ScheduledProactiveMessageTimeSource,
  ScheduledTaskCalendarSyncStatus,
} from '@health-agent/shared'
import { users } from './users.js'
import { chatSessions } from './sessions.js'
import { messages } from './messages.js'

export const scheduledProactiveMessages = pgTable(
  'scheduled_proactive_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id').notNull().references(() => chatSessions.id, { onDelete: 'cascade' }),
    purpose: varchar('purpose', { length: 80 }).$type<ScheduledProactiveMessagePurpose>().notNull(),
    taskName: varchar('task_name', { length: 120 }).notNull().default('提醒'),
    timeSource: varchar('time_source', { length: 40 }).$type<ScheduledProactiveMessageTimeSource>().notNull(),
    scheduleType: varchar('schedule_type', { length: 20 })
      .$type<ScheduledProactiveMessageScheduleType>()
      .notNull()
      .default('once'),
    cronExpression: varchar('cron_expression', { length: 160 }),
    timezone: varchar('timezone', { length: 64 }).notNull().default('Asia/Shanghai'),
    dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
    lastDueAt: timestamp('last_due_at', { withTimezone: true }),
    status: varchar('status', { length: 40 }).$type<ScheduledProactiveMessageStatus>().notNull().default('pending'),
    messageContent: text('message_content').notNull(),
    pushTitle: varchar('push_title', { length: 120 }).notNull().default('Health Agent Lab'),
    pushAlert: varchar('push_alert', { length: 500 }).notNull(),
    appNotifyEnabled: boolean('app_notify_enabled').notNull().default(true),
    calendarSyncEnabled: boolean('calendar_sync_enabled').notNull().default(true),
    route: varchar('route', { length: 500 }),
    entityType: varchar('entity_type', { length: 80 }),
    entityId: varchar('entity_id', { length: 160 }),
    dedupeKey: varchar('dedupe_key', { length: 160 }),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    attemptCount: integer('attempt_count').notNull().default(0),
    lastError: varchar('last_error', { length: 1000 }),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    messageId: uuid('message_id').references(() => messages.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_scheduled_proactive_due').on(table.status, table.dueAt),
    index('idx_scheduled_proactive_user_created').on(table.userId, table.createdAt),
    index('idx_scheduled_proactive_entity_status').on(table.entityType, table.entityId, table.status),
    index('idx_scheduled_proactive_dedupe').on(table.dedupeKey),
  ],
)

export const scheduledTaskCalendarLinks = pgTable(
  'scheduled_task_calendar_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    scheduledTaskId: uuid('scheduled_task_id')
      .notNull()
      .references(() => scheduledProactiveMessages.id, { onDelete: 'cascade' }),
    platform: varchar('platform', { length: 20 }).$type<PushPlatform>().notNull(),
    deviceKey: varchar('device_key', { length: 256 }).notNull(),
    externalIds: jsonb('external_ids').$type<string[]>(),
    planHash: varchar('plan_hash', { length: 120 }),
    syncStatus: varchar('sync_status', { length: 40 })
      .$type<ScheduledTaskCalendarSyncStatus>()
      .notNull()
      .default('pending'),
    lastError: varchar('last_error', { length: 1000 }),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('uniq_scheduled_task_calendar_device').on(
      table.scheduledTaskId,
      table.platform,
      table.deviceKey,
    ),
    index('idx_scheduled_task_calendar_user_device').on(table.userId, table.platform, table.deviceKey),
    index('idx_scheduled_task_calendar_status').on(table.syncStatus, table.updatedAt),
  ],
)
