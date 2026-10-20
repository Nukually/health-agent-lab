import assert from 'node:assert/strict'

const storage = new Map<string, string>([
  ['cx-token', 'stored-token'],
  ['cx-auth-user', JSON.stringify({
    id: 'user-1',
    phone: '',
    nickname: '退出前昵称',
    avatarUrl: null,
    birthday: null,
    gender: null,
    currentConcern: 'breast_nodule_followup',
  })],
])

;(globalThis as typeof globalThis & { localStorage?: Storage }).localStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { storage.set(key, value) },
  removeItem: (key: string) => { storage.delete(key) },
  clear: () => { storage.clear() },
  key: (index: number) => Array.from(storage.keys())[index] ?? null,
  get length() { return storage.size },
} as Storage

const { useStore } = await import('../src/stores/index.js')

assert.equal(useStore.getState().user?.nickname, '退出前昵称')

useStore.getState().updateAuthUserProfile({ nickname: '退出后保留的新昵称' })

assert.equal(JSON.parse(storage.get('cx-auth-user') ?? '{}').nickname, '退出后保留的新昵称')

console.log('auth persisted user tests passed')
