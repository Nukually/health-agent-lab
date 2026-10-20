import type {
  ApnsEnvironment,
  ApiResponse,
  BindPushDeviceRequest,
  NotificationPermissionStatus,
  PushDeviceRecord,
  PushPlatform,
  PushProvider,
  UnbindPushDeviceRequest,
} from '@health-agent/shared'
import { api } from '../services/api.js'
import { useStore } from '../stores/index.js'
import { hasNativeBridge, nativeCall } from './nativeBridge.js'

export interface NativeDeviceInfo {
  platform?: string
  appVersion?: string
  versionCode?: number
  osVersion?: string
  sdkInt?: number
  manufacturer?: string
  model?: string
}

export interface NativePushInfo {
  platform: PushPlatform
  provider: PushProvider
  registrationId: string
  deviceId?: string | null
  appVersion?: string | null
  apnsEnvironment?: ApnsEnvironment | null
  apnsTokenRegistered?: boolean
  apnsTokenRegisteredAt?: string | null
  apnsRegistrationError?: string | null
  pushEnabled: boolean
  notificationPermission: NotificationPermissionStatus
  versionCode?: number
}

type RawNativePushInfo = {
  platform?: string
  provider?: string
  registrationId?: string
  deviceId?: string | null
  appVersion?: string | null
  apnsEnvironment?: string | null
  apnsTokenRegistered?: boolean
  apnsTokenRegisteredAt?: string | null
  apnsRegistrationError?: string | null
  pushEnabled?: boolean
  notificationPermission?: string
  versionCode?: number
}

let lastBindKey: string | null = null
let lastBindAt = 0
let inFlightBind: Promise<boolean> | null = null
let inFlightRequestsPermission = false
let notificationPermissionRequestedThisSession = false

function debugNativePush(message: string, data?: Record<string, unknown>): void {
  if (typeof window === 'undefined' || window.localStorage.getItem('cx.debug.nativePush') !== '1') return
  // 仅用于本地 WebView 联调；Android WebChromeClient 会把 console 输出转到 Logcat。
  // 不打印完整 registrationId，避免误泄漏。
  console.info('[native-push]', message, JSON.stringify(data ?? {}))
}

export async function getNativeDeviceInfo(options?: { timeoutMs?: number }): Promise<NativeDeviceInfo | null> {
  if (!hasNativeBridge()) {
    debugNativePush('device.getInfo skipped: bridge unavailable')
    return null
  }
  debugNativePush('device.getInfo calling')
  return nativeCall<NativeDeviceInfo>('device', 'getInfo', undefined, { timeoutMs: options?.timeoutMs })
    .then((info) => {
      debugNativePush('device.getInfo ok', { platform: info?.platform, appVersion: info?.appVersion })
      return info
    })
    .catch((err) => {
      debugNativePush('device.getInfo failed', { message: err?.message, code: err?.code })
      return null
    })
}

export async function getNativePushInfo(options?: {
  requestPermissionIfNeeded?: boolean
  timeoutMs?: number
}): Promise<NativePushInfo | null> {
  if (!hasNativeBridge()) {
    debugNativePush('push.getInfo skipped: bridge unavailable')
    return null
  }

  const device = await getNativeDeviceInfo({ timeoutMs: options?.timeoutMs })
  const platform = normalizePlatform(device?.platform)
  if (!platform) {
    debugNativePush('push.getInfo skipped: unsupported platform', { platform: device?.platform })
    return null
  }

  debugNativePush('push.getInfo calling')
  let raw = await nativeCall<RawNativePushInfo>('push', 'getInfo', undefined, {
    timeoutMs: options?.timeoutMs,
  }).catch((err) => {
    debugNativePush('push.getInfo failed', { message: err?.message, code: err?.code })
    return null
  })
  if (!raw) return null

  let info = normalizePushInfo(raw, platform, device)
  if (!info) {
    debugNativePush('push.getInfo normalize failed')
    return null
  }
  debugNativePush('push.getInfo ok', {
    platform: info.platform,
    provider: info.provider,
    registrationIdLen: info.registrationId.length,
    notificationPermission: info.notificationPermission,
    pushEnabled: info.pushEnabled,
    apnsEnvironment: info.apnsEnvironment,
    apnsTokenRegistered: info.apnsTokenRegistered,
  })

  if (options?.requestPermissionIfNeeded && info.notificationPermission !== 'granted') {
    if (notificationPermissionRequestedThisSession) {
      debugNativePush('push.requestPermission skipped: already requested this session', {
        current: info.notificationPermission,
      })
      return info
    }

    // Android 用户拒绝通知权限后，Native 会派发 permissionChanged。
    // App 收到事件会再次同步 push 状态；如果这里继续自动 requestPermission，
    // 会形成 permissionChanged -> requestPermission -> denied -> permissionChanged 的循环，
    // 部分 MIUI/HyperOS WebView 上会表现为点击卡顿甚至 renderer 退出。
    notificationPermissionRequestedThisSession = true
    debugNativePush('push.requestPermission calling', { current: info.notificationPermission })
    const requested = await nativeCall<RawNativePushInfo>('push', 'requestPermission', undefined, {
      timeoutMs: options?.timeoutMs,
    }).catch((err) => {
      debugNativePush('push.requestPermission failed', { message: err?.message, code: err?.code })
      return null
    })
    info = normalizePushInfo(requested ?? raw, platform, device) ?? info
    debugNativePush('push.requestPermission result', {
      registrationIdLen: info.registrationId.length,
      notificationPermission: info.notificationPermission,
      pushEnabled: info.pushEnabled,
      apnsEnvironment: info.apnsEnvironment,
      apnsTokenRegistered: info.apnsTokenRegistered,
    })
  }

  return info
}

export async function bindNativePushDevice(options?: {
  requestPermissionIfNeeded?: boolean
}): Promise<boolean> {
  const requestPermissionIfNeeded = !!options?.requestPermissionIfNeeded

  // Native 可能连续派发 ready / registrationChanged / permissionChanged，且 React 严格模式
  // 在开发环境会重复执行 effect。这里合并并发绑定，避免同一启动阶段打出多次 bind 请求。
  if (inFlightBind) {
    if (!requestPermissionIfNeeded || inFlightRequestsPermission) return inFlightBind
    await inFlightBind.catch(() => false)
  }

  inFlightRequestsPermission = requestPermissionIfNeeded
  inFlightBind = bindNativePushDeviceOnce({ requestPermissionIfNeeded })
    .finally(() => {
      inFlightBind = null
      inFlightRequestsPermission = false
    })

  return inFlightBind
}

async function bindNativePushDeviceOnce(options: {
  requestPermissionIfNeeded: boolean
}): Promise<boolean> {
  const token = useStore.getState().token
  if (!token) {
    debugNativePush('bind skipped: no token')
    return false
  }
  debugNativePush('bind start', { requestPermissionIfNeeded: options.requestPermissionIfNeeded })

  const info = await getNativePushInfo({
    requestPermissionIfNeeded: options.requestPermissionIfNeeded,
  })
  if (!info?.registrationId) {
    debugNativePush('bind skipped: no registrationId')
    return false
  }
  if (info.platform === 'ios' && info.apnsTokenRegistered !== true) {
    debugNativePush('bind skipped: iOS APNs token not registered', {
      apnsEnvironment: info.apnsEnvironment,
      apnsRegistrationError: info.apnsRegistrationError ?? '',
    })
    return false
  }

  const bindKey = [
    info.provider,
    info.platform,
    info.registrationId,
    info.pushEnabled,
    info.notificationPermission,
    info.apnsEnvironment ?? '',
    info.apnsTokenRegistered ? 'apns-ready' : 'apns-not-ready',
    info.apnsTokenRegisteredAt ?? '',
    info.appVersion ?? '',
  ].join('|')

  // 同一状态短时间内只绑定一次，避免无意义请求。
  if (bindKey === lastBindKey && Date.now() - lastBindAt < 30_000) {
    debugNativePush('bind skipped: duplicate state')
    return true
  }

  const body: BindPushDeviceRequest = {
    platform: info.platform,
    provider: info.provider,
    registrationId: info.registrationId,
    deviceId: info.deviceId ?? undefined,
    appVersion: info.appVersion ?? undefined,
    apnsEnvironment: info.apnsEnvironment ?? undefined,
    pushEnabled: info.pushEnabled,
    notificationPermission: info.notificationPermission,
  }

  await api.post<ApiResponse<PushDeviceRecord>>('/push/devices/bind', body)
  debugNativePush('bind ok', {
    platform: info.platform,
    provider: info.provider,
    registrationIdLen: info.registrationId.length,
    notificationPermission: info.notificationPermission,
    pushEnabled: info.pushEnabled,
    apnsEnvironment: info.apnsEnvironment,
    apnsTokenRegistered: info.apnsTokenRegistered,
  })
  lastBindKey = bindKey
  lastBindAt = Date.now()
  return true
}

export async function unbindNativePushDevice(options?: {
  keepalive?: boolean
  timeoutMs?: number
}): Promise<boolean> {
  const token = useStore.getState().token
  if (!token) return false

  const info = await getNativePushInfo({ timeoutMs: options?.timeoutMs ?? 1_000 })
  if (!info?.registrationId) return false

  const body: UnbindPushDeviceRequest = {
    platform: info.platform,
    provider: info.provider,
    registrationId: info.registrationId,
  }

  lastBindKey = null
  lastBindAt = 0

  if (options?.keepalive) {
    fetch('/api/push/devices/unbind', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      keepalive: true,
    }).catch(() => undefined)
    return true
  }

  await api.post<ApiResponse<{ unbound: boolean }>>('/push/devices/unbind', body)
  return true
}

export function normalizeNativeRoute(route: unknown): string | null {
  if (typeof route !== 'string') return null
  const trimmed = route.trim()
  if (!trimmed) return null
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://') || trimmed.startsWith('//')) {
    return null
  }
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`
}

function normalizePushInfo(
  raw: RawNativePushInfo,
  fallbackPlatform: PushPlatform,
  device: NativeDeviceInfo | null,
): NativePushInfo | null {
  const platform = normalizePlatform(raw.platform) ?? fallbackPlatform
  const provider = normalizeProvider(raw.provider) ?? 'jpush'
  const registrationId = raw.registrationId?.trim() ?? ''
  const notificationPermission = normalizePermission(raw.notificationPermission)
  const apnsEnvironment = platform === 'ios'
    ? normalizeApnsEnvironment(raw.apnsEnvironment)
    : null
  const pushEnabled = typeof raw.pushEnabled === 'boolean'
    ? raw.pushEnabled
    : notificationPermission === 'granted'
  const apnsTokenRegistered = platform === 'ios'
    ? raw.apnsTokenRegistered === true
    : undefined

  return {
    platform,
    provider,
    registrationId,
    deviceId: raw.deviceId ?? undefined,
    appVersion: raw.appVersion ?? device?.appVersion ?? undefined,
    apnsEnvironment,
    apnsTokenRegistered,
    apnsTokenRegisteredAt: platform === 'ios' ? raw.apnsTokenRegisteredAt ?? undefined : undefined,
    apnsRegistrationError: platform === 'ios' ? raw.apnsRegistrationError ?? undefined : undefined,
    pushEnabled,
    notificationPermission,
    versionCode: raw.versionCode ?? device?.versionCode,
  }
}

function normalizePlatform(platform: string | undefined): PushPlatform | null {
  if (platform === 'android' || platform === 'ios' || platform === 'harmony') return platform
  return null
}

function normalizeProvider(provider: string | undefined): PushProvider | null {
  if (provider === 'jpush' || provider === 'apns' || provider === 'fcm' || provider === 'hms') {
    return provider
  }
  return null
}

function normalizePermission(permission: string | undefined): NotificationPermissionStatus {
  if (permission === 'granted' || permission === 'denied' || permission === 'unknown') return permission
  return 'unknown'
}

function normalizeApnsEnvironment(value: string | null | undefined): ApnsEnvironment | null {
  if (value === 'development' || value === 'production') return value
  return null
}
