import type {
  NativeAnalyticsEventItem,
  NativeAnalyticsEventsRequest,
  NativeAnalyticsEventRecord,
} from '@health-agent/shared'
import { getDb } from '../db/client.js'
import { nativeAnalyticsEvents } from '../db/schema/index.js'
import type { Logger } from '../lib/logger.js'

export interface RecordNativeAnalyticsEventsInput extends NativeAnalyticsEventsRequest {
  userId?: string | null
}

const FORBIDDEN_PROPERTY_KEYS = new Set([
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
  'registrationid',
  'registration_id',
  'pushregistrationid',
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
])

function normalizeText(value: unknown, max: number): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const trimmed = String(value).trim()
  if (!trimmed) return null
  return trimmed.slice(0, max)
}

function parseOptionalDate(value: string | null | undefined): Date | null {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function sanitizeValue(value: unknown, depth = 0): unknown {
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
      const normalizedKey = key.replace(/[^a-zA-Z0-9_]/g, '').toLowerCase()
      if (!normalizedKey || FORBIDDEN_PROPERTY_KEYS.has(normalizedKey)) continue
      out[key.slice(0, 80)] = sanitizeValue(child, depth + 1)
    }
    return out
  }
  return null
}

function sanitizeProperties(value: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!value) return null
  const sanitized = sanitizeValue(value)
  if (!sanitized || typeof sanitized !== 'object' || Array.isArray(sanitized)) return null
  return sanitized as Record<string, unknown>
}

function sanitizeBridgeModules(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  const modules = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim().slice(0, 40))
    .filter(Boolean)
    .slice(0, 30)
  return modules.length ? Array.from(new Set(modules)) : null
}

function chooseGeo(eventGeo: NativeAnalyticsEventItem['geo']) {
  const geo = eventGeo ?? null
  return {
    source: normalizeText(geo?.source, 40),
    country: normalizeText(geo?.country, 80),
    province: normalizeText(geo?.province, 120),
    city: normalizeText(geo?.city, 120),
    precision: normalizeText(geo?.precision, 40),
  }
}

function serialize(row: typeof nativeAnalyticsEvents.$inferSelect): NativeAnalyticsEventRecord {
  return {
    id: row.id,
    installId: row.installId,
    userId: row.userId ?? null,
    eventName: row.eventName,
    dedupeKey: row.dedupeKey ?? null,
    entityType: row.entityType ?? null,
    entityId: row.entityId ?? null,
    platform: row.platform,
    appVersion: row.appVersion ?? null,
    versionCode: row.versionCode ?? null,
    buildNumber: row.buildNumber ?? null,
    channel: row.channel ?? null,
    osVersion: row.osVersion ?? null,
    sdkInt: row.sdkInt ?? null,
    manufacturer: row.manufacturer ?? null,
    model: row.model ?? null,
    webViewVersion: row.webViewVersion ?? null,
    bridgeVersion: row.bridgeVersion ?? null,
    bridgeModules: row.bridgeModules ?? null,
    geoSource: row.geoSource ?? null,
    geoCountry: row.geoCountry ?? null,
    geoProvince: row.geoProvince ?? null,
    geoCity: row.geoCity ?? null,
    geoPrecision: row.geoPrecision ?? null,
    startedAt: row.startedAt?.toISOString() ?? null,
    endedAt: row.endedAt?.toISOString() ?? null,
    durationMs: row.durationMs ?? null,
    properties: row.properties ?? null,
    createdAt: row.createdAt.toISOString(),
  }
}

export async function recordNativeAnalyticsEvents(
  input: RecordNativeAnalyticsEventsInput,
  logger: Logger,
): Promise<NativeAnalyticsEventRecord[]> {
  const db = getDb()
  const installId = normalizeText(input.installId, 120)
  if (!installId) return []

  const bridgeModules = sanitizeBridgeModules(input.device?.bridgeModules)
  const values = input.events.slice(0, 20).map((event) => {
    const geo = chooseGeo(event.geo)
    const durationMs = event.durationMs == null
      ? null
      : Math.max(0, Math.min(24 * 60 * 60 * 1000, Math.floor(event.durationMs)))
    return {
      installId,
      userId: input.userId ?? null,
      eventName: event.eventName,
      dedupeKey: normalizeText(event.dedupeKey, 180),
      entityType: normalizeText(event.entityType, 80),
      entityId: normalizeText(event.entityId, 160),
      platform: input.app.platform,
      appVersion: normalizeText(input.app.appVersion, 80),
      versionCode: normalizeText(input.app.versionCode, 80),
      buildNumber: normalizeText(input.app.buildNumber, 80),
      channel: normalizeText(input.app.channel, 80),
      osVersion: normalizeText(input.device?.osVersion, 80),
      sdkInt: typeof input.device?.sdkInt === 'number' ? input.device.sdkInt : null,
      manufacturer: normalizeText(input.device?.manufacturer, 120),
      model: normalizeText(input.device?.model, 120),
      webViewVersion: normalizeText(input.device?.webViewVersion, 160),
      bridgeVersion: normalizeText(input.device?.bridgeVersion, 40),
      bridgeModules,
      geoSource: geo.source,
      geoCountry: geo.country,
      geoProvince: geo.province,
      geoCity: geo.city,
      geoPrecision: geo.precision,
      startedAt: parseOptionalDate(event.startedAt),
      endedAt: parseOptionalDate(event.endedAt),
      durationMs,
      properties: sanitizeProperties(event.properties),
    }
  })

  if (values.length === 0) return []

  const rows = await db.insert(nativeAnalyticsEvents).values(values).onConflictDoNothing({
    target: [nativeAnalyticsEvents.installId, nativeAnalyticsEvents.eventName, nativeAnalyticsEvents.dedupeKey],
  }).returning()

  logger.info(
    { module: 'native-analytics', installIdPrefix: installId.slice(0, 8), received: values.length, recorded: rows.length },
    'native analytics events recorded',
  )
  return rows.map(serialize)
}
