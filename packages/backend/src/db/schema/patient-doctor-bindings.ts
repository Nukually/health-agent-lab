import { pgTable, uuid, varchar, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core'
import { users } from './users.js'
import { doctors } from './doctors.js'

export const patientDoctorBindings = pgTable(
  'patient_doctor_bindings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    doctorId: varchar('doctor_id', { length: 120 }).notNull().references(() => doctors.id),
    status: varchar('status', { length: 30 }).notNull().default('pending_confirmation'),
    unbindRequestedBy: varchar('unbind_requested_by', { length: 20 }),
    boundAt: timestamp('bound_at', { withTimezone: true }).notNull().defaultNow(),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    unboundAt: timestamp('unbound_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('idx_patient_doctor_bindings_user_doctor').on(table.userId, table.doctorId),
    index('idx_patient_doctor_bindings_user').on(table.userId),
    index('idx_patient_doctor_bindings_doctor').on(table.doctorId),
    index('idx_patient_doctor_bindings_status').on(table.status),
  ],
)
