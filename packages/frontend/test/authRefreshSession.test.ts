import assert from 'node:assert/strict'

const storage = new Map<string, string>()
;(globalThis as typeof globalThis & { localStorage?: Storage }).localStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { storage.set(key, value) },
  removeItem: (key: string) => { storage.delete(key) },
  clear: () => { storage.clear() },
  key: (index: number) => Array.from(storage.keys())[index] ?? null,
  get length() { return storage.size },
} as Storage

const fetchUrls: string[] = []
;(globalThis as typeof globalThis & { fetch?: typeof fetch }).fetch = (async (input) => {
  fetchUrls.push(String(input))
  return {
  ok: true,
  status: 200,
  json: async () => ({
    success: true,
    data: {
      token: 'next-token',
      user: {
        id: 'user-1',
        phone: '13800000000',
        nickname: '橙子小柔',
        avatarUrl: null,
        birthday: null,
        gender: null,
        currentConcern: 'breast_nodule_followup',
      },
      needsProfile: false,
      requireCompleteProfile: false,
      consents: [],
    },
  }),
  }
}) as typeof fetch

const { useStore } = await import('../src/stores/index.js')
const { bootstrapRefreshSessionIfNeeded, refreshAccessToken } = await import('../src/services/api.js')

useStore.setState({
  token: 'old-token',
  user: null,
  needsProfile: true,
  requireCompleteProfile: true,
  consents: [],
})

const token = await refreshAccessToken()

assert.equal(token, 'next-token')
assert.equal(useStore.getState().token, 'next-token')
assert.equal(useStore.getState().user?.nickname, '橙子小柔')
assert.equal(useStore.getState().needsProfile, false)
assert.equal(useStore.getState().requireCompleteProfile, false)

useStore.getState().updateAuthUserProfile({
  nickname: '橙子小澄',
  birthday: '1990-01-02',
  gender: '女',
  currentConcern: 'breast_tumor_care',
})

assert.equal(useStore.getState().user?.nickname, '橙子小澄')
assert.equal(useStore.getState().user?.birthday, '1990-01-02')
assert.equal(useStore.getState().user?.gender, '女')
assert.equal(useStore.getState().user?.currentConcern, 'breast_tumor_care')

storage.set('cx-refresh-session', 'true')
useStore.setState({
  token: 'stored-token',
  user: null,
  needsProfile: true,
  requireCompleteProfile: true,
  consents: [],
})

await bootstrapRefreshSessionIfNeeded()

assert.match(fetchUrls.at(-1) ?? '', /\/api\/auth\/refresh$/)
assert.equal(useStore.getState().user?.nickname, '橙子小柔')

console.log('auth refresh session tests passed')
