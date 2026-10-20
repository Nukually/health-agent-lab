import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveFeatureSnapshot } from '@health-agent/shared'
import {
  resolveInterventionFollowupIntentKind,
  shouldEnforceDailyEffectFollowupLimit,
  shouldCreateInterventionFollowupIntent,
} from './intervention-followup-intent.js'

test('intervention followup intent uses two buckets with 50 percent included', () => {
  assert.equal(
    resolveInterventionFollowupIntentKind({ totalFollowSec: 49, materialDurationSec: 100 }),
    'completion_reminder_offer',
  )
  assert.equal(
    resolveInterventionFollowupIntentKind({ totalFollowSec: 50, materialDurationSec: 100 }),
    'effect_question',
  )
  assert.equal(
    resolveInterventionFollowupIntentKind({ totalFollowSec: 51, materialDurationSec: 100 }),
    'effect_question',
  )
})

test('intervention followup intent falls back to reminder offer when duration is unavailable', () => {
  assert.equal(
    resolveInterventionFollowupIntentKind({ totalFollowSec: 30, materialDurationSec: 0 }),
    'completion_reminder_offer',
  )
})

test('completion reminder offer follows feature gate while effect checks stay enabled', () => {
  const prod = resolveFeatureSnapshot({ profile: 'prod' })
  const sit = resolveFeatureSnapshot({ profile: 'sit' })

  assert.equal(shouldCreateInterventionFollowupIntent('completion_reminder_offer', prod), false)
  assert.equal(shouldCreateInterventionFollowupIntent('completion_reminder_offer', sit), true)
  assert.equal(shouldCreateInterventionFollowupIntent('effect_question', prod), true)
})

test('daily effect followup limit only applies outside dev', () => {
  assert.equal(shouldEnforceDailyEffectFollowupLimit(resolveFeatureSnapshot({ profile: 'dev' })), false)
  assert.equal(shouldEnforceDailyEffectFollowupLimit(resolveFeatureSnapshot({ profile: 'sit' })), true)
  assert.equal(shouldEnforceDailyEffectFollowupLimit(resolveFeatureSnapshot({ profile: 'prod' })), true)
})
