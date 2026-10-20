import { pgTable, uuid, varchar, boolean, timestamp, jsonb, index, uniqueIndex } from 'drizzle-orm/pg-core'
import type {
  ApnsEnvironment,
  NotificationPermissionStatus,
  PushLogStatus,
  PushPlatform,
  PushProvider,
} from '@health-agent/shared'
import { users } from './users.js'

export type {
  NotificationPermissionStatus,
  PushLogStatus,
  PushPlatform,
  PushProvider,
} from '@health-agent/shared'

export const pushDevices = pgTable(
  'push_devices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    platform: varchar('platform', { length: 20 }).$type<PushPlatform>().notNull(),
    provider: varchar('provider', { length: 20 }).$type<PushProvider>().notNull().default('jpush'),
    registrationId: varchar('registration_id', { length: 512 }).notNull(),
    deviceId: varchar('device_id', { length: 256 }),
    appVersion: varchar('app_version', { length: 64 }),
    apnsEnvironment: varchar('apns_environment', { length: 20 }).$type<ApnsEnvironment>(),
    pushEnabled: boolean('push_enabled').notNull().default(true),
    notificationPermission: varchar('notification_permission', { length: 20 })
      .$type<NotificationPermissionStatus>()
      .notNull()
      .default('unknown'),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    unboundAt: timestamp('unbound_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('uniq_push_devices_provider_platform_registration').on(
      table.provider,
      table.platform,
      table.registrationId,
    ),
    index('idx_push_devices_user_platform').on(table.userId, table.platform),
    index('idx_push_devices_user_active').on(table.userId, table.pushEnabled, table.unboundAt),
    index('idx_push_devices_last_seen').on(table.lastSeenAt),
  ],
)

export const pushLogs = pgTable(
  'push_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    platform: varchar('platform', { length: 20 }).$type<PushPlatform | 'all'>().notNull(),
    provider: varchar('provider', { length: 20 }).$type<PushProvider>().notNull().default('jpush'),
    audienceType: varchar('audience_type', { length: 40 }).notNull(),
    audienceValue: varchar('audience_value', { length: 512 }),
    title: varchar('title', { length: 120 }).notNull(),
    alert: varchar('alert', { length: 500 }).notNull(),
    route: varchar('route', { length: 500 }),
    dedupeKey: varchar('dedupe_key', { length: 160 }),
    payload: jsonb('payload').$type<Record<string, unknown>>(),
    providerResponse: jsonb('provider_response').$type<Record<string, unknown>>(),
    providerMsgId: varchar('provider_msg_id', { length: 120 }),
    providerSendno: varchar('provider_sendno', { length: 120 }),
    status: varchar('status', { length: 20 }).$type<PushLogStatus>().notNull().default('pending'),
    errorCode: varchar('error_code', { length: 80 }),
    errorMessage: varchar('error_message', { length: 1000 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_push_logs_user_created').on(table.userId, table.createdAt),
    index('idx_push_logs_status_created').on(table.status, table.createdAt),
    index('idx_push_logs_dedupe').on(table.dedupeKey),
  ],
)
