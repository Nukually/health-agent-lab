/**
 * 结构化档案字段校验与 label 生成，供 routes/medical.ts（确认卡落库路径）
 * 和 agent/tools/executor.ts（工具自动落库路径）共享。
 */

import {
  CURRENT_CONCERNS,
  STRUCTURED_PROFILE_FIELDS,
  MEDICATION_OPTIONS,
  SELECTABLE_MEDICATION_DURATIONS,
  FIELD_ENUM_LABELS,
  MEDICATION_LABELS,
  MEDICATION_CUSTOM_NAME_MAX_LENGTH,
  formatMedicationDurationDetails,
  getStructuredFieldDefinition,
  isBreastCancerExtensionField,
  isBreastNoduleExtensionField,
  isMedicalRecordField,
  resolveVisibleMedicalFields,
  type CurrentConcern,
  type MedicalProfileData,
} from '@health-agent/shared'

const ENUM_SETS: Record<string, ReadonlyArray<string>> = {
  currentConcern: CURRENT_CONCERNS,
}

function normalizeMedicationCustomName(value: string): string {
  return value.trim().replace(/[。．.!！?？,，、;；：:]+$/u, '').trim()
}

function splitMedicationCustomNames(value: string): string[] {
  return value
    .split(/[、,，;；。！？!?\n\r]+/u)
    .map(normalizeMedicationCustomName)
    .filter(Boolean)
}

function getTextLength(value: string): number {
  return Array.from(value).length
}

function validateMedicationCustom(value: string): string | null {
  if (getTextLength(value) > 200) return 'medicationCustom 过长'
  const tooLongName = splitMedicationCustomNames(value)
    .find((name) => getTextLength(name) > MEDICATION_CUSTOM_NAME_MAX_LENGTH)
  if (tooLongName) {
    return `单个自定义药品名称最多 ${MEDICATION_CUSTOM_NAME_MAX_LENGTH} 个字`
  }
  return null
}

function validateMedicationDurations(value: unknown): string | null {
  if (value == null) return null
  if (typeof value !== 'object' || Array.isArray(value)) {
    return 'medicationDurations 必须是对象'
  }
  for (const [key, duration] of Object.entries(value as Record<string, unknown>)) {
    if (!key.trim()) return 'medicationDurations 包含空药品 key'
    if (typeof duration !== 'string' || !SELECTABLE_MEDICATION_DURATIONS.includes(duration as any)) {
      return `medicationDurations.${key} 枚举值非法：${duration}`
    }
  }
  return null
}

export function validateField(field: string, value: unknown): string | null {
  if (!STRUCTURED_PROFILE_FIELDS.includes(field as any)) {
    return `非法字段：${field}`
  }

  if (field === 'medications') {
    if (!Array.isArray(value)) return 'medications 必须是字符串数组'
    for (const v of value) {
      if (typeof v !== 'string' || !MEDICATION_OPTIONS.includes(v as any)) {
        return `medications 包含非法枚举值：${v}`
      }
    }
    return null
  }

  if (field === 'gender') {
    if (value !== '男' && value !== '女') return 'gender 必须为 "男" 或 "女"'
    return null
  }

  if (field === 'birthday') {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return 'birthday 必须是 YYYY-MM-DD'
    }
    return null
  }

  if (field === 'nickname') {
    if (typeof value !== 'string' || value.trim().length === 0) {
      return 'nickname 必须是非空字符串'
    }
    if (value.length > 100) return 'nickname 过长'
    return null
  }

  const def = getStructuredFieldDefinition(field)
  const enumSet = def?.options ?? ENUM_SETS[field]
  if (enumSet) {
    if (typeof value !== 'string' || !enumSet.includes(value)) {
      return `${field} 枚举值非法：${value}`
    }
  }
  return null
}

export function validateMedicalFieldAllowed(
  field: string,
  currentConcern: CurrentConcern | null | undefined,
  gender?: string | null,
): string | null {
  if (!isMedicalRecordField(field)) return null
  const allowed = new Set(resolveVisibleMedicalFields(currentConcern, gender))
  if (allowed.has(field)) return null
  if (isBreastCancerExtensionField(field)) {
    return `当前关注情况不允许更新字段：${field}。如用户已进入乳腺肿瘤相关诊疗场景，请先更新 currentConcern=breast_tumor_care`
  }
  if (isBreastNoduleExtensionField(field)) {
    return `当前关注情况不允许更新字段：${field}。如用户已进入乳腺结节随访场景，请先更新 currentConcern=breast_nodule_followup`
  }
  return `当前关注情况不允许更新字段：${field}`
}

export function validateMedicalProfilePatch(
  patch: MedicalProfileData,
  currentConcern: CurrentConcern | null | undefined,
  gender?: string | null,
): string | null {
  const allowed = new Set(resolveVisibleMedicalFields(currentConcern, gender))

  for (const [field, value] of Object.entries(patch)) {
    if (field === 'fieldUpdatedAt') {
      return 'fieldUpdatedAt 不允许由客户端传入'
    }

    if (field === 'medicationCustom') {
      if (value !== undefined && typeof value !== 'string') {
        return 'medicationCustom 必须是字符串'
      }
      if (typeof value === 'string') {
        const err = validateMedicationCustom(value)
        if (err) return err
      }
      continue
    }

    if (field === 'medicationDurations') {
      const err = validateMedicationDurations(value)
      if (err) return err
      continue
    }

    if (!isMedicalRecordField(field)) {
      return `非法字段：${field}`
    }

    if (!allowed.has(field)) {
      if (isBreastCancerExtensionField(field)) {
        return `当前关注情况不允许更新字段：${field}。如用户已进入乳腺肿瘤相关诊疗场景，请先更新 currentConcern=breast_tumor_care`
      }
      if (isBreastNoduleExtensionField(field)) {
        return `当前关注情况不允许更新字段：${field}。如用户已进入乳腺结节随访场景，请先更新 currentConcern=breast_nodule_followup`
      }
      return `当前关注情况不允许更新字段：${field}`
    }

    const err = validateField(field, value)
    if (err) return err
  }

  return null
}

export function valueLabelOf(field: string, value: unknown): string {
  if (value == null || value === '') return '未填写'
  if (field === 'medications' && Array.isArray(value)) {
    if (value.length === 0) return '未填写'
    return value.map((v) => MEDICATION_LABELS[String(v)] || String(v)).join('、')
  }
  const enumMap = FIELD_ENUM_LABELS[field]
  if (enumMap) return enumMap[String(value)] || String(value)
  return String(value)
}

export function medicationDurationLabelOfProfile(profile: MedicalProfileData | null | undefined): string {
  return formatMedicationDurationDetails(profile)
}
