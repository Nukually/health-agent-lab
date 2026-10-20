import assert from 'node:assert/strict'
import test from 'node:test'
import {
  featureSignature,
  isFeatureEnabled,
  resolveFeatureProfile,
  resolveFeatureSnapshot,
} from '../src/features.js'

test('feature profiles resolve expected defaults', () => {
  const dev = resolveFeatureSnapshot({ profile: 'dev' })
  const sit = resolveFeatureSnapshot({ profile: 'sit' })
  const prod = resolveFeatureSnapshot({ profile: 'prod' })

  assert.equal(isFeatureEnabled(dev, 'healthEducationPlaza'), true)
  assert.equal(isFeatureEnabled(dev, 'myDoctorEntry'), false)
  assert.equal(isFeatureEnabled(dev, 'materialUploadAdmin'), true)
  assert.equal(isFeatureEnabled(dev, 'interventionCompletionReminderOffer'), true)
  assert.equal(isFeatureEnabled(dev, 'checkInRecords'), true)
  assert.equal(isFeatureEnabled(dev, 'llmContextDashboard'), true)
  assert.equal(isFeatureEnabled(dev, 'chatTtsControl'), true)
  assert.equal(isFeatureEnabled(dev, 'nativeDebugEntry'), true)
  assert.equal(isFeatureEnabled(dev, 'h5AppDownloadBanner'), false)
  assert.equal(isFeatureEnabled(sit, 'agentScheduledTasks'), true)
  assert.equal(isFeatureEnabled(sit, 'interventionCompletionReminderOffer'), true)
  assert.equal(isFeatureEnabled(sit, 'checkInRecords'), true)
  assert.equal(isFeatureEnabled(sit, 'myDoctorEntry'), false)
  assert.equal(isFeatureEnabled(sit, 'materialUploadAdmin'), false)
  assert.equal(isFeatureEnabled(sit, 'llmContextDashboard'), false)
  assert.equal(isFeatureEnabled(sit, 'chatTtsControl'), true)
  assert.equal(isFeatureEnabled(sit, 'nativeDebugEntry'), false)
  assert.equal(isFeatureEnabled(sit, 'h5AppDownloadBanner'), false)
  assert.equal(isFeatureEnabled(prod, 'healthEducationPlaza'), false)
  assert.equal(isFeatureEnabled(prod, 'myDoctorEntry'), false)
  assert.equal(isFeatureEnabled(prod, 'healthEducationFavorites'), false)
  assert.equal(isFeatureEnabled(prod, 'materialUploadAdmin'), false)
  assert.equal(isFeatureEnabled(prod, 'agentScheduledTasks'), true)
  assert.equal(isFeatureEnabled(prod, 'interventionCompletionReminderOffer'), false)
  assert.equal(isFeatureEnabled(prod, 'checkInRecords'), true)
  assert.equal(isFeatureEnabled(prod, 'llmContextDashboard'), false)
  assert.equal(isFeatureEnabled(prod, 'chatTtsControl'), true)
  assert.equal(isFeatureEnabled(prod, 'nativeDebugEntry'), false)
  assert.equal(isFeatureEnabled(prod, 'h5AppDownloadBanner'), false)
})

test('doctor subject enables my doctor entry', () => {
  const unbound = resolveFeatureSnapshot({ profile: 'dev' })
  const prodUnbound = resolveFeatureSnapshot({
    profile: 'prod',
    subject: { userId: 'user-1' },
  })
  const bound = resolveFeatureSnapshot({
    profile: 'prod',
    subject: { userId: 'user-1', doctorId: 'doctor-1' },
  })
  const forcedOff = resolveFeatureSnapshot({
    profile: 'prod',
    subject: { userId: 'user-1', doctorId: 'doctor-1' },
    overrides: { myDoctorEntry: false },
  })

  assert.equal(isFeatureEnabled(unbound, 'myDoctorEntry'), false)
  assert.equal(isFeatureEnabled(prodUnbound, 'myDoctorEntry'), false)
  assert.equal(isFeatureEnabled(bound, 'myDoctorEntry'), true)
  assert.equal(isFeatureEnabled(forcedOff, 'myDoctorEntry'), false)
})

test('feature overrides win over profile defaults', () => {
  const snapshot = resolveFeatureSnapshot({
    profile: 'prod',
    overrides: {
      agentScheduledTasks: true,
      checkInRecords: true,
      materialUploadAdmin: true,
    },
  })

  assert.equal(isFeatureEnabled(snapshot, 'healthEducationPlaza'), false)
  assert.equal(isFeatureEnabled(snapshot, 'agentScheduledTasks'), true)
  assert.equal(isFeatureEnabled(snapshot, 'checkInRecords'), true)
  assert.equal(isFeatureEnabled(snapshot, 'materialUploadAdmin'), true)
})

test('feature profile fallback and signature are stable', () => {
  const dev = resolveFeatureSnapshot({ profile: 'dev' })
  const devAgain = resolveFeatureSnapshot({ profile: 'dev' })
  const devWithEntrypointOverrides = resolveFeatureSnapshot({
    profile: 'dev',
    overrides: {
      myDoctorEntry: true,
      chatTtsControl: false,
      nativeDebugEntry: false,
      h5AppDownloadBanner: false,
    },
  })
  const devWithDoctorSubject = resolveFeatureSnapshot({
    profile: 'dev',
    subject: { userId: 'user-1', doctorId: 'doctor-1' },
  })
  const devWithoutCheckIns = resolveFeatureSnapshot({
    profile: 'dev',
    overrides: { checkInRecords: false },
  })
  const prod = resolveFeatureSnapshot({ profile: 'prod' })

  assert.equal(resolveFeatureProfile('unknown'), 'dev')
  assert.equal(featureSignature(dev), featureSignature(devAgain))
  assert.equal(featureSignature(dev), featureSignature(devWithEntrypointOverrides))
  assert.equal(featureSignature(dev), featureSignature(devWithDoctorSubject))
  assert.notEqual(featureSignature(dev), featureSignature(devWithoutCheckIns))
  assert.notEqual(featureSignature(dev), featureSignature(prod))
})
