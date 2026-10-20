import { pgTable, varchar, timestamp } from 'drizzle-orm/pg-core'

export const doctors = pgTable('doctors', {
  id: varchar('id', { length: 120 }).primaryKey(),
  doctorInviteCode: varchar('doctor_invite_code', { length: 120 }),
  name: varchar('name', { length: 100 }).notNull(),
  avatarUrl: varchar('avatar_url', { length: 500 }),
  hospital: varchar('hospital', { length: 200 }),
  department: varchar('department', { length: 100 }),
  title: varchar('title', { length: 100 }),
  phone: varchar('phone', { length: 20 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})
