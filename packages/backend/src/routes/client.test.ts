import assert from 'node:assert/strict'
import test from 'node:test'
import { Hono } from 'hono'

process.env.LLM_API_KEY ||= 'test-llm-key'
process.env.DATABASE_URL ||= 'postgres://cxagent:cxagent@localhost:5432/cxagent'
process.env.JWT_SECRET ||= 'test-jwt-secret'
process.env.NODE_ENV ||= 'development'
process.env.DEPLOY_ENV ||= 'dev'
process.env.HEALTH_AGENT_ANDROID_APK_URL = 'https://app.example.test/downloads/android/HealthAgentLab-1.0.0-10000-prod-release.apk'
process.env.HEALTH_AGENT_TESTFLIGHT_URL = 'https://testflight.apple.com/join/runtime'
process.env.HEALTH_AGENT_HARMONY_BETA_URL = 'https://appgallery.huawei.com/link/invite-test-wap?taskId=runtime'

const { default: clientRoutes } = await import('./client.js')

function createApp() {
  const app = new Hono()
  app.route('/api/client', clientRoutes)
  return app
}

test('client experience endpoint keeps all dev surfaces on current UI release', async () => {
  const app = createApp()

  for (const platform of ['android', 'harmony', 'h5', 'ios']) {
    const res = await app.request(`/api/client/experience?platform=${platform}&source=native_bridge`)
    assert.equal(res.status, 200)
    const body = await res.json()

    assert.equal(body.success, true)
    assert.equal(body.data.features.profile, 'dev')
    assert.equal(body.data.experience.uiReleaseId, 'current')
    assert.equal(body.data.experience.uiVariant, 'default')
    assert.deepEqual(body.data.experience.contractVersion, { chat: 'chat.v1', message: 'message.v1' })
    assert.equal(body.data.experience.v2Only, undefined)
  }
})

test('client experience endpoint returns runtime app download urls', async () => {
  const app = createApp()

  const res = await app.request('/api/client/experience?platform=h5')
  assert.equal(res.status, 200)
  const body = await res.json()

  assert.deepEqual(body.data.appDownloads, {
    android: 'https://app.example.test/downloads/android/HealthAgentLab-1.0.0-10000-prod-release.apk',
    ios: 'https://testflight.apple.com/join/runtime',
    harmony: 'https://appgallery.huawei.com/link/invite-test-wap?taskId=runtime',
  })
})
