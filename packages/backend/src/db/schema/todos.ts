import {
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import type {
  TodoFeedback,
  TodoItemClosedReason,
  TodoItemStatus,
  MedicalRiskResource,
  TodoPlanSourceType,
  TodoPlanStatus,
} from '@health-agent/shared'
import { users } from './users.js'
import { chatSessions } from './sessions.js'
import { scheduledProactiveMessages } from './scheduled-proactive-messages.js'

export const todoPlans = pgTable(
  'todo_plans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id').notNull().references(() => chatSessions.id, { onDelete: 'cascade' }),
    title: varchar('title', { length: 160 }).notNull(),
    status: varchar('status', { length: 32 }).$type<TodoPlanStatus>().notNull().default('not_started'),
    timezone: varchar('timezone', { length: 64 }).notNull().default('Asia/Shanghai'),
    sourceType: varchar('source_type', { length: 32 }).$type<TodoPlanSourceType>().notNull().default('custom'),
    sourceId: varchar('source_id', { length: 160 }),
    resourceRefId: varchar('resource_ref_id', { length: 80 }),
    courseDays: integer('course_days'),
    targetSideEffect: varchar('target_side_effect', { length: 120 }),
    resourceSnapshot: jsonb('resource_snapshot').$type<MedicalRiskResource | null>(),
    dedupeKey: varchar('dedupe_key', { length: 160 }),
    todosMd: text('todos_md').notNull().default(''),
    stoppedReason: varchar('stopped_reason', { length: 500 }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    stoppedAt: timestamp('stopped_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_todo_plans_user_status_updated').on(table.userId, table.status, table.updatedAt),
    index('idx_todo_plans_session_updated').on(table.sessionId, table.updatedAt),
    index('idx_todo_plans_source').on(table.sourceType, table.sourceId),
    index('idx_todo_plans_dedupe').on(table.userId, table.dedupeKey),
  ],
)

export const todoItems = pgTable(
  'todo_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    planId: uuid('plan_id').notNull().references(() => todoPlans.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id').notNull().references(() => chatSessions.id, { onDelete: 'cascade' }),
    scheduleId: uuid('schedule_id').references(() => scheduledProactiveMessages.id, { onDelete: 'set null' }),
    todoDate: date('todo_date').notNull(),
    todoTime: varchar('todo_time', { length: 5 }).notNull(),
    showPrompt: varchar('show_prompt', { length: 500 }).notNull(),
    prompt: text('prompt').notNull(),
    status: varchar('status', { length: 32 }).$type<TodoItemStatus>().notNull().default('pending'),
    feedback: varchar('feedback', { length: 20 }).$type<TodoFeedback>(),
    notifiedAt: timestamp('notified_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    closedReason: varchar('closed_reason', { length: 80 }).$type<TodoItemClosedReason>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_todo_items_plan_time').on(table.planId, table.todoDate, table.todoTime),
    index('idx_todo_items_user_status_time').on(table.userId, table.status, table.todoDate, table.todoTime),
    uniqueIndex('uniq_todo_items_schedule').on(table.scheduleId),
  ],
)
