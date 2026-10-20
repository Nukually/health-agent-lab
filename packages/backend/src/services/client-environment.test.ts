import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveClientEnvironment } from './client-environment.js'

test('client environment preserves actual UI release hints', () => {
  const env = resolveClientEnvironment({
    hint: {
      platform: 'chrome',
      source: 'navigator',
      uiReleaseId: 'main-20260524',
      uiVariant: 'legacy-20260524',
      userAgent: 'Mozilla/5.0 Chrome/126.0',
    },
  })

  assert.equal(env.platform, 'chrome')
  assert.equal(env.uiReleaseId, 'main-20260524')
  assert.equal(env.uiVariant, 'legacy-20260524')
})
