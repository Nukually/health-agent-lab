import { pgTable, uuid, varchar, date, timestamp } from 'drizzle-orm/pg-core'
import type { CurrentConcern } from '@health-agent/shared'
import { channelAgents, channelPartners, channelQrCodes } from './channel.js'

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  phone: varchar('phone', { length: 20 }).notNull().unique(),
  nickname: varchar('nickname', { length: 100 }),
  avatarUrl: varchar('avatar_url', { length: 500 }),
  birthday: date('birthday'),
  gender: varchar('gender', { length: 10 }),
  currentConcern: varchar('current_concern', { length: 64 }).$type<CurrentConcern | null>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  channelPartnerId: uuid('channel_partner_id').references(() => channelPartners.id),
  channelAgentId: uuid('channel_agent_id').references(() => channelAgents.id),
  channelQrCodeId: uuid('channel_qr_code_id').references(() => channelQrCodes.id),
  channelAttributedAt: timestamp('channel_attributed_at', { withTimezone: true }),
  status: varchar('status', { length: 20 }).notNull().default('active'),
  deletionRequestedAt: timestamp('deletion_requested_at', { withTimezone: true }),
})
