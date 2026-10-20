import test from 'node:test'
import assert from 'node:assert/strict'
import type { MedicalProfileData } from '@health-agent/shared'
import {
  buildProfileFieldChanges,
  profilePatchChangedFields,
} from './medical-profile-patch.js'

test('profile patch changes render BI-RADS labels', () => {
  const changes = buildProfileFieldChanges(
    ['noduleBiradsGrade'],
    { noduleBiradsGrade: 'uncertain' },
    { noduleBiradsGrade: 'birads_3' },
  )

  assert.deepEqual(changes, [
    {
      field: 'noduleBiradsGrade',
      fieldLabel: '乳腺检查分型',
      fromValue: '不清楚/未检测',
      toValue: 'BI-RADS 3类',
    },
  ])
})

test('profile patch changed fields fold per-medication durations into one field', () => {
  const patch: MedicalProfileData = {
    medications: ['tamoxifen'],
    medicationDurations: {
      tamoxifen: 'within_1m',
    },
    medicationCustom: '',
  }

  assert.deepEqual(profilePatchChangedFields(patch), ['medications', 'medicationDuration'])
})
