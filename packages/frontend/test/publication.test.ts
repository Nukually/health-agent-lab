import assert from 'node:assert/strict'
import test from 'node:test'
import { LOGIN_AGREEMENT_HTML } from '../src/assets/agreements/loginAgreement.js'
import { PRIVACY_POLICY_HTML } from '../src/assets/agreements/privacyPolicy.js'
import { HEALTH_PROFILE_CONSENT_HTML } from '../src/assets/agreements/healthProfileConsent.js'
import { DEFAULT_ANDROID_APK_URL, DEFAULT_HARMONY_BETA_URL, DEFAULT_TESTFLIGHT_URL } from '../src/appInstallCta.js'
import { CONSENT_VERSIONS, resolveFeatureSnapshot } from '@health-agent/shared'

test('demo notices describe the deployment without restricting source licensing', () => {
  assert.match(LOGIN_AGREEMENT_HTML, /Apache License 2.0/)
  assert.match(LOGIN_AGREEMENT_HTML, /合成资料|合成数据|合成/)
  assert.doesNotMatch(LOGIN_AGREEMENT_HTML, /非商业的使用|禁止.*竞争|未经.*书面许可/)
  assert.match(PRIVACY_POLICY_HTML, /发送至部署者配置的模型服务/)
  assert.match(HEALTH_PROFILE_CONSENT_HTML, /不包含.*模型训练/)
  assert.equal(CONSENT_VERSIONS.login_agreement, 'demo-2026-10-20')
  assert.equal(CONSENT_VERSIONS.health_profile, 'demo-2026-10-20')
})

test('the demo has no default app download or marketing destination', () => {
  for (const url of [DEFAULT_ANDROID_APK_URL, DEFAULT_HARMONY_BETA_URL, DEFAULT_TESTFLIGHT_URL]) assert.equal(url, '')
  for (const profile of ['dev', 'sit', 'prod']) {
    assert.equal(resolveFeatureSnapshot({ profile }).features.h5AppDownloadBanner, false)
  }
})
