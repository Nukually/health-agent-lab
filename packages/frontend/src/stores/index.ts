/**
 * Unified Zustand Store
 *
 * 参考 claude-code ch03: createStore 模式
 * - 单一 store，slices 划分领域
 * - updater function + Object.is 防冗余渲染
 * - onChange 集中式副作用（未来扩展）
 */

import { create } from 'zustand'
import { createAuthSlice, type AuthSlice } from './slices/auth.js'
import { createChatSlice, type ChatSlice } from './slices/chat.js'
import { createMedicalSlice, type MedicalSlice } from './slices/medical.js'
import { createSettingsSlice, type SettingsSlice } from './slices/settings.js'

export type AppState = AuthSlice & ChatSlice & MedicalSlice & SettingsSlice

export const useStore = create<AppState>()((...a) => ({
  ...createAuthSlice(...a),
  ...createChatSlice(...a),
  ...createMedicalSlice(...a),
  ...createSettingsSlice(...a),
}))
