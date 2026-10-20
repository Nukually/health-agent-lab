import { pgTable, uuid, integer, jsonb, timestamp } from 'drizzle-orm/pg-core'
import { users } from './users.js'
import type { MedicalProfileData } from '@health-agent/shared'

export const medicalRecords = pgTable('medical_records', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id),
  schemaVersion: integer('schema_version').notNull().default(1),
  profileData: jsonb('profile_data').$type<MedicalProfileData>().notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})
