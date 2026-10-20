import {
  isFeatureEnabled,
  resolveFeatureProfile,
  resolveFeatureSnapshot,
  type FeatureKey,
  type FeatureProfile,
  type FeatureSnapshot,
} from '@health-agent/shared'
import { getNativeReadyInfo, hasNativeBridge } from './lib/nativeBridge.js'

export interface FrontendFeatureRuntime {
  userAgent?: string | null
  platform?: string | null
  maxTouchPoints?: number | null
  hasNativeBridge?: boolean
  nativeModules?: Record<string, string[]> | null
}

export interface ChatEntrypointFeatures {
  showTtsControl: boolean
  showNativeDebugEntry: boolean
}

function configuredFeatureProfile(): string | undefined {
  return (import.meta as unknown as { env?: { VITE_HEALTH_AGENT_FEATURE_PROFILE?: string } })
    .env?.VITE_HEALTH_AGENT_FEATURE_PROFILE
}

export function inferFeatureProfileFromHostname(_hostname: string): FeatureProfile {
  // A standalone deployment selects its profile explicitly, not by a vendor domain.
  return 'dev'
}

export function createFrontendFeatureSnapshot(params: {
  configuredProfile?: string | null
  hostname?: string | null
} = {}): FeatureSnapshot {
  const hostname = params.hostname ?? (
    typeof window !== 'undefined' ? window.location.hostname : ''
  )
  const fallback = inferFeatureProfileFromHostname(hostname ?? '')
  return resolveFeatureSnapshot({
    profile: resolveFeatureProfile(params.configuredProfile, fallback),
  })
}

export const frontendFeatureSnapshot = createFrontendFeatureSnapshot({
  configuredProfile: configuredFeatureProfile(),
})

export function isCxFeatureEnabled(key: FeatureKey): boolean {
  return isFeatureEnabled(frontendFeatureSnapshot, key)
}

function currentRuntime(): FrontendFeatureRuntime {
  const configuredSurface = (import.meta as unknown as { env?: { VITE_HEALTH_AGENT_CLIENT_SURFACE?: string } })
    .env?.VITE_HEALTH_AGENT_CLIENT_SURFACE
  return {
    userAgent: configuredSurface ?? (typeof navigator !== 'undefined' ? navigator.userAgent : null),
    platform: configuredSurface ?? (typeof navigator !== 'undefined' ? navigator.platform : null),
    maxTouchPoints: typeof navigator !== 'undefined' ? navigator.maxTouchPoints : null,
    hasNativeBridge: hasNativeBridge(),
    nativeModules: getNativeReadyInfo()?.modules ?? null,
  }
}

function isMobileRuntime(runtime: FrontendFeatureRuntime): boolean {
  const userAgent = runtime.userAgent ?? ''
  const platform = runtime.platform ?? ''
  const maxTouchPoints = runtime.maxTouchPoints ?? 0
  return /Mobi|Android|iPhone|iPad|iPod|HarmonyOS|OpenHarmony/i.test(userAgent) ||
    (platform === 'MacIntel' && maxTouchPoints > 1)
}

function hasNativeDebugCapability(runtime: FrontendFeatureRuntime): boolean {
  if (!runtime.hasNativeBridge) return false
  const modules = runtime.nativeModules
  return Array.isArray(modules?.debug) && modules.debug.includes('openNativeDebug')
}

export function resolveChatEntrypointFeatures(
  snapshot: FeatureSnapshot,
  runtime: FrontendFeatureRuntime = currentRuntime(),
): ChatEntrypointFeatures {
  const nativeBridgeAvailable = runtime.hasNativeBridge === true
  return {
    showTtsControl: isFeatureEnabled(snapshot, 'chatTtsControl') &&
      (nativeBridgeAvailable || !isMobileRuntime(runtime)),
    showNativeDebugEntry: isFeatureEnabled(snapshot, 'nativeDebugEntry') &&
      hasNativeDebugCapability(runtime),
  }
}
