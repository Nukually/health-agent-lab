import { ensureNativeBridgeBootstrap, getNativeReadyInfo, hasNativeBridge, nativeCall } from './nativeBridge.js'

type NativeRumInitStatus = {
  initialized?: boolean
}

type NativeRumFirstScreenStatus = {
  reported?: boolean
}

let firstScreenReported = false

function debugNativeRum(message: string, data?: Record<string, unknown>): void {
  if (typeof window === 'undefined' || window.localStorage.getItem('cx.debug.nativeRum') !== '1') return
  console.info('[native-rum]', message, JSON.stringify(data ?? {}))
}

export function hasNativeRumBridge(method = 'init'): boolean {
  if (!hasNativeBridge()) return false
  const modules = getNativeReadyInfo()?.modules
  return Array.isArray(modules?.rum) && modules.rum.includes(method)
}

export async function initNativeRum(userId?: string): Promise<boolean> {
  ensureNativeBridgeBootstrap()
  if (!hasNativeBridge() || !hasNativeRumBridge()) {
    debugNativeRum('init skipped: bridge unavailable')
    return false
  }

  try {
    const result = await nativeCall<NativeRumInitStatus>(
      'rum',
      'init',
      userId ? { userId } : undefined,
      { timeoutMs: 1000 },
    )
    debugNativeRum('init ok', { initialized: result.initialized === true })
    return result.initialized === true
  } catch (err) {
    const error = err as { code?: string; message?: string }
    debugNativeRum('init failed', { code: error.code, message: error.message })
    return false
  }
}

export async function reportNativeFirstScreen(route = window.location.pathname): Promise<boolean> {
  ensureNativeBridgeBootstrap()
  if (firstScreenReported || !hasNativeBridge() || !hasNativeRumBridge('firstScreen')) {
    debugNativeRum('first screen skipped', { firstScreenReported, route })
    return false
  }

  firstScreenReported = true
  try {
    const result = await nativeCall<NativeRumFirstScreenStatus>(
      'rum',
      'firstScreen',
      { route },
      { timeoutMs: 1000 },
    )
    debugNativeRum('first screen reported', { reported: result.reported === true, route })
    return result.reported === true
  } catch (err) {
    // 失败允许 native-ready 后重试一次，避免 WebView 刚完成加载时 bridge info 还没注入。
    firstScreenReported = false
    const error = err as { code?: string; message?: string }
    debugNativeRum('first screen failed', { code: error.code, message: error.message, route })
    return false
  }
}
