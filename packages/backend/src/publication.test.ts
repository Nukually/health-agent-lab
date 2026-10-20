import assert from 'node:assert/strict'
import test from 'node:test'
import { getEnv } from './env.js'
import { searchMedicalLiterature } from './services/medical-literature-search.js'
import { rootLogger } from './lib/logger.js'

test('standalone defaults contain no private service connection or credentials', () => {
  const env = getEnv()
  assert.equal(env.HOST, '127.0.0.1')
  assert.equal(env.DOCTOR_SERVER_BASE_URL, undefined)
  assert.equal(env.DOCTOR_SERVER_TOKEN, undefined)
  assert.equal(env.MEDICAL_RAG_QUERY_URL, undefined)
  assert.equal(env.JPUSH_ENABLED, false)
  assert.equal(env.LANGFUSE_ENABLED, false)
})

test('unconfigured literature search makes no network request', async () => {
  const originalFetch = globalThis.fetch
  let requests = 0
  globalThis.fetch = async () => { requests += 1; throw new Error('network forbidden in this test') }
  try {
    const result = await searchMedicalLiterature('synthetic demonstration', rootLogger.child({ module: 'publication-test' }), 1)
    assert.equal(requests, 0)
    assert.equal(result.displayOutput.selectedCount, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})
