import { getNativeReadyInfo, hasNativeBridge, nativeCall } from './nativeBridge.js'

export function canOpenNativeDebug(): boolean {
  if (!hasNativeBridge()) return false
  const modules = getNativeReadyInfo()?.modules
  return Array.isArray(modules?.debug) && modules.debug.includes('openNativeDebug')
}

export async function openNativeDebug(options?: { timeoutMs?: number }): Promise<boolean> {
  if (!canOpenNativeDebug()) return false
  try {
    await nativeCall('debug', 'openNativeDebug', {}, {
      timeoutMs: options?.timeoutMs ?? 3000,
    })
    return true
  } catch (err) {
    console.warn('[native-debug] openNativeDebug failed', err)
    return false
  }
}
