import { isSupportedLoginPhone, normalizeLoginPhoneInput } from '@health-agent/shared'
import type { KVStore } from '../lib/redis.js'

const MANUAL_CODE_RE = /^\d{6}$/
const DYNAMIC_ALLOWLIST_KEY_PREFIX = 'sms:login:manual-code:'
const DYNAMIC_ALLOWLIST_CODE_OWNER_KEY_PREFIX = 'sms:login:manual-code-owner:'

export function buildSmsLoginAllowlistCodeKey(phone: string): string {
  return `${DYNAMIC_ALLOWLIST_KEY_PREFIX}${normalizeLoginPhoneInput(phone)}`
}

export function buildSmsLoginAllowlistCodeOwnerKey(code: string): string {
  return `${DYNAMIC_ALLOWLIST_CODE_OWNER_KEY_PREFIX}${code}`
}

export function isSmsLoginManualCode(code: string): boolean {
  return MANUAL_CODE_RE.test(code)
}

function assertManualCode(code: string, phone: string): void {
  if (!isSmsLoginManualCode(code)) {
    throw new Error(`invalid code for phone "${phone}", expected 6 digits`)
  }
}

export function parseSmsLoginCodeAllowlist(raw: string | undefined): Map<string, string> {
  const allowlist = new Map<string, string>()
  const usedCodes = new Set<string>()
  if (!raw?.trim()) return allowlist

  for (const item of raw.split(/[,;\n]+/)) {
    const entry = item.trim()
    if (!entry) continue

    const sepIndex = entry.indexOf('=')
    if (sepIndex <= 0 || sepIndex === entry.length - 1) {
      throw new Error('invalid entry, expected phone=6_digit_code')
    }

    const phone = normalizeLoginPhoneInput(entry.slice(0, sepIndex))
    const code = entry.slice(sepIndex + 1).trim()

    if (!isSupportedLoginPhone(phone)) {
      throw new Error(`invalid phone "${phone}"`)
    }

    assertManualCode(code, phone)

    if (allowlist.has(phone)) {
      throw new Error(`duplicate phone "${phone}"`)
    }

    if (usedCodes.has(code)) {
      throw new Error('duplicate manual login code')
    }

    allowlist.set(phone, code)
    usedCodes.add(code)
  }

  return allowlist
}

export function getSmsLoginAllowlistCode(raw: string | undefined, phone: string): string | null {
  const normalizedPhone = normalizeLoginPhoneInput(phone)
  return parseSmsLoginCodeAllowlist(raw).get(normalizedPhone) ?? null
}

export async function getDynamicSmsLoginAllowlistCode(kv: KVStore, phone: string): Promise<string | null> {
  const normalizedPhone = normalizeLoginPhoneInput(phone)
  const code = await kv.get(buildSmsLoginAllowlistCodeKey(normalizedPhone))
  if (!code) return null

  assertManualCode(code, normalizedPhone)
  return code
}
