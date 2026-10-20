import {
  CURRENT_CONCERNS,
  MENSTRUAL_STATUSES,
  NODULE_BIRADS_GRADES,
  TUMOR_TYPES,
  DIAGNOSIS_DURATIONS,
  TREATMENT_PHASES,
  MEDICATION_OPTIONS,
  MEDICATION_DURATIONS,
  SELECTABLE_MEDICATION_DURATIONS,
  type CurrentConcern,
  type MedicalProfileData,
  type MedicationDuration,
  type NoduleBiradsGrade,
  type SelectableMedicationDuration,
  type TreatmentPhase,
} from '../types/user.js'

export const CURRENT_CONCERN_LABELS: Record<CurrentConcern, string> = {
  breast_tumor_care: '乳腺肿瘤相关诊疗',
  breast_nodule_followup: '乳腺结节 / 结节随访',
  awaiting_exam_or_results: '正在等待进一步检查或结果',
  not_sure_exploring: '还不确定，先想了解看看',
  other_breast_issue: '其他乳腺相关问题',
}

export const CURRENT_CONCERN_OPTIONS = CURRENT_CONCERNS.map((value) => ({
  value,
  label: CURRENT_CONCERN_LABELS[value],
}))

export const MENSTRUAL_STATUS_LABELS: Record<string, string> = {
  premenopausal: '未绝经（仍有规律月经）',
  perimenopausal: '围绝经期（月经不规律）',
  postmenopausal: '已绝经（超过12个月没有月经）',
  treatment_induced: '治疗相关停经',
  uncertain: '不确定',
}

export const TUMOR_TYPE_LABELS: Record<string, string> = {
  luminal_a: 'Luminal A 型',
  luminal_b_her2_negative: 'Luminal B 型（HER2-）',
  luminal_b_her2_positive: 'Luminal B 型（HER2+）',
  her2_positive_hr_negative: 'HER2 阳性型（HR- / HER2+）',
  triple_negative: '三阴性',
  unknown_or_untested: '不清楚 / 未检测',
}

export const NODULE_BIRADS_GRADE_LABELS: Record<NoduleBiradsGrade, string> = {
  birads_1_2: 'BI-RADS 1–2类',
  birads_3: 'BI-RADS 3类',
  birads_4: 'BI-RADS 4类',
  birads_5: 'BI-RADS 5类',
  uncertain: '不清楚/未检测',
}

export const DIAGNOSIS_DURATION_LABELS: Record<string, string> = {
  within_3m: '3个月内',
  '3_to_6m': '3–6个月',
  '6_to_12m': '6–12个月',
  '1_to_3y': '1–3年',
  over_3y: '3年以上',
}

export const TREATMENT_PHASE_LABELS: Record<string, string> = {
  pre_surgery: '手术前 / 等待手术',
  surgery_recovery: '术后恢复中',
  on_endocrine: '内分泌治疗中',
  on_chemo: '化疗中',
  on_radiation: '放疗中',
  on_targeted: '靶向治疗中',
  non_surgical_comprehensive: '未手术，正在综合治疗中',
  phase_completed_waiting_next: '阶段性治疗已结束，等待下一步',
  completed_main: '主要治疗已完成，定期复查中',
  paused_observation: '暂停治疗 / 观察中',
  uncertain: '不确定',
  post_chemo: '阶段性治疗已结束，等待下一步',
  post_radiation: '阶段性治疗已结束，等待下一步',
}

export const MEDICATION_LABELS: Record<string, string> = {
  tamoxifen: '他莫昔芬',
  letrozole: '来曲唑',
  anastrozole: '阿那曲唑',
  exemestane: '依西美坦',
  fulvestrant: '氟维司群',
  other: '其他',
  none: '没有服用',
  // 仅用于兼容历史数据展示；新提交不再允许选择/写入 uncertain。
  uncertain: '不确定',
}

export const MEDICATION_DURATION_LABELS: Record<string, string> = {
  within_1m: '1个月内',
  '1_to_3m': '1–3个月',
  '3_to_6m': '3–6个月',
  '6_to_12m': '6–12个月',
  over_1y: '1年以上',
  not_required: '无需填写',
}

export interface MedicationItem {
  key: string
  label: string
  option: string
  customName?: string
}

const SELECTABLE_MEDICATION_DURATION_SET = new Set<string>(SELECTABLE_MEDICATION_DURATIONS)
const TREATMENT_PHASE_SET = new Set<string>(TREATMENT_PHASES)
const LEGACY_TREATMENT_PHASE_MAP: Record<string, TreatmentPhase> = {
  post_chemo: 'phase_completed_waiting_next',
  post_radiation: 'phase_completed_waiting_next',
}

export function normalizeTreatmentPhase(value: unknown): TreatmentPhase | undefined {
  if (typeof value !== 'string') return undefined
  const mapped = LEGACY_TREATMENT_PHASE_MAP[value] ?? value
  return TREATMENT_PHASE_SET.has(mapped) ? mapped as TreatmentPhase : undefined
}

function normalizeMedicationCustomName(value: string): string {
  return value.trim().replace(/[。．.!！?？,，、;；：:]+$/u, '').trim()
}

export function splitMedicationCustomNames(value: string | null | undefined): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const item of String(value ?? '').split(/[、,，;；。！？!?\n\r]+/u)) {
    const trimmed = normalizeMedicationCustomName(item)
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    result.push(trimmed)
  }
  return result
}

export function isNoMedicationSelected(profile: Pick<MedicalProfileData, 'medications'> | null | undefined): boolean {
  return Array.isArray(profile?.medications) && profile.medications.includes('none' as any)
}

export function resolveMedicationItems(
  medications: readonly string[] | null | undefined,
  medicationCustom?: string | null,
): MedicationItem[] {
  if (!Array.isArray(medications) || medications.length === 0 || medications.includes('none')) return []

  const customNames = splitMedicationCustomNames(medicationCustom)
  const result: MedicationItem[] = []
  const seen = new Set<string>()

  for (const option of medications) {
    if (option === 'none' || option === 'uncertain') continue
    if (option === 'other') {
      const items = customNames.length
        ? customNames.map((name) => ({
            key: `custom:${name}`,
            label: name,
            option,
            customName: name,
          }))
        : [{ key: 'other', label: MEDICATION_LABELS.other, option }]
      for (const item of items) {
        if (seen.has(item.key)) continue
        seen.add(item.key)
        result.push(item)
      }
      continue
    }

    const key = option
    if (seen.has(key)) continue
    seen.add(key)
    result.push({
      key,
      label: MEDICATION_LABELS[option] || option,
      option,
    })
  }

  return result
}

function isSelectableMedicationDuration(value: unknown): value is SelectableMedicationDuration {
  return typeof value === 'string' && SELECTABLE_MEDICATION_DURATION_SET.has(value)
}

function mostFrequentDuration(values: SelectableMedicationDuration[]): SelectableMedicationDuration | undefined {
  const counts = new Map<SelectableMedicationDuration, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1])
  if (!sorted.length) return undefined
  if (sorted.length > 1 && sorted[0][1] === sorted[1][1]) return undefined
  return sorted[0][0]
}

export function resolveMedicationDurationMap(
  profile: MedicalProfileData | null | undefined,
): Record<string, SelectableMedicationDuration> {
  if (!profile || isNoMedicationSelected(profile)) return {}

  const items = resolveMedicationItems(profile.medications, profile.medicationCustom)
  if (items.length === 0) return {}
  const itemKeys = new Set(items.map((item) => item.key))

  const rawMap = profile.medicationDurations && typeof profile.medicationDurations === 'object'
    ? profile.medicationDurations
    : null
  const defaultDuration = isSelectableMedicationDuration(profile.medicationDuration)
    ? profile.medicationDuration
    : undefined
  if (rawMap) {
    const next: Record<string, SelectableMedicationDuration> = {}
    for (const [key, value] of Object.entries(rawMap)) {
      if (itemKeys.has(key) && isSelectableMedicationDuration(value)) {
        next[key] = value
      }
    }
    if (defaultDuration) {
      for (const item of items) {
        if (!next[item.key]) next[item.key] = defaultDuration
      }
    }
    if (Object.keys(next).length > 0) return next
  }

  if (defaultDuration) {
    return Object.fromEntries(items.map((item) => [item.key, defaultDuration]))
  }

  return {}
}

export function isMedicationDurationFilled(profile: MedicalProfileData | null | undefined): boolean {
  if (!profile) return false
  if (isNoMedicationSelected(profile)) return true

  const items = resolveMedicationItems(profile.medications, profile.medicationCustom)
  if (items.length === 0) return false
  const durationMap = resolveMedicationDurationMap(profile)
  return items.every((item) => Boolean(durationMap[item.key]))
}

export function formatMedicationNames(profile: MedicalProfileData | null | undefined): string {
  if (!profile?.medications?.length) return ''
  if (isNoMedicationSelected(profile)) return MEDICATION_LABELS.none
  const items = resolveMedicationItems(profile.medications, profile.medicationCustom)
  if (items.length) return items.map((item) => item.label).join('、')
  return profile.medications.map((m) => MEDICATION_LABELS[m] || m).join('、')
}

export function formatMedicationDurationDetails(
  profile: MedicalProfileData | null | undefined,
  missingLabel = '未填写',
): string {
  if (!profile) return missingLabel
  if (isNoMedicationSelected(profile)) return MEDICATION_DURATION_LABELS.not_required

  const items = resolveMedicationItems(profile.medications, profile.medicationCustom)
  if (items.length === 0) return missingLabel

  const durationMap = resolveMedicationDurationMap(profile)
  return items
    .map((item) => {
      const duration = durationMap[item.key]
      return `${item.label}：${duration ? MEDICATION_DURATION_LABELS[duration] || duration : missingLabel}`
    })
    .join('；')
}

export function normalizeMedicalProfileData(profile: MedicalProfileData | null | undefined): MedicalProfileData {
  const source = { ...(profile ?? {}) } as MedicalProfileData
  if (source.tumorType && !TUMOR_TYPES.includes(source.tumorType as any)) {
    delete source.tumorType
  }
  if (source.treatmentPhase) {
    const treatmentPhase = normalizeTreatmentPhase(source.treatmentPhase)
    if (treatmentPhase) {
      source.treatmentPhase = treatmentPhase
    } else {
      delete source.treatmentPhase
    }
  }

  const rawMedications = Array.isArray(source.medications)
    ? source.medications.filter((m): m is NonNullable<MedicalProfileData['medications']>[number] => (
        typeof m === 'string' && MEDICATION_OPTIONS.includes(m as any)
      ))
    : undefined

  if (!rawMedications) return source

  const hasConcreteMedication = rawMedications.some((m) => m !== 'none')
  const medications: NonNullable<MedicalProfileData['medications']> = hasConcreteMedication
    ? rawMedications.filter((m) => m !== 'none')
    : rawMedications.includes('none')
      ? ['none' as const]
      : []

  const next: MedicalProfileData = {
    ...source,
    medications,
    medicationCustom: medications.includes('other') ? (source.medicationCustom ?? '') : '',
  }

  if (medications.includes('none')) {
    next.medicationDuration = 'not_required'
    next.medicationDurations = {}
    return next
  }

  if (medications.length === 0) {
    delete next.medicationDuration
    delete next.medicationDurations
    return next
  }

  const items = resolveMedicationItems(medications, next.medicationCustom)
  const itemKeys = new Set(items.map((item) => item.key))
  const durationMap: Record<string, SelectableMedicationDuration> = {}

  const rawMap = source.medicationDurations && typeof source.medicationDurations === 'object'
    ? source.medicationDurations
    : null
  const defaultDuration = isSelectableMedicationDuration(source.medicationDuration)
    ? source.medicationDuration
    : undefined
  if (rawMap) {
    for (const [key, value] of Object.entries(rawMap)) {
      if (itemKeys.has(key) && isSelectableMedicationDuration(value)) {
        durationMap[key] = value
      }
    }
  }

  if (Object.keys(durationMap).length > 0) {
    const values = items.map((item) => durationMap[item.key]).filter(Boolean)
    const uniqueValues = [...new Set(values)]
    const resolvedDefault = defaultDuration ?? (
      values.length === items.length && uniqueValues.length === 1
        ? uniqueValues[0]
        : values.length === items.length
          ? mostFrequentDuration(values)
          : undefined
    )

    if (resolvedDefault) {
      next.medicationDuration = resolvedDefault as MedicationDuration
    } else {
      delete next.medicationDuration
    }

    const overrides: Record<string, SelectableMedicationDuration> = {}
    for (const [key, value] of Object.entries(durationMap)) {
      if (!resolvedDefault || value !== resolvedDefault) overrides[key] = value
    }
    if (Object.keys(overrides).length > 0) {
      next.medicationDurations = overrides
    } else {
      delete next.medicationDurations
    }
  } else {
    delete next.medicationDurations
    if (defaultDuration) {
      next.medicationDuration = defaultDuration
    } else {
      delete next.medicationDuration
    }
  }

  return next
}

export const USER_PROFILE_FIELDS = ['nickname', 'birthday', 'gender', 'currentConcern'] as const
export const PERSONAL_INFO_FIELDS = ['nickname', 'birthday', 'gender'] as const
export const MEDICAL_RECORD_FIELDS = [
  'menstrualStatus',
  'noduleBiradsGrade',
  'tumorType',
  'diagnosisDuration',
  'treatmentPhase',
  'medications',
  'medicationDuration',
] as const
export const STRUCTURED_PROFILE_FIELDS = [
  ...USER_PROFILE_FIELDS,
  ...MEDICAL_RECORD_FIELDS,
] as const

export const BASE_BREAST_MEDICAL_FIELDS = [
  'menstrualStatus',
  'medications',
  'medicationDuration',
] as const
export const BREAST_NODULE_EXTENSION_FIELDS = [
  'noduleBiradsGrade',
] as const
export const BREAST_CANCER_EXTENSION_FIELDS = [
  'tumorType',
  'diagnosisDuration',
  'treatmentPhase',
] as const

export type UserProfileField = (typeof USER_PROFILE_FIELDS)[number]
export type PersonalInfoFieldKey = (typeof PERSONAL_INFO_FIELDS)[number]
export type MedicalRecordField = (typeof MEDICAL_RECORD_FIELDS)[number]
export type StructuredProfileFieldKey = (typeof STRUCTURED_PROFILE_FIELDS)[number]
export type StructuredFieldStorageScope = 'user_profile' | 'medical_record'
export type StructuredFieldInputType = 'text' | 'date' | 'single_select' | 'multi_select'
export type StructuredFieldApprovalPolicy = 'auto_apply' | 'confirm_before_apply'

export interface RequiredUserProfileLike {
  nickname?: string | null
  birthday?: string | null
  gender?: string | null
  currentConcern?: CurrentConcern | null
}

export interface StructuredFieldDefinition {
  label: string
  storageScope: StructuredFieldStorageScope
  inputType: StructuredFieldInputType
  options?: readonly string[]
  approvalPolicy: StructuredFieldApprovalPolicy
  requiresHealthProfileConsent: boolean
}

export const FIELD_LABELS: Record<StructuredProfileFieldKey, string> = {
  nickname: '昵称',
  birthday: '生日',
  gender: '性别',
  currentConcern: '当前关注情况',
  menstrualStatus: '月经状态',
  noduleBiradsGrade: '乳腺检查分型',
  tumorType: '肿瘤分型',
  diagnosisDuration: '确诊时长',
  treatmentPhase: '治疗阶段',
  medications: '用药情况',
  medicationDuration: '用药时长',
}

/** 字段对应的枚举 label 表；未列出的字段（nickname/birthday/gender）直接原文展示 */
export const FIELD_ENUM_LABELS: Record<string, Record<string, string>> = {
  currentConcern: CURRENT_CONCERN_LABELS,
  menstrualStatus: MENSTRUAL_STATUS_LABELS,
  noduleBiradsGrade: NODULE_BIRADS_GRADE_LABELS,
  tumorType: TUMOR_TYPE_LABELS,
  diagnosisDuration: DIAGNOSIS_DURATION_LABELS,
  treatmentPhase: TREATMENT_PHASE_LABELS,
  medications: MEDICATION_LABELS,
  medicationDuration: MEDICATION_DURATION_LABELS,
}

export const STRUCTURED_FIELD_DEFINITIONS: Record<StructuredProfileFieldKey, StructuredFieldDefinition> = {
  nickname: {
    label: FIELD_LABELS.nickname,
    storageScope: 'user_profile',
    inputType: 'text',
    approvalPolicy: 'auto_apply',
    requiresHealthProfileConsent: false,
  },
  birthday: {
    label: FIELD_LABELS.birthday,
    storageScope: 'user_profile',
    inputType: 'date',
    approvalPolicy: 'auto_apply',
    requiresHealthProfileConsent: false,
  },
  gender: {
    label: FIELD_LABELS.gender,
    storageScope: 'user_profile',
    inputType: 'single_select',
    options: ['男', '女'],
    approvalPolicy: 'auto_apply',
    requiresHealthProfileConsent: false,
  },
  currentConcern: {
    label: FIELD_LABELS.currentConcern,
    storageScope: 'user_profile',
    inputType: 'single_select',
    options: CURRENT_CONCERNS,
    approvalPolicy: 'confirm_before_apply',
    requiresHealthProfileConsent: false,
  },
  menstrualStatus: {
    label: FIELD_LABELS.menstrualStatus,
    storageScope: 'medical_record',
    inputType: 'single_select',
    options: MENSTRUAL_STATUSES,
    approvalPolicy: 'confirm_before_apply',
    requiresHealthProfileConsent: true,
  },
  noduleBiradsGrade: {
    label: FIELD_LABELS.noduleBiradsGrade,
    storageScope: 'medical_record',
    inputType: 'single_select',
    options: NODULE_BIRADS_GRADES,
    approvalPolicy: 'confirm_before_apply',
    requiresHealthProfileConsent: true,
  },
  tumorType: {
    label: FIELD_LABELS.tumorType,
    storageScope: 'medical_record',
    inputType: 'single_select',
    options: TUMOR_TYPES,
    approvalPolicy: 'confirm_before_apply',
    requiresHealthProfileConsent: true,
  },
  diagnosisDuration: {
    label: FIELD_LABELS.diagnosisDuration,
    storageScope: 'medical_record',
    inputType: 'single_select',
    options: DIAGNOSIS_DURATIONS,
    approvalPolicy: 'confirm_before_apply',
    requiresHealthProfileConsent: true,
  },
  treatmentPhase: {
    label: FIELD_LABELS.treatmentPhase,
    storageScope: 'medical_record',
    inputType: 'single_select',
    options: TREATMENT_PHASES,
    approvalPolicy: 'confirm_before_apply',
    requiresHealthProfileConsent: true,
  },
  medications: {
    label: FIELD_LABELS.medications,
    storageScope: 'medical_record',
    inputType: 'multi_select',
    options: MEDICATION_OPTIONS,
    approvalPolicy: 'confirm_before_apply',
    requiresHealthProfileConsent: true,
  },
  medicationDuration: {
    label: FIELD_LABELS.medicationDuration,
    storageScope: 'medical_record',
    inputType: 'single_select',
    options: MEDICATION_DURATIONS,
    approvalPolicy: 'confirm_before_apply',
    requiresHealthProfileConsent: true,
  },
}

export const CONCERN_MEDICAL_FIELD_REGISTRY: Record<CurrentConcern, readonly MedicalRecordField[]> = {
  breast_tumor_care: [...BASE_BREAST_MEDICAL_FIELDS, ...BREAST_CANCER_EXTENSION_FIELDS],
  breast_nodule_followup: [...BREAST_NODULE_EXTENSION_FIELDS, ...BASE_BREAST_MEDICAL_FIELDS],
  awaiting_exam_or_results: BASE_BREAST_MEDICAL_FIELDS,
  not_sure_exploring: BASE_BREAST_MEDICAL_FIELDS,
  other_breast_issue: BASE_BREAST_MEDICAL_FIELDS,
}

const STRUCTURED_FIELD_SET = new Set<string>(STRUCTURED_PROFILE_FIELDS)
const USER_PROFILE_FIELD_SET = new Set<string>(USER_PROFILE_FIELDS)
const MEDICAL_RECORD_FIELD_SET = new Set<string>(MEDICAL_RECORD_FIELDS)
const BREAST_CANCER_EXTENSION_SET = new Set<string>(BREAST_CANCER_EXTENSION_FIELDS)
const BREAST_NODULE_EXTENSION_SET = new Set<string>(BREAST_NODULE_EXTENSION_FIELDS)

export function isBreastTumorConcern(concern: CurrentConcern | null | undefined): boolean {
  return concern === 'breast_tumor_care'
}

export function isStructuredProfileField(field: string): field is StructuredProfileFieldKey {
  return STRUCTURED_FIELD_SET.has(field)
}

export function isUserProfileField(field: string): field is UserProfileField {
  return USER_PROFILE_FIELD_SET.has(field)
}

export function isMedicalRecordField(field: string): field is MedicalRecordField {
  return MEDICAL_RECORD_FIELD_SET.has(field)
}

export function isBreastCancerExtensionField(field: string): field is (typeof BREAST_CANCER_EXTENSION_FIELDS)[number] {
  return BREAST_CANCER_EXTENSION_SET.has(field)
}

export function isBreastNoduleExtensionField(field: string): field is (typeof BREAST_NODULE_EXTENSION_FIELDS)[number] {
  return BREAST_NODULE_EXTENSION_SET.has(field)
}

export function getStructuredFieldDefinition(field: string): StructuredFieldDefinition | null {
  return isStructuredProfileField(field) ? STRUCTURED_FIELD_DEFINITIONS[field] : null
}

export function getFieldStorageScope(field: string): StructuredFieldStorageScope | null {
  return getStructuredFieldDefinition(field)?.storageScope ?? null
}

export function requiresApprovalForField(field: string): boolean {
  return getStructuredFieldDefinition(field)?.approvalPolicy === 'confirm_before_apply'
}

export function requiresHealthProfileConsentForField(field: string): boolean {
  return Boolean(getStructuredFieldDefinition(field)?.requiresHealthProfileConsent)
}

export function hasCompleteUserProfile(profile: RequiredUserProfileLike | null | undefined): boolean {
  const nickname = typeof profile?.nickname === 'string' ? profile.nickname.trim() : ''
  const birthday = typeof profile?.birthday === 'string' ? profile.birthday : ''
  const gender = profile?.gender
  const currentConcern = profile?.currentConcern

  return Boolean(
    nickname &&
    birthday &&
    (gender === '男' || gender === '女') &&
    currentConcern,
  )
}

function resolveConcernMedicalFields(currentConcern: CurrentConcern | null | undefined): readonly MedicalRecordField[] {
  if (!currentConcern) return BASE_BREAST_MEDICAL_FIELDS
  return CONCERN_MEDICAL_FIELD_REGISTRY[currentConcern]
}

export function resolveVisibleMedicalFields(
  currentConcern: CurrentConcern | null | undefined,
  gender?: string | null,
): MedicalRecordField[] {
  const fields = [...resolveConcernMedicalFields(currentConcern)]
  if (gender === '男') {
    return fields.filter((field) => field !== 'menstrualStatus')
  }
  return fields
}

export function resolveAllowedMedicalFieldsForAI(
  currentConcern: CurrentConcern | null | undefined,
  gender?: string | null,
): MedicalRecordField[] {
  return resolveVisibleMedicalFields(currentConcern, gender)
}

export function resolveOcrExtractableMedicalFields(
  currentConcern: CurrentConcern | null | undefined,
  gender?: string | null,
): MedicalRecordField[] {
  return resolveVisibleMedicalFields(currentConcern, gender)
}
