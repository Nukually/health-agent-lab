// === User Profile (Level 1 - Personal Info) ===

export const CURRENT_CONCERNS = [
  'breast_tumor_care',
  'breast_nodule_followup',
  'awaiting_exam_or_results',
  'not_sure_exploring',
  'other_breast_issue',
] as const
export type CurrentConcern = (typeof CURRENT_CONCERNS)[number]

export interface UserProfileInput {
  nickname?: string
  birthday?: string // YYYY-MM-DD
  gender?: '男' | '女'
  currentConcern?: CurrentConcern
}

// === Medical Profile (Level 2 - Medical Archive) ===

export const MENSTRUAL_STATUSES = [
  'premenopausal',
  'perimenopausal',
  'postmenopausal',
  'treatment_induced',
  'uncertain',
] as const
export type MenstrualStatus = (typeof MENSTRUAL_STATUSES)[number]

export const TUMOR_TYPES = [
  'luminal_a',
  'luminal_b_her2_negative',
  'luminal_b_her2_positive',
  'her2_positive_hr_negative',
  'triple_negative',
  'unknown_or_untested',
] as const
export type TumorType = (typeof TUMOR_TYPES)[number]

export const NODULE_BIRADS_GRADES = [
  'birads_1_2',
  'birads_3',
  'birads_4',
  'birads_5',
  'uncertain',
] as const
export type NoduleBiradsGrade = (typeof NODULE_BIRADS_GRADES)[number]

export const DIAGNOSIS_DURATIONS = [
  'within_3m',
  '3_to_6m',
  '6_to_12m',
  '1_to_3y',
  'over_3y',
] as const
export type DiagnosisDuration = (typeof DIAGNOSIS_DURATIONS)[number]

export const TREATMENT_PHASES = [
  'pre_surgery',
  'surgery_recovery',
  'on_endocrine',
  'on_chemo',
  'on_radiation',
  'on_targeted',
  'non_surgical_comprehensive',
  'phase_completed_waiting_next',
  'completed_main',
  'paused_observation',
  'uncertain',
] as const
export type TreatmentPhase = (typeof TREATMENT_PHASES)[number]

export const MEDICATION_OPTIONS = [
  'tamoxifen',
  'letrozole',
  'anastrozole',
  'exemestane',
  'fulvestrant',
  'other',
  'none',
] as const
export type MedicationOption = (typeof MEDICATION_OPTIONS)[number]

export const SELECTABLE_MEDICATION_DURATIONS = [
  'within_1m',
  '1_to_3m',
  '3_to_6m',
  '6_to_12m',
  'over_1y',
] as const
export type SelectableMedicationDuration = (typeof SELECTABLE_MEDICATION_DURATIONS)[number]

export const MEDICATION_DURATIONS = [
  ...SELECTABLE_MEDICATION_DURATIONS,
  'not_required',
] as const
export type MedicationDuration = (typeof MEDICATION_DURATIONS)[number]

export interface MedicalProfileData {
  menstrualStatus?: MenstrualStatus
  noduleBiradsGrade?: NoduleBiradsGrade
  tumorType?: TumorType
  diagnosisDuration?: DiagnosisDuration
  treatmentPhase?: TreatmentPhase
  medications?: MedicationOption[]
  medicationCustom?: string
  /**
   * 新版用药时长：key 为具体药物标识。
   * - 常见药使用枚举值，如 letrozole
   * - 自定义药使用 custom:<药名>
   */
  medicationDurations?: Record<string, SelectableMedicationDuration>
  /** @deprecated 兼容旧版单一用药时长；新版只作为默认/历史兜底展示。 */
  medicationDuration?: MedicationDuration
  /**
   * 时间敏感字段的最近一次变更时间戳（ISO 8601 UTC）。
   * 仅对"相对时间"字段打戳 —— LLM prompt 渲染成"YYYY-MM-DD 填写"，防止过期相对时间误导推理。
   */
  fieldUpdatedAt?: {
    diagnosisDuration?: string
    medicationDuration?: string
  }
}

export interface MedicalRecordInput {
  profileData: MedicalProfileData
}

export interface MedicalRecord {
  id: string
  userId: string
  schemaVersion: number
  profileData: MedicalProfileData
  createdAt: string
  updatedAt: string
}
