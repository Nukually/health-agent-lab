import { and, eq } from 'drizzle-orm'
import type {
  InternalVideoEngagementRecord,
  InternalVideoInteractionRequest,
} from '@health-agent/shared'
import { getDb } from '../db/client.js'
import { internalVideoEngagements } from '../db/schema/index.js'
import type { Logger } from '../lib/logger.js'

type EngagementRow = typeof internalVideoEngagements.$inferSelect

const STOP_EVENTS = new Set(['pause', 'ended'])

function toRecord(row: EngagementRow): InternalVideoEngagementRecord {
  return {
    id: row.id,
    userId: row.userId,
    sessionId: row.sessionId,
    toolCallId: row.toolCallId,
    videoId: row.videoId,
    videoVersion: row.videoVersion,
    durationSec: row.durationSec,
    totalWatchedSec: row.totalWatchedSec,
    lastPositionSec: row.lastPositionSec,
    playStartedAt: row.playStartedAt?.toISOString() ?? null,
    lastStoppedAt: row.lastStoppedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    stopCount: row.stopCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

/**
 * 记录内部视频播放打点：只关心"播放多久"（totalWatchedSec 取累计最大值）与
 * "什么时候停止"（pause/ended 写 lastStoppedAt 并自增 stopCount）。按
 * (session, toolCall, video) 维度 upsert，原生 <video> 精确驱动。
 */
export async function recordInternalVideoInteraction(
  userId: string,
  payload: InternalVideoInteractionRequest,
  _logger: Logger,
): Promise<InternalVideoEngagementRecord> {
  const db = getDb()
  const now = new Date()
  const positionSec = Math.max(0, Math.floor(payload.positionSec))
  const watchedSec = Math.max(0, Math.floor(payload.watchedSec))
  const durationSec = Math.max(0, Math.floor(payload.durationSec))
  const isStop = STOP_EVENTS.has(payload.event)
  const isCompleted = payload.event === 'ended'

  const existing = await db
    .select()
    .from(internalVideoEngagements)
    .where(and(
      eq(internalVideoEngagements.sessionId, payload.sessionId),
      eq(internalVideoEngagements.toolCallId, payload.toolCallId),
      eq(internalVideoEngagements.videoId, payload.videoId),
    ))
    .limit(1)

  const current = existing[0]
  if (!current) {
    const inserted = await db
      .insert(internalVideoEngagements)
      .values({
        userId,
        sessionId: payload.sessionId,
        toolCallId: payload.toolCallId,
        videoId: payload.videoId,
        videoVersion: payload.videoVersion,
        durationSec,
        totalWatchedSec: watchedSec,
        lastPositionSec: positionSec,
        playStartedAt: payload.event === 'play_start' ? now : null,
        lastStoppedAt: isStop ? now : null,
        completedAt: isCompleted ? now : null,
        stopCount: isStop ? 1 : 0,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
    return toRecord(inserted[0])
  }

  const updated = await db
    .update(internalVideoEngagements)
    .set({
      videoVersion: payload.videoVersion,
      durationSec: durationSec || current.durationSec,
      totalWatchedSec: Math.max(current.totalWatchedSec, watchedSec),
      lastPositionSec: positionSec,
      playStartedAt: current.playStartedAt ?? (payload.event === 'play_start' ? now : null),
      lastStoppedAt: isStop ? now : current.lastStoppedAt,
      completedAt: isCompleted ? (current.completedAt ?? now) : current.completedAt,
      stopCount: isStop ? current.stopCount + 1 : current.stopCount,
      updatedAt: now,
    })
    .where(eq(internalVideoEngagements.id, current.id))
    .returning()

  return toRecord(updated[0])
}
