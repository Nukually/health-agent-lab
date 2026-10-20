import { pgTable, uuid, text, date, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core'
import { users } from './users.js'

export const userDailyMemories = pgTable(
  'user_daily_memories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id),
    memoryDate: date('memory_date').notNull(),
    content: text('content').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('idx_daily_memories_user_date').on(table.userId, table.memoryDate),
    index('idx_daily_memories_date').on(table.memoryDate),
  ],
)
