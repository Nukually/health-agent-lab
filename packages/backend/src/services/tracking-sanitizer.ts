const FORBIDDEN_PROPERTY_KEYS = new Set([
  'token',
  'jwt',
  'authorization',
  'cookie',
  'phone',
  'mobile',
  'smscode',
  'verificationcode',
  'registrationid',
  'registration_id',
  'pushregistrationid',
  'lat',
  'latitude',
  'lng',
  'lon',
  'longitude',
  'imei',
  'imsi',
  'mac',
  'androidid',
  'android_id',
  'idfa',
  'idfv',
  'oaid',
  'apps',
  'applist',
  'installedapps',
  'installed_applications',
  'clipboard',
  'ssid',
  'bssid',
  'url',
  'fullurl',
  'href',
  'prompt',
  'messages',
  'ocrtext',
  'reporttext',
  'llmresponse',
])

function normalizeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9_]/g, '').toLowerCase()
}

function isForbiddenPropertyKey(normalized: string): boolean {
  if (FORBIDDEN_PROPERTY_KEYS.has(normalized)) return true
  return [
    'token',
    'authorization',
    'password',
    'secret',
    'cookie',
    'phone',
    'mobile',
    'sms',
    'registrationid',
    'latitude',
    'longitude',
    'clipboard',
    'url',
    'href',
    'prompt',
    'message',
    'ocr',
    'reporttext',
    'llm',
  ].some((pattern) => normalized.includes(pattern))
}

export function sanitizeTrackingObject(value: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  const sanitized = sanitizeValue(value, 0)
  if (!sanitized || typeof sanitized !== 'object' || Array.isArray(sanitized)) return null
  return sanitized as Record<string, unknown>
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (value == null) return null
  if (typeof value === 'string') return value.slice(0, 512)
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'boolean') return value
  if (Array.isArray(value)) {
    if (depth >= 3) return null
    return value.slice(0, 30).map((item) => sanitizeValue(item, depth + 1))
  }
  if (typeof value === 'object') {
    if (depth >= 3) return null
    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value as Record<string, unknown>).slice(0, 80)) {
      const normalized = normalizeKey(key)
      if (!normalized || isForbiddenPropertyKey(normalized)) continue
      out[key.slice(0, 80)] = sanitizeValue(child, depth + 1)
    }
    return out
  }
  return null
}
