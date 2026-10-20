import { pgTable, uuid, varchar, date, integer, jsonb, timestamp, index } from 'drizzle-orm/pg-core'
import { users } from './users.js'
import type { CommunicationCardContent } from '@health-agent/shared'

export const communicationCards = pgTable(
  'communication_cards',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id),
    title: varchar('title', { length: 200 }).notNull(),
    cardDate: date('card_date').notNull(),
    templateVersion: integer('template_version').notNull().default(1),
    sourceSessionId: uuid('source_session_id'),
    contentJson: jsonb('content_json').$type<CommunicationCardContent>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_communication_cards_user_date').on(table.userId, table.cardDate),
  ],
)
