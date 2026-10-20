import test from 'node:test'
import assert from 'node:assert/strict'
import { isSupportedLoginPhone, normalizeLoginPhoneInput } from '@health-agent/shared'
import {
  buildSmsLoginAllowlistCodeKey,
  getDynamicSmsLoginAllowlistCode,
  getSmsLoginAllowlistCode,
  parseSmsLoginCodeAllowlist,
} from './sms-login-allowlist.js'
import type { KVStore } from '../lib/redis.js'

function createMockKV(initial: Record<string, string> = {}): KVStore {
  const store = new Map(Object.entries(initial))
  return {
    async get(key) {
      return store.get(key) ?? null
    },
    async set(key, value) {
      store.set(key, value)
    },
    async setNX(key, value) {
      if (store.has(key)) return false
      store.set(key, value)
      return true
    },
    async del(key) {
      store.delete(key)
    },
    async delIfValue(key, value) {
      if (store.get(key) !== value) return false
      store.delete(key)
      return true
    },
    async incr() {
      return 1
    },
    async pexpire() {},
    async lpush() {
      return 0
    },
    async rpop() {
      return null
    },
    async llen() {
      return 0
    },
  }
}

test('supports mainland mobile numbers and E.164 international numbers for login', () => {
  assert.equal(isSupportedLoginPhone('13800138000'), true)
  assert.equal(isSupportedLoginPhone('+6581234567'), true)
  assert.equal(isSupportedLoginPhone('6581234567'), false)
  assert.equal(normalizeLoginPhoneInput(' +65 8123 4567 '), '+6581234567')
})

test('parses per-phone manual login verification codes', () => {
  const allowlist = parseSmsLoginCodeAllowlist('+6581234567=482913, 13800138000=739201')

  assert.equal(allowlist.get('+6581234567'), '482913')
  assert.equal(allowlist.get('13800138000'), '739201')
  assert.equal(getSmsLoginAllowlistCode('+6581234567=482913', '+65 8123 4567'), '482913')
})

test('reads dynamic manual login verification code from KV', async () => {
  const kv = createMockKV()

  await kv.set(buildSmsLoginAllowlistCodeKey('+6581234567'), '482913')

  assert.equal(await getDynamicSmsLoginAllowlistCode(kv, '+65 8123 4567'), '482913')
})

test('rejects malformed manual login verification code allowlist entries', () => {
  assert.throws(() => parseSmsLoginCodeAllowlist('+6581234567=123'), /expected 6 digits/)
  assert.throws(() => parseSmsLoginCodeAllowlist('6581234567=482913'), /invalid phone/)
  assert.throws(() => parseSmsLoginCodeAllowlist('+6581234567=482913,+6581234567=739201'), /duplicate phone/)
  assert.throws(() => parseSmsLoginCodeAllowlist('+6581234567=482913,13800138000=482913'), /duplicate manual login code/)
})

test('rejects invalid dynamic manual login verification codes', async () => {
  const kv = createMockKV({
    [buildSmsLoginAllowlistCodeKey('+6581234567')]: '123',
  })

  await assert.rejects(() => getDynamicSmsLoginAllowlistCode(kv, '+6581234567'), /expected 6 digits/)
})
