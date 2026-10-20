import assert from 'node:assert/strict'
import test from 'node:test'
import {
  resolveClientExperienceSnapshot,
  resolveClientSurface,
} from '../src/client-experience.js'

for (const profile of ['dev', 'sit', 'prod'] as const) {
  test(`${profile}: all surfaces use current UI release`, () => {
    for (const platform of ['h5', 'ios', 'android', 'harmony']) {
      const snapshot = resolveClientExperienceSnapshot({
        profile,
        client: { platform, source: platform === 'h5' ? 'navigator' : 'native_bridge' },
      })

      assert.equal(snapshot.uiReleaseId, 'current')
      assert.equal(snapshot.uiVariant, 'default')
      assert.equal(snapshot.legacyUiRef, undefined)
      assert.deepEqual(snapshot.contractVersion, { chat: 'chat.v1', message: 'message.v1' })
    }
  })
}

test('client surface falls back from user agent when platform is absent', () => {
  assert.equal(resolveClientSurface({ userAgent: 'Mozilla/5.0 (Linux; Android 14)' }), 'android')
  assert.equal(resolveClientSurface({ userAgent: 'Mozilla/5.0 (HarmonyOS; ArkWeb)' }), 'harmony')
  assert.equal(resolveClientSurface({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' }), 'ios')
  assert.equal(resolveClientSurface({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X)' }), 'h5')
})
