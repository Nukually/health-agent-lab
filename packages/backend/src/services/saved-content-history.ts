import { and, desc, eq, inArray } from 'drizzle-orm'
import {
  parseCommunicationCardToolOutput,
  parseInterventionMaterialToolOutput,
  parseMedicalRiskToolOutput,
  type CommunicationCardDraft,
  type InterventionMaterialProgressSnapshot,
  type InterventionMaterialToolOutput,
  type MedicalRiskVideoResource,
  type ToolCallRecord,
} from '@health-agent/shared'
import { getDb } from '../db/client.js'
import {
  analyticsEvents,
  chatSessions,
  communicationCards,
  interventionMaterialEngagements,
  messages as dbMessages,
} from '../db/schema/index.js'
import type { Logger } from '../lib/logger.js'

const MAX_UNSAVED_SENT_SCAN_MESSAGES = 300
const MAX_UNSAVED_SENT_ANALYTICS_EVENTS = 1_000
const MAX_UNSAVED_SENT_ITEMS = 50

const VIDEO_ANALYTICS_EVENT_NAMES = [
  'video_resource_save_clicked',
  'video_resource_follow_started',
  'video_resource_follow_progress',
  'video_resource_follow_session_ended',
  'video_resource_follow_completed',
] as const

export type UnsavedSentContentItem =
  | {
    kind: 'intervention_material'
    sessionId: string
    toolCallId: string
    title: string
    sentAt: string
    detail: InterventionMaterialToolOutput
    progress: InterventionMaterialProgressSnapshot | null
  }
  | {
    kind: 'video_resource'
    sessionId: string
    toolCallId: string | null
    title: string
    sentAt: string
    resource: MedicalRiskVideoResource
    followed: boolean
    totalFollowSec: number
    followEventCount: number
    lastFollowedAt: string | null
  }
  | {
    kind: 'communication_card'
    sessionId: string
    toolCallId: string
    title: string
    sentAt: string
    draft: CommunicationCardDraft
    templateVersion: number
  }

export interface UnsavedSentContentIndex {
  items: UnsavedSentContentItem[]
  truncated: boolean
}

interface AssistantMessageRow {
  id: string
  sessionId: string
  content: string
  toolCalls: unknown[] | null
  createdAt: Date
}

interface EngagementRow {
  sessionId: string
  toolCallId: string
  materialId: string
  materialVersion: string
  materialCode: string
  savedAt: Date | null
  viewedAt: Date | null
  followStartedAt: Date | null
  followCompletedAt: Date | null
  totalFollowSec: number
  completedStepCount: number
  totalStepCount: number
  lastStepIndex: number | null
}

interface VideoFollowStats {
  followed: boolean
  totalFollowSec: number
  followEventCount: number
  lastFollowedAt: string | null
}

function normalizeResourceRefId(value: string): string {
  return value.trim().replace(/^\[|\]$/g, '')
}

export function extractResourceRefIds(content: string): Set<string> {
  const ids = new Set<string>()
  for (const match of content.matchAll(/<resource_ref\b[^>]*\bid\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s/>]+))[^>]*\/?>/gi)) {
    const id = normalizeResourceRefId(match[1] ?? match[2] ?? match[3] ?? '')
    if (id) ids.add(id)
  }
  return ids
}

function toProgressSnapshot(row: EngagementRow | undefined): InterventionMaterialProgressSnapshot | null {
  if (!row) return null
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

function materialKey(materialId: string, version: string): string {
  return `${materialId}:${version}`
}

function sessionToolKey(sessionId: string | null | undefined, toolCallId: string | null | undefined): string | null {
  if (!sessionId || !toolCallId) return null
  return `${sessionId}:${toolCallId}`
}

function generatedCardMetaKey(sessionId: string, draft: CommunicationCardDraft): string {
  return `${sessionId}:${draft.title}:${draft.cardDate}`
}

function toolCallIdOf(toolCall: ToolCallRecord, fallback: string): string {
  return typeof toolCall.toolCallId === 'string' && toolCall.toolCallId.trim()
    ? toolCall.toolCallId.trim()
    : fallback
}

function parseMedicalResources(toolCall: ToolCallRecord) {
  return parseMedicalRiskToolOutput(toolCall.output) ?? parseMedicalRiskToolOutput(toolCall.llmOutput)
}

function parseLegacyInterventionMaterial(toolCall: ToolCallRecord) {
  return parseInterventionMaterialToolOutput(toolCall.output) ?? parseInterventionMaterialToolOutput(toolCall.llmOutput)
}

function parseGeneratedCommunicationCard(toolCall: ToolCallRecord) {
  return parseCommunicationCardToolOutput(toolCall.output) ?? parseCommunicationCardToolOutput(toolCall.llmOutput)
}

function videoIdentityKeys(resource: Pick<MedicalRiskVideoResource, 'providerVideoId' | 'url'>): string[] {
  return [resource.providerVideoId, resource.url]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value))
}

function analyticsVideoKeys(row: {
  entityId: string | null
  properties: Record<string, unknown> | null
}): string[] {
  const props = row.properties ?? {}
  return [row.entityId, props.providerVideoId, props.url]
    .map((value) => typeof value === 'string' ? value.trim() : '')
    .filter(Boolean)
}

function defaultVideoFollowStats(): VideoFollowStats {
  return {
    followed: false,
    totalFollowSec: 0,
    followEventCount: 0,
    lastFollowedAt: null,
  }
}

function mergeVideoFollowStats(
  current: VideoFollowStats | undefined,
  row: {
    eventName: string
    properties: Record<string, unknown> | null
    createdAt: Date
  },
): VideoFollowStats {
  const next = current ?? defaultVideoFollowStats()
  const followedSec = typeof row.properties?.followedSec === 'number'
    ? Math.max(0, Math.floor(row.properties.followedSec))
    : 0
  return {
    followed: true,
    totalFollowSec: Math.max(next.totalFollowSec, followedSec),
    followEventCount: next.followEventCount + 1,
    lastFollowedAt: next.lastFollowedAt && next.lastFollowedAt > row.createdAt.toISOString()
      ? next.lastFollowedAt
      : row.createdAt.toISOString(),
  }
}

function isVideoSaveEvent(eventName: string): boolean {
  return eventName === 'video_resource_save_clicked'
}

function addVideoAnalytics(
  savedVideoKeys: Set<string>,
  videoFollowStats: Map<string, VideoFollowStats>,
  row: {
    eventName: string
    entityId: string | null
    properties: Record<string, unknown> | null
    createdAt: Date
  },
) {
  const keys = analyticsVideoKeys(row)
  if (keys.length === 0) return

  if (isVideoSaveEvent(row.eventName)) {
    keys.forEach((key) => savedVideoKeys.add(key))
    return
  }

  for (const key of keys) {
    videoFollowStats.set(key, mergeVideoFollowStats(videoFollowStats.get(key), row))
  }
}

function resolveVideoFollowStats(
  resource: MedicalRiskVideoResource,
  videoFollowStats: Map<string, VideoFollowStats>,
): VideoFollowStats {
  const stats = videoIdentityKeys(resource)
    .map((key) => videoFollowStats.get(key))
    .filter((item): item is VideoFollowStats => Boolean(item))

  if (stats.length === 0) return defaultVideoFollowStats()
  return stats.reduce((acc, item) => ({
    followed: acc.followed || item.followed,
    totalFollowSec: Math.max(acc.totalFollowSec, item.totalFollowSec),
    followEventCount: acc.followEventCount + item.followEventCount,
    lastFollowedAt: !acc.lastFollowedAt || (item.lastFollowedAt && item.lastFollowedAt > acc.lastFollowedAt)
      ? item.lastFollowedAt
      : acc.lastFollowedAt,
  }), defaultVideoFollowStats())
}

function isVideoSaved(resource: MedicalRiskVideoResource, savedVideoKeys: Set<string>): boolean {
  return videoIdentityKeys(resource).some((key) => savedVideoKeys.has(key))
}

function isCommunicationCardSaved(
  sessionId: string,
  toolCallId: string,
  draft: CommunicationCardDraft,
  savedCardToolKeys: Set<string>,
  savedCardMetaKeys: Set<string>,
): boolean {
  return savedCardToolKeys.has(`${sessionId}:${toolCallId}`)
    || savedCardMetaKeys.has(generatedCardMetaKey(sessionId, draft))
}

function pushUniqueItem(
  items: UnsavedSentContentItem[],
  seen: Set<string>,
  key: string,
  item: UnsavedSentContentItem,
) {
  if (seen.has(key)) return
  seen.add(key)
  items.push(item)
}

export async function listUnsavedSentContent(
  userId: string,
  logger: Logger,
): Promise<UnsavedSentContentIndex> {
  const db = getDb()
  const [assistantRows, engagementRows, savedCards, videoEvents] = await Promise.all([
    db
      .select({
        id: dbMessages.id,
        sessionId: dbMessages.sessionId,
        content: dbMessages.content,
        toolCalls: dbMessages.toolCalls,
        createdAt: dbMessages.createdAt,
      })
      .from(dbMessages)
      .innerJoin(chatSessions, eq(dbMessages.sessionId, chatSessions.id))
      .where(and(eq(chatSessions.userId, userId), eq(dbMessages.role, 'assistant')))
      .orderBy(desc(dbMessages.createdAt))
      .limit(MAX_UNSAVED_SENT_SCAN_MESSAGES),
    db
      .select({
        sessionId: interventionMaterialEngagements.sessionId,
        toolCallId: interventionMaterialEngagements.toolCallId,
        materialId: interventionMaterialEngagements.materialId,
        materialVersion: interventionMaterialEngagements.materialVersion,
        materialCode: interventionMaterialEngagements.materialCode,
        savedAt: interventionMaterialEngagements.savedAt,
        viewedAt: interventionMaterialEngagements.viewedAt,
        followStartedAt: interventionMaterialEngagements.followStartedAt,
        followCompletedAt: interventionMaterialEngagements.followCompletedAt,
        totalFollowSec: interventionMaterialEngagements.totalFollowSec,
        completedStepCount: interventionMaterialEngagements.completedStepCount,
        totalStepCount: interventionMaterialEngagements.totalStepCount,
        lastStepIndex: interventionMaterialEngagements.lastStepIndex,
      })
      .from(interventionMaterialEngagements)
      .where(eq(interventionMaterialEngagements.userId, userId)),
    db
      .select({
        sourceSessionId: communicationCards.sourceSessionId,
        title: communicationCards.title,
        cardDate: communicationCards.cardDate,
        contentJson: communicationCards.contentJson,
      })
      .from(communicationCards)
      .where(eq(communicationCards.userId, userId)),
    db
      .select({
        eventName: analyticsEvents.eventName,
        entityId: analyticsEvents.entityId,
        properties: analyticsEvents.properties,
        createdAt: analyticsEvents.createdAt,
      })
      .from(analyticsEvents)
      .where(and(
        eq(analyticsEvents.userId, userId),
        inArray(analyticsEvents.eventName, [...VIDEO_ANALYTICS_EVENT_NAMES]),
      ))
      .orderBy(desc(analyticsEvents.createdAt))
      .limit(MAX_UNSAVED_SENT_ANALYTICS_EVENTS),
  ])

  const engagementBySessionTool = new Map<string, EngagementRow>()
  const savedMaterialCodes = new Set<string>()
  const savedMaterialKeys = new Set<string>()
  for (const row of engagementRows) {
    const key = sessionToolKey(row.sessionId, row.toolCallId)
    if (key) engagementBySessionTool.set(key, row)
    if (row.savedAt) {
      savedMaterialCodes.add(row.materialCode)
      savedMaterialKeys.add(materialKey(row.materialId, row.materialVersion))
    }
  }

  const savedCardToolKeys = new Set<string>()
  const savedCardMetaKeys = new Set<string>()
  for (const card of savedCards) {
    const sourceToolCallId = typeof card.contentJson?.sourceToolCallId === 'string'
      ? card.contentJson.sourceToolCallId
      : null
    const toolKey = sessionToolKey(card.sourceSessionId, sourceToolCallId)
    if (toolKey) savedCardToolKeys.add(toolKey)
    if (card.sourceSessionId) {
      savedCardMetaKeys.add(`${card.sourceSessionId}:${card.title}:${card.cardDate}`)
    }
  }

  const savedVideoKeys = new Set<string>()
  const videoFollowStats = new Map<string, VideoFollowStats>()
  for (const row of videoEvents) {
    addVideoAnalytics(savedVideoKeys, videoFollowStats, row)
  }

  const items: UnsavedSentContentItem[] = []
  const seen = new Set<string>()

  for (const row of assistantRows as AssistantMessageRow[]) {
    const resourceRefIds = extractResourceRefIds(row.content)
    const toolCalls = (row.toolCalls ?? []) as ToolCallRecord[]
    for (const [toolIndex, toolCall] of toolCalls.entries()) {
      const toolCallId = toolCallIdOf(toolCall, `${row.id}:tool:${toolIndex + 1}`)
      const sentAt = row.createdAt.toISOString()

      if (toolCall.name === 'generate_plan' || toolCall.name === 'grade_medical_risk') {
        const parsed = parseMedicalResources(toolCall)
        for (const resource of parsed?.resources ?? []) {
          if (!resourceRefIds.has(resource.id)) continue
          if (resource.kind === 'intervention_material') {
            const detail = resource.material
            if (
              savedMaterialCodes.has(detail.code) ||
              savedMaterialKeys.has(materialKey(detail.materialId, detail.version))
            ) {
              continue
            }
            const virtualToolCallId = `${toolCallId}:resource:${resource.id}`
            const progress = toProgressSnapshot(engagementBySessionTool.get(`${row.sessionId}:${virtualToolCallId}`))
            pushUniqueItem(items, seen, `intervention:${detail.materialId}:${detail.version}`, {
              kind: 'intervention_material',
              sessionId: row.sessionId,
              toolCallId: virtualToolCallId,
              title: detail.actionName,
              sentAt,
              detail,
              progress,
            })
            continue
          }

          if (resource.kind === 'internal_video') continue
          if (isVideoSaved(resource, savedVideoKeys)) continue
          const stats = resolveVideoFollowStats(resource, videoFollowStats)
          pushUniqueItem(items, seen, `video:${videoIdentityKeys(resource)[0] ?? resource.id}`, {
            kind: 'video_resource',
            sessionId: row.sessionId,
            toolCallId,
            title: resource.title,
            sentAt,
            resource,
            ...stats,
          })
        }
      }

      if (toolCall.name === 'show_intervention_material') {
        const detail = parseLegacyInterventionMaterial(toolCall)
        if (!detail) continue
        if (
          savedMaterialCodes.has(detail.code) ||
          savedMaterialKeys.has(materialKey(detail.materialId, detail.version))
        ) {
          continue
        }
        const progress = toProgressSnapshot(engagementBySessionTool.get(`${row.sessionId}:${toolCallId}`))
        pushUniqueItem(items, seen, `intervention:${detail.materialId}:${detail.version}`, {
          kind: 'intervention_material',
          sessionId: row.sessionId,
          toolCallId,
          title: detail.actionName,
          sentAt,
          detail,
          progress,
        })
      }

      if (toolCall.name === 'generate_communication_card') {
        const parsed = parseGeneratedCommunicationCard(toolCall)
        if (!parsed) continue
        if (
          isCommunicationCardSaved(
            row.sessionId,
            toolCallId,
            parsed.draft,
            savedCardToolKeys,
            savedCardMetaKeys,
          )
        ) {
          continue
        }
        pushUniqueItem(items, seen, `communication_card:${row.sessionId}:${toolCallId}`, {
          kind: 'communication_card',
          sessionId: row.sessionId,
          toolCallId,
          title: parsed.draft.title,
          sentAt,
          draft: parsed.draft,
          templateVersion: parsed.templateVersion,
        })
      }
    }
  }

  const truncated = items.length > MAX_UNSAVED_SENT_ITEMS
  const result = {
    items: items.slice(0, MAX_UNSAVED_SENT_ITEMS),
    truncated,
  }

  logger.debug({
    userId,
    count: result.items.length,
    truncated,
    scannedMessages: assistantRows.length,
  }, 'listed unsaved sent content')

  return result
}
