import { Hono } from 'hono'
import { z } from 'zod'
import type {
  ApiResponse,
  InternalVideoInteractionRequest,
  InternalVideoInteractionResponse,
} from '@health-agent/shared'
import { authMiddleware } from '../middleware/auth.js'
import { requireActiveAccount } from '../middleware/active-account.js'
import { getSession } from '../services/session.js'
import { recordInternalVideoInteraction } from '../services/internal-video-engagement.js'
import {
  getInternalVideoRuntimeCatalog,
  toMedicalRiskInternalVideoResource,
} from '../services/internal-video-runtime.js'
import { resolveInterventionBucketEnv } from '../services/intervention-material.js'
import { getEnv } from '../env.js'

const interactionBodySchema = z.object({
  sessionId: z.string().uuid(),
  toolCallId: z.string().trim().min(1).max(120),
  resourceId: z.string().trim().min(1).max(120),
  videoId: z.string().trim().min(1).max(120),
  videoVersion: z.string().trim().min(1).max(120),
  event: z.enum(['play_start', 'progress', 'pause', 'ended']),
  positionSec: z.number().nonnegative(),
  watchedSec: z.number().nonnegative(),
  durationSec: z.number().nonnegative(),
  endReason: z.enum(['pause', 'ended', 'pagehide', 'unmount', 'seek']).nullable().optional(),
}) satisfies z.ZodType<InternalVideoInteractionRequest>

const internalVideoRuntimeRoutes = new Hono()

internalVideoRuntimeRoutes.use('*', authMiddleware)
internalVideoRuntimeRoutes.use('*', requireActiveAccount)

async function ensureOwnedSession(
  sessionId: string,
  userId: string,
  logger: Parameters<typeof getSession>[1],
): Promise<boolean> {
  const session = await getSession(sessionId, logger)
  return !!session && session.userId === userId
}

internalVideoRuntimeRoutes.post('/interactions', async (c) => {
  const logger = c.get('logger')
  const userId = c.get('userId')
  const parsed = interactionBodySchema.safeParse(await c.req.json().catch(() => ({})))

  if (!parsed.success) {
    return c.json({ success: false, error: parsed.error.issues[0]?.message ?? '参数错误' }, 400)
  }

  const payload = parsed.data
  if (!await ensureOwnedSession(payload.sessionId, userId, logger)) {
    return c.json({ success: false, error: 'session not found' }, 404)
  }

  // 仅对 catalog 中存在的视频记录打点
  const snapshot = await getInternalVideoRuntimeCatalog(logger)
  if (!snapshot.byId.has(payload.videoId)) {
    return c.json({ success: false, error: '内部视频不存在' }, 404)
  }

  const engagement = await recordInternalVideoInteraction(userId, payload, logger)
  const response: ApiResponse<InternalVideoInteractionResponse> = {
    success: true,
    data: { engagement },
  }
  return c.json(response)
})

internalVideoRuntimeRoutes.get('/playback', async (c) => {
  const logger = c.get('logger')
  const videoId = c.req.query('videoId')?.trim()
  if (!videoId) {
    return c.json({ success: false, error: 'videoId 必填' }, 400)
  }

  const snapshot = await getInternalVideoRuntimeCatalog(logger)
  const entry = snapshot.byId.get(videoId)
  if (!entry) {
    return c.json({ success: false, error: '内部视频不存在' }, 404)
  }

  const targetEnv = resolveInterventionBucketEnv(getEnv().DEPLOY_ENV)
  const resource = toMedicalRiskInternalVideoResource(entry.id, entry, targetEnv)
  return c.json({
    success: true,
    data: {
      videoId: resource.videoId,
      version: resource.version,
      durationSec: resource.durationSec,
      videoUrl: resource.videoUrl,
      posterUrl: resource.posterUrl,
    },
  })
})

export default internalVideoRuntimeRoutes
