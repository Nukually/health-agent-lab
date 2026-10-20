import { index, pgTable, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core'

export const channelPartners = pgTable(
  'channel_partners',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    code: varchar('code', { length: 64 }).notNull().unique(),
    name: varchar('name', { length: 120 }).notNull(),
    status: varchar('status', { length: 20 }).notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_channel_partners_status').on(table.status),
  ],
)

export const channelAgents = pgTable(
  'channel_agents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    partnerId: uuid('partner_id').notNull().references(() => channelPartners.id, { onDelete: 'cascade' }),
    code: varchar('code', { length: 64 }).notNull(),
    name: varchar('name', { length: 120 }).notNull(),
    status: varchar('status', { length: 20 }).notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('uniq_channel_agents_partner_code').on(table.partnerId, table.code),
    index('idx_channel_agents_partner').on(table.partnerId),
    index('idx_channel_agents_status').on(table.status),
  ],
)

export const channelQrCodes = pgTable(
  'channel_qr_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    partnerId: uuid('partner_id').notNull().references(() => channelPartners.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id').notNull().references(() => channelAgents.id, { onDelete: 'cascade' }),
    code: varchar('code', { length: 80 }).notNull().unique(),
    url: varchar('url', { length: 500 }).notNull(),
    status: varchar('status', { length: 20 }).notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_channel_qr_codes_partner').on(table.partnerId),
    index('idx_channel_qr_codes_agent').on(table.agentId),
    index('idx_channel_qr_codes_status').on(table.status),
  ],
)
