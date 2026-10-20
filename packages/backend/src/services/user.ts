import { eq } from 'drizzle-orm'
import { getDb } from '../db/client.js'
import { users, medicalRecords } from '../db/schema/index.js'
import { normalizeMedicalProfileData, type MedicalProfileData, type UserProfileInput } from '@health-agent/shared'
import type { Logger } from '../lib/logger.js'

export async function updateUserProfile(
  userId: string,
  data: UserProfileInput,
  logger: Logger,
) {
  const db = getDb()

  const values: Record<string, unknown> = {}
  if (data.nickname !== undefined) values.nickname = data.nickname || null
  if (data.birthday !== undefined) values.birthday = data.birthday || null
  if (data.gender !== undefined) values.gender = data.gender || null
  if (data.currentConcern !== undefined) values.currentConcern = data.currentConcern || null

  // 没有要更新的字段时直接返回当前数据
  if (Object.keys(values).length === 0) {
    const current = await db.query.users.findFirst({ where: eq(users.id, userId) })
    logger.info({ userId }, 'user profile update skipped (no changes)')
    return current!
  }
  values.updatedAt = new Date()

  const [updated] = await db
    .update(users)
    .set(values)
    .where(eq(users.id, userId))
    .returning()

  logger.info({ userId, fields: Object.keys(values) }, 'user profile updated')
  return updated
}

export async function getFullProfile(userId: string, logger: Logger) {
  const db = getDb()

  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: {
      nickname: true,
      birthday: true,
      gender: true,
      currentConcern: true,
      updatedAt: true,
    },
  })

  const medical = await db.query.medicalRecords.findFirst({
    where: eq(medicalRecords.userId, userId),
  })

  logger.info({ userId, hasUser: !!user, hasMedical: !!medical }, 'full profile lookup')

  return {
    user:
      user || {
        nickname: null,
        birthday: null,
        gender: null,
        currentConcern: null,
        updatedAt: null,
      },
    medical: medical
      ? { ...medical, profileData: normalizeMedicalProfileData(medical.profileData as MedicalProfileData) }
      : null,
  }
}

export async function getMedicalRecord(userId: string, logger: Logger) {
  const db = getDb()

  const record = await db.query.medicalRecords.findFirst({
    where: eq(medicalRecords.userId, userId),
  })

  logger.info({ userId, found: !!record }, 'medical record lookup')
  return record
    ? { ...record, profileData: normalizeMedicalProfileData(record.profileData as MedicalProfileData) }
    : record
}

// 对这两个"相对时间"字段维护 fieldUpdatedAt —— 见 MedicalProfileData.fieldUpdatedAt
const TIMESTAMPED_FIELDS = ['diagnosisDuration', 'medicationDuration'] as const

/**
 * 根据最终 merged 结果与 existing 对比，维护 fieldUpdatedAt：
 * - merged 新值存在 && 与旧值不同 → 打当前时间戳
 * - merged 新值存在 && 与旧值相同 → 保留旧时间戳
 * - merged 不存在 → 删除该字段时间戳
 */
function resolveFieldUpdatedAt(
  merged: MedicalProfileData,
  existing: MedicalProfileData | null,
): MedicalProfileData['fieldUpdatedAt'] {
  const now = new Date().toISOString()
  const prev = existing?.fieldUpdatedAt ?? {}
  const next: Record<string, string> = {}

  for (const field of TIMESTAMPED_FIELDS) {
    const mergedValue = merged[field]
    const existingValue = existing?.[field]

    if (mergedValue === undefined && field !== 'medicationDuration') continue
    if (
      field === 'medicationDuration' &&
      mergedValue === undefined &&
      merged.medicationDurations === undefined
    ) {
      continue
    }

    const changed = field === 'medicationDuration'
      ? (
          mergedValue !== existingValue ||
          JSON.stringify(merged.medicationDurations ?? {}) !== JSON.stringify(existing?.medicationDurations ?? {})
        )
      : mergedValue !== existingValue

    if (changed) {
      next[field] = now
    } else if (prev[field]) {
      next[field] = prev[field] as string
    }
  }

  return Object.keys(next).length ? (next as MedicalProfileData['fieldUpdatedAt']) : undefined
}

export async function upsertMedicalRecord(
  userId: string,
  profileDataPatch: MedicalProfileData,
  logger: Logger,
) {
  const db = getDb()

  const existing = await db.query.medicalRecords.findFirst({
    where: eq(medicalRecords.userId, userId),
  })

  const existingProfile = existing?.profileData
    ? normalizeMedicalProfileData(existing.profileData as MedicalProfileData)
    : null
  const { fieldUpdatedAt: _existingFieldUpdatedAt, ...existingProfileWithoutFieldUpdatedAt } = existingProfile ?? {}

  // 剥掉调用方可能误传的 fieldUpdatedAt，服务端是唯一写入源
  const { fieldUpdatedAt: _ignored, ...cleanIncoming } = profileDataPatch
  const mergedProfile: MedicalProfileData = normalizeMedicalProfileData({
    ...existingProfileWithoutFieldUpdatedAt,
    ...cleanIncoming,
  })
  const fieldUpdatedAt = resolveFieldUpdatedAt(mergedProfile, existingProfile)
  const finalProfile: MedicalProfileData = fieldUpdatedAt
    ? { ...mergedProfile, fieldUpdatedAt }
    : { ...mergedProfile }

  if (existing) {
    const [updated] = await db
      .update(medicalRecords)
      .set({ profileData: finalProfile, updatedAt: new Date() })
      .where(eq(medicalRecords.id, existing.id))
      .returning()
    logger.info({ userId, recordId: updated.id }, 'medical record updated')
    return updated
  }

  const [created] = await db
    .insert(medicalRecords)
    .values({ userId, profileData: finalProfile })
    .returning()
  logger.info({ userId, recordId: created.id }, 'medical record created')
  return created
}
