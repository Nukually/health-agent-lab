import assert from 'node:assert/strict'
import {
  isFeatureEnabled,
  resolveClientExperienceSnapshot,
  resolveFeatureSnapshot,
} from '@health-agent/shared'

const storage = new Map<string, string>()
;(globalThis as typeof globalThis & { localStorage?: Storage }).localStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { storage.set(key, value) },
  removeItem: (key: string) => { storage.delete(key) },
  clear: () => { storage.clear() },
  key: (index: number) => Array.from(storage.keys())[index] ?? null,
  get length() { return storage.size },
} as Storage

Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: {
    userAgent: 'Mozilla/5.0',
    platform: 'MacIntel',
    maxTouchPoints: 0,
  },
})

let requestInit: RequestInit | undefined
;(globalThis as typeof globalThis & { fetch?: typeof fetch }).fetch = (async (_input, init) => {
  requestInit = init
  return {
    ok: true,
    status: 200,
    json: async () => ({
      success: true,
      data: {
        features: resolveFeatureSnapshot({
          profile: 'prod',
          subject: { userId: 'user-1' },
        }),
        experience: resolveClientExperienceSnapshot({
          profile: 'prod',
          client: { surface: 'h5' },
        }),
        appDownloads: {
          android: 'https://app.example.test/downloads/android/HealthAgentLab-runtime-prod-release.apk',
          ios: 'https://testflight.apple.com/join/runtime',
          harmony: 'https://appgallery.huawei.com/link/invite-test-wap?taskId=runtime',
        },
      },
    }),
  } as Response
}) as typeof fetch

const { useStore } = await import('../src/stores/index.js')
const { refreshClientExperienceSnapshot } = await import('../src/clientExperience.js')

useStore.setState({
  token: 'access-token-1',
  features: resolveFeatureSnapshot({
    profile: 'prod',
    overrides: { myDoctorEntry: true },
  }),
})

await refreshClientExperienceSnapshot()

const headers = requestInit?.headers as Record<string, string>
assert.equal(headers.Authorization, 'Bearer access-token-1')
assert.equal(isFeatureEnabled(useStore.getState().features, 'myDoctorEntry'), false)
assert.deepEqual(useStore.getState().appDownloads, {
  android: 'https://app.example.test/downloads/android/HealthAgentLab-runtime-prod-release.apk',
  ios: 'https://testflight.apple.com/join/runtime',
  harmony: 'https://appgallery.huawei.com/link/invite-test-wap?taskId=runtime',
})

console.log('client experience tests passed')
