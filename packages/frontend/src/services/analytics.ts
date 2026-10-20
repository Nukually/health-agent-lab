import type { AnalyticsEventName, AnalyticsEventRequest } from '@health-agent/shared'
import { api } from './api.js'
import { trackEvent } from './tracking.js'

export interface ReportAnalyticsOptions {
  sessionId?: string | null
  entityType?: string | null
  entityId?: string | null
  properties?: Record<string, unknown> | null
  dedupeKey?: string | null
  startedAt?: string | null
  endedAt?: string | null
  durationMs?: number | null
  endpointPath?: string
}

export function reportAnalyticsEvent(
  eventName: AnalyticsEventName,
  options: ReportAnalyticsOptions = {},
): void {
  try {
    trackEvent(eventName, {
      eventVersion: '1.0',
      eventTime: options.endedAt ?? options.startedAt ?? undefined,
      chatSessionId: options.sessionId ?? null,
      entityType: options.entityType ?? null,
      entityId: options.entityId ?? null,
      properties: {
        ...(options.properties ?? {}),
        ...(options.dedupeKey ? { legacyDedupeKey: options.dedupeKey } : {}),
        ...(options.durationMs == null ? {} : { durationMs: options.durationMs }),
        legacyEndpointPath: options.endpointPath ?? '/analytics/events',
      },
    })
  } catch {
    // Tracking v2 is best-effort and must never block legacy analytics.
  }
  const payload: AnalyticsEventRequest = {
    eventName,
    sessionId: options.sessionId ?? null,
    entityType: options.entityType ?? null,
    entityId: options.entityId ?? null,
    properties: options.properties ?? null,
    dedupeKey: options.dedupeKey ?? null,
    startedAt: options.startedAt ?? null,
    endedAt: options.endedAt ?? null,
    durationMs: options.durationMs ?? null,
  }
  void api.postKeepalive(options.endpointPath ?? '/analytics/events', payload)
}
