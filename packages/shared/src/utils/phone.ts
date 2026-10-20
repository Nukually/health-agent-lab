const MAINLAND_MOBILE_RE = /^1[3-9]\d{9}$/
const E164_PHONE_RE = /^\+[1-9]\d{6,14}$/

export const LOGIN_PHONE_ERROR_MESSAGE = '请输入正确的手机号'
export const LOGIN_PHONE_MAX_LENGTH = 16

export function normalizeLoginPhoneInput(input: string): string {
  return input.trim().replace(/[\s()-]/g, '')
}

export function normalizeLoginPhoneTyping(input: string): string {
  const compact = input.replace(/[^\d+]/g, '')
  const hasLeadingPlus = compact.startsWith('+')
  const digits = compact.replace(/\+/g, '')
  const maxDigits = hasLeadingPlus ? LOGIN_PHONE_MAX_LENGTH - 1 : LOGIN_PHONE_MAX_LENGTH
  return hasLeadingPlus ? `+${digits.slice(0, maxDigits)}` : digits.slice(0, maxDigits)
}

export function isSupportedLoginPhone(phone: string): boolean {
  const normalized = normalizeLoginPhoneInput(phone)
  return MAINLAND_MOBILE_RE.test(normalized) || E164_PHONE_RE.test(normalized)
}
