import { and, eq, lte } from 'drizzle-orm'
import type {
  InterventionDiscomfortFeedbackRecord,
  InterventionDiscomfortFeedbackRequest,
  InterventionDiscomfortFeedbackSnapshotItem,
  InterventionDiscomfortFeedbackState,
  InterventionDiscomfortFeedbackTiming,
  InterventionMaterialToolOutput,
  MedicalRiskResource,
  ToolCallRecord,
} from '@health-agent/shared'
import {
  parseInterventionMaterialToolOutput,
  parseMedicalRiskToolOutput,
} from '@health-agent/shared'
import { getDb } from '../db/client.js'
import { interventionDiscomfortFeedback } from '../db/schema/index.js'
import type { Logger } from '../lib/logger.js'
import { appendPendingSystemReminder } from './pending-system-reminders.js'

type FeedbackRow = typeof interventionDiscomfortFeedback.$inferSelect
type FeedbackStateRow = Pick<FeedbackRow, 'resourceKind' | 'resourceId' | 'timing' | 'score'>

export type InterventionDiscomfortFeedbackMap = Map<string, InterventionDiscomfortFeedbackState>
const MEDICAL_RISK_RESOURCE_TOOL_NAMES = new Set(['grade_medical_risk', 'generate_plan', 'saved_content'])

function feedbackKey(kind: FeedbackStateRow['resourceKind'], resourceId: string): string {
  return `${kind}:${resourceId.trim().slice(0, 160)}`
}

export function buildInterventionDiscomfortFeedbackMap(
  rows: FeedbackStateRow[],
): InterventionDiscomfortFeedbackMap {
  const result: InterventionDiscomfortFeedbackMap = new Map()
  for (const row of rows) {
    const key = feedbackKey(row.resourceKind, row.resourceId)
    const current = result.get(key) ?? { preScore: null, postScore: null }
    if (row.timing === 'pre') {
      current.preScore = row.score
    } else {
      current.postScore = row.score
    }
    result.set(key, current)
  }
  return result
}

export function buildInterventionDiscomfortFeedbackMapFromSnapshot(
  snapshot: InterventionDiscomfortFeedbackSnapshotItem[] | null | undefined,
): InterventionDiscomfortFeedbackMap {
  const result: InterventionDiscomfortFeedbackMap = new Map()
  for (const item of snapshot ?? []) {
    if (item.preScore === null && item.postScore === null) continue
    result.set(feedbackKey(item.resourceKind, item.resourceId), {
      preScore: item.preScore,
      postScore: item.postScore,
    })
  }
  return result
}

export function getInterventionDiscomfortFeedbackState(
  map: InterventionDiscomfortFeedbackMap,
  kind: FeedbackStateRow['resourceKind'],
  resourceId: string,
): InterventionDiscomfortFeedbackState | null {
  const state = map.get(feedbackKey(kind, resourceId))
  return state && (state.preScore !== null || state.postScore !== null) ? state : null
}

export function buildInterventionDiscomfortFeedbackSnapshot(
  map: InterventionDiscomfortFeedbackMap,
): InterventionDiscomfortFeedbackSnapshotItem[] {
  return [...map.entries()].map(([key, state]) => {
    const separator = key.indexOf(':')
    return {
      resourceKind: key.slice(0, separator) as InterventionDiscomfortFeedbackSnapshotItem['resourceKind'],
      resourceId: key.slice(separator + 1),
      preScore: state.preScore,
      postScore: state.postScore,
    }
  })
}

export function attachInterventionDiscomfortFeedbackToMaterial(
  material: InterventionMaterialToolOutput,
  feedbackMap: InterventionDiscomfortFeedbackMap,
): InterventionMaterialToolOutput {
  const discomfortFeedback = getInterventionDiscomfortFeedbackState(
    feedbackMap,
    'intervention_material',
    material.code,
  )
  return discomfortFeedback ? { ...material, discomfortFeedback } : material
}

export function attachInterventionDiscomfortFeedbackToToolCalls(
  toolCalls: ToolCallRecord[] | null,
  feedbackMap: InterventionDiscomfortFeedbackMap,
): ToolCallRecord[] | null {
  if (!toolCalls?.length || feedbackMap.size === 0) return toolCalls

  return toolCalls.map((toolCall) => {
    if (MEDICAL_RISK_RESOURCE_TOOL_NAMES.has(toolCall.name)) {
      const parsed = parseMedicalRiskToolOutput(toolCall.output)
      if (!parsed) return toolCall
      const resources = parsed.resources.map((resource): MedicalRiskResource => {
        if (resource.kind === 'intervention_material') {
          return {
            ...resource,
            material: attachInterventionDiscomfortFeedbackToMaterial(resource.material, feedbackMap),
          }
        }
        if (resource.kind === 'internal_video') {
          const discomfortFeedback = getInterventionDiscomfortFeedbackState(
            feedbackMap,
            'internal_video',
            resource.id,
          )
          return discomfortFeedback ? { ...resource, discomfortFeedback } : resource
        }
        const resourceId = resource.providerVideoId ?? resource.id
        const discomfortFeedback = getInterventionDiscomfortFeedbackState(
          feedbackMap,
          'video_resource',
          resourceId,
        )
        return discomfortFeedback ? { ...resource, discomfortFeedback } : resource
      })
      return { ...toolCall, output: { ...parsed, resources } }
    }

    if (toolCall.name !== 'show_intervention_material') return toolCall
    const material = parseInterventionMaterialToolOutput(toolCall.output)
    if (!material) return toolCall
    return {
      ...toolCall,
      output: attachInterventionDiscomfortFeedbackToMaterial(material, feedbackMap),
    }
  })
}

export async function listInterventionDiscomfortFeedbackSnapshot(
  sessionId: string,
  userId: string,
  opts: { createdAtLte?: Date } = {},
): Promise<InterventionDiscomfortFeedbackSnapshotItem[]> {
  const db = getDb()
  const where = opts.createdAtLte
    ? and(
      eq(interventionDiscomfortFeedback.sessionId, sessionId),
      eq(interventionDiscomfortFeedback.userId, userId),
      lte(interventionDiscomfortFeedback.createdAt, opts.createdAtLte),
    )
    : and(
      eq(interventionDiscomfortFeedback.sessionId, sessionId),
      eq(interventionDiscomfortFeedback.userId, userId),
    )
  const rows = await db.query.interventionDiscomfortFeedback.findMany({
    where,
    columns: {
      resourceKind: true,
      resourceId: true,
      timing: true,
      score: true,
    },
  })
  return buildInterventionDiscomfortFeedbackSnapshot(buildInterventionDiscomfortFeedbackMap(rows))
}

function normalizeNullableText(value: string | null | undefined, max: number): string | null {
  const trimmed = value?.trim()
  if (!trimmed) return null
  return trimmed.slice(0, max)
}

function serialize(row: FeedbackRow): InterventionDiscomfortFeedbackRecord {
  return {
    id: row.id,
    userId: row.userId,
    sessionId: row.sessionId,
    resourceKind: row.resourceKind,
    resourceId: row.resourceId,
    resourceTitle: row.resourceTitle ?? null,
    resourceContext: row.resourceContext ?? null,
    toolCallId: row.toolCallId ?? null,
    engagementId: row.engagementId ?? null,
    timing: row.timing,
    score: row.score,
    source: row.source,
    totalFollowSec: row.totalFollowSec ?? null,
    materialDurationSec: row.materialDurationSec ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

function timingLabel(timing: InterventionDiscomfortFeedbackTiming): string {
  return timing === 'pre' ? '跟练前' : '跟练后'
}

function resourceKindLabel(row: FeedbackRow): string {
  return row.resourceKind === 'video_resource' ? '视频' : '跟练卡'
}

function renderScorePair(rows: FeedbackRow[]): string {
  const pre = rows.find((row) => row.timing === 'pre')
  const post = rows.find((row) => row.timing === 'post')
  if (pre && post) {
    const delta = post.score - pre.score
    const trend = delta < 0
      ? `，较跟练前降低 ${Math.abs(delta)} 分`
      : delta > 0
        ? `，较跟练前升高 ${delta} 分`
        : '，与跟练前持平'
    return `当前已记录：跟练前 ${pre.score}/10，跟练后 ${post.score}/10${trend}。`
  }
  const only = post ?? pre
  return only ? `当前已记录：${timingLabel(only.timing)} ${only.score}/10。` : ''
}

function buildFeedbackReminder(row: FeedbackRow, relatedRows: FeedbackRow[]): string {
  const title = row.resourceTitle || (row.resourceKind === 'video_resource' ? '这条视频' : '这张跟练卡')
  const context = row.resourceContext ? `（${row.resourceContext}）` : ''
  const pairText = renderScorePair(relatedRows)
  return `[intervention-discomfort-feedback]
用户刚点击了${resourceKindLabel(row)}“${title}”${context}的${timingLabel(row.timing)}不舒服程度反馈：${row.score}/10。
${pairText}
本轮回复请结合该数字理解用户当前状态；不要要求用户重复填写这个量表，也不要暴露内部标签。若分值较高或跟练后升高，优先关注安全提醒、停止跟练和就医阈值。`
}

export async function recordInterventionDiscomfortFeedback(
  userId: string,
  input: InterventionDiscomfortFeedbackRequest,
  logger: Logger,
): Promise<InterventionDiscomfortFeedbackRecord> {
  const now = new Date()
  const score = Math.max(0, Math.min(10, Math.floor(input.score)))
  const totalFollowSec = input.totalFollowSec == null
    ? null
    : Math.max(0, Math.floor(input.totalFollowSec))
  const materialDurationSec = input.materialDurationSec == null
    ? null
    : Math.max(0, Math.floor(input.materialDurationSec))
  const values = {
    userId,
    sessionId: input.sessionId,
    resourceKind: input.resourceKind,
    resourceId: input.resourceId.trim().slice(0, 160),
    resourceTitle: normalizeNullableText(input.resourceTitle, 240),
    resourceContext: normalizeNullableText(input.resourceContext, 160),
    toolCallId: normalizeNullableText(input.toolCallId, 120),
    engagementId: input.engagementId ?? null,
    timing: input.timing,
    score,
    source: input.source ?? 'chat_inline',
    totalFollowSec,
    materialDurationSec,
    updatedAt: now,
  }

  const db = getDb()
  const [row] = await db.insert(interventionDiscomfortFeedback)
    .values({
      ...values,
      createdAt: now,
    })
    .onConflictDoUpdate({
      target: [
        interventionDiscomfortFeedback.userId,
        interventionDiscomfortFeedback.sessionId,
        interventionDiscomfortFeedback.resourceKind,
        interventionDiscomfortFeedback.resourceId,
        interventionDiscomfortFeedback.timing,
      ],
      set: values,
    })
    .returning()

  const relatedRows = await db.query.interventionDiscomfortFeedback.findMany({
    where: and(
      eq(interventionDiscomfortFeedback.userId, userId),
      eq(interventionDiscomfortFeedback.sessionId, input.sessionId),
      eq(interventionDiscomfortFeedback.resourceKind, input.resourceKind),
      eq(interventionDiscomfortFeedback.resourceId, values.resourceId),
    ),
  })
  await appendPendingSystemReminder(input.sessionId, buildFeedbackReminder(row, relatedRows), logger)

  logger.info({
    sessionId: input.sessionId,
    resourceKind: input.resourceKind,
    timing: input.timing,
  }, 'intervention discomfort feedback recorded')

  return serialize(row)
}
