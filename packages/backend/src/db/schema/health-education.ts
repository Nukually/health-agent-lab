import { pgTable, uuid, varchar, text, jsonb, timestamp, index, uniqueIndex, boolean } from 'drizzle-orm/pg-core'
import type { HealthEducationReaction, HealthEducationStatus } from '@health-agent/shared'
import { users } from './users.js'
import { doctors } from './doctors.js'

export const healthEducationItems = pgTable(
  'health_education_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    doctorId: varchar('doctor_id', { length: 120 }).notNull().references(() => doctors.id),
    title: varchar('title', { length: 200 }).notNull(),
    summary: varchar('summary', { length: 500 }),
    content: text('content').notNull(),
    imageUrls: jsonb('image_urls').$type<string[]>().notNull().default([]),
    status: varchar('status', { length: 20 }).$type<HealthEducationStatus>().notNull().default('published'),
    publishedAt: timestamp('published_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_health_education_items_doctor').on(table.doctorId),
    index('idx_health_education_items_status_published').on(table.status, table.publishedAt),
  ],
)

export const healthEducationInteractions = pgTable(
  'health_education_interactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    itemId: varchar('item_id', { length: 64 }).notNull(),
    reaction: varchar('reaction', { length: 10 }).$type<HealthEducationReaction | null>(),
    isFavorited: boolean('is_favorited').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('idx_health_education_interactions_user_item').on(table.userId, table.itemId),
    index('idx_health_education_interactions_item').on(table.itemId),
    index('idx_health_education_interactions_user_favorite').on(table.userId, table.isFavorited),
  ],
)

export const healthEducationViews = pgTable(
  'health_education_views',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    itemId: varchar('item_id', { length: 64 }).notNull(),
    viewId: varchar('view_id', { length: 160 }).notNull(),
    source: varchar('source', { length: 40 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('idx_health_education_views_user_view').on(table.userId, table.viewId),
    index('idx_health_education_views_item').on(table.itemId),
    index('idx_health_education_views_item_user').on(table.itemId, table.userId),
    index('idx_health_education_views_created').on(table.createdAt),
  ],
)
