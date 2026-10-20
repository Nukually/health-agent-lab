import test from 'node:test'
import assert from 'node:assert/strict'
import { MEDICATION_CUSTOM_NAME_MAX_LENGTH, normalizeMedicalProfileData } from '@health-agent/shared'
import { validateMedicalProfilePatch } from './profile-validation.js'

test('rejects custom medication names above the per-name limit', () => {
  const longName = '一'.repeat(MEDICATION_CUSTOM_NAME_MAX_LENGTH + 1)

  const err = validateMedicalProfilePatch(
    { medications: ['other'], medicationCustom: longName },
    'breast_tumor_care',
    '女',
  )

  assert.equal(err, `单个自定义药品名称最多 ${MEDICATION_CUSTOM_NAME_MAX_LENGTH} 个字`)
})

test('continues validating other fields after a valid custom medication name', () => {
  const err = validateMedicalProfilePatch(
    {
      medicationCustom: '注射用紫杉醇（白蛋白结合型）',
      medications: ['invalid_medication' as any],
    },
    'breast_tumor_care',
    '女',
  )

  assert.equal(err, 'medications 包含非法枚举值：invalid_medication')
})

test('accepts per-medication duration map in medical profile patch', () => {
  const err = validateMedicalProfilePatch(
    {
      medications: ['tamoxifen', 'letrozole'],
      medicationDuration: 'within_1m',
      medicationDurations: {
        tamoxifen: 'within_1m',
        letrozole: '1_to_3m',
      },
    },
    'breast_tumor_care',
    '女',
  )

  assert.equal(err, null)
})

test('accepts BI-RADS grade only for breast nodule follow-up concern', () => {
  assert.equal(
    validateMedicalProfilePatch(
      { noduleBiradsGrade: 'birads_4' },
      'breast_nodule_followup',
      '女',
    ),
    null,
  )

  assert.equal(
    validateMedicalProfilePatch(
      { noduleBiradsGrade: 'birads_4' },
      'breast_tumor_care',
      '女',
    ),
    '当前关注情况不允许更新字段：noduleBiradsGrade。如用户已进入乳腺结节随访场景，请先更新 currentConcern=breast_nodule_followup',
  )
})

test('accepts new breast tumor subtype options and rejects legacy HER2-only values', () => {
  assert.equal(
    validateMedicalProfilePatch(
      { tumorType: 'luminal_b_her2_positive' },
      'breast_tumor_care',
      '女',
    ),
    null,
  )

  assert.equal(
    validateMedicalProfilePatch(
      { tumorType: 'her2_positive' as any },
      'breast_tumor_care',
      '女',
    ),
    'tumorType 枚举值非法：her2_positive',
  )
})

test('accepts new treatment phases and normalizes legacy finished chemo/radiation values', () => {
  assert.equal(
    validateMedicalProfilePatch(
      { treatmentPhase: 'on_targeted' },
      'breast_tumor_care',
      '女',
    ),
    null,
  )

  assert.equal(
    validateMedicalProfilePatch(
      { treatmentPhase: 'post_chemo' as any },
      'breast_tumor_care',
      '女',
    ),
    'treatmentPhase 枚举值非法：post_chemo',
  )

  assert.deepEqual(
    normalizeMedicalProfileData({ treatmentPhase: 'post_radiation' as any }),
    { treatmentPhase: 'phase_completed_waiting_next' },
  )
})

test('normalizes legacy tumor subtype values to empty', () => {
  const normalized = normalizeMedicalProfileData({
    tumorType: 'her2_negative' as any,
    diagnosisDuration: 'within_3m',
  })

  assert.deepEqual(normalized, {
    diagnosisDuration: 'within_3m',
  })
})

test('normalizes an explicit empty medication list by clearing stale durations', () => {
  const normalized = normalizeMedicalProfileData({
    medications: [],
    medicationDuration: 'within_1m',
    medicationDurations: { tamoxifen: '1_to_3m' },
  })

  assert.deepEqual(normalized, {
    medications: [],
    medicationCustom: '',
  })
})
