import {
  FIELD_LABELS,
  formatMedicationDurationDetails,
  formatMedicationNames,
  normalizeMedicalProfileData,
  type CurrentConcern,
  type MedicalProfileData,
} from '@health-agent/shared'
import type { Logger } from '../lib/logger.js'
import { getMedicalRecord, upsertMedicalRecord } from './user.js'
import { validateMedicalProfilePatch, valueLabelOf } from './profile-validation.js'

export interface FieldChangePayload {
  field: string
  fieldLabel: string
  fromValue: string
  toValue: string
}

export interface AppliedMedicalProfilePatch {
  existingProfile: MedicalProfileData | null
  updatedProfile: MedicalProfileData
  fieldNames: string[]
  changes: FieldChangePayload[]
}

export function valueLabelOfProfilePatch(
  field: string,
  value: unknown,
  profilePatch?: MedicalProfileData,
): string {
  if (field === 'medications' && Array.isArray(value)) {
    const profile = { ...(profilePatch ?? {}), medications: value as MedicalProfileData['medications'] }
    const names = formatMedicationNames(profile)
    const durations = formatMedicationDurationDetails(profile)
    if (!names) return '未填写'
    return durations === '无需填写' ? `${names}：无需填写` : durations
  }
  if (field === 'medicationDuration') {
    return formatMedicationDurationDetails({
      ...(profilePatch ?? {}),
      medicationDuration: value as MedicalProfileData['medicationDuration'],
    })
  }
  return valueLabelOf(field, value)
}

function buildFieldChange(
  field: string,
  fromValue: unknown,
  toValue: unknown,
  opts?: {
    fromProfile?: MedicalProfileData | null
    toProfile?: MedicalProfileData | null
  },
): FieldChangePayload | null {
  const fromLabel = field === 'medications' || field === 'medicationDuration'
    ? valueLabelOfProfilePatch(field, fromValue, opts?.fromProfile ?? undefined)
    : valueLabelOf(field, fromValue)
  const toLabel = field === 'medications' || field === 'medicationDuration'
    ? valueLabelOfProfilePatch(field, toValue, opts?.toProfile ?? undefined)
    : valueLabelOf(field, toValue)

  if (fromLabel === toLabel) return null
  return {
    field,
    fieldLabel: FIELD_LABELS[field as keyof typeof FIELD_LABELS] || field,
    fromValue: fromLabel,
    toValue: toLabel,
  }
}

export function buildProfileFieldChanges(
  fields: string[],
  fromProfile: unknown,
  toProfile: unknown,
): FieldChangePayload[] {
  const fromRecord = fromProfile && typeof fromProfile === 'object'
    ? fromProfile as Record<string, unknown>
    : {}
  const toRecord = toProfile && typeof toProfile === 'object'
    ? toProfile as Record<string, unknown>
    : {}
  return fields
    .map((field) => buildFieldChange(field, fromRecord[field], toRecord[field], {
      fromProfile: fromProfile as MedicalProfileData | null | undefined,
      toProfile: toProfile as MedicalProfileData | null | undefined,
    }))
    .filter((change): change is FieldChangePayload => Boolean(change))
}

export function profilePatchChangedFields(profilePatch: MedicalProfileData): string[] {
  const fields = new Set<string>()
  for (const field of Object.keys(profilePatch)) {
    if (field === 'fieldUpdatedAt' || field === 'medicationCustom' || field === 'medicationDurations') continue
    fields.add(field)
  }
  if ('medicationDurations' in profilePatch) fields.add('medicationDuration')
  return [...fields]
}

export function hasProfilePatchData(profilePatch: MedicalProfileData): boolean {
  return Object.keys(profilePatch).some((field) => field !== 'fieldUpdatedAt')
}

export async function applyOcrExtractedMedicalProfilePatch(params: {
  userId: string
  extractedFields: MedicalProfileData
  currentConcern: CurrentConcern | null | undefined
  gender?: string | null
  logger: Logger
}): Promise<AppliedMedicalProfilePatch | null> {
  const { userId, extractedFields, currentConcern, gender, logger } = params
  const normalizedFields = normalizeMedicalProfileData(extractedFields)
  if (!hasProfilePatchData(normalizedFields)) return null

  const patchErr = validateMedicalProfilePatch(normalizedFields, currentConcern, gender)
  if (patchErr) {
    logger.warn({ userId, patchErr }, 'ocr extracted profile patch skipped')
    return null
  }

  const existingRecord = await getMedicalRecord(userId, logger)
  const existingProfile = (existingRecord?.profileData as MedicalProfileData | null) ?? null
  const updatedRecord = await upsertMedicalRecord(userId, normalizedFields, logger)
  const updatedProfile = updatedRecord.profileData as MedicalProfileData
  const fieldNames = profilePatchChangedFields(normalizedFields)
  const changes = buildProfileFieldChanges(fieldNames, existingProfile, updatedProfile)

  logger.info({ userId, fields: Object.keys(normalizedFields) }, 'medical profile auto-updated from ocr')

  return {
    existingProfile,
    updatedProfile,
    fieldNames,
    changes,
  }
}
