import { ensureNativeBridgeBootstrap, getNativeReadyInfo, hasNativeBridge, nativeCall } from './nativeBridge.js'

type NativeAuthStatus = {
  authenticated?: boolean
  tokenLength?: number
}

function debugNativeAuth(message: string, data?: Record<string, unknown>): void {
  if (typeof window === 'undefined' || window.localStorage.getItem('cx.debug.nativePush') !== '1') return
  console.info('[native-auth]', message, JSON.stringify(data ?? {}))
}

export function hasNativeAuthBridge(): boolean {
  if (!hasNativeBridge()) return false
  const modules = getNativeReadyInfo()?.modules
  return Array.isArray(modules?.auth) && modules.auth.includes('setToken')
}

export async function setNativeAuthToken(token: string): Promise<boolean> {
  ensureNativeBridgeBootstrap()
  if (!hasNativeBridge()) {
    debugNativeAuth('setToken skipped: bridge unavailable')
    return false
  }

  try {
    await nativeCall<NativeAuthStatus>('auth', 'setToken', { token })
    debugNativeAuth('setToken ok', { tokenLen: token.length })
    return true
  } catch (err) {
    const error = err as { code?: string; message?: string }
    debugNativeAuth('setToken failed', { code: error.code, message: error.message })
    return false
  }
}

export async function clearNativeAuthToken(): Promise<boolean> {
  ensureNativeBridgeBootstrap()
  if (!hasNativeBridge()) return false

  try {
    await nativeCall<NativeAuthStatus>('auth', 'clearToken', undefined, { timeoutMs: 1000 })
    debugNativeAuth('clearToken ok')
    return true
  } catch (err) {
    const error = err as { code?: string; message?: string }
    debugNativeAuth('clearToken failed', { code: error.code, message: error.message })
    return false
  }
}
