import type {
  TrackingEventV2,
  TrackingEventRawRecord,
  TrackingEventsRequestV2,
} from '@health-agent/shared'
import { validateTrackingEventContract } from '@health-agent/shared'
import { randomUUID } from 'node:crypto'
import { getTrackingDb } from '../db/tracking-client.js'
import { trackingEventsRaw } from '../db/schema/index.js'
import { getEnv } from '../env.js'
import type { Logger } from '../lib/logger.js'
import type { RecordAnalyticsEventInput } from './analytics.js'
import { sanitizeTrackingObject } from './tracking-sanitizer.js'

export interface RecordTrackingEventsInput extends TrackingEventsRequestV2 {
  userId?: string | null
}

export interface TrackingRequestContext {
  installId?: string | null
  appSessionId?: string | null
  webSessionId?: string | null
  traceId?: string | null
  requestId?: string | null
}

function normalizeText(value: unknown, max: number): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const trimmed = String(value).trim()
  if (!trimmed) return null
  return trimmed.slice(0, max)
}

function parseEventTime(value: string): Date | null {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function safeEventIdPart(value: unknown, max: number): string {
  const normalized = normalizeText(value, max) ?? 'unknown'
  return normalized.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, max) || 'unknown'
}

function chooseEventTime(...dates: Array<Date | null | undefined>): string {
  for (const date of dates) {
    if (date instanceof Date && !Number.isNaN(date.getTime())) return date.toISOString()
  }
  return new Date().toISOString()
}

const W3C_TRACEPARENT_PATTERN = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/
const W3C_TRACE_ID_PATTERN = /^[0-9a-f]{32}$/

function isAllZeroHex(value: string): boolean {
  return /^0+$/.test(value)
}

function traceIdFromTraceparent(value: unknown): string | null {
  const normalized = normalizeText(value, 160)?.toLowerCase()
  if (!normalized) return null
  const match = normalized.match(W3C_TRACEPARENT_PATTERN)
  if (!match) return null
  const [, version, traceId, spanId] = match
  if (version === 'ff' || isAllZeroHex(traceId) || isAllZeroHex(spanId)) return null
  return traceId
}

function normalizeTraceId(value: unknown): string | null {
  const normalized = normalizeText(value, 120)
  if (!normalized) return null
  const lower = normalized.toLowerCase()
  if (W3C_TRACE_ID_PATTERN.test(lower) && !isAllZeroHex(lower)) return lower
  // Backward compatibility for older clients that used non-W3C trace ids.
  return normalized
}

export function trackingRequestContextFromHeaders(
  headers: (name: string) => string | undefined,
  requestId?: string | null,
): TrackingRequestContext {
  const traceparentTraceId = traceIdFromTraceparent(headers('traceparent'))
  return {
    installId: normalizeText(headers('x-install-id'), 120),
    appSessionId: normalizeText(headers('x-app-session-id'), 120),
    webSessionId: normalizeText(headers('x-web-session-id'), 120),
    traceId: traceparentTraceId ?? normalizeTraceId(headers('x-tracking-trace-id')),
    requestId: normalizeText(requestId, 120),
  }
}

export function backendTrackingEventFromAnalyticsInput(
  input: RecordAnalyticsEventInput,
  context: TrackingRequestContext = {},
): TrackingEventV2 {
  const dedupeKey = input.dedupeKey ?? context.requestId ?? randomUUID()
  const properties = sanitizeTrackingObject({
    ...(input.properties ?? {}),
    ...(input.durationMs == null ? {} : { durationMs: input.durationMs }),
    backendDedupeKey: input.dedupeKey ?? null,
  })
  return {
    eventId: [
      'bt',
      safeEventIdPart(input.userId, 36),
      safeEventIdPart(input.eventName, 48),
      safeEventIdPart(dedupeKey, 32),
    ].join('_').slice(0, 120),
    eventName: input.eventName,
    eventVersion: '1.0',
    eventTime: chooseEventTime(input.endedAt, input.startedAt),
    source: 'backend',
    platform: 'server',
    installId: context.installId ?? null,
    userId: input.userId,
    appSessionId: context.appSessionId ?? null,
    webSessionId: context.webSessionId ?? null,
    traceId: context.traceId ?? null,
    requestId: context.requestId ?? null,
    chatSessionId: input.sessionId ?? null,
    entityType: input.entityType ?? null,
    entityId: input.entityId ?? null,
    route: normalizeText(input.properties?.route, 240),
    properties,
  }
}

export function safeTrackBackendEvent(
  input: RecordAnalyticsEventInput,
  logger: Logger,
  context: TrackingRequestContext = {},
): void {
  const env = getEnv()
  if (!env.TRACKING_V2_ENABLED) return
  if (env.TRACKING_V2_SAMPLE_RATE <= 0) return
  if (env.TRACKING_V2_SAMPLE_RATE < 1 && Math.random() > env.TRACKING_V2_SAMPLE_RATE) return
  void recordTrackingEvents({
    events: [backendTrackingEventFromAnalyticsInput(input, context)],
    userId: input.userId,
  }, logger).catch((err) => {
    logger.warn(
      { module: 'tracking', eventName: input.eventName, err: err instanceof Error ? err.message : String(err) },
      'backend tracking event record failed',
    )
  })
}

function serialize(row: typeof trackingEventsRaw.$inferSelect): TrackingEventRawRecord {
  return {
    id: row.id,
    eventId: row.eventId,
    eventName: row.eventName,
    eventVersion: row.eventVersion,
    source: row.source,
    platform: row.platform ?? null,
    installId: row.installId ?? null,
    userId: row.userId ?? null,
    appSessionId: row.appSessionId ?? null,
    webSessionId: row.webSessionId ?? null,
    traceId: row.traceId ?? null,
    requestId: row.requestId ?? null,
    chatSessionId: row.chatSessionId ?? null,
    entityType: row.entityType ?? null,
    entityId: row.entityId ?? null,
    route: row.route ?? null,
    appVersion: row.appVersion ?? null,
    buildNumber: row.buildNumber ?? null,
    channel: row.channel ?? null,
    eventTime: row.eventTime.toISOString(),
    receiveTime: row.receiveTime.toISOString(),
    properties: row.properties ?? null,
    rawPayload: row.rawPayload ?? null,
    createdAt: row.createdAt.toISOString(),
  }
}

export async function recordTrackingEvents(
  input: RecordTrackingEventsInput,
  logger: Logger,
): Promise<TrackingEventRawRecord[]> {
  const env = getEnv()
  if (!env.TRACKING_V2_ENABLED) return []
  const db = getTrackingDb()
  const userId = input.userId ?? null
  for (const event of input.events) {
    const contractWarnings = validateTrackingEventContract({
      ...event,
      userId: userId ?? event.userId ?? null,
    })
    if (contractWarnings.length > 0) {
      logger.warn(
        { module: 'tracking', eventName: event.eventName, contractWarnings },
        'tracking event contract warning',
      )
    }
  }
  const values = input.events.slice(0, 20).flatMap((event) => {
    const eventTime = parseEventTime(event.eventTime)
    if (!eventTime) return []
    const eventId = normalizeText(event.eventId, 120)
    const eventName = normalizeText(event.eventName, 120)
    const eventVersion = normalizeText(event.eventVersion, 40)
    if (!eventId || !eventName || !eventVersion) return []
    const rawPayload = sanitizeTrackingObject(event as unknown as Record<string, unknown>)
    return [{
      eventId,
      eventName,
      eventVersion,
      source: event.source,
      platform: event.platform ?? null,
      installId: normalizeText(event.installId, 120),
      userId,
      appSessionId: normalizeText(event.appSessionId, 120),
      webSessionId: normalizeText(event.webSessionId, 120),
      traceId: normalizeText(event.traceId, 120),
      requestId: normalizeText(event.requestId, 120),
      chatSessionId: normalizeText(event.chatSessionId, 120),
      entityType: normalizeText(event.entityType, 80),
      entityId: normalizeText(event.entityId, 160),
      route: normalizeText(event.route, 240),
      appVersion: normalizeText(event.appVersion, 80),
      buildNumber: normalizeText(event.buildNumber, 80),
      channel: normalizeText(event.channel, 80),
      eventTime,
      properties: sanitizeTrackingObject(event.properties),
      rawPayload,
    }]
  })

  if (values.length === 0) return []

  const rows = await db.insert(trackingEventsRaw).values(values).onConflictDoNothing({
    target: trackingEventsRaw.eventId,
  }).returning()

  logger.info(
    { module: 'tracking', received: input.events.length, recorded: rows.length },
    'tracking events recorded',
  )
  return rows.map(serialize)
}
