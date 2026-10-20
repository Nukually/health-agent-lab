import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
} from 'drizzle-orm'
import {
  parseMedicalRiskToolOutput,
  parseInterventionMaterialToolOutput,
} from '@health-agent/shared'
import type {
  InterventionMaterialEngagementRecord,
  InterventionMaterialInteractionEvent,
  InterventionMaterialInteractionSource,
  InterventionMaterialProgressSnapshot,
  SavedInterventionMaterialRecord,
  InterventionMaterialToolOutput,
  ToolCallRecord,
} from '@health-agent/shared'
import { getDb } from '../db/client.js'
import { interventionMaterialEngagements, messages } from '../db/schema/index.js'
import type { Logger } from '../lib/logger.js'
import { refreshInterventionToolOutput } from './intervention-material-runtime.js'

function serialize(
  row: typeof interventionMaterialEngagements.$inferSelect,
): InterventionMaterialEngagementRecord {
  return {
    id: row.id,
    userId: row.userId,
    sessionId: row.sessionId,
    toolCallId: row.toolCallId,
    materialId: row.materialId,
    materialVersion: row.materialVersion,
    materialCode: row.materialCode,
    materialDurationSec: row.materialDurationSec,
    savedAt: row.savedAt?.toISOString() ?? null,
    viewedAt: row.viewedAt?.toISOString() ?? null,
    followStartedAt: row.followStartedAt?.toISOString() ?? null,
    followCompletedAt: row.followCompletedAt?.toISOString() ?? null,
    totalFollowSec: row.totalFollowSec,
    completedStepCount: row.completedStepCount,
    totalStepCount: row.totalStepCount,
    lastStepIndex: row.lastStepIndex ?? null,
    reminderConsumedAt: row.reminderConsumedAt?.toISOString() ?? null,
    effectFollowupDueAt: row.effectFollowupDueAt?.toISOString() ?? null,
    effectFollowupStatus: row.effectFollowupStatus,
    effectFollowupSentAt: row.effectFollowupSentAt?.toISOString() ?? null,
    effectFollowupMessageId: row.effectFollowupMessageId ?? null,
    effectFollowupAttemptCount: row.effectFollowupAttemptCount,
    effectFollowupLastError: row.effectFollowupLastError ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

function toProgressSnapshot(
  row: typeof interventionMaterialEngagements.$inferSelect,
): InterventionMaterialProgressSnapshot {
  return {
    savedAt: row.savedAt?.toISOString() ?? null,
    viewedAt: row.viewedAt?.toISOString() ?? null,
    followStartedAt: row.followStartedAt?.toISOString() ?? null,
    followCompletedAt: row.followCompletedAt?.toISOString() ?? null,
    totalFollowSec: row.totalFollowSec,
    completedStepCount: row.completedStepCount,
    totalStepCount: row.totalStepCount,
    lastStepIndex: row.lastStepIndex ?? null,
  }
}

export async function findInterventionEngagementByToolCall(
  userId: string,
  sessionId: string,
  toolCallId: string,
): Promise<InterventionMaterialEngagementRecord | null> {
  const db = getDb()
  const row = await db.query.interventionMaterialEngagements.findFirst({
    where: and(
      eq(interventionMaterialEngagements.userId, userId),
      eq(interventionMaterialEngagements.sessionId, sessionId),
      eq(interventionMaterialEngagements.toolCallId, toolCallId),
    ),
  })

  return row ? serialize(row) : null
}

export async function findInterventionProgressByToolCall(
  sessionId: string,
  toolCallId: string,
): Promise<InterventionMaterialProgressSnapshot | null> {
  const db = getDb()
  const row = await db.query.interventionMaterialEngagements.findFirst({
    where: and(
      eq(interventionMaterialEngagements.sessionId, sessionId),
      eq(interventionMaterialEngagements.toolCallId, toolCallId),
    ),
  })

  return row ? toProgressSnapshot(row) : null
}

export async function findInterventionToolOutputInSession(
  sessionId: string,
  toolCallId: string,
  logger: Logger,
): Promise<InterventionMaterialToolOutput | null> {
  const resourceRef = parseResourceToolCallId(toolCallId)
  const db = getDb()
  const rows = await db.query.messages.findMany({
    where: and(eq(messages.sessionId, sessionId), eq(messages.role, 'assistant')),
    columns: { toolCalls: true },
    orderBy: asc(messages.createdAt),
  })

  for (const row of rows) {
    const toolCalls = (row.toolCalls as ToolCallRecord[] | null) ?? []
    for (const toolCall of toolCalls) {
      if (resourceRef) {
        if (toolCall.toolCallId !== resourceRef.parentToolCallId) continue
        const parsed = parseMedicalRiskToolOutput(toolCall.output)
        const resource = parsed?.resources.find((item) =>
          item.id === resourceRef.resourceId && item.kind === 'intervention_material')
        if (resource?.kind === 'intervention_material') return resource.material
        continue
      }

      if (toolCall.toolCallId === toolCallId) {
        const parsed = parseInterventionMaterialToolOutput(toolCall.output)
        if (parsed) return parsed
      }
    }
  }

  logger.warn({ sessionId, toolCallId }, 'intervention tool output not found in session')
  return null
}

/**
 * 在会话历史里反查某个 medical_risk 资源（按 resource.id）所属的工具调用，
 * 返回 `<parentToolCallId>:resource:<resourceId>` 形式的合成 toolCallId，
 * 供日历详情复用聊天内播放器（/detail 会用 parseResourceToolCallId 解析它）。
 * 找不到时返回 null（资源可能已被压缩/跨会话），调用方应降级为静态展示。
 */
export async function findResourceToolCallIdInSession(
  sessionId: string,
  resourceId: string,
): Promise<string | null> {
  const db = getDb()
  const rows = await db.query.messages.findMany({
    where: and(eq(messages.sessionId, sessionId), eq(messages.role, 'assistant')),
    columns: { toolCalls: true },
    orderBy: asc(messages.createdAt),
  })

  for (const row of rows) {
    const toolCalls = (row.toolCalls as ToolCallRecord[] | null) ?? []
    for (const toolCall of toolCalls) {
      const parsed = parseMedicalRiskToolOutput(toolCall.output)
      const resource = parsed?.resources.find((item) => item.id === resourceId)
      if (resource) return `${toolCall.toolCallId}:resource:${resourceId}`
    }
  }

  return null
}

function parseResourceToolCallId(
  toolCallId: string,
): { parentToolCallId: string; resourceId: string } | null {
  const marker = ':resource:'
  const index = toolCallId.lastIndexOf(marker)
  if (index <= 0) return null
  const parentToolCallId = toolCallId.slice(0, index)
  const resourceId = toolCallId.slice(index + marker.length)
  return parentToolCallId && resourceId ? { parentToolCallId, resourceId } : null
}

export interface InterventionEngagementReminderInput {
  materialCode: string
  savedAt?: Date | null
  followStartedAt: Date | null
  totalFollowSec: number
}

export interface SavedInterventionMaterialPromptSummaryItem {
  materialCode: string
  materialId: string
  materialVersion: string
  savedAt: string
  followStartedAt: string | null
  lastFollowedAt: string | null
  followCompletedAt: string | null
  totalFollowSec: number
  completedStepCount: number
  totalStepCount: number
}

export interface SavedInterventionMaterialPromptSummary {
  totalCount: number
  items: SavedInterventionMaterialPromptSummaryItem[]
}

type EngagementRow = typeof interventionMaterialEngagements.$inferSelect

function latestDate(a: Date | null, b: Date | null): Date | null {
  if (!a) return b
  if (!b) return a
  return a.getTime() >= b.getTime() ? a : b
}

function inferLastFollowedAt(row: EngagementRow): Date | null {
  if (!row.followStartedAt) return null
  return row.followCompletedAt ?? row.updatedAt ?? row.followStartedAt
}

export function buildInterventionEngagementReminderLine(
  row: InterventionEngagementReminderInput,
): string {
  const title = row.materialCode
  if (!row.followStartedAt) {
    if (row.savedAt) {
      return `- 干预方案 ${title}：用户已保存到我的跟练卡，但尚未开始跟练。`
    }
    return `- 干预方案 ${title}：用户未点击跟练卡片。`
  }

  const totalFollowSec = Math.max(0, Math.floor(row.totalFollowSec))
  return `- 干预方案 ${title}：用户点击了卡片跟练，并跟练了 ${totalFollowSec}s。`
}

export async function consumePendingInterventionEngagementReminders(
  userId: string,
  sessionId: string,
  logger: Logger,
): Promise<string[]> {
  const db = getDb()
  const rows = await db.query.interventionMaterialEngagements.findMany({
    where: and(
      eq(interventionMaterialEngagements.userId, userId),
      eq(interventionMaterialEngagements.sessionId, sessionId),
      isNull(interventionMaterialEngagements.reminderConsumedAt),
    ),
    orderBy: asc(interventionMaterialEngagements.updatedAt),
  })

  if (rows.length === 0) return []

  const now = new Date()
  await db.update(interventionMaterialEngagements)
    .set({ reminderConsumedAt: now, updatedAt: now })
    .where(inArray(interventionMaterialEngagements.id, rows.map((row) => row.id)))

  logger.info({ sessionId, count: rows.length }, 'intervention engagement reminders consumed')
  return [
    '本会话里的干预资料跟练情况：',
    ...rows.map(buildInterventionEngagementReminderLine),
  ]
}

export async function listSavedInterventionMaterials(
  userId: string,
  logger: Logger,
): Promise<SavedInterventionMaterialRecord[]> {
  const db = getDb()
  const rows = await db.query.interventionMaterialEngagements.findMany({
    where: and(
      eq(interventionMaterialEngagements.userId, userId),
      isNotNull(interventionMaterialEngagements.savedAt),
    ),
    orderBy: desc(interventionMaterialEngagements.savedAt),
  })

  const result: SavedInterventionMaterialRecord[] = []
  const seenCodes = new Set<string>()
  for (const row of rows) {
    if (seenCodes.has(row.materialCode)) continue
    seenCodes.add(row.materialCode)

    const snapshot = await findInterventionToolOutputInSession(row.sessionId, row.toolCallId, logger)
    const detail = snapshot ? await refreshInterventionToolOutput(snapshot, logger) : null

    result.push({
      engagement: serialize(row),
      detail,
    })
  }

  logger.debug({ userId, count: result.length }, 'listed saved intervention materials')
  return result
}

export async function findSavedInterventionMaterialByCode(
  userId: string,
  materialCode: string,
  logger: Logger,
): Promise<InterventionMaterialEngagementRecord | null> {
  const db = getDb()
  const row = await db.query.interventionMaterialEngagements.findFirst({
    where: and(
      eq(interventionMaterialEngagements.userId, userId),
      eq(interventionMaterialEngagements.materialCode, materialCode),
      isNotNull(interventionMaterialEngagements.savedAt),
    ),
    orderBy: desc(interventionMaterialEngagements.savedAt),
  })

  if (!row) return null
  logger.debug({ userId, materialCode, engagementId: row.id }, 'saved intervention material fetched by code')
  return serialize(row)
}

export async function deleteSavedInterventionMaterial(
  userId: string,
  engagementId: string,
  logger: Logger,
): Promise<SavedInterventionMaterialRecord | null> {
  const db = getDb()
  const row = await db.query.interventionMaterialEngagements.findFirst({
    where: and(
      eq(interventionMaterialEngagements.id, engagementId),
      eq(interventionMaterialEngagements.userId, userId),
      isNotNull(interventionMaterialEngagements.savedAt),
    ),
  })

  if (!row) return null

  const snapshot = await findInterventionToolOutputInSession(row.sessionId, row.toolCallId, logger)
  const detail = snapshot ? await refreshInterventionToolOutput(snapshot, logger) : null
  const now = new Date()

  await db.update(interventionMaterialEngagements)
    .set({ savedAt: null, updatedAt: now })
    .where(and(
      eq(interventionMaterialEngagements.userId, userId),
      eq(interventionMaterialEngagements.materialCode, row.materialCode),
      isNotNull(interventionMaterialEngagements.savedAt),
    ))

  logger.info({ userId, engagementId, materialCode: row.materialCode }, 'saved intervention material deleted')
  return {
    engagement: serialize({ ...row, savedAt: null, updatedAt: now }),
    detail,
  }
}

export async function getSavedInterventionMaterialPromptSummary(
  userId: string,
  logger: Logger,
): Promise<SavedInterventionMaterialPromptSummary> {
  const db = getDb()
  const rows = await db.query.interventionMaterialEngagements.findMany({
    where: eq(interventionMaterialEngagements.userId, userId),
    orderBy: desc(interventionMaterialEngagements.updatedAt),
  })
  const savedCodes = new Set(rows.filter((row) => row.savedAt).map((row) => row.materialCode))
  const grouped = new Map<string, SavedInterventionMaterialPromptSummaryItem>()

  for (const row of rows) {
    if (!savedCodes.has(row.materialCode)) continue
    const existing = grouped.get(row.materialCode)
    const savedAt = row.savedAt?.toISOString() ?? existing?.savedAt ?? ''
    const followStartedAt = latestDate(
      existing?.followStartedAt ? new Date(existing.followStartedAt) : null,
      row.followStartedAt,
    )
    const lastFollowedAt = latestDate(
      existing?.lastFollowedAt ? new Date(existing.lastFollowedAt) : null,
      inferLastFollowedAt(row),
    )
    const followCompletedAt = latestDate(
      existing?.followCompletedAt ? new Date(existing.followCompletedAt) : null,
      row.followCompletedAt,
    )

    grouped.set(row.materialCode, {
      materialCode: row.materialCode,
      materialId: existing?.materialId ?? row.materialId,
      materialVersion: existing?.materialVersion ?? row.materialVersion,
      savedAt: existing?.savedAt && savedAt
        ? latestDate(new Date(existing.savedAt), new Date(savedAt))?.toISOString() ?? existing.savedAt
        : savedAt,
      followStartedAt: followStartedAt?.toISOString() ?? null,
      lastFollowedAt: lastFollowedAt?.toISOString() ?? null,
      followCompletedAt: followCompletedAt?.toISOString() ?? null,
      totalFollowSec: Math.max(existing?.totalFollowSec ?? 0, row.totalFollowSec),
      completedStepCount: Math.max(existing?.completedStepCount ?? 0, row.completedStepCount),
      totalStepCount: Math.max(existing?.totalStepCount ?? 0, row.totalStepCount),
    })
  }

  const items = Array.from(grouped.values())
    .filter((item) => item.savedAt)
    .sort((a, b) => b.savedAt.localeCompare(a.savedAt))

  logger.debug({ userId, totalCount: items.length }, 'saved intervention material prompt summary loaded')
  return { totalCount: items.length, items }
}

export async function recordInterventionMaterialInteraction(
  params: {
    userId: string
    sessionId: string
    toolCallId: string
    event: InterventionMaterialInteractionEvent
    source?: InterventionMaterialInteractionSource
    totalFollowSec?: number
    completedStepCount?: number
    totalStepCount?: number
    lastStepIndex?: number | null
    snapshot: InterventionMaterialToolOutput
  },
  logger: Logger,
): Promise<InterventionMaterialEngagementRecord> {
  const db = getDb()
  const existing = await db.query.interventionMaterialEngagements.findFirst({
    where: and(
      eq(interventionMaterialEngagements.sessionId, params.sessionId),
      eq(interventionMaterialEngagements.toolCallId, params.toolCallId),
    ),
  })

  const now = new Date()

  if (params.event === 'save') {
    const saved = await findSavedInterventionMaterialByCode(params.userId, params.snapshot.code, logger)
    if (saved) {
      logger.info({
        userId: params.userId,
        materialCode: params.snapshot.code,
        engagementId: saved.id,
      }, 'intervention material already saved, reusing engagement')
      return saved
    }
  }

  if (params.event === 'view' && existing && existing.materialDurationSec > 0) {
    return serialize(existing)
  }

  const totalStepCount = Math.max(
    params.snapshot.stepsMeta.length,
    params.totalStepCount ?? 0,
    existing?.totalStepCount ?? 0,
  )
  const totalFollowSec = Math.max(params.totalFollowSec ?? 0, existing?.totalFollowSec ?? 0)
  const completedStepCount = Math.max(
    Math.min(params.completedStepCount ?? 0, totalStepCount),
    existing?.completedStepCount ?? 0,
  )
  const lastStepIndex = params.lastStepIndex ?? existing?.lastStepIndex ?? null

  const nextValues = {
    userId: params.userId,
    sessionId: params.sessionId,
    toolCallId: params.toolCallId,
    materialId: params.snapshot.materialId,
    materialVersion: params.snapshot.version,
    materialCode: params.snapshot.code,
    materialDurationSec: Math.max(0, Math.floor(params.snapshot.overview.totalDurationSec)),
    savedAt:
      params.event === 'save'
        ? (existing?.savedAt ?? now)
        : existing?.savedAt ?? null,
    viewedAt: existing?.viewedAt ?? now,
    followStartedAt:
      params.event === 'follow_start'
      || params.event === 'progress'
      || params.event === 'follow_complete'
      || params.event === 'follow_return_overview'
        ? (existing?.followStartedAt ?? now)
        : existing?.followStartedAt ?? null,
    followCompletedAt:
      params.event === 'follow_complete' ||
      (params.event === 'follow_return_overview' && completedStepCount >= totalStepCount && totalStepCount > 0)
        ? now
        : existing?.followCompletedAt ?? null,
    totalFollowSec,
    completedStepCount,
    totalStepCount,
    lastStepIndex,
    reminderConsumedAt:
      params.event === 'view' && existing
        ? existing.reminderConsumedAt ?? null
        : null,
    effectFollowupDueAt: existing?.effectFollowupDueAt ?? null,
    effectFollowupStatus: existing?.effectFollowupStatus ?? 'none' as const,
    effectFollowupSentAt: existing?.effectFollowupSentAt ?? null,
    effectFollowupMessageId: existing?.effectFollowupMessageId ?? null,
    effectFollowupAttemptCount: existing?.effectFollowupAttemptCount ?? 0,
    effectFollowupLastError: existing?.effectFollowupLastError ?? null,
    updatedAt: now,
  }

  async function syncSavedProgress(currentId: string) {
    if (
      params.event !== 'follow_start' &&
      params.event !== 'progress' &&
      params.event !== 'follow_complete' &&
      params.event !== 'follow_return_overview'
    ) {
      return
    }

    const saved = await db.query.interventionMaterialEngagements.findFirst({
      where: and(
        eq(interventionMaterialEngagements.userId, params.userId),
        eq(interventionMaterialEngagements.materialCode, params.snapshot.code),
        isNotNull(interventionMaterialEngagements.savedAt),
      ),
      orderBy: desc(interventionMaterialEngagements.savedAt),
    })
    if (!saved || saved.id === currentId) return

    await db.update(interventionMaterialEngagements)
      .set({
        followStartedAt: saved.followStartedAt ?? nextValues.followStartedAt,
        followCompletedAt:
          params.event === 'follow_complete'
          || (params.event === 'follow_return_overview' && completedStepCount >= totalStepCount && totalStepCount > 0)
            ? now
            : saved.followCompletedAt,
        totalFollowSec: Math.max(saved.totalFollowSec, totalFollowSec),
        completedStepCount: Math.max(saved.completedStepCount, completedStepCount),
        totalStepCount: Math.max(saved.totalStepCount, totalStepCount),
        lastStepIndex,
        updatedAt: now,
      })
      .where(eq(interventionMaterialEngagements.id, saved.id))
  }

  if (!existing) {
    const [created] = await db.insert(interventionMaterialEngagements).values({
      ...nextValues,
      createdAt: now,
    }).returning()
    await syncSavedProgress(created.id)
    logger.info({
      sessionId: params.sessionId,
      toolCallId: params.toolCallId,
      event: params.event,
    }, 'intervention engagement created')
    return serialize(created)
  }

  const [updated] = await db.update(interventionMaterialEngagements)
    .set(nextValues)
    .where(eq(interventionMaterialEngagements.id, existing.id))
    .returning()
  await syncSavedProgress(updated.id)

  logger.info({
    sessionId: params.sessionId,
    toolCallId: params.toolCallId,
    event: params.event,
  }, 'intervention engagement updated')

  return serialize(updated)
}
