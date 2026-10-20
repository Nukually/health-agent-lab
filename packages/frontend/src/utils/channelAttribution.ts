const CHANNEL_CODE_KEY = 'cx-channel-code'
const CHANNEL_CODE_PATTERN = /^[A-Za-z0-9_-]{1,80}$/

export function normalizeChannelCode(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  if (!trimmed) return null
  return CHANNEL_CODE_PATTERN.test(trimmed) ? trimmed : null
}

export function captureChannelCodeFromCurrentUrl(): string | null {
  if (typeof window === 'undefined') return null
  const params = new URLSearchParams(window.location.search)
  const channelCode = normalizeChannelCode(params.get('channelCode'))
  if (!channelCode) return null

  sessionStorage.setItem(CHANNEL_CODE_KEY, channelCode)
  return channelCode
}

export function readStoredChannelCode(): string | null {
  if (typeof window === 'undefined') return null
  return normalizeChannelCode(sessionStorage.getItem(CHANNEL_CODE_KEY))
}

export function clearStoredChannelCode() {
  if (typeof window === 'undefined') return
  sessionStorage.removeItem(CHANNEL_CODE_KEY)
}
