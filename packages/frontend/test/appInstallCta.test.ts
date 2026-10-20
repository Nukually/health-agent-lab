import assert from 'node:assert/strict'
import test from 'node:test'
import {
  APP_INSTALL_CTA_DISMISSED_KEY,
  DEFAULT_ANDROID_APK_URL,
  DEFAULT_HARMONY_BETA_URL,
  DEFAULT_TESTFLIGHT_URL,
  readAppInstallCtaDismissed,
  resolveMarketingBannerSequence,
  shouldShowMarketingBannerIndicators,
  resolveAppInstallAction,
  resolveUserChannelSourceType,
  shouldShowAppInstallCta,
} from '../src/appInstallCta.js'

const ANDROID_WECHAT_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 MicroMessenger/8.0.48 Mobile Safari/537.36'
const ANDROID_CHROME_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/125.0.0.0 Mobile Safari/537.36'
const ANDROID_FEISHU_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/125.0.0.0 Mobile Safari/537.36 Feishu/7.28.0'
const HARMONY_4_UA = 'Mozilla/5.0 (Linux; Android 12; HUAWEI Mate 60; HarmonyOS/4.2) AppleWebKit/537.36 Chrome/125.0.0.0 Mobile Safari/537.36'
const HARMONY_5_UA = 'Mozilla/5.0 (Linux; HarmonyOS/5.0; HUAWEI Mate 70) AppleWebKit/537.36 ArkWeb/4.1 Mobile Safari/537.36'
const HARMONY_5_FEISHU_UA = `${HARMONY_5_UA} Lark/7.28.0`
const IOS_SAFARI_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1'

test('hides the install CTA inside native app webviews', () => {
  assert.equal(shouldShowAppInstallCta({ hasNativeBridge: true, dismissed: false }), false)
})

test('hides the install CTA when disabled by feature gate', () => {
  assert.equal(shouldShowAppInstallCta({ hasNativeBridge: false, dismissed: false, featureEnabled: false }), false)
})

test('hides the install CTA after the user dismisses it', () => {
  assert.equal(shouldShowAppInstallCta({ hasNativeBridge: false, dismissed: true }), false)
})

test('classifies only the explicit online channel partner name as online', () => {
  assert.equal(resolveUserChannelSourceType('线上'), 'online')
  assert.equal(resolveUserChannelSourceType('线下团队'), null)
  assert.equal(resolveUserChannelSourceType('内部测试'), null)
  assert.equal(resolveUserChannelSourceType(null), null)
})

test('resolves banner sequence by surface and online source', () => {
  assert.deepEqual(resolveMarketingBannerSequence({ surface: 'h5', channelSourceType: 'online' }), ['app_install', 'private_wechat'])
  assert.deepEqual(resolveMarketingBannerSequence({ surface: 'h5', channelSourceType: null }), ['app_install'])
  assert.deepEqual(resolveMarketingBannerSequence({ surface: 'ios', channelSourceType: 'online' }), ['private_wechat'])
  assert.deepEqual(resolveMarketingBannerSequence({ surface: 'android', channelSourceType: null }), [])
})


test('shows carousel indicators only when multiple banners are available', () => {
  assert.equal(shouldShowMarketingBannerIndicators(['app_install', 'private_wechat']), true)
  assert.equal(shouldShowMarketingBannerIndicators(['app_install']), false)
  assert.equal(shouldShowMarketingBannerIndicators([]), false)
})

test('does not persist the install CTA dismissal across page reloads', () => {
  const previousWindow = (globalThis as { window?: unknown }).window
  const storage = new Map<string, string>()
  ;(globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
  }

  try {
    storage.set(APP_INSTALL_CTA_DISMISSED_KEY, 'true')
    assert.equal(readAppInstallCtaDismissed(), false)
  } finally {
    ;(globalThis as { window?: unknown }).window = previousWindow
  }
})

test('downloads the Android APK directly outside WeChat', () => {
  assert.deepEqual(resolveAppInstallAction({ userAgent: ANDROID_CHROME_UA }), {
    type: 'download_apk',
    url: DEFAULT_ANDROID_APK_URL,
  })
})

test('uses runtime Android APK URL from client experience before the default fallback', () => {
  assert.deepEqual(resolveAppInstallAction({
    userAgent: ANDROID_CHROME_UA,
    androidApkUrl: 'https://app.example.test/downloads/android/HealthAgentLab-runtime-prod-release.apk',
  }), {
    type: 'download_apk',
    url: 'https://app.example.test/downloads/android/HealthAgentLab-runtime-prod-release.apk',
  })
})

test('shows browser-open guidance for Android WeChat', () => {
  assert.deepEqual(resolveAppInstallAction({ userAgent: ANDROID_WECHAT_UA }), {
    type: 'show_embedded_browser_guide',
    target: 'android_apk',
    url: DEFAULT_ANDROID_APK_URL,
  })
})

test('shows browser-open guidance for Android Feishu', () => {
  assert.deepEqual(resolveAppInstallAction({ userAgent: ANDROID_FEISHU_UA }), {
    type: 'show_embedded_browser_guide',
    target: 'android_apk',
    url: DEFAULT_ANDROID_APK_URL,
  })
})

test('downloads the Android APK on HarmonyOS below 5', () => {
  assert.deepEqual(resolveAppInstallAction({ userAgent: HARMONY_4_UA }), {
    type: 'download_apk',
    url: DEFAULT_ANDROID_APK_URL,
  })
})

test('opens the Harmony beta link on HarmonyOS 5 or above', () => {
  assert.deepEqual(resolveAppInstallAction({ userAgent: HARMONY_5_UA }), {
    type: 'open_harmony_beta',
    url: DEFAULT_HARMONY_BETA_URL,
  })
})

test('shows browser-open guidance for HarmonyOS 5 Feishu', () => {
  assert.deepEqual(resolveAppInstallAction({ userAgent: HARMONY_5_FEISHU_UA }), {
    type: 'show_embedded_browser_guide',
    target: 'harmony_beta',
    url: DEFAULT_HARMONY_BETA_URL,
  })
})

test('opens TestFlight on iOS when a TestFlight URL is configured', () => {
  assert.deepEqual(resolveAppInstallAction({
    userAgent: IOS_SAFARI_UA,
    testFlightUrl: 'https://testflight.apple.com/join/demo',
  }), {
    type: 'open_testflight',
    url: 'https://testflight.apple.com/join/demo',
  })
})

test('has no built-in TestFlight destination', () => {
  assert.equal(DEFAULT_TESTFLIGHT_URL, '')
  assert.deepEqual(resolveAppInstallAction({ userAgent: IOS_SAFARI_UA }), {
    type: 'show_platform_options',
  })
})

test('falls back to platform choices on desktop or unsupported mobile browsers', () => {
  assert.deepEqual(resolveAppInstallAction({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' }), {
    type: 'show_platform_options',
  })
})
