import type { AnalyticsEventName, AnalyticsEventRecord } from '@health-agent/shared'
import { getDb } from '../db/client.js'
import { analyticsEvents } from '../db/schema/index.js'
import type { Logger } from '../lib/logger.js'

export interface RecordAnalyticsEventInput {
  userId: string
  eventName: AnalyticsEventName
  dedupeKey?: string | null
  sessionId?: string | null
  entityType?: string | null
  entityId?: string | null
  startedAt?: Date | null
  endedAt?: Date | null
  durationMs?: number | null
  properties?: Record<string, unknown> | null
}

function serialize(row: typeof analyticsEvents.$inferSelect): AnalyticsEventRecord {
  return {
    id: row.id,
    userId: row.userId,
    eventName: row.eventName,
    dedupeKey: row.dedupeKey ?? null,
    sessionId: row.sessionId ?? null,
    entityType: row.entityType ?? null,
    entityId: row.entityId ?? null,
    startedAt: row.startedAt?.toISOString() ?? null,
    endedAt: row.endedAt?.toISOString() ?? null,
    durationMs: row.durationMs ?? null,
    properties: row.properties ?? null,
    createdAt: row.createdAt.toISOString(),
  }
}

function normalizeText(value: string | null | undefined, max: number): string | null {
  const trimmed = value?.trim()
  if (!trimmed) return null
  return trimmed.slice(0, max)
}

export async function recordAnalyticsEvent(
  input: RecordAnalyticsEventInput,
  logger: Logger,
): Promise<AnalyticsEventRecord | null> {
  const db = getDb()
  const durationMs = input.durationMs == null
    ? null
    : Math.max(0, Math.floor(input.durationMs))

  const [row] = await db.insert(analyticsEvents).values({
    userId: input.userId,
    eventName: input.eventName,
    dedupeKey: normalizeText(input.dedupeKey, 160),
    sessionId: input.sessionId ?? null,
    entityType: normalizeText(input.entityType, 80),
    entityId: normalizeText(input.entityId, 160),
    startedAt: input.startedAt ?? null,
    endedAt: input.endedAt ?? null,
    durationMs,
    properties: input.properties ?? null,
  }).onConflictDoNothing({
    target: [analyticsEvents.userId, analyticsEvents.eventName, analyticsEvents.dedupeKey],
  }).returning()

  if (!row) {
    logger.debug({ eventName: input.eventName, dedupeKey: input.dedupeKey }, 'analytics event skipped by dedupe')
    return null
  }

  const logLevel = row.eventName === 'chat_request_completed' ? 'debug' : 'info'
  logger[logLevel]({ eventName: row.eventName, eventId: row.id }, 'analytics event recorded')
  return serialize(row)
}

export async function safeRecordAnalyticsEvent(
  input: RecordAnalyticsEventInput,
  logger: Logger,
): Promise<void> {
  try {
    await recordAnalyticsEvent(input, logger)
  } catch (err: any) {
    logger.warn(
      { eventName: input.eventName, err: err?.message },
      'analytics event record failed',
    )
  }
}
