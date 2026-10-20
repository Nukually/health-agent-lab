import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveFeatureSnapshot } from '@health-agent/shared'
import {
  renderCxProductGuide,
  resolveCxProductGuideDownloadUrls,
} from './product-ui-guide.js'

test('CX product guide renders current UI layout for web/current release', () => {
  const guide = renderCxProductGuide({
    features: resolveFeatureSnapshot({ profile: 'dev' }),
    clientEnvironment: {
      platform: 'chrome',
      label: 'Chrome/网页',
      source: 'navigator',
    },
  })

  assert.match(guide, /生效 UI：current \/ default/)
  assert.match(guide, /surface=h5；profile=dev/)
  assert.match(guide, /该页内包含个人信息、阅读设置、账号与安全/)
  assert.match(guide, /\[个人信息\]\(\/profile\?mode=edit\)/)
  assert.match(guide, /必须保留 Markdown 链接格式/)
  assert.match(guide, /\[提醒\]\(\/scheduled-tasks\)/)
  assert.match(guide, /\[打卡记录\]\(\/check-ins\)/)
  assert.doesNotMatch(guide, /侧边栏底部“设置”菜单可展开/)
})

test('CX product guide renders current layout for prod Android release', () => {
  const guide = renderCxProductGuide({
    features: resolveFeatureSnapshot({ profile: 'prod' }),
    clientEnvironment: {
      platform: 'android',
      label: 'Android App',
      source: 'native_bridge',
      isNativeApp: true,
    },
  })

  assert.match(guide, /生效 UI：current \/ default/)
  assert.match(guide, /surface=android；profile=prod/)
  assert.match(guide, /该页内包含个人信息、阅读设置、账号与安全/)
  assert.match(guide, /\[个人信息\]\(\/profile\?mode=edit\)/)
  assert.doesNotMatch(guide, /侧边栏底部“设置”菜单可展开/)
  assert.match(guide, /\[提醒\]\(\/scheduled-tasks\)/)
})

test('CX product guide trusts actual legacy UI release from web client hint', () => {
  const guide = renderCxProductGuide({
    features: resolveFeatureSnapshot({ profile: 'dev' }),
    clientEnvironment: {
      platform: 'chrome',
      label: 'Chrome/网页',
      source: 'navigator',
      uiReleaseId: 'main-20260524',
      uiVariant: 'legacy-20260524',
    },
  })

  assert.match(guide, /生效 UI：main-20260524 \/ legacy-20260524/)
  assert.match(guide, /surface=h5；profile=dev/)
  assert.match(guide, /阅读设置和退出账户：侧边栏底部“设置”菜单/)
  assert.match(guide, /不要说“这个链接”但只输出不可点击的页面名/)
  assert.doesNotMatch(guide, /该页内包含个人信息、阅读设置、账号与安全/)
})

test('CX product guide can render only future notes', () => {
  const guide = renderCxProductGuide({
    features: resolveFeatureSnapshot({ profile: 'dev' }),
    clientEnvironment: {
      platform: 'web',
      label: '网页',
    },
    topic: 'future_notes',
  })

  assert.match(guide, /后续与未来 UI 事项/)
  assert.match(guide, /每次遇到产品 UI、入口、页面操作或使用问题，都要重新调用本工具/)
  assert.doesNotMatch(guide, /当前 UI 布局/)
})

test('CX product guide renders configured app download links as Markdown', () => {
  const guide = renderCxProductGuide({
    features: resolveFeatureSnapshot({ profile: 'prod' }),
    clientEnvironment: {
      platform: 'web',
      label: '网页',
    },
    topic: 'app_download',
    downloadUrls: {
      android: 'https://app.example.test/downloads/android/HealthAgentLab-1.0.0-10000-prod-release.apk',
      ios: 'https://testflight.apple.com/join/DEMO0000',
      harmony: 'https://appgallery.huawei.com/link/invite-test-wap?taskId=demo-invite-placeholder',
    },
  })

  assert.match(guide, /\[Android 下载 APK\]\(https:\/\/app\.example\.test\/downloads\/android\/HealthAgentLab-1\.0\.0-10000-prod-release\.apk\)/)
  assert.match(guide, /\[iOS TestFlight\]\(https:\/\/testflight\.apple\.com\/join\/DEMO0000\)/)
  assert.match(guide, /\[鸿蒙 5\.0\+ 内测\]\(https:\/\/appgallery\.huawei\.com\/link\/invite-test-wap\?taskId=demo-invite-placeholder\)/)
  assert.match(guide, /必须用 Markdown 链接给出已配置的对应入口/)
  assert.doesNotMatch(guide, /当前 UI 布局/)
})

test('CX product guide leaves app download links empty when env is absent', () => {
  assert.deepEqual(resolveCxProductGuideDownloadUrls({}), {
    android: '',
    ios: '',
    harmony: '',
  })

  const guide = renderCxProductGuide({
    features: resolveFeatureSnapshot({ profile: 'prod' }),
    clientEnvironment: {
      platform: 'web',
      label: '网页',
    },
    topic: 'app_download',
    downloadUrls: resolveCxProductGuideDownloadUrls({}),
  })

  assert.match(guide, /Android：未配置/)
  assert.match(guide, /iOS：未配置/)
  assert.match(guide, /鸿蒙 5\.0\+：未配置/)
})
