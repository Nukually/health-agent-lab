import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_FEATURE_SNAPSHOT,
  featureSignature,
  resolveFeatureSnapshot,
} from './features.js'

test('feature snapshot defaults memory recall persistence off', () => {
  assert.equal(DEFAULT_FEATURE_SNAPSHOT.features.MEMORY_ENABLE_PERSIST, false)
  assert.equal(
    resolveFeatureSnapshot({ profile: 'prod' }).features.MEMORY_ENABLE_PERSIST,
    false,
  )
})

test('feature snapshot supports memory recall persistence override', () => {
  const snapshot = resolveFeatureSnapshot({
    profile: 'dev',
    overrides: { MEMORY_ENABLE_PERSIST: true },
  })

  assert.equal(snapshot.features.MEMORY_ENABLE_PERSIST, true)
})

test('feature signature includes memory recall persistence flag', () => {
  const persisted = resolveFeatureSnapshot({
    profile: 'dev',
    overrides: { MEMORY_ENABLE_PERSIST: true },
  })
  const ephemeral = resolveFeatureSnapshot({
    profile: 'dev',
    overrides: { MEMORY_ENABLE_PERSIST: false },
  })

  assert.notEqual(featureSignature(ephemeral), featureSignature(persisted))
  assert.match(featureSignature(persisted), /MEMORY_ENABLE_PERSIST:1/)
})
