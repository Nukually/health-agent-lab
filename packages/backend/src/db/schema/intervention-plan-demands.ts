import { index, integer, jsonb, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core'
import { users } from './users.js'
import { chatSessions } from './sessions.js'

/** 干预方案聚合需求：cron 用 LLM 把原始需求合并/去重后的聚合条目（全局，不按 user 隔离，供运营看内容缺口）。 */
export const interventionPlanDemandGroups = pgTable(
  'intervention_plan_demand_groups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    demandCount: integer('demand_count').notNull().default(0),
    status: varchar('status', { length: 20 }).notNull().default('open'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    statusCountIdx: index('idx_plan_demand_groups_status_count').on(table.status, table.demandCount),
  }),
)

/** 干预方案需求：generate_plan 内部干预卡匹配为 0 时采集的原始需求（append-only，按 query 落库，保留溯源）。 */
export const interventionPlanDemands = pgTable(
  'intervention_plan_demands',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    searchQuery: text('search_query').notNull(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id').references(() => chatSessions.id, { onDelete: 'set null' }),
    status: varchar('status', { length: 20 }).notNull().default('pending'),
    mergedIntoId: uuid('merged_into_id').references(() => interventionPlanDemandGroups.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    statusCreatedIdx: index('idx_plan_demands_status_created').on(table.status, table.createdAt),
    mergedIntoIdx: index('idx_plan_demands_merged_into').on(table.mergedIntoId),
  }),
)
