import assert from 'node:assert/strict'
import { isFeatureEnabled } from '@health-agent/shared'
import {
  createFrontendFeatureSnapshot,
  inferFeatureProfileFromHostname,
  resolveChatEntrypointFeatures,
} from '../src/features.js'

{
  assert.equal(inferFeatureProfileFromHostname('app.example.test'), 'dev')
  assert.equal(inferFeatureProfileFromHostname('sit-app.example.test'), 'dev')
  assert.equal(inferFeatureProfileFromHostname('localhost'), 'dev')
}

{
  const snapshot = createFrontendFeatureSnapshot({ configuredProfile: 'prod', hostname: 'localhost' })
  assert.equal(isFeatureEnabled(snapshot, 'healthEducationPlaza'), false)
  assert.equal(isFeatureEnabled(snapshot, 'myDoctorEntry'), false)
  assert.equal(isFeatureEnabled(snapshot, 'healthEducationFavorites'), false)
  assert.equal(isFeatureEnabled(snapshot, 'materialUploadAdmin'), false)
  assert.equal(isFeatureEnabled(snapshot, 'interventionCompletionReminderOffer'), false)
  assert.equal(isFeatureEnabled(snapshot, 'checkInRecords'), true)
  assert.equal(isFeatureEnabled(snapshot, 'llmContextDashboard'), false)
  assert.equal(isFeatureEnabled(snapshot, 'h5AppDownloadBanner'), false)
}

{
  const snapshot = createFrontendFeatureSnapshot({ configuredProfile: 'sit', hostname: 'sit-app.example.test' })
  assert.equal(isFeatureEnabled(snapshot, 'healthEducationPlaza'), true)
  assert.equal(isFeatureEnabled(snapshot, 'myDoctorEntry'), false)
  assert.equal(isFeatureEnabled(snapshot, 'healthEducationFavorites'), true)
  assert.equal(isFeatureEnabled(snapshot, 'materialUploadAdmin'), false)
  assert.equal(isFeatureEnabled(snapshot, 'interventionCompletionReminderOffer'), true)
  assert.equal(isFeatureEnabled(snapshot, 'checkInRecords'), true)
  assert.equal(isFeatureEnabled(snapshot, 'llmContextDashboard'), false)
  assert.equal(isFeatureEnabled(snapshot, 'h5AppDownloadBanner'), false)
}

{
  const snapshot = createFrontendFeatureSnapshot({ configuredProfile: 'dev', hostname: 'app.example.test' })
  assert.equal(isFeatureEnabled(snapshot, 'materialUploadAdmin'), true)
  assert.equal(isFeatureEnabled(snapshot, 'llmContextDashboard'), true)
}

{
  const snapshot = createFrontendFeatureSnapshot({ configuredProfile: 'dev', hostname: 'localhost' })
  assert.equal(resolveChatEntrypointFeatures(snapshot, {
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) MicroMessenger',
    platform: 'iPhone',
    maxTouchPoints: 1,
    hasNativeBridge: false,
    nativeModules: null,
  }).showTtsControl, false)
  assert.equal(resolveChatEntrypointFeatures(snapshot, {
    userAgent: 'Mozilla/5.0 (Linux; Android 14) Feishu',
    platform: 'Linux armv8l',
    maxTouchPoints: 5,
    hasNativeBridge: false,
    nativeModules: null,
  }).showTtsControl, false)
  assert.equal(resolveChatEntrypointFeatures(snapshot, {
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
    platform: 'MacIntel',
    maxTouchPoints: 0,
    hasNativeBridge: false,
    nativeModules: null,
  }).showTtsControl, true)
  assert.equal(resolveChatEntrypointFeatures(snapshot, {
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
    platform: 'iPhone',
    maxTouchPoints: 1,
    hasNativeBridge: true,
    nativeModules: null,
  }).showTtsControl, true)
}

{
  const dev = createFrontendFeatureSnapshot({ configuredProfile: 'dev', hostname: 'localhost' })
  const sit = createFrontendFeatureSnapshot({ configuredProfile: 'sit', hostname: 'localhost' })
  const runtime = {
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
    platform: 'iPhone',
    maxTouchPoints: 1,
    hasNativeBridge: true,
    nativeModules: { debug: ['openNativeDebug'] },
  }
  assert.equal(resolveChatEntrypointFeatures(dev, runtime).showNativeDebugEntry, true)
  assert.equal(resolveChatEntrypointFeatures(sit, runtime).showNativeDebugEntry, false)
}

console.log('frontend feature tests passed')
