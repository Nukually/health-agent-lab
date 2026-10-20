import { Hono } from 'hono'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import type {
  ApiResponse,
  DoctorAccessConfirmBindingResponse,
  DoctorAccessDocumentImageResponse,
  DoctorAccessHealthEducationStatsByDoctorResponse,
  DoctorAccessHealthEducationStatsResponse,
  DoctorAccessMedicalProfileZh,
  DoctorAccessMedicalSummaryResponse,
  DoctorAccessPatientsResponse,
  MedicalProfileData,
} from '@health-agent/shared'
import {
  FIELD_ENUM_LABELS,
  FIELD_LABELS,
  formatMedicationDurationDetails,
  formatMedicationNames,
  MEDICAL_RECORD_FIELDS,
  normalizeMedicalProfileData,
} from '@health-agent/shared'
import { doctorAccessMiddleware, requireDoctorIdHeader } from '../middleware/doctor-access.js'
import { getDb } from '../db/client.js'
import { doctors, medicalDocuments, medicalRecords, patientDoctorBindings, users } from '../db/schema/index.js'
import { getEnv } from '../env.js'
import { signUrl } from '../lib/oss.js'
import {
  getHealthEducationStatsForItemIds,
  listDoctorHealthEducationItemIds,
  toHealthEducationStatsRecord,
} from '../services/health-education.js'
import { pushToUser } from '../services/push.js'
import { resolveDoctorInitiatedUnbind } from '../services/doctor-binding.js'

const doctorAccessRoutes = new Hono()

const bindingStatusSchema = z.object({
  status: z.enum(['confirmed', 'rejected', 'pending_unbind', 'unbound']),
})

const statsQuerySchema = z.object({
  itemIds: z.string().trim().min(1),
})

const statsByDoctorQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
  cursor: z.coerce.number().int().min(0).optional(),
})

const extendedMedicalProfileFieldLabels: Record<string, string> = {
  followupNote: '随访备注',
  followupInterval: '随访间隔',
  followupInternal: '随访间隔',
  noduleSizeMm: '结节大小（mm）',
}

const extendedMedicalProfileValueLabels: Record<string, Record<string, string>> = {
  menstrualStatus: {
    regular: '规律',
    irregular: '不规律',
  },
}

function maskPhone(phone: string | null): string {
  if (!phone) return ''
  return phone.replace(/(\d{3})\d{4}(\d{4})/, '$1****$2')
}

function parseJsonArray(raw: string | null): string[] {
  if (!raw) return []
  try {
    const value = JSON.parse(raw)
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function hasMedicalProfileValue(value: unknown): boolean {
  if (value == null || value === '') return false
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === 'object') return Object.keys(value).length > 0
  return true
}

function getMedicalProfileFieldLabel(field: string): string {
  return FIELD_LABELS[field as keyof typeof FIELD_LABELS] ?? extendedMedicalProfileFieldLabels[field] ?? field
}

function translateMedicalProfileValue(field: string, value: unknown): string | Record<string, string> {
  if (value == null || value === '') return '未填写'
  if (Array.isArray(value)) {
    const enumLabels = FIELD_ENUM_LABELS[field] ?? extendedMedicalProfileValueLabels[field]
    return value.map((item) => enumLabels?.[String(item)] ?? String(item)).join('、')
  }
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, nestedValue]) => hasMedicalProfileValue(nestedValue))
        .map(([nestedKey, nestedValue]) => [
          getMedicalProfileFieldLabel(nestedKey),
          String(translateMedicalProfileValue(nestedKey, nestedValue)),
        ]),
    )
  }

  const enumLabels = FIELD_ENUM_LABELS[field] ?? extendedMedicalProfileValueLabels[field]
  if (field === 'noduleBiradsGrade' && /^\d+$/.test(String(value))) {
    return `BI-RADS ${value}类`
  }
  return enumLabels?.[String(value)] ?? String(value)
}

function translateMedicalProfile(profileData: MedicalProfileData | null | undefined): DoctorAccessMedicalProfileZh {
  const profile = normalizeMedicalProfileData(profileData)
  const result: DoctorAccessMedicalProfileZh = {}
  const handledFields = new Set<string>()

  for (const field of MEDICAL_RECORD_FIELDS) {
    handledFields.add(field)
    if (field === 'medications') {
      const text = formatMedicationNames(profile)
      if (text) result[FIELD_LABELS.medications] = text
      continue
    }
    if (field === 'medicationDuration') {
      const text = formatMedicationDurationDetails(profile)
      if (text && text !== '未填写') result[FIELD_LABELS.medicationDuration] = text
      continue
    }

    const value = profile[field]
    if (!hasMedicalProfileValue(value)) continue
    result[FIELD_LABELS[field]] = translateMedicalProfileValue(field, value)
  }

  for (const [field, value] of Object.entries(profile as Record<string, unknown>)) {
    if (handledFields.has(field) || field === 'fieldUpdatedAt') continue
    if (!hasMedicalProfileValue(value)) continue
    result[getMedicalProfileFieldLabel(field)] = translateMedicalProfileValue(field, value)
  }

  const fieldUpdatedAt: Record<string, string> = {}
  if (profile.fieldUpdatedAt?.diagnosisDuration) {
    fieldUpdatedAt[FIELD_LABELS.diagnosisDuration] = profile.fieldUpdatedAt.diagnosisDuration
  }
  if (profile.fieldUpdatedAt?.medicationDuration) {
    fieldUpdatedAt[FIELD_LABELS.medicationDuration] = profile.fieldUpdatedAt.medicationDuration
  }
  if (Object.keys(fieldUpdatedAt).length > 0) {
    result['字段更新时间'] = fieldUpdatedAt
  }

  return result
}

function getDoctorId(c: { req: { header: (name: string) => string | undefined } }): string {
  return c.req.header('x-doctor-id')!.trim()
}

async function findConfirmedBinding(params: {
  doctorId: string
  bindingId: string
}) {
  const db = getDb()
  return db.query.patientDoctorBindings.findFirst({
    where: and(
      eq(patientDoctorBindings.id, params.bindingId),
      eq(patientDoctorBindings.doctorId, params.doctorId),
      eq(patientDoctorBindings.status, 'confirmed'),
    ),
  })
}

doctorAccessRoutes.use('*', doctorAccessMiddleware)
doctorAccessRoutes.use('*', requireDoctorIdHeader)

// GET /api/doctor-access/health-education/stats?itemIds=123,456
doctorAccessRoutes.get('/health-education/stats', async (c) => {
  const parsed = statsQuerySchema.safeParse({
    itemIds: c.req.query('itemIds') ?? '',
  })
  if (!parsed.success) {
    return c.json({ success: false, error: parsed.error.issues[0]?.message ?? '参数错误' }, 400)
  }

  const itemIds = [...new Set(parsed.data.itemIds
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean))]
  if (itemIds.length === 0) {
    return c.json({ success: false, error: '缺少 itemIds' }, 400)
  }
  if (itemIds.length > 100) {
    return c.json({ success: false, error: 'itemIds 最多支持 100 个' }, 400)
  }

  const stats = await getHealthEducationStatsForItemIds(itemIds)
  const payload: ApiResponse<DoctorAccessHealthEducationStatsResponse> = {
    success: true,
    data: {
      items: itemIds.map((itemId) => toHealthEducationStatsRecord(stats.get(itemId) ?? {
        itemId,
        likeCount: 0,
        dislikeCount: 0,
        favoriteCount: 0,
        pvCount: 0,
        uvCount: 0,
      })),
    },
  }
  return c.json(payload)
})

// GET /api/doctor-access/health-education/stats/by-doctor?limit=100&cursor=0
doctorAccessRoutes.get('/health-education/stats/by-doctor', async (c) => {
  const doctorId = getDoctorId(c)
  const parsed = statsByDoctorQuerySchema.safeParse({
    limit: c.req.query('limit') ?? undefined,
    cursor: c.req.query('cursor') ?? undefined,
  })
  if (!parsed.success) {
    return c.json({ success: false, error: parsed.error.issues[0]?.message ?? '参数错误' }, 400)
  }

  const page = await listDoctorHealthEducationItemIds({
    doctorId,
    limit: parsed.data.limit,
    cursor: parsed.data.cursor ?? null,
    logger: c.get('logger'),
  })
  const stats = await getHealthEducationStatsForItemIds(page.itemIds)
  const payload: ApiResponse<DoctorAccessHealthEducationStatsByDoctorResponse> = {
    success: true,
    data: {
      doctorId,
      items: page.itemIds.map((itemId) => toHealthEducationStatsRecord(stats.get(itemId) ?? {
        itemId,
        likeCount: 0,
        dislikeCount: 0,
        favoriteCount: 0,
        pvCount: 0,
        uvCount: 0,
      })),
      nextCursor: page.nextCursor,
    },
  }
  return c.json(payload)
})

// GET /api/doctor-access/patients?status=pending_confirmation|confirmed
doctorAccessRoutes.get('/patients', async (c) => {
  const doctorId = getDoctorId(c)
  const status = c.req.query('status') === 'confirmed' ? 'confirmed' : 'pending_confirmation'
  const db = getDb()

  if (status === 'pending_confirmation') {
    const rows = await db
      .select({
        bindingId: patientDoctorBindings.id,
        status: patientDoctorBindings.status,
        unbindRequestedBy: patientDoctorBindings.unbindRequestedBy,
        createdAt: patientDoctorBindings.createdAt,
        nickname: users.nickname,
        phone: users.phone,
      })
      .from(patientDoctorBindings)
      .innerJoin(users, eq(patientDoctorBindings.userId, users.id))
      .where(and(
        eq(patientDoctorBindings.doctorId, doctorId),
        inArray(patientDoctorBindings.status, ['pending_confirmation', 'rejected', 'pending_unbind']),
      ))
      .orderBy(desc(patientDoctorBindings.updatedAt))

    const payload: ApiResponse<DoctorAccessPatientsResponse> = {
      success: true,
      data: {
        patients: rows.map((row) => ({
          bindingId: row.bindingId,
          patient: {
            nickname: row.nickname,
            phoneMasked: maskPhone(row.phone),
          },
          status: row.status as 'pending_confirmation' | 'rejected' | 'pending_unbind',
          unbindRequestedBy: row.unbindRequestedBy as 'patient' | 'doctor' | null,
          createdAt: row.createdAt.toISOString(),
        })),
      },
    }
    return c.json(payload)
  }

  const rows = await db
    .select({
      bindingId: patientDoctorBindings.id,
      userId: patientDoctorBindings.userId,
      confirmedAt: patientDoctorBindings.confirmedAt,
      nickname: users.nickname,
      gender: users.gender,
      birthday: users.birthday,
      phone: users.phone,
      currentConcern: users.currentConcern,
      userUpdatedAt: users.updatedAt,
    })
    .from(patientDoctorBindings)
    .innerJoin(users, eq(patientDoctorBindings.userId, users.id))
    .where(and(
      eq(patientDoctorBindings.doctorId, doctorId),
      eq(patientDoctorBindings.status, 'confirmed'),
    ))
    .orderBy(desc(patientDoctorBindings.confirmedAt), desc(patientDoctorBindings.updatedAt))

  const patients = await Promise.all(rows.map(async (row) => {
    const medical = await db.query.medicalRecords.findFirst({
      where: eq(medicalRecords.userId, row.userId),
      columns: { updatedAt: true },
    })
    const lastDoc = await db.query.medicalDocuments.findFirst({
      where: eq(medicalDocuments.userId, row.userId),
      columns: { updatedAt: true },
      orderBy: desc(medicalDocuments.updatedAt),
    })
    return {
      bindingId: row.bindingId,
      patient: {
        nickname: row.nickname,
        gender: row.gender as any,
        birthday: row.birthday,
        phoneMasked: maskPhone(row.phone),
        currentConcern: row.currentConcern,
      },
      confirmedAt: row.confirmedAt?.toISOString() ?? null,
      lastProfileUpdatedAt: (medical?.updatedAt ?? row.userUpdatedAt)?.toISOString() ?? null,
      lastDocumentUpdatedAt: lastDoc?.updatedAt.toISOString() ?? null,
    }
  }))

  const payload: ApiResponse<DoctorAccessPatientsResponse> = {
    success: true,
    data: { patients },
  }
  return c.json(payload)
})

// POST /api/doctor-access/bindings/:bindingId/confirm
doctorAccessRoutes.post('/bindings/:bindingId/confirm', async (c) => {
  const logger = c.get('logger')
  const doctorId = getDoctorId(c)
  const bindingId = c.req.param('bindingId')
  const parsed = bindingStatusSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) {
    return c.json({ success: false, error: parsed.error.issues[0]?.message ?? '参数错误' }, 400)
  }

  const db = getDb()
  const existing = await db.query.patientDoctorBindings.findFirst({
    where: and(
      eq(patientDoctorBindings.id, bindingId),
      eq(patientDoctorBindings.doctorId, doctorId),
    ),
  })
  if (!existing) return c.json({ success: false, error: '绑定关系不存在' }, 404)

  const now = new Date()
  const nextStatus = parsed.data.status
  const isConfirmingPatientUnbind =
    nextStatus === 'unbound' &&
    existing.status === 'pending_unbind' &&
    existing.unbindRequestedBy === 'patient'
  if (nextStatus === 'unbound' && !isConfirmingPatientUnbind) {
    return c.json({ success: false, error: '待确认解绑关系不存在' }, 404)
  }
  if (nextStatus === 'rejected' && existing.status !== 'pending_confirmation') {
    return c.json({ success: false, error: '待确认绑定关系不存在' }, 404)
  }

  const doctorUnbind = nextStatus === 'pending_unbind'
    ? resolveDoctorInitiatedUnbind({
        bindingId: existing.id,
        status: existing.status as any,
        unbindRequestedBy: existing.unbindRequestedBy as any,
        createdAt: existing.createdAt.toISOString(),
        confirmedAt: existing.confirmedAt?.toISOString() ?? null,
        unboundAt: existing.unboundAt?.toISOString() ?? null,
        doctor: {
          id: existing.doctorId,
          doctorInviteCode: null,
          name: '',
          avatarUrl: null,
          hospital: null,
          department: null,
          title: null,
          phone: null,
        },
      })
    : null

  const nextValues = nextStatus === 'confirmed'
    ? {
        status: 'confirmed',
        unbindRequestedBy: null,
        confirmedAt: existing.confirmedAt ?? now,
        unboundAt: null,
        updatedAt: now,
      }
    : nextStatus === 'rejected'
      ? {
          status: 'rejected',
          unbindRequestedBy: null,
          confirmedAt: null,
          unboundAt: null,
          updatedAt: now,
        }
      : isConfirmingPatientUnbind
        ? {
            status: 'unbound',
            unboundAt: now,
            updatedAt: now,
          }
        : doctorUnbind?.status === 'unbound'
          ? {
              status: 'unbound',
              unboundAt: now,
              updatedAt: now,
            }
          : {
              status: 'pending_unbind',
              unbindRequestedBy: 'doctor',
              unboundAt: now,
              updatedAt: now,
            }

  const [updated] = await db.update(patientDoctorBindings).set(nextValues).where(and(
    eq(patientDoctorBindings.id, bindingId),
    eq(patientDoctorBindings.doctorId, doctorId),
  )).returning()

  if (updated && nextStatus === 'confirmed' && existing.status !== 'confirmed') {
    const doctor = await db.query.doctors.findFirst({ where: eq(doctors.id, doctorId) })
    void pushToUser(updated.userId, {
      title: '医生绑定已确认',
      alert: `${doctor?.name ?? '医生'}已确认与你绑定`,
      route: '/my-doctor',
      type: 'doctor_binding_confirmed',
      entityType: 'doctor_binding',
      entityId: bindingId,
      dedupeKey: `doctor-binding-confirmed:${bindingId}`,
    }, logger)
  }
  if (updated && nextStatus === 'rejected' && existing.status !== 'rejected') {
    const doctor = await db.query.doctors.findFirst({ where: eq(doctors.id, doctorId) })
    void pushToUser(updated.userId, {
      title: '医生绑定未通过',
      alert: `${doctor?.name ?? '医生'}暂未接受你的绑定申请`,
      route: '/my-doctor',
      type: 'doctor_binding_rejected',
      entityType: 'doctor_binding',
      entityId: bindingId,
      dedupeKey: `doctor-binding-rejected:${bindingId}:${updated.updatedAt.getTime()}`,
    }, logger)
  }
  if (updated && nextStatus === 'pending_unbind' && updated.status === 'pending_unbind' && existing.unbindRequestedBy !== 'doctor') {
    const doctor = await db.query.doctors.findFirst({ where: eq(doctors.id, doctorId) })
    void pushToUser(updated.userId, {
      title: '医生发起解除绑定',
      alert: `${doctor?.name ?? '医生'}已发起解除绑定，请确认`,
      route: '/my-doctor',
      type: 'doctor_binding_unbind_requested',
      entityType: 'doctor_binding',
      entityId: bindingId,
      dedupeKey: `doctor-binding-unbind-requested:${bindingId}:${updated.updatedAt.getTime()}`,
    }, logger)
  }

  const payload: ApiResponse<DoctorAccessConfirmBindingResponse> = {
    success: true,
    data: {
      bindingId,
      status: updated.status as 'confirmed' | 'rejected' | 'pending_unbind' | 'unbound',
      confirmedAt: updated.confirmedAt?.toISOString() ?? null,
    },
  }
  return c.json(payload)
})

// POST /api/doctor-access/bindings/:bindingId/unbind-confirm
// Doctor confirms an unbind request initiated by patient.
doctorAccessRoutes.post('/bindings/:bindingId/unbind-confirm', async (c) => {
  const doctorId = getDoctorId(c)
  const bindingId = c.req.param('bindingId')
  const db = getDb()
  const [updated] = await db.update(patientDoctorBindings).set({
    status: 'unbound',
    updatedAt: new Date(),
  }).where(and(
    eq(patientDoctorBindings.id, bindingId),
    eq(patientDoctorBindings.doctorId, doctorId),
    eq(patientDoctorBindings.status, 'pending_unbind'),
    eq(patientDoctorBindings.unbindRequestedBy, 'patient'),
  )).returning()

  if (!updated) return c.json({ success: false, error: '待确认解绑关系不存在' }, 404)

  const payload: ApiResponse<DoctorAccessConfirmBindingResponse> = {
    success: true,
    data: {
      bindingId,
      status: 'unbound',
      confirmedAt: updated.confirmedAt?.toISOString() ?? null,
    },
  }
  return c.json(payload)
})

// GET /api/doctor-access/patients/:bindingId/medical-summary
doctorAccessRoutes.get('/patients/:bindingId/medical-summary', async (c) => {
  const doctorId = getDoctorId(c)
  const bindingId = c.req.param('bindingId')
  const db = getDb()
  const binding = await findConfirmedBinding({ doctorId, bindingId })
  if (!binding) return c.json({ success: false, error: '患者绑定关系不存在或未确认' }, 404)

  const patient = await db.query.users.findFirst({
    where: eq(users.id, binding.userId),
    columns: {
      nickname: true,
      gender: true,
      birthday: true,
      currentConcern: true,
    },
  })
  const medical = await db.query.medicalRecords.findFirst({
    where: eq(medicalRecords.userId, binding.userId),
    columns: { profileData: true },
  })
  const docs = await db.query.medicalDocuments.findMany({
    where: eq(medicalDocuments.userId, binding.userId),
    orderBy: [desc(medicalDocuments.documentDate), desc(medicalDocuments.uploadedAt)],
  })
  const profileData = (medical?.profileData ?? {}) as MedicalProfileData
  const profileDataZh = translateMedicalProfile(profileData)

  const payload: ApiResponse<DoctorAccessMedicalSummaryResponse> = {
    success: true,
    data: {
      bindingId,
      patient: {
        nickname: patient?.nickname ?? null,
        gender: patient?.gender as any ?? null,
        birthday: patient?.birthday ?? null,
        currentConcern: patient?.currentConcern ?? null,
      },
      medicalProfile: {
        profileData: profileDataZh,
        profileDataRaw: profileData,
        profileDataZh,
      },
      documents: docs.map((doc) => ({
        documentId: doc.id,
        title: doc.title,
        documentType: doc.documentType as any,
        hospital: doc.hospital,
        documentDate: doc.documentDate,
        imageCount: parseJsonArray(doc.imageUrls).length,
        uploadedAt: doc.uploadedAt.toISOString(),
        updatedAt: doc.updatedAt.toISOString(),
      })),
    },
  }
  return c.json(payload)
})

// GET /api/doctor-access/patients/:bindingId/documents/:documentId/images/:imageIndex
doctorAccessRoutes.get('/patients/:bindingId/documents/:documentId/images/:imageIndex', async (c) => {
  const doctorId = getDoctorId(c)
  const bindingId = c.req.param('bindingId')
  const documentId = c.req.param('documentId')
  const imageIndex = Number(c.req.param('imageIndex'))
  if (!Number.isInteger(imageIndex) || imageIndex < 0) {
    return c.json({ success: false, error: '图片序号不合法' }, 400)
  }

  const binding = await findConfirmedBinding({ doctorId, bindingId })
  if (!binding) return c.json({ success: false, error: '患者绑定关系不存在或未确认' }, 404)

  const db = getDb()
  const doc = await db.query.medicalDocuments.findFirst({
    where: and(
      eq(medicalDocuments.id, documentId),
      eq(medicalDocuments.userId, binding.userId),
    ),
  })
  if (!doc) return c.json({ success: false, error: '病例不存在' }, 404)

  const imageKeys = parseJsonArray(doc.imageUrls)
  const imageKey = imageKeys[imageIndex]
  if (!imageKey) return c.json({ success: false, error: '图片不存在' }, 404)

  const expiresIn = getEnv().DOCTOR_ACCESS_IMAGE_URL_EXPIRES_SECONDS
  const payload: ApiResponse<DoctorAccessDocumentImageResponse> = {
    success: true,
    data: {
      documentId,
      imageIndex,
      imageUrl: signUrl(imageKey, expiresIn),
      expiresIn,
    },
  }
  return c.json(payload)
})

export default doctorAccessRoutes
