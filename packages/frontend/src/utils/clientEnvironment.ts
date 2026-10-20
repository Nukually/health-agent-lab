import { CURRENT_UI_RELEASE_ID, type ClientEnvironmentHint } from '@health-agent/shared'
import { getNativeReadyInfo, hasNativeBridge } from '../lib/nativeBridge.js'

function normalizeNavigatorPlatform(): string {
  if (typeof navigator === 'undefined') return 'unknown'

  const ua = navigator.userAgent || ''
  const platform = navigator.platform || ''

  if (/HarmonyOS|OpenHarmony|ArkWeb/i.test(ua)) return 'harmony'
  if (/Android/i.test(ua)) return 'android'
  if (/iPad|iPhone|iPod/i.test(ua)) return 'ios'
  if (platform === 'MacIntel' && navigator.maxTouchPoints > 1) return 'ios'
  if (/Chrome|Chromium|CriOS/i.test(ua)) return 'chrome'
  return 'web'
}

export function buildClientEnvironmentHint(): ClientEnvironmentHint {
  const ready = getNativeReadyInfo()
  const nativePlatform = typeof ready?.platform === 'string' ? ready.platform : null
  const nativeBridgeAvailable = hasNativeBridge()
  const configuredSurface = (import.meta as unknown as { env?: { VITE_HEALTH_AGENT_CLIENT_SURFACE?: string } })
    .env?.VITE_HEALTH_AGENT_CLIENT_SURFACE ?? null

  return {
    platform: configuredSurface || nativePlatform || normalizeNavigatorPlatform(),
    source: configuredSurface ? 'start_sh' : nativePlatform || nativeBridgeAvailable ? 'native_bridge' : 'navigator',
    appVersion: ready?.appVersion ?? null,
    versionCode: ready?.versionCode ?? null,
    bridgeVersion: ready?.bridgeVersion ?? ready?.version ?? null,
    h5BuildVersion: (import.meta as unknown as { env?: { VITE_CX_BUILD_VERSION?: string } })
      .env?.VITE_CX_BUILD_VERSION ?? null,
    uiReleaseId: CURRENT_UI_RELEASE_ID,
    uiVariant: 'default',
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : null,
  }
}
