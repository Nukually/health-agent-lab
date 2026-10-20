import { and, desc, eq, inArray } from 'drizzle-orm'
import type { BoundDoctor, DoctorBindingStatus } from '@health-agent/shared'
import { getDb } from '../db/client.js'
import { doctors, patientDoctorBindings } from '../db/schema/index.js'
import { ensureDoctorProfile, upsertDoctorProfile } from './doctor-sync.js'
import type { Logger } from '../lib/logger.js'

export const DOCTOR_BINDING_LIMIT = 5

export const ACTIVE_DOCTOR_BINDING_STATUSES = [
  'pending_confirmation',
  'confirmed',
  'pending_unbind',
] as const satisfies readonly DoctorBindingStatus[]

export interface BindDoctorInput {
  userId: string
  doctorId: string
  name: string
  avatarUrl?: string | null
  department?: string | null
  title?: string | null
}

type BindingRow = {
  bindingId: string
  status: string
  unbindRequestedBy: string | null
  createdAt: Date
  confirmedAt: Date | null
  unboundAt: Date | null
  doctorId: string
  doctorInviteCode: string | null
  name: string
  avatarUrl: string | null
  hospital: string | null
  department: string | null
  title: string | null
  phone: string | null
}

function toIso(value: Date | null): string | null {
  return value ? value.toISOString() : null
}

function toBoundDoctor(row: BindingRow): BoundDoctor {
  return {
    bindingId: row.bindingId,
    status: row.status as DoctorBindingStatus,
    unbindRequestedBy: row.unbindRequestedBy as BoundDoctor['unbindRequestedBy'],
    createdAt: row.createdAt.toISOString(),
    confirmedAt: toIso(row.confirmedAt),
    unboundAt: toIso(row.unboundAt),
    doctor: {
      id: row.doctorId,
      doctorInviteCode: row.doctorInviteCode,
      name: row.name,
      avatarUrl: row.avatarUrl,
      hospital: row.hospital,
      department: row.department,
      title: row.title,
      phone: row.phone,
    },
  }
}

async function findBindingsForUser(userId: string, statuses: DoctorBindingStatus[]): Promise<BoundDoctor[]> {
  const db = getDb()
  const rows = await db
    .select({
      bindingId: patientDoctorBindings.id,
      status: patientDoctorBindings.status,
      unbindRequestedBy: patientDoctorBindings.unbindRequestedBy,
      createdAt: patientDoctorBindings.createdAt,
      confirmedAt: patientDoctorBindings.confirmedAt,
      unboundAt: patientDoctorBindings.unboundAt,
      doctorId: doctors.id,
      doctorInviteCode: doctors.doctorInviteCode,
      name: doctors.name,
      avatarUrl: doctors.avatarUrl,
      hospital: doctors.hospital,
      department: doctors.department,
      title: doctors.title,
      phone: doctors.phone,
    })
    .from(patientDoctorBindings)
    .innerJoin(doctors, eq(patientDoctorBindings.doctorId, doctors.id))
    .where(and(
      eq(patientDoctorBindings.userId, userId),
      inArray(patientDoctorBindings.status, statuses),
    ))
    .orderBy(desc(patientDoctorBindings.updatedAt))

  return rows.map(toBoundDoctor)
}

async function findBindingForUser(userId: string, statuses: DoctorBindingStatus[]): Promise<BoundDoctor | null> {
  return (await findBindingsForUser(userId, statuses))[0] ?? null
}

export async function listDoctorBindingsForUser(userId: string): Promise<BoundDoctor[]> {
  return findBindingsForUser(userId, ['pending_confirmation', 'confirmed', 'rejected', 'pending_unbind'])
}

export async function listActiveDoctorBindingsForUser(userId: string): Promise<BoundDoctor[]> {
  return findBindingsForUser(userId, [...ACTIVE_DOCTOR_BINDING_STATUSES])
}

export async function getBoundDoctorForUser(userId: string): Promise<BoundDoctor | null> {
  return findBindingForUser(userId, [...ACTIVE_DOCTOR_BINDING_STATUSES])
}

export async function getDoctorEntryDoctorIdForUser(userId: string): Promise<string | null> {
  const binding = await findBindingForUser(userId, [...ACTIVE_DOCTOR_BINDING_STATUSES])
  return binding?.doctor.id ?? null
}

export async function bindDoctorForUser(input: BindDoctorInput): Promise<BoundDoctor> {
  const db = getDb()
  const now = new Date()
  const doctorId = input.doctorId.trim()

  await upsertDoctorProfile({
    id: doctorId,
    name: input.name.trim(),
    avatarUrl: input.avatarUrl?.trim() || null,
    department: input.department?.trim() || null,
    title: input.title?.trim() || null,
  })

  await db.insert(patientDoctorBindings).values({
    userId: input.userId,
    doctorId,
    status: 'confirmed',
    unbindRequestedBy: null,
    boundAt: now,
    confirmedAt: now,
    unboundAt: null,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: [patientDoctorBindings.userId, patientDoctorBindings.doctorId],
    set: {
      status: 'confirmed',
      unbindRequestedBy: null,
      boundAt: now,
      confirmedAt: now,
      unboundAt: null,
      updatedAt: now,
    },
  })

  const bindings = await listDoctorBindingsForUser(input.userId)
  const binding = bindings.find((item) => item.doctor.id === doctorId)
  if (!binding) throw new Error('绑定医生失败')
  return binding
}

export async function getBoundDoctorIdForUser(userId: string): Promise<string | null> {
  const binding = await findBindingForUser(userId, ['confirmed'])
  return binding?.doctor.id ?? null
}

export async function getBoundDoctorIdsForUser(userId: string): Promise<string[]> {
  return (await findBindingsForUser(userId, ['confirmed'])).map((binding) => binding.doctor.id)
}

type InviteBindPlan =
  | { type: 'reuse_existing'; binding: BoundDoctor }
  | { type: 'create_pending'; doctorId: string }
  | { type: 'max_reached'; limit: number }

export function planInviteBindDoctor(
  existingBindings: BoundDoctor[],
  invitedDoctorId: string,
): InviteBindPlan {
  const doctorId = invitedDoctorId.trim()
  const sameDoctor = existingBindings.find((binding) => binding.doctor.id === doctorId)
  if (sameDoctor) return { type: 'reuse_existing', binding: sameDoctor }
  if (existingBindings.length >= DOCTOR_BINDING_LIMIT) return { type: 'max_reached', limit: DOCTOR_BINDING_LIMIT }
  return { type: 'create_pending', doctorId }
}

export function resolvePatientInitiatedUnbind(binding: BoundDoctor): {
  status: Extract<DoctorBindingStatus, 'pending_unbind' | 'unbound'>
  unbindRequestedBy: BoundDoctor['unbindRequestedBy']
} {
  if (binding.status === 'pending_unbind' && binding.unbindRequestedBy === 'doctor') {
    return { status: 'unbound', unbindRequestedBy: 'doctor' }
  }
  return { status: 'pending_unbind', unbindRequestedBy: 'patient' }
}

export function resolveDoctorInitiatedUnbind(binding: BoundDoctor): {
  status: Extract<DoctorBindingStatus, 'pending_unbind' | 'unbound'>
  unbindRequestedBy: BoundDoctor['unbindRequestedBy']
} {
  if (binding.status === 'pending_unbind' && binding.unbindRequestedBy === 'patient') {
    return { status: 'unbound', unbindRequestedBy: 'patient' }
  }
  return { status: 'pending_unbind', unbindRequestedBy: 'doctor' }
}

export async function getDoctorBindingForUser(params: {
  userId: string
  bindingId: string
  statuses?: DoctorBindingStatus[]
}): Promise<BoundDoctor | null> {
  const bindings = await findBindingsForUser(params.userId, params.statuses ?? [
    'pending_confirmation',
    'confirmed',
    'rejected',
    'pending_unbind',
  ])
  return bindings.find((binding) => binding.bindingId === params.bindingId) ?? null
}

export async function requestUnbindDoctorForUser(userId: string, bindingId: string): Promise<BoundDoctor | null> {
  const db = getDb()
  const existing = await getDoctorBindingForUser({
    userId,
    bindingId,
    statuses: ['pending_confirmation', 'confirmed', 'pending_unbind'],
  })
  if (!existing) return null

  const now = new Date()
  const next = resolvePatientInitiatedUnbind(existing)
  await db
    .update(patientDoctorBindings)
    .set({
      status: next.status,
      unbindRequestedBy: next.status === 'unbound' ? existing.unbindRequestedBy : next.unbindRequestedBy,
      unboundAt: now,
      updatedAt: now,
    })
    .where(and(
      eq(patientDoctorBindings.userId, userId),
      eq(patientDoctorBindings.id, bindingId),
    ))

  return getDoctorBindingForUser({ userId, bindingId, statuses: ['pending_unbind', 'unbound'] })
}

export async function confirmDoctorUnbindForUser(userId: string, bindingId: string): Promise<boolean> {
  const db = getDb()
  const rows = await db
    .update(patientDoctorBindings)
    .set({
      status: 'unbound',
      unboundAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(
      eq(patientDoctorBindings.userId, userId),
      eq(patientDoctorBindings.id, bindingId),
      eq(patientDoctorBindings.status, 'pending_unbind'),
      eq(patientDoctorBindings.unbindRequestedBy, 'doctor'),
    ))
    .returning({ id: patientDoctorBindings.id })
  return rows.length > 0
}

export async function rejectDoctorUnbindForUser(userId: string, bindingId: string): Promise<BoundDoctor | null> {
  const db = getDb()
  const rows = await db
    .update(patientDoctorBindings)
    .set({
      status: 'confirmed',
      unbindRequestedBy: null,
      unboundAt: null,
      updatedAt: new Date(),
    })
    .where(and(
      eq(patientDoctorBindings.userId, userId),
      eq(patientDoctorBindings.id, bindingId),
      eq(patientDoctorBindings.status, 'pending_unbind'),
      eq(patientDoctorBindings.unbindRequestedBy, 'doctor'),
    ))
    .returning({ id: patientDoctorBindings.id })
  if (rows.length === 0) return getDoctorBindingForUser({ userId, bindingId })
  return getDoctorBindingForUser({ userId, bindingId })
}

export async function cancelPatientUnbindForUser(userId: string, bindingId: string): Promise<BoundDoctor | null> {
  const db = getDb()
  const rows = await db
    .update(patientDoctorBindings)
    .set({
      status: 'confirmed',
      unbindRequestedBy: null,
      unboundAt: null,
      updatedAt: new Date(),
    })
    .where(and(
      eq(patientDoctorBindings.userId, userId),
      eq(patientDoctorBindings.id, bindingId),
      eq(patientDoctorBindings.status, 'pending_unbind'),
      eq(patientDoctorBindings.unbindRequestedBy, 'patient'),
    ))
    .returning({ id: patientDoctorBindings.id })
  if (rows.length === 0) return getDoctorBindingForUser({ userId, bindingId })
  return getDoctorBindingForUser({ userId, bindingId })
}

export async function inviteBindDoctorForUser(input: {
  userId: string
  doctorId: string
  logger: Logger
}): Promise<BoundDoctor> {
  const db = getDb()
  const now = new Date()
  const doctorId = input.doctorId.trim()

  const existingBindings = await listActiveDoctorBindingsForUser(input.userId)
  const plan = planInviteBindDoctor(existingBindings, doctorId)
  if (plan.type === 'reuse_existing') return plan.binding
  if (plan.type === 'max_reached') {
    const err = new Error(`最多只能绑定 ${plan.limit} 位医生`) as Error & { status?: number }
    err.status = 409
    throw err
  }

  await ensureDoctorProfile(plan.doctorId, input.logger)

  await db.insert(patientDoctorBindings).values({
    userId: input.userId,
    doctorId: plan.doctorId,
    status: 'pending_confirmation',
    unbindRequestedBy: null,
    boundAt: now,
    confirmedAt: null,
    unboundAt: null,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: [patientDoctorBindings.userId, patientDoctorBindings.doctorId],
    set: {
      status: 'pending_confirmation',
      unbindRequestedBy: null,
      boundAt: now,
      confirmedAt: null,
      unboundAt: null,
      updatedAt: now,
    },
  })

  const binding = (await listDoctorBindingsForUser(input.userId)).find((item) => item.doctor.id === plan.doctorId)
  if (!binding) throw new Error('绑定医生失败')
  return binding
}

export async function autoApproveExpiredDoctorUnbinds(params: {
  cutoff: Date
  logger: Logger
}): Promise<number> {
  const db = getDb()
  const rows = await db.query.patientDoctorBindings.findMany({
    where: and(
      eq(patientDoctorBindings.status, 'pending_unbind'),
    ),
  })
  const expired = rows.filter((row) => row.updatedAt <= params.cutoff)
  if (expired.length === 0) return 0

  const now = new Date()
  const updated = await db
    .update(patientDoctorBindings)
    .set({
      status: 'unbound',
      unboundAt: now,
      updatedAt: now,
    })
    .where(inArray(patientDoctorBindings.id, expired.map((row) => row.id)))
    .returning({ id: patientDoctorBindings.id })

  params.logger.info({ count: updated.length }, 'expired doctor unbind requests auto approved')
  return updated.length
}
