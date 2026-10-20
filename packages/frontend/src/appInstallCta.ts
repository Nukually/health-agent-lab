import {
  resolveChannelSourceTypeFromPartnerName,
  type ChannelSourceType,
} from '@health-agent/shared'
import { hasNativeBridge } from './lib/nativeBridge.js'

export const APP_INSTALL_CTA_DISMISSED_KEY = 'cx-app-install-cta-dismissed'
export const DEFAULT_ANDROID_APK_URL = ''
export const DEFAULT_TESTFLIGHT_URL = ''
export const DEFAULT_HARMONY_BETA_URL = ''

let appInstallCtaDismissedInCurrentPage = false

export type MarketingBannerKind = 'app_install' | 'private_wechat'
export type AppInstallGuideTarget = 'android_apk' | 'harmony_beta'

export type AppInstallAction =
  | { type: 'download_apk'; url: string }
  | { type: 'show_embedded_browser_guide'; target: AppInstallGuideTarget; url: string }
  | { type: 'open_harmony_beta'; url: string }
  | { type: 'open_testflight'; url: string }
  | { type: 'show_platform_options' }

export interface AppInstallRuntime {
  userAgent?: string | null
  hasNativeBridge?: boolean
  dismissed?: boolean
  androidApkUrl?: string | null
  testFlightUrl?: string | null
  harmonyBetaUrl?: string | null
  featureEnabled?: boolean
}

export interface MarketingBannerRuntime {
  surface?: 'h5' | 'ios' | 'android' | 'harmony' | string | null
  channelSourceType?: ChannelSourceType
  dismissed?: boolean
  featureEnabled?: boolean
}

export function resolveUserChannelSourceType(partnerName: string | null | undefined): ChannelSourceType {
  return resolveChannelSourceTypeFromPartnerName(partnerName)
}

export function shouldShowMarketingBannerIndicators(sequence: MarketingBannerKind[]): boolean {
  return sequence.length > 1
}

export function resolveMarketingBannerSequence(runtime: MarketingBannerRuntime = {}): MarketingBannerKind[] {
  if (runtime.featureEnabled === false) return []
  if (runtime.dismissed === true) return []

  const surface = runtime.surface === 'ios' || runtime.surface === 'android' || runtime.surface === 'harmony'
    ? runtime.surface
    : 'h5'
  const isOnline = runtime.channelSourceType === 'online'
  if (surface === 'h5') {
    return isOnline ? ['app_install', 'private_wechat'] : ['app_install']
  }
  return isOnline ? ['private_wechat'] : []
}

function normalizeUserAgent(userAgent: string | null | undefined): string {
  return userAgent ?? ''
}

export function isAndroidUserAgent(userAgent: string | null | undefined): boolean {
  return /Android/i.test(normalizeUserAgent(userAgent))
}

export function isIosUserAgent(userAgent: string | null | undefined): boolean {
  const ua = normalizeUserAgent(userAgent)
  return /iPhone|iPad|iPod/i.test(ua)
}

export function parseHarmonyOsMajorVersion(userAgent: string | null | undefined): number | null {
  const ua = normalizeUserAgent(userAgent)
  const match = ua.match(/(?:HarmonyOS|OpenHarmony)[/\s]+(\d+)(?:\.\d+)?/i)
  if (!match) return null
  const major = Number.parseInt(match[1], 10)
  return Number.isFinite(major) ? major : null
}

export function isHarmonyUserAgent(userAgent: string | null | undefined): boolean {
  return /HarmonyOS|OpenHarmony/i.test(normalizeUserAgent(userAgent))
}

export function isWechatUserAgent(userAgent: string | null | undefined): boolean {
  return /MicroMessenger/i.test(normalizeUserAgent(userAgent))
}

export function isFeishuUserAgent(userAgent: string | null | undefined): boolean {
  return /Feishu|Lark/i.test(normalizeUserAgent(userAgent))
}

export function isEmbeddedBrowserUserAgent(userAgent: string | null | undefined): boolean {
  return isWechatUserAgent(userAgent) || isFeishuUserAgent(userAgent)
}

export function shouldShowAppInstallCta(runtime: AppInstallRuntime = {}): boolean {
  if (runtime.featureEnabled === false) return false
  const nativeBridgeAvailable = runtime.hasNativeBridge ?? hasNativeBridge()
  if (nativeBridgeAvailable) return false
  if (runtime.dismissed === true) return false
  return true
}

export function readAppInstallCtaDismissed(): boolean {
  return appInstallCtaDismissedInCurrentPage
}

export function writeAppInstallCtaDismissed(): void {
  appInstallCtaDismissedInCurrentPage = true
}

export function getAndroidApkUrl(override?: string | null): string {
  return override || DEFAULT_ANDROID_APK_URL
}

export function getTestFlightUrl(override?: string | null): string | null {
  return override || DEFAULT_TESTFLIGHT_URL
}

export function getHarmonyBetaUrl(override?: string | null): string {
  return override || DEFAULT_HARMONY_BETA_URL
}

export function resolveAppInstallAction(runtime: AppInstallRuntime = {}): AppInstallAction {
  const userAgent = runtime.userAgent ?? (typeof navigator !== 'undefined' ? navigator.userAgent : '')
  const embeddedBrowser = isEmbeddedBrowserUserAgent(userAgent)
  if (isHarmonyUserAgent(userAgent)) {
    const harmonyMajorVersion = parseHarmonyOsMajorVersion(userAgent)
    if (harmonyMajorVersion !== null && harmonyMajorVersion >= 5) {
      const url = getHarmonyBetaUrl(runtime.harmonyBetaUrl)
      if (embeddedBrowser) return { type: 'show_embedded_browser_guide', target: 'harmony_beta', url }
      return { type: 'open_harmony_beta', url }
    }
    if (harmonyMajorVersion !== null && harmonyMajorVersion < 5) {
      const url = getAndroidApkUrl(runtime.androidApkUrl)
      if (embeddedBrowser) return { type: 'show_embedded_browser_guide', target: 'android_apk', url }
      return { type: 'download_apk', url }
    }
  }
  if (isAndroidUserAgent(userAgent)) {
    const url = getAndroidApkUrl(runtime.androidApkUrl)
    if (embeddedBrowser) return { type: 'show_embedded_browser_guide', target: 'android_apk', url }
    return { type: 'download_apk', url }
  }
  if (isIosUserAgent(userAgent)) {
    const url = getTestFlightUrl(runtime.testFlightUrl)
    if (url) return { type: 'open_testflight', url }
  }
  return { type: 'show_platform_options' }
}
