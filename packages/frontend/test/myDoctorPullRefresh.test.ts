import assert from 'node:assert/strict'
import test from 'node:test'

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
  MY_DOCTOR_PULL_REFRESH_THRESHOLD_PX,
  MY_DOCTOR_REFRESH_COLLAPSE_TRANSITION_MS,
  MY_DOCTOR_REFRESH_ERROR_VISIBLE_MS,
  MY_DOCTOR_REFRESH_MIN_VISIBLE_MS,
  MY_DOCTOR_REFRESH_SUCCESS_VISIBLE_MS,
  getMyDoctorRefreshMinimumWaitMs,
  getMyDoctorPullRefreshState,
  markMyDoctorMounted,
} = await import('../src/pages/MyDoctor.js')

test('my doctor pull refresh becomes ready only when pulling down from top past threshold', () => {
  const state = getMyDoctorPullRefreshState({
    startY: 100,
    currentY: 260,
    scrollTop: 0,
    refreshing: false,
  })

  assert.equal(MY_DOCTOR_PULL_REFRESH_THRESHOLD_PX, 64)
  assert.equal(state.ready, true)
  assert.equal(state.distance, 72)
})

test('my doctor pull refresh ignores pulls when content is already scrolled', () => {
  assert.deepEqual(getMyDoctorPullRefreshState({
    startY: 100,
    currentY: 260,
    scrollTop: 12,
    refreshing: false,
  }), {
    distance: 0,
    ready: false,
  })
})

test('my doctor pull refresh ignores upward gestures and active refreshes', () => {
  assert.deepEqual(getMyDoctorPullRefreshState({
    startY: 200,
    currentY: 120,
    scrollTop: 0,
    refreshing: false,
  }), {
    distance: 0,
    ready: false,
  })

  assert.deepEqual(getMyDoctorPullRefreshState({
    startY: 100,
    currentY: 260,
    scrollTop: 0,
    refreshing: true,
  }), {
    distance: 0,
    ready: false,
  })
})

test('my doctor refresh keeps feedback visible long enough to read', () => {
  assert.equal(MY_DOCTOR_REFRESH_MIN_VISIBLE_MS, 600)
  assert.equal(MY_DOCTOR_REFRESH_SUCCESS_VISIBLE_MS, 500)
  assert.equal(MY_DOCTOR_REFRESH_ERROR_VISIBLE_MS, 800)
  assert.equal(MY_DOCTOR_REFRESH_COLLAPSE_TRANSITION_MS, 260)
  assert.equal(getMyDoctorRefreshMinimumWaitMs(1000, 1120), 480)
  assert.equal(getMyDoctorRefreshMinimumWaitMs(1000, 1800), 0)
})

test('my doctor mounted flag is restored when StrictMode re-runs effects', () => {
  const mountedRef = { current: false }

  const cleanup = markMyDoctorMounted(mountedRef)
  assert.equal(mountedRef.current, true)

  cleanup()
  assert.equal(mountedRef.current, false)

  const secondCleanup = markMyDoctorMounted(mountedRef)
  assert.equal(mountedRef.current, true)

  secondCleanup()
  assert.equal(mountedRef.current, false)
})
