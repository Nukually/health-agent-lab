import {
  CURRENT_UI_RELEASE_ID,
  LEGACY_20260524_UI_REF,
  LEGACY_20260524_UI_RELEASE_ID,
  TOOL_UI_MANIFEST,
  clientExperienceSignature,
  isFeatureEnabled,
  resolveClientExperienceSnapshot,
  type AppDownloadUrls,
  type ClientContext,
  type ClientExperienceSnapshot,
  type FeatureKey,
  type FeatureSnapshot,
} from '@health-agent/shared'
import type { ToolDefinition } from '../../api/types.js'
import type { ResolvedClientEnvironment } from '../../services/client-environment.js'

type CxProductGuideTopic =
  | 'all'
  | 'navigation'
  | 'data_management'
  | 'account_settings'
  | 'app_download'
  | 'feature_availability'
  | 'future_notes'

type AppDownloadEnv = Partial<Record<
  | 'HEALTH_AGENT_ANDROID_APK_URL'
  | 'HEALTH_AGENT_TESTFLIGHT_URL'
  | 'HEALTH_AGENT_HARMONY_BETA_URL'
  | 'VITE_HEALTH_AGENT_ANDROID_APK_URL'
  | 'VITE_HEALTH_AGENT_TESTFLIGHT_URL'
  | 'VITE_HEALTH_AGENT_HARMONY_BETA_URL',
  string | undefined
>>

const FEATURE_LABELS: Record<FeatureKey, string> = {
  healthEducationPlaza: '医生说广场',
  myDoctorEntry: '我的医生',
  healthEducationFavorites: '医生说收藏',
  materialUploadAdmin: '素材上传台',
  agentScheduledTasks: '提醒',
  interventionCompletionReminderOffer: '跟练完成提醒',
  checkInRecords: '打卡记录',
  llmContextDashboard: 'LLM Context',
  chatTtsControl: '语音播报',
  nativeDebugEntry: '原生调试',
  h5AppDownloadBanner: 'H5 下载 App banner',
  MEMORY_ENABLE_PERSIST: '记忆召回入库',
}

function clientContextFromEnvironment(env: ResolvedClientEnvironment): ClientContext {
  const platform = env.platform === 'chrome' || env.platform === 'web'
    ? 'h5'
    : env.platform === 'unknown'
      ? null
      : env.platform

  return {
    surface: env.surface ?? null,
    platform,
    source: env.source ?? (env.isNativeApp ? 'native_bridge' : null),
    appVersion: env.appVersion ?? null,
    versionCode: env.versionCode ?? null,
    bridgeVersion: env.bridgeVersion ?? null,
    h5BuildVersion: env.h5BuildVersion ?? null,
    userAgent: null,
  }
}

function normalizedText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function firstConfiguredUrl(...values: Array<string | undefined>): string | null {
  for (const value of values) {
    const normalized = normalizedText(value)
    if (normalized) return normalized
  }
  return null
}

export function resolveCxProductGuideDownloadUrls(env: AppDownloadEnv = process.env): AppDownloadUrls {
  return {
    android: firstConfiguredUrl(env.HEALTH_AGENT_ANDROID_APK_URL, env.VITE_HEALTH_AGENT_ANDROID_APK_URL) ?? '',
    ios: firstConfiguredUrl(env.HEALTH_AGENT_TESTFLIGHT_URL, env.VITE_HEALTH_AGENT_TESTFLIGHT_URL) ?? '',
    harmony: firstConfiguredUrl(env.HEALTH_AGENT_HARMONY_BETA_URL, env.VITE_HEALTH_AGENT_HARMONY_BETA_URL) ?? '',
  }
}

function withActualUiRelease(
  inferred: ClientExperienceSnapshot,
  env: ResolvedClientEnvironment,
): ClientExperienceSnapshot {
  const uiReleaseId = normalizedText(env.uiReleaseId)
  const uiVariant = normalizedText(env.uiVariant)

  if (uiReleaseId === LEGACY_20260524_UI_RELEASE_ID || uiVariant === 'legacy-20260524') {
    const base = {
      ...inferred,
      uiReleaseId: LEGACY_20260524_UI_RELEASE_ID,
      uiVariant: 'legacy-20260524' as const,
      legacyUiRef: LEGACY_20260524_UI_REF,
    }
    return {
      ...base,
      signature: clientExperienceSignature(base),
    }
  }

  if (uiReleaseId === CURRENT_UI_RELEASE_ID || uiVariant === 'default') {
    const base = {
      profile: inferred.profile,
      surface: inferred.surface,
      uiReleaseId: CURRENT_UI_RELEASE_ID,
      uiVariant: 'default' as const,
      contractVersion: inferred.contractVersion,
    }
    return {
      ...base,
      signature: clientExperienceSignature(base),
    }
  }

  return inferred
}

function enabledFeatureLabels(features: FeatureSnapshot): string {
  return Object.entries(features.features)
    .filter(([, enabled]) => enabled)
    .map(([key]) => FEATURE_LABELS[key as FeatureKey])
    .join('、') || '无'
}

function disabledFeatureLabels(features: FeatureSnapshot): string {
  return Object.entries(features.features)
    .filter(([, enabled]) => !enabled)
    .map(([key]) => FEATURE_LABELS[key as FeatureKey])
    .join('、') || '无'
}

function renderVisibleEntry(
  features: FeatureSnapshot,
  key: FeatureKey,
  text: string,
): string | null {
  return isFeatureEnabled(features, key) ? text : null
}

function renderCurrentLayout(features: FeatureSnapshot): string {
  const commonItems = [
    '- 健康档案：[健康档案](/medical-records)，管理病历、报告和病历图片。',
    renderVisibleEntry(features, 'agentScheduledTasks', '- 提醒：[提醒](/scheduled-tasks)，查看、调整或取消未来提醒。'),
    renderVisibleEntry(features, 'checkInRecords', '- 打卡记录：[打卡记录](/check-ins)，查看和管理已保存打卡。'),
    renderVisibleEntry(features, 'myDoctorEntry', '- 我的医生：[我的医生](/my-doctor)，查看绑定医生相关信息。'),
    '- 收藏：[收藏](/materials)，查看跟练卡/视频和沟通卡；若医生说收藏开启，也会包含医生说内容。',
  ].filter(Boolean).join('\n')

  return `## 当前 UI 布局（current / default）
- 聊天页左上角菜单按钮打开侧边栏；右上角可能出现“医生说”和语音播报按钮，是否显示取决于功能开关。
- 侧边栏顶部个人卡片进入 [个人信息](/profile?mode=edit)。该页内包含个人信息、阅读设置、账号与安全；账号与安全里包含清空健康档案、退出账户、注销账户。
- 侧边栏常用功能：
${commonItems}
- 最近对话在侧边栏下方展示，可切换或删除单个对话。
- 素材上传台、原生调试、LLM Context 是内部/调试入口，只在对应开关开启时显示。
- 回答用户时，如果给出页面直达入口，必须保留 Markdown 链接格式，例如 [个人信息](/profile?mode=edit)，不要只输出页面名。`
}

function renderLegacy20260524Layout(features: FeatureSnapshot): string {
  const commonItems = [
    '- 健康档案：[健康档案](/medical-records)，管理病历、报告和病历图片。',
    renderVisibleEntry(features, 'agentScheduledTasks', '- 提醒：[提醒](/scheduled-tasks)，查看、调整或取消未来提醒。'),
    renderVisibleEntry(features, 'checkInRecords', '- 打卡记录：[打卡记录](/check-ins)，查看和管理已保存打卡。'),
    '- 收藏：[收藏](/materials)，查看跟练卡/视频和沟通卡；若医生说收藏开启，也会包含医生说内容。',
  ].filter(Boolean).join('\n')

  const doctorEntry = isFeatureEnabled(features, 'myDoctorEntry')
    ? '\n- “我的医生”在侧边栏工具入口区域显示，不在常用功能列表里。'
    : ''

  return `## 当前 UI 布局（main-20260524 / legacy-20260524）
- 聊天页左上角菜单按钮打开侧边栏；右上角可能出现“医生说”和语音播报按钮，是否显示取决于功能开关。
- 侧边栏顶部个人卡片进入 [个人信息](/profile?mode=edit)，主要用于编辑个人资料；账号与安全从个人信息页底部进入 [账号与安全](/account-security)。
- 侧边栏常用功能：
${commonItems}${doctorEntry}
- 侧边栏底部“设置”菜单可展开阅读设置、退出账户、注销账户；阅读设置也可直接进入 [阅读设置](/reading-settings)。
- 最近对话在侧边栏下方展示，可切换或删除单个对话。
- 回答用户时，如果给出页面直达入口，必须保留 Markdown 链接格式，例如 [阅读设置](/reading-settings)，不要只输出页面名。`
}

function renderDataManagement(experienceId: string): string {
  if (experienceId === LEGACY_20260524_UI_RELEASE_ID) {
    return `## 资料管理与删除边界
- 需要引导用户进入页面时，优先直接发 Markdown 链接，同时说明旧版 UI 的真实入口。
- 直接发入口时必须保留 [页面名](/path) 格式；不要说“这个链接”但只输出不可点击的页面名。
- 阅读设置和退出账户：侧边栏底部“设置”菜单；阅读设置也可直接进入 [阅读设置](/reading-settings)。
- 删除单份病历、报告或病历图片：引导到 [健康档案](/medical-records)，由用户自行操作。
- 清空全部健康档案或注销账户：引导到 [账号与安全](/account-security)，由用户自行操作；注销账户也可从侧边栏底部“设置”菜单进入。
- 删除或取消收藏沟通卡、跟练卡片、干预方案、医生说收藏：引导到 [收藏](/materials)，由用户自行操作。
- 你不能替用户点击页面按钮，也不要声称“已删除/已清空/已退出/已注销/已取消收藏”。非删除类个人信息和健康档案结构化字段更新，继续按 update_structured_profile 工具规则处理。`
  }

  return `## 资料管理与删除边界
- 需要引导用户进入页面时，优先直接发 Markdown 链接，不要只说“打开侧边栏/点击菜单按钮”。
- 直接发入口时必须保留 [页面名](/path) 格式；不要说“这个链接”但只输出不可点击的页面名。
- 删除单份病历、报告或病历图片：引导到 [健康档案](/medical-records)，由用户自行操作。
- 阅读设置、清空全部健康档案、退出账户或注销账户：引导到 [个人信息](/profile?mode=edit)，由用户自行操作。
- 删除或取消收藏沟通卡、跟练卡片、干预方案、医生说收藏：引导到 [收藏](/materials)，由用户自行操作。
- 你不能替用户点击页面按钮，也不要声称“已删除/已清空/已退出/已注销/已取消收藏”。非删除类个人信息和健康档案结构化字段更新，继续按 update_structured_profile 工具规则处理。`
}

function renderAppDownloadGuide(urls: AppDownloadUrls): string {
  const android = urls.android ? `[Android 下载 APK](${urls.android})` : '未配置'
  const ios = urls.ios ? `[iOS TestFlight](${urls.ios})` : '未配置'
  const harmony = urls.harmony ? `[鸿蒙 5.0+ 内测](${urls.harmony})` : '未配置'

  return `## 移动端 App 下载指南
- Android：${android}。
- iOS：${ios}。
- 鸿蒙 5.0+：${harmony}。
- 链接由服务端运行时环境变量解析，优先使用 HEALTH_AGENT_ANDROID_APK_URL / HEALTH_AGENT_TESTFLIGHT_URL / HEALTH_AGENT_HARMONY_BETA_URL，并兼容 VITE_HEALTH_AGENT_ANDROID_APK_URL / VITE_HEALTH_AGENT_TESTFLIGHT_URL / VITE_HEALTH_AGENT_HARMONY_BETA_URL；不要改成临时签名 URL 或会过期的短链接。
- 回答用户下载或安装问题时，必须用 Markdown 链接给出已配置的对应入口；未配置的端不要编造链接。若用户在微信/飞书内置浏览器中遇到下载拦截，提示使用系统浏览器打开。`
}

function renderFutureNotes(): string {
  return `## 后续与未来 UI 事项
- Health Agent Lab可能继续多 UI release 并行；每次遇到产品 UI、入口、页面操作或使用问题，都要重新调用本工具，不要凭旧版本记忆回答。
- 只按本工具返回的生效 UI release、surface 和功能开关回答；未在当前版本出现的入口，不要借用另一套 UI 的入口描述。
- 如果用户问到本工具未覆盖的新页面或入口，应说明“我按你当前版本暂时没有看到这个入口”，再给出最接近的现有入口或建议更新到最新客户端。`
}

function normalizeTopic(value: unknown): CxProductGuideTopic {
  if (
    value === 'navigation'
    || value === 'data_management'
    || value === 'account_settings'
    || value === 'app_download'
    || value === 'feature_availability'
    || value === 'future_notes'
  ) {
    return value
  }
  return 'all'
}

export function renderCxProductGuide(input: {
  features: FeatureSnapshot
  clientEnvironment: ResolvedClientEnvironment
  topic?: unknown
  downloadUrls?: AppDownloadUrls
}): string {
  const topic = normalizeTopic(input.topic)
  const downloadUrls = input.downloadUrls ?? resolveCxProductGuideDownloadUrls()
  const inferredExperience = resolveClientExperienceSnapshot({
    profile: input.features.profile,
    client: clientContextFromEnvironment(input.clientEnvironment),
  })
  const experience = withActualUiRelease(inferredExperience, input.clientEnvironment)
  const layout = experience.uiReleaseId === 'main-20260524'
    ? renderLegacy20260524Layout(input.features)
    : renderCurrentLayout(input.features)
  const sections = [
    '[cx-product-guide]',
    `当前客户端：${input.clientEnvironment.label}`,
    `生效 UI：${experience.uiReleaseId} / ${experience.uiVariant}`,
    `surface=${experience.surface}；profile=${experience.profile}；contract=${experience.contractVersion.chat}/${experience.contractVersion.message}`,
  ]

  if (topic === 'all' || topic === 'navigation' || topic === 'account_settings' || topic === 'feature_availability') {
    sections.push(layout)
  }
  if (topic === 'all' || topic === 'feature_availability') {
    sections.push(`## 当前功能开关\n- 已开启：${enabledFeatureLabels(input.features)}\n- 未开启：${disabledFeatureLabels(input.features)}\n- 入口是否可见以当前 UI 和账号实际展示为准；开关关闭时不要承诺用户一定能看到该入口。`)
  }
  if (topic === 'all' || topic === 'data_management' || topic === 'account_settings') {
    sections.push(renderDataManagement(experience.uiReleaseId))
  }
  if (topic === 'all' || topic === 'app_download') {
    sections.push(renderAppDownloadGuide(downloadUrls))
  }
  if (topic === 'all' || topic === 'future_notes') {
    sections.push(renderFutureNotes())
  }

  return sections.join('\n\n')
}

export const READ_CX_PRODUCT_GUIDE_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'read_product_guide',
    description: `读取当前客户端实际生效的Health Agent Lab UI release、布局、入口、资料管理边界、移动端 App 下载指南和后续 UI 维护注意事项。

当用户询问Health Agent Lab产品 UI、页面入口、按钮位置、如何使用、如何删除/清空/退出/注销、健康档案、提醒、打卡、收藏、医生说、我的医生、阅读设置、账号设置，或询问 iOS/Android/鸿蒙 App 如何下载、安装、TestFlight、APK、鸿蒙内测入口时，必须先调用本工具，再基于工具结果回答。

本工具只说明产品界面和使用边界，不读取用户医疗资料，不执行页面操作，也不替代医学工具。`,
    parameters: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          enum: ['all', 'navigation', 'data_management', 'account_settings', 'app_download', 'feature_availability', 'future_notes'],
          description: '可选。需要阅读的产品说明主题；下载 App、安装包、TestFlight 或鸿蒙内测相关问题传 app_download；不确定时传 all。',
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  uiMeta: TOOL_UI_MANIFEST.read_product_guide,
  isReadOnly: true,
  maxResultSizeChars: 8_000,
}
