import {
  pgTable,
  uuid,
  text,
  date,
  jsonb,
  integer,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import { users } from './users.js'

export const userDailyStructuredProfiles = pgTable(
  'user_daily_structured_profiles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    profileDate: date('profile_date').notNull(),
    fields: jsonb('fields').$type<Record<string, unknown>>().notNull().default({}),
    schemaFields: text('schema_fields').array().notNull().default([]),
    modelUsed: text('model_used'),
    attempts: integer('attempts').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('idx_user_daily_sp_user_date').on(table.userId, table.profileDate),
    index('idx_user_daily_sp_date').on(table.profileDate),
  ],
)
