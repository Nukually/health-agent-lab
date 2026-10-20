import type { TrackingEventPlatform, TrackingEventV2, TrackingEventsRequestV2 } from '@health-agent/shared'
import { useStore } from '../stores/index.js'
import { getTrackingCommonContext, getTrackingContextHeaders, normalizeTrackingTraceId } from './trackingContext.js'
import { createClientId } from '../utils/id.js'

const TRACKING_PLATFORMS = new Set(['h5', 'ios', 'android', 'harmony', 'server'])
const TRACKING_RETRY_DELAY_MS = 1_500
const TRACKING_QUEUE_KEY = 'cx-tracking-v2-pending-events'
const TRACKING_QUEUE_MAX_EVENTS = 100
const TRACKING_QUEUE_BATCH_SIZE = 20

export interface TrackEventOptions {
  eventVersion?: string
  eventTime?: string
  traceId?: string | null
  chatSessionId?: string | null
  entityType?: string | null
  entityId?: string | null
  properties?: Record<string, unknown> | null
}

function normalizePlatform(value: string | null | undefined): TrackingEventPlatform {
  return TRACKING_PLATFORMS.has(value ?? '') ? value as TrackingEventPlatform : 'h5'
}

function shouldRetryTrackingStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500
}

function canUseBrowserStorage(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined'
}

function readTrackingQueue(): TrackingEventV2[] {
  if (!canUseBrowserStorage()) return []
  try {
    const raw = window.localStorage.getItem(TRACKING_QUEUE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((event): event is TrackingEventV2 =>
      event != null &&
      typeof event === 'object' &&
      typeof (event as TrackingEventV2).eventId === 'string' &&
      typeof (event as TrackingEventV2).eventName === 'string',
    )
  } catch {
    return []
  }
}

function writeTrackingQueue(events: TrackingEventV2[]): boolean {
  if (!canUseBrowserStorage()) return false
  try {
    window.localStorage.setItem(TRACKING_QUEUE_KEY, JSON.stringify(events.slice(-TRACKING_QUEUE_MAX_EVENTS)))
    return true
  } catch {
    return false
  }
}

function enqueueTrackingEvent(event: TrackingEventV2): boolean {
  const pending = readTrackingQueue()
  pending.push(event)
  return writeTrackingQueue(pending)
}

function removeTrackingEvents(eventIds: Set<string>): void {
  const pending = readTrackingQueue()
  if (pending.length === 0) return
  writeTrackingQueue(pending.filter((event) => !eventIds.has(event.eventId)))
}

function sendTrackingBatch(body: TrackingEventsRequestV2, headers: Record<string, string>, retry = true): void {
  void fetch('/api/tracking/events', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    keepalive: true,
    credentials: 'same-origin',
  }).then((response) => {
    if (retry && shouldRetryTrackingStatus(response.status)) {
      window.setTimeout(() => sendTrackingBatch(body, headers, false), TRACKING_RETRY_DELAY_MS)
    }
  }).catch(() => {
    if (retry) {
      window.setTimeout(() => sendTrackingBatch(body, headers, false), TRACKING_RETRY_DELAY_MS)
    }
  })
}

let flushTimer: number | null = null
let flushInFlight = false
let flushHooksInstalled = false

function scheduleTrackingFlush(delayMs = 0): void {
  if (typeof window === 'undefined') return
  if (flushTimer != null) window.clearTimeout(flushTimer)
  flushTimer = window.setTimeout(() => {
    flushTimer = null
    flushTrackingQueue()
  }, delayMs)
}

function flushTrackingQueue(retry = true): void {
  if (flushInFlight) return
  const batch = readTrackingQueue().slice(0, TRACKING_QUEUE_BATCH_SIZE)
  if (batch.length === 0) return

  const token = useStore.getState().token
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...getTrackingContextHeaders(batch[0]?.traceId ?? undefined),
  }
  if (token) headers.Authorization = `Bearer ${token}`

  flushInFlight = true
  void fetch('/api/tracking/events', {
    method: 'POST',
    headers,
    body: JSON.stringify({ events: batch } satisfies TrackingEventsRequestV2),
    keepalive: true,
    credentials: 'same-origin',
  }).then((response) => {
    if (response.ok || !shouldRetryTrackingStatus(response.status)) {
      removeTrackingEvents(new Set(batch.map((event) => event.eventId)))
    } else if (retry) {
      scheduleTrackingFlush(TRACKING_RETRY_DELAY_MS)
    }
  }).catch(() => {
    if (retry) scheduleTrackingFlush(TRACKING_RETRY_DELAY_MS)
  }).finally(() => {
    flushInFlight = false
    if (readTrackingQueue().length > 0) scheduleTrackingFlush(TRACKING_RETRY_DELAY_MS)
  })
}

function ensureTrackingFlushHooks(): void {
  if (flushHooksInstalled || typeof window === 'undefined') return
  flushHooksInstalled = true
  window.addEventListener('online', () => scheduleTrackingFlush())
  window.addEventListener('pagehide', () => flushTrackingQueue(false))
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      flushTrackingQueue(false)
    } else {
      scheduleTrackingFlush()
    }
  })
}

export function trackEvent(eventName: string, options: TrackEventOptions = {}): void {
  ensureTrackingFlushHooks()
  const common = getTrackingCommonContext()
  const traceId = normalizeTrackingTraceId(options.traceId)
  const event: TrackingEventV2 = {
    eventId: `evt_${createClientId('tracking-event')}`,
    eventName,
    eventVersion: options.eventVersion ?? '1.0',
    eventTime: options.eventTime ?? new Date().toISOString(),
    source: 'h5',
    platform: normalizePlatform(common.platform),
    installId: common.installId,
    appSessionId: common.appSessionId,
    webSessionId: common.webSessionId,
    traceId,
    chatSessionId: options.chatSessionId ?? null,
    entityType: options.entityType ?? null,
    entityId: options.entityId ?? null,
    route: common.route,
    appVersion: common.appVersion,
    buildNumber: common.buildNumber,
    channel: common.channel,
    properties: options.properties ?? null,
  }

  const body: TrackingEventsRequestV2 = { events: [event] }
  const token = useStore.getState().token
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...getTrackingContextHeaders(traceId),
  }
  if (token) headers.Authorization = `Bearer ${token}`

  if (!enqueueTrackingEvent(event)) {
    sendTrackingBatch(body, headers)
    return
  }
  scheduleTrackingFlush()
}
