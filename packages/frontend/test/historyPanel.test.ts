import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

;(globalThis as typeof globalThis & { React?: typeof React }).React = React

const storage = new Map<string, string>()
;(globalThis as typeof globalThis & { localStorage?: Storage }).localStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { storage.set(key, value) },
  removeItem: (key: string) => { storage.delete(key) },
  clear: () => { storage.clear() },
  key: (index: number) => Array.from(storage.keys())[index] ?? null,
  get length() { return storage.size },
} as Storage

const {
  default: HistoryPanel,
  getSidebarDefaultAvatarIconName,
  formatSidebarSessionTimestamp,
  getSidebarDisplayUser,
  getSidebarUserDisplayName,
} = await import('../src/components/chat/HistoryPanel.js')
const { useStore } = await import('../src/stores/index.js')

const now = new Date(2026, 4, 22, 22, 30, 0)
const source = readFileSync(
  fileURLToPath(new URL('../src/components/chat/HistoryPanel.tsx', import.meta.url)),
  'utf8',
)

assert.equal(formatSidebarSessionTimestamp('2026-05-22T21:36:00', now), '21:36')
assert.equal(formatSidebarSessionTimestamp('2026-05-21T09:15:00', now), '昨天')
assert.equal(formatSidebarSessionTimestamp('2026-05-12T09:15:00', now), '05/12')

assert.equal(getSidebarUserDisplayName({ nickname: '示例用户' }), '示例用户')
assert.equal(getSidebarUserDisplayName({ nickname: '  ' }), 'Health Agent Lab用户')
assert.equal(getSidebarUserDisplayName(null), 'Health Agent Lab用户')
assert.equal(getSidebarDisplayUser(
  { nickname: '旧昵称' },
  { nickname: '新昵称' },
).nickname, '新昵称')
assert.equal(getSidebarDisplayUser(
  { nickname: '旧昵称' },
  { nickname: '  ' },
).nickname, '旧昵称')
assert.equal(getSidebarDisplayUser(
  { nickname: '旧昵称', gender: '男' },
  { gender: '女' },
).gender, '女')
assert.equal(getSidebarDefaultAvatarIconName('男'), 'default-avatar-male')
assert.equal(getSidebarDefaultAvatarIconName('女'), 'default-avatar-female')
assert.equal(getSidebarDefaultAvatarIconName(null), 'default-avatar-female')
assert.match(source, /SESSION_LIST_REVALIDATE_MS = 15_000/)
assert.match(source, /window\.setInterval\(refreshSessions, SESSION_LIST_REVALIDATE_MS\)/)
assert.match(source, /document\.addEventListener\('visibilitychange', handleVisibilityChange\)/)
assert.match(source, /window\.addEventListener\('focus', handleFocus\)/)
assert.match(source, /window\.clearInterval\(interval\)/)

useStore.setState({
  user: {
    id: 'user-1',
    phone: '',
    nickname: '旧昵称',
    avatarUrl: null,
    birthday: null,
    gender: '男',
    currentConcern: null,
  },
  sessions: [],
  sessionsLoaded: true,
  loadingSessions: false,
  loadingMoreSessions: false,
  sessionsHasMore: false,
})

const html = renderToStaticMarkup(React.createElement(HistoryPanel, {
  currentSessionId: null,
  onSelectSession: () => undefined,
  onLogout: () => undefined,
  onDeleteAccount: () => undefined,
  onViewMedicalRecord: () => undefined,
  onViewReadingSettings: () => undefined,
  onViewMedicalDocuments: () => undefined,
  onViewMaterials: () => undefined,
  onViewCheckIns: () => undefined,
  onViewScheduledTasks: () => undefined,
  onViewDoctor: () => undefined,
  onClose: () => undefined,
  onDeleteSession: () => undefined,
}))

assert.match(html, /default-avatar\.svg/)
assert.doesNotMatch(html, /常用功能/)
assert.match(html, /最近对话/)
assert.match(html, /min-height:46px/)
assert.match(html, /padding-top:12px">最近对话/)
assert.match(html, /健康档案[\s\S]*打卡记录[\s\S]*我的医生[\s\S]*收藏/)

console.log('history panel helper tests passed')
