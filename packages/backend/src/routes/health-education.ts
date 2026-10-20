import { Hono } from 'hono'
import { z } from 'zod'
import type {
  ApiResponse,
  HealthEducationInteractionResponse,
  HealthEducationItemWithStats,
  HealthEducationListResponse,
  HealthEducationSavedListResponse,
  HealthEducationViewResponse,
} from '@health-agent/shared'
import { authMiddleware } from '../middleware/auth.js'
import { requireActiveAccount } from '../middleware/active-account.js'
import { getBoundDoctorIdsForUser } from '../services/doctor-binding.js'
import {
  getHealthEducationItem,
  listHealthEducationItems,
  listSavedHealthEducationItems,
  recordHealthEducationView,
  setHealthEducationFavorite,
  setHealthEducationReaction,
} from '../services/health-education.js'

const reactionSchema = z.object({
  reaction: z.enum(['like', 'dislike']).nullable(),
})

const favoriteSchema = z.object({
  favorite: z.boolean(),
})

const viewSchema = z.object({
  viewId: z.string().trim().min(1).max(160),
  source: z.string().trim().max(40).nullable().optional(),
})

const listQuerySchema = z.object({
  scope: z.enum(['all', 'my_doctor']).default('all'),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.coerce.number().int().min(0).optional(),
})

const healthEducationRoutes = new Hono()

healthEducationRoutes.use('*', authMiddleware)
healthEducationRoutes.use('*', requireActiveAccount)

healthEducationRoutes.get('/items', async (c) => {
  const userId = c.get('userId')
  const logger = c.get('logger')
  const parsed = listQuerySchema.safeParse({
    scope: c.req.query('scope') ?? 'all',
    limit: c.req.query('limit') ?? undefined,
    cursor: c.req.query('cursor') ?? undefined,
  })
  if (!parsed.success) {
    return c.json({ success: false, error: parsed.error.issues[0]?.message ?? '参数错误' }, 400)
  }

  const boundDoctorIds = await getBoundDoctorIdsForUser(userId)
  const boundDoctorId = boundDoctorIds[0] ?? null
  let page: Awaited<ReturnType<typeof listHealthEducationItems>>
  if (parsed.data.scope === 'my_doctor' && boundDoctorIds.length === 0) {
    page = { items: [], nextCursor: null }
  } else {
    try {
      page = await listHealthEducationItems({
        userId,
        doctorIds: parsed.data.scope === 'my_doctor' ? boundDoctorIds : null,
        limit: parsed.data.limit,
        cursor: parsed.data.cursor ?? null,
        logger,
      })
    } catch (err: any) {
      const status = typeof err?.status === 'number' ? err.status : null
      const shouldFallbackToEmpty = (
        parsed.data.scope === 'my_doctor' &&
        boundDoctorIds.length > 0 &&
        (status === 404 || status === 422 || (status != null && status >= 500))
      )
      if (!shouldFallbackToEmpty) throw err

      logger.warn(
        { err: err?.message ?? String(err), status, boundDoctorIds },
        'bound doctor health education list unavailable, returning empty list',
      )
      page = { items: [], nextCursor: null }
    }
  }

  const payload: ApiResponse<HealthEducationListResponse> = {
    success: true,
    data: {
      items: page.items,
      scope: parsed.data.scope,
      boundDoctorId,
      boundDoctorIds,
      nextCursor: page.nextCursor,
    },
  }
  return c.json(payload)
})

healthEducationRoutes.get('/items/:itemId', async (c) => {
  const item = await getHealthEducationItem({
    userId: c.get('userId'),
    itemId: c.req.param('itemId'),
    logger: c.get('logger'),
  })
  if (!item) return c.json({ success: false, error: '患教内容不存在' }, 404)

  const payload: ApiResponse<HealthEducationItemWithStats> = {
    success: true,
    data: item,
  }
  return c.json(payload)
})

healthEducationRoutes.get('/saved', async (c) => {
  const items = await listSavedHealthEducationItems({
    userId: c.get('userId'),
    logger: c.get('logger'),
  })
  const payload: ApiResponse<HealthEducationSavedListResponse> = {
    success: true,
    data: { items },
  }
  return c.json(payload)
})

healthEducationRoutes.post('/items/:itemId/reaction', async (c) => {
  const parsed = reactionSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) {
    return c.json({ success: false, error: parsed.error.issues[0]?.message ?? '参数错误' }, 400)
  }

  const item = await setHealthEducationReaction({
    userId: c.get('userId'),
    itemId: c.req.param('itemId'),
    reaction: parsed.data.reaction,
    logger: c.get('logger'),
  })
  if (!item) return c.json({ success: false, error: '患教内容不存在' }, 404)

  const payload: ApiResponse<HealthEducationInteractionResponse> = {
    success: true,
    data: { item },
  }
  return c.json(payload)
})

healthEducationRoutes.post('/items/:itemId/favorite', async (c) => {
  const parsed = favoriteSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) {
    return c.json({ success: false, error: parsed.error.issues[0]?.message ?? '参数错误' }, 400)
  }

  const item = await setHealthEducationFavorite({
    userId: c.get('userId'),
    itemId: c.req.param('itemId'),
    favorite: parsed.data.favorite,
    logger: c.get('logger'),
  })
  if (!item) return c.json({ success: false, error: '患教内容不存在' }, 404)

  const payload: ApiResponse<HealthEducationInteractionResponse> = {
    success: true,
    data: { item },
  }
  return c.json(payload)
})

healthEducationRoutes.post('/items/:itemId/view', async (c) => {
  const parsed = viewSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) {
    return c.json({ success: false, error: parsed.error.issues[0]?.message ?? '参数错误' }, 400)
  }

  const stats = await recordHealthEducationView({
    userId: c.get('userId'),
    itemId: c.req.param('itemId'),
    viewId: parsed.data.viewId,
    source: parsed.data.source ?? null,
    logger: c.get('logger'),
  })
  if (!stats) return c.json({ success: false, error: '患教内容不存在' }, 404)

  const payload: ApiResponse<HealthEducationViewResponse> = {
    success: true,
    data: {
      itemId: stats.itemId,
      pvCount: stats.pvCount,
      uvCount: stats.uvCount,
    },
  }
  return c.json(payload)
})

export default healthEducationRoutes
