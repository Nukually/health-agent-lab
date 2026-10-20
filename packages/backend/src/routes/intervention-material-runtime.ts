import { Hono } from 'hono'
import { z } from 'zod'
import type {
  AnalyticsEventName,
  ApiResponse,
  InterventionDiscomfortFeedbackRequest,
  InterventionDiscomfortFeedbackResponse,
  InterventionMaterialInteractionResponse,
  InterventionMaterialRuntimeDetailResponse,
  MedicalRiskVideoResource,
  SavedInterventionMaterialListResponse,
} from '@health-agent/shared'
import { authMiddleware } from '../middleware/auth.js'
import { requireActiveAccount } from '../middleware/active-account.js'
import { getSession } from '../services/session.js'
import {
  deleteSavedInterventionMaterial,
  findInterventionEngagementByToolCall,
  findInterventionToolOutputInSession,
  findSavedInterventionMaterialByCode,
  listSavedInterventionMaterials,
  recordInterventionMaterialInteraction,
} from '../services/intervention-material-engagement.js'
import {
  recordInterventionDiscomfortFeedback,
} from '../services/intervention-discomfort-feedback.js'
import { refreshInterventionToolOutput } from '../services/intervention-material-runtime.js'
import { safeRecordAnalyticsEvent } from '../services/analytics.js'
import { safeTrackBackendEvent } from '../services/tracking.js'
import { appendUserExternalEvent } from '../services/session-events.js'

const detailQuerySchema = z.object({
  sessionId: z.string().uuid(),
  toolCallId: z.string().trim().min(1),
})

const interactionBodySchema = z.object({
  sessionId: z.string().uuid(),
  toolCallId: z.string().trim().min(1),
  event: z.enum(['view', 'save', 'follow_start', 'progress', 'follow_complete', 'follow_return_overview']),
  source: z.enum(['chat_inline', 'materials']).optional(),
  totalFollowSec: z.number().int().nonnegative().optional(),
  materialDurationSec: z.number().int().nonnegative().optional(),
  completedStepCount: z.number().int().nonnegative().optional(),
  totalStepCount: z.number().int().nonnegative().optional(),
  lastStepIndex: z.number().int().positive().nullable().optional(),
})

const videoResourceSchema = z.object({
  id: z.string().trim().min(1).max(120),
  kind: z.literal('video_resource'),
  title: z.string().trim().min(1).max(240),
  url: z.string().trim().min(1).max(1000),
  providerVideoId: z.string().trim().max(120).nullable(),
  publishedAt: z.string().trim().max(40).nullable(),
  durationSec: z.number().int().nonnegative(),
  thumbnailUrl: z.string().trim().max(1000).nullable(),
  snippet: z.string().trim().max(1000),
  sourceQuery: z.string().trim().max(120),
}) satisfies z.ZodType<MedicalRiskVideoResource>

const videoFollowupBodySchema = z.object({
  sessionId: z.string().uuid(),
  source: z.enum(['chat_inline', 'materials']).optional(),
  resource: videoResourceSchema,
  totalFollowSec: z.number().int().nonnegative(),
  materialDurationSec: z.number().int().nonnegative().optional(),
  delivery: z.enum(['immediate', 'deferred']).optional(),
  followupTrigger: z.enum(['playback_end', 'mobile_play_30s', 'mobile_play_half']).optional(),
})

const videoFollowupIntentProcessBodySchema = z.object({
  sessionId: z.string().uuid(),
})

const discomfortFeedbackBodySchema = z.object({
  sessionId: z.string().uuid(),
  resourceKind: z.enum(['intervention_material', 'video_resource', 'internal_video']),
  resourceId: z.string().trim().min(1).max(160),
  resourceTitle: z.string().trim().max(240).nullable().optional(),
  resourceContext: z.string().trim().max(160).nullable().optional(),
  toolCallId: z.string().trim().max(120).nullable().optional(),
  engagementId: z.string().uuid().nullable().optional(),
  timing: z.enum(['pre', 'post']),
  score: z.number().int().min(0).max(10),
  source: z.enum(['chat_inline', 'materials']).optional(),
  totalFollowSec: z.number().int().nonnegative().optional(),
  materialDurationSec: z.number().int().nonnegative().optional(),
}) satisfies z.ZodType<InterventionDiscomfortFeedbackRequest>

const interventionMaterialRuntimeRoutes = new Hono()

interventionMaterialRuntimeRoutes.use('*', authMiddleware)
interventionMaterialRuntimeRoutes.use('*', requireActiveAccount)

async function ensureOwnedSession(
  sessionId: string,
  userId: string,
  logger: Parameters<typeof getSession>[1],
): Promise<boolean> {
  const session = await getSession(sessionId, logger)
  return !!session && session.userId === userId
}

function analyticsEventNameForInteraction(
  event: 'view' | 'save' | 'follow_start' | 'progress' | 'follow_complete' | 'follow_return_overview',
): AnalyticsEventName | null {
  if (event === 'save') return 'intervention_material_save_clicked'
  if (event === 'follow_start') return 'intervention_material_follow_started'
  if (event === 'progress') return 'intervention_material_follow_progress'
  if (event === 'follow_complete') return 'intervention_material_follow_completed'
  return null
}

function analyticsDedupeKeyForInteraction(params: {
  event: 'view' | 'save' | 'follow_start' | 'progress' | 'follow_complete' | 'follow_return_overview'
  sessionId: string
  toolCallId: string
  source: 'chat_inline' | 'materials'
  totalFollowSec?: number
  completedStepCount?: number
}): string | null {
  if (params.event === 'save') return `${params.sessionId}:${params.toolCallId}:save`
  if (params.event !== 'progress') return null
  return [
    params.sessionId,
    params.toolCallId,
    params.source,
    params.event,
    params.completedStepCount ?? 0,
    params.totalFollowSec ?? 0,
  ].join(':')
}

interventionMaterialRuntimeRoutes.get('/detail', async (c) => {
  const logger = c.get('logger')
  const userId = c.get('userId')
  const parsed = detailQuerySchema.safeParse({
    sessionId: c.req.query('sessionId'),
    toolCallId: c.req.query('toolCallId'),
  })

  if (!parsed.success) {
    return c.json({ success: false, error: parsed.error.issues[0]?.message ?? '参数错误' }, 400)
  }

  const { sessionId, toolCallId } = parsed.data
  if (!await ensureOwnedSession(sessionId, userId, logger)) {
    return c.json({ success: false, error: 'session not found' }, 404)
  }

  const snapshot = await findInterventionToolOutputInSession(sessionId, toolCallId, logger)
  if (!snapshot) {
    return c.json({ success: false, error: '干预方案不存在' }, 404)
  }

  const detail = await refreshInterventionToolOutput(snapshot, logger)
  if (!detail) {
    return c.json({ success: false, error: '干预方案已失效' }, 404)
  }

  const engagement = await findInterventionEngagementByToolCall(userId, sessionId, toolCallId)
  const savedEngagement = await findSavedInterventionMaterialByCode(userId, snapshot.code, logger)
  const payload: ApiResponse<InterventionMaterialRuntimeDetailResponse> = {
    success: true,
    data: { detail, engagement, savedEngagement },
  }
  return c.json(payload)
})

interventionMaterialRuntimeRoutes.get('/saved', async (c) => {
  const logger = c.get('logger')
  const userId = c.get('userId')

  const items = await listSavedInterventionMaterials(userId, logger)
  const payload: ApiResponse<SavedInterventionMaterialListResponse> = {
    success: true,
    data: { items },
  }
  return c.json(payload)
})

interventionMaterialRuntimeRoutes.delete('/saved/:engagementId', async (c) => {
  const logger = c.get('logger')
  const userId = c.get('userId')
  const engagementId = c.req.param('engagementId')
  const sessionId = c.req.query('sessionId')

  const parsed = z.string().uuid().safeParse(engagementId)
  if (!parsed.success) {
    return c.json({ success: false, error: '参数错误' }, 400)
  }

  const deleted = await deleteSavedInterventionMaterial(userId, parsed.data, logger)
  if (!deleted) return c.json({ success: false, error: '跟练卡不存在' }, 404)

  if (sessionId && await ensureOwnedSession(sessionId, userId, logger)) {
    await appendUserExternalEvent(
      userId,
      {
        type: 'external_page_changed',
        page: 'materials',
        action: 'intervention_material_deleted',
        interventionMaterial: {
          engagementId: deleted.engagement.id,
          materialId: deleted.engagement.materialId,
          materialCode: deleted.engagement.materialCode,
          title: deleted.detail?.actionName ?? null,
          sideEffect: deleted.detail?.sideEffect ?? null,
          scene: deleted.detail?.scene ?? null,
        },
      },
      logger,
    )
  }

  const payload: ApiResponse<SavedInterventionMaterialListResponse['items'][number]> = {
    success: true,
    data: deleted,
  }
  return c.json(payload)
})

interventionMaterialRuntimeRoutes.post('/interactions', async (c) => {
  const logger = c.get('logger')
  const userId = c.get('userId')
  const parsed = interactionBodySchema.safeParse(await c.req.json().catch(() => ({})))

  if (!parsed.success) {
    return c.json({ success: false, error: parsed.error.issues[0]?.message ?? '参数错误' }, 400)
  }

  const {
    sessionId,
    toolCallId,
    event,
    source = 'chat_inline',
    totalFollowSec,
    completedStepCount,
    totalStepCount,
    lastStepIndex,
  } = parsed.data

  if (!await ensureOwnedSession(sessionId, userId, logger)) {
    return c.json({ success: false, error: 'session not found' }, 404)
  }

  const snapshot = await findInterventionToolOutputInSession(sessionId, toolCallId, logger)
  if (!snapshot) {
    return c.json({ success: false, error: '干预方案不存在' }, 404)
  }

  const engagement = await recordInterventionMaterialInteraction({
    userId,
    sessionId,
    toolCallId,
    event,
    totalFollowSec,
    completedStepCount,
    totalStepCount,
    lastStepIndex,
    snapshot,
    source,
  }, logger)

  const analyticsEventName = analyticsEventNameForInteraction(event)
  if (analyticsEventName && (event === 'save' || source === 'materials')) {
    const analyticsEvent = {
      userId,
      sessionId,
      eventName: analyticsEventName,
      dedupeKey: analyticsDedupeKeyForInteraction({
        event,
        sessionId,
        toolCallId,
        source,
        totalFollowSec,
        completedStepCount,
      }),
      entityType: 'intervention_material',
      entityId: engagement.id,
      properties: {
        source,
        toolCallId,
        materialId: snapshot.materialId,
        materialVersion: snapshot.version,
        materialCode: snapshot.code,
        actionName: snapshot.actionName,
        sideEffect: snapshot.sideEffect,
        scene: snapshot.scene,
        totalFollowSec: totalFollowSec ?? null,
        completedStepCount: completedStepCount ?? null,
        totalStepCount: totalStepCount ?? snapshot.stepsMeta.length,
        lastStepIndex: lastStepIndex ?? null,
      },
    } as const
    await safeRecordAnalyticsEvent(analyticsEvent, logger)
    safeTrackBackendEvent(
      analyticsEvent,
      logger,
      c.get('trackingContext'),
    )
  }

  const payload: ApiResponse<InterventionMaterialInteractionResponse> = {
    success: true,
    data: { engagement, assistantMessage: null },
  }
  return c.json(payload)
})

interventionMaterialRuntimeRoutes.post('/discomfort-feedback', async (c) => {
  const logger = c.get('logger')
  const userId = c.get('userId')
  const parsed = discomfortFeedbackBodySchema.safeParse(await c.req.json().catch(() => ({})))

  if (!parsed.success) {
    return c.json({ success: false, error: parsed.error.issues[0]?.message ?? '参数错误' }, 400)
  }

  const { sessionId } = parsed.data
  if (!await ensureOwnedSession(sessionId, userId, logger)) {
    return c.json({ success: false, error: 'session not found' }, 404)
  }

  const feedback = await recordInterventionDiscomfortFeedback(userId, parsed.data, logger)
  const payload: ApiResponse<InterventionDiscomfortFeedbackResponse> = {
    success: true,
    data: { feedback },
  }
  return c.json(payload)
})

interventionMaterialRuntimeRoutes.post('/video-followup', async (c) => {
  const logger = c.get('logger')
  const userId = c.get('userId')
  const parsed = videoFollowupBodySchema.safeParse(await c.req.json().catch(() => ({})))

  if (!parsed.success) {
    return c.json({ success: false, error: parsed.error.issues[0]?.message ?? '参数错误' }, 400)
  }

  const { sessionId } = parsed.data
  if (!await ensureOwnedSession(sessionId, userId, logger)) {
    return c.json({ success: false, error: 'session not found' }, 404)
  }

  const payload: ApiResponse<{ assistantMessage: null; intentId: null }> = {
    success: true,
    data: { assistantMessage: null, intentId: null },
  }
  return c.json(payload)
})

interventionMaterialRuntimeRoutes.post('/video-followup/:intentId/process', async (c) => {
  const logger = c.get('logger')
  const userId = c.get('userId')
  const intentId = c.req.param('intentId')
  const parsedIntentId = z.string().uuid().safeParse(intentId)
  const parsed = videoFollowupIntentProcessBodySchema.safeParse(await c.req.json().catch(() => ({})))

  if (!parsedIntentId.success || !parsed.success) {
    return c.json({ success: false, error: '参数错误' }, 400)
  }

  const { sessionId } = parsed.data
  if (!await ensureOwnedSession(sessionId, userId, logger)) {
    return c.json({ success: false, error: 'session not found' }, 404)
  }

  const payload: ApiResponse<{ assistantMessage: null }> = {
    success: true,
    data: { assistantMessage: null },
  }
  return c.json(payload)
})

export default interventionMaterialRuntimeRoutes
