import type { StateCreator } from 'zustand'
import { applyStableChatFontSize } from '../../utils/fontEnvironment.js'

/**
 * 用户偏好设置，持久化到 localStorage（手动模式，与 auth slice 对齐）。
 */

const STORAGE_KEY = 'cx-settings'
const NATIVE_TTS_PREFERENCE_MIGRATION_VERSION = 1

export type ChatFontScale = 'small' | 'medium' | 'large'

export const CHAT_FONT_SIZE_PX: Record<ChatFontScale, number> = {
  small: 14,
  medium: 17,
  large: 20,
}

interface PersistedSettings {
  ttsEnabled?: boolean
  chatFontScale?: ChatFontScale
  nativeTtsPreferenceMigrationVersion?: number
}

function hasNativeBridge(): boolean {
  if (typeof window === 'undefined') return false
  return typeof window.CXNative?.invoke === 'function'
    || typeof window.CXNative?.call === 'function'
}

function loadPersisted(): PersistedSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    return JSON.parse(raw) as PersistedSettings
  } catch {
    return {}
  }
}

function savePersisted(state: PersistedSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // quota 或隐私模式下可能抛错，忽略
  }
}

function applyChatFontScale(scale: ChatFontScale): void {
  applyStableChatFontSize(CHAT_FONT_SIZE_PX[scale])
}

export interface SettingsSlice {
  ttsEnabled: boolean
  setTtsEnabled: (v: boolean) => void
  chatFontScale: ChatFontScale
  setChatFontScale: (v: ChatFontScale) => void
}

export const createSettingsSlice: StateCreator<SettingsSlice, [], [], SettingsSlice> = (set) => {
  const initial = loadPersisted()
  const initialScale: ChatFontScale = initial.chatFontScale ?? 'medium'
  const shouldRepairNativeTtsPreference =
    hasNativeBridge() &&
    initial.nativeTtsPreferenceMigrationVersion !== NATIVE_TTS_PREFERENCE_MIGRATION_VERSION
  const initialTtsEnabled = initial.ttsEnabled ?? false

  if (shouldRepairNativeTtsPreference) {
    savePersisted({
      ...initial,
      ttsEnabled: initialTtsEnabled,
      nativeTtsPreferenceMigrationVersion: NATIVE_TTS_PREFERENCE_MIGRATION_VERSION,
    })
  }

  applyChatFontScale(initialScale)
  return {
    ttsEnabled: initialTtsEnabled,
    setTtsEnabled: (v) => {
      savePersisted({
        ...loadPersisted(),
        ttsEnabled: v,
        nativeTtsPreferenceMigrationVersion: NATIVE_TTS_PREFERENCE_MIGRATION_VERSION,
      })
      set({ ttsEnabled: v })
    },
    chatFontScale: initialScale,
    setChatFontScale: (v) => {
      savePersisted({ ...loadPersisted(), chatFontScale: v })
      applyChatFontScale(v)
      set({ chatFontScale: v })
    },
  }
}
