import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveClientEnvironment } from './client-environment.js'

test('client environment preserves actual UI release hints', () => {
  const env = resolveClientEnvironment({
    hint: {
      platform: 'chrome',
      source: 'navigator',
      uiReleaseId: 'current',
      uiVariant: 'default',
      userAgent: 'Mozilla/5.0 Chrome/126.0',
    },
  })

  assert.equal(env.platform, 'chrome')
  assert.equal(env.uiReleaseId, 'current')
  assert.equal(env.uiVariant, 'default')
})
