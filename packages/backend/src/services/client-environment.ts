import type {
  ClientEnvironmentHint,
  ClientSurface,
  UiReleaseId,
  UiVariantKey,
} from '@health-agent/shared'

export type ClientEnvironmentPlatform = 'ios' | 'android' | 'harmony' | 'chrome' | 'web' | 'unknown'

export interface ResolvedClientEnvironment {
  platform: ClientEnvironmentPlatform
  label: string
  surface?: ClientSurface | string | null
  source?: string | null
  isNativeApp?: boolean
  appVersion?: string | null
  versionCode?: string | number | null
  bridgeVersion?: string | null
  h5BuildVersion?: string | null
  uiReleaseId?: UiReleaseId | string | null
  uiVariant?: UiVariantKey | string | null
}

function normalizePlatform(value: unknown): ClientEnvironmentPlatform | null {
  if (typeof value !== 'string') return null
  const raw = value.trim().toLowerCase()
  if (!raw) return null
  if (raw === 'ios' || raw === 'iphone' || raw === 'ipad') return 'ios'
  if (raw === 'android') return 'android'
  if (raw === 'harmony' || raw === 'harmonyos' || raw === 'hmos' || raw === 'openharmony') return 'harmony'
  if (raw === 'chrome' || raw === 'chromium') return 'chrome'
  if (raw === 'h5') return 'web'
  if (raw === 'web' || raw === 'browser') return 'web'
  return null
}

function detectPlatformFromUserAgent(userAgent: string | null | undefined): ClientEnvironmentPlatform {
  const ua = userAgent ?? ''
  if (!ua) return 'unknown'
  if (/HarmonyOS|OpenHarmony|ArkWeb/i.test(ua)) return 'harmony'
  if (/Android/i.test(ua)) return 'android'
  if (/iPad|iPhone|iPod|iOS/i.test(ua)) return 'ios'
  if (/Chrome|Chromium|CriOS/i.test(ua)) return 'chrome'
  return 'web'
}

function platformLabel(platform: ClientEnvironmentPlatform, source: string | null | undefined): string {
  const native = source === 'native_bridge'
  if (platform === 'ios') return native ? 'iOS App' : 'iOS'
  if (platform === 'android') return native ? 'Android App' : 'Android'
  if (platform === 'harmony') return native ? '鸿蒙 App' : '鸿蒙'
  if (platform === 'chrome') return 'Chrome/网页'
  if (platform === 'web') return '网页'
  return '未知'
}

export function resolveClientEnvironment(input: {
  hint?: ClientEnvironmentHint | null
  userAgent?: string | null
}): ResolvedClientEnvironment {
  const source = input.hint?.source ?? null
  const platform = normalizePlatform(input.hint?.platform)
    ?? detectPlatformFromUserAgent(input.hint?.userAgent ?? input.userAgent)

  return {
    platform,
    label: platformLabel(platform, source),
    surface: input.hint?.surface ?? null,
    source,
    isNativeApp: source === 'native_bridge',
    appVersion: input.hint?.appVersion ?? null,
    versionCode: input.hint?.versionCode ?? null,
    bridgeVersion: input.hint?.bridgeVersion ?? null,
    h5BuildVersion: input.hint?.h5BuildVersion ?? null,
    uiReleaseId: input.hint?.uiReleaseId ?? null,
    uiVariant: input.hint?.uiVariant ?? null,
  }
}

export function buildClientEnvironmentReminder(env: ResolvedClientEnvironment): string {
  return `[client-environment]
${env.label}`
}
