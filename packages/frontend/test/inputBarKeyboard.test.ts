import assert from 'node:assert/strict'
import test from 'node:test'

;(globalThis as typeof globalThis & { localStorage?: Storage }).localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
  clear: () => {},
  key: () => null,
  length: 0,
}

const { shouldRefocusAfterSend } = await import('../src/components/chat/InputBar.js')

function setBrowserEnvironment(input: {
  nativePlatform?: string
  userAgent?: string
  platform?: string
  maxTouchPoints?: number
}) {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: input.nativePlatform
      ? { __CXNativeBridge__: { info: { platform: input.nativePlatform } } }
      : {},
  })
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      userAgent: input.userAgent ?? '',
      platform: input.platform ?? '',
      maxTouchPoints: input.maxTouchPoints ?? 0,
    },
  })
}

test('does not refocus after sending on iOS native shell', () => {
  setBrowserEnvironment({ nativePlatform: 'ios' })

  assert.equal(shouldRefocusAfterSend(), false)
})

test('does not refocus after sending on iOS Safari-style browser', () => {
  setBrowserEnvironment({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', platform: 'iPhone' })

  assert.equal(shouldRefocusAfterSend(), false)
})

test('keeps desktop refocus behavior after sending', () => {
  setBrowserEnvironment({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)', platform: 'MacIntel' })

  assert.equal(shouldRefocusAfterSend(), true)
})
