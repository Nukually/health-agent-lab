import { Hono } from 'hono'
import { z } from 'zod'
import {
  ANALYTICS_EVENT_NAMES,
  type AnalyticsEventRecord,
  type AnalyticsEventRequest,
  type ApiResponse,
} from '@health-agent/shared'
import { eq } from 'drizzle-orm'
import { authMiddleware } from '../middleware/auth.js'
import { requireActiveAccount } from '../middleware/active-account.js'
import { rateLimitMiddleware } from '../middleware/rate-limit.js'
import { getDb } from '../db/client.js'
import { chatSessions, shareTokens } from '../db/schema/index.js'
import { recordAnalyticsEvent } from '../services/analytics.js'
import { createShareToken, getSharedSession } from '../services/share.js'

const shareBodySchema = z.object({
  upToMessageId: z.string().uuid(),
})

const sharedAnalyticsEventSchema = z.object({
  eventName: z.enum(ANALYTICS_EVENT_NAMES),
  dedupeKey: z.string().trim().max(160).nullable().optional(),
  sessionId: z.string().uuid().nullable().optional(),
  entityType: z.string().trim().max(80).nullable().optional(),
  entityId: z.string().trim().max(160).nullable().optional(),
  startedAt: z.string().datetime().nullable().optional(),
  endedAt: z.string().datetime().nullable().optional(),
  durationMs: z.number().int().nonnegative().max(24 * 60 * 60 * 1000).nullable().optional(),
  properties: z.record(z.unknown()).nullable().optional(),
}) satisfies z.ZodType<AnalyticsEventRequest>

function parseOptionalDate(value: string | null | undefined): Date | null {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

// Authenticated routes: POST /api/share/:sessionId
const shareRoutes = new Hono()
shareRoutes.use('*', authMiddleware)
shareRoutes.use('*', requireActiveAccount)

shareRoutes.post('/:sessionId', async (c) => {
  const logger = c.get('logger')
  const userId = c.get('userId')
  const sessionId = c.req.param('sessionId')

  const raw = await c.req.json().catch(() => null)
  const parsed = shareBodySchema.safeParse(raw)
  if (!parsed.success) {
    return c.json({ success: false, error: 'upToMessageId (uuid) is required' }, 400)
  }

  const token = await createShareToken(sessionId, userId, parsed.data.upToMessageId, logger)
  if (!token) {
    return c.json({ success: false, error: 'session or message not found' }, 404)
  }

  return c.json({
    success: true,
    data: {
      shareToken: token,
      shareUrl: `/s/${token}`,
    },
  })
})

// Public routes: GET /api/shared/:token (no auth)
const sharedRoutes = new Hono()

sharedRoutes.get('/:token', async (c) => {
  const logger = c.get('logger')
  const token = c.req.param('token')

  const data = await getSharedSession(token, logger)
  if (!data) {
    return c.json({ success: false, error: 'not found' }, 404)
  }

  return c.json({ success: true, data })
})

sharedRoutes.post(
  '/:token/analytics/events',
  rateLimitMiddleware({
    windowMs: 1_000,
    max: 20,
    keyPrefix: 'rl:shared-analytics-events',
    keyExtractor: (c) => `${c.req.param('token')}:${c.req.header('x-forwarded-for') || 'unknown'}`,
  }),
  async (c) => {
    const logger = c.get('logger')
    const token = c.req.param('token')
    const parsed = sharedAnalyticsEventSchema.safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) {
      return c.json({ success: false, error: parsed.error.issues[0]?.message ?? '参数错误' }, 400)
    }

    const body = parsed.data
    if (!body.eventName.startsWith('video_resource_')) {
      return c.json({ success: false, error: 'unsupported shared analytics event' }, 400)
    }

    const db = getDb()
    const [share] = await db.select({
      sessionId: shareTokens.sessionId,
      userId: chatSessions.userId,
    }).from(shareTokens)
      .innerJoin(chatSessions, eq(chatSessions.id, shareTokens.sessionId))
      .where(eq(shareTokens.token, token))
      .limit(1)
    if (!share) {
      return c.json({ success: false, error: 'not found' }, 404)
    }
    if (body.sessionId && body.sessionId !== share.sessionId) {
      return c.json({ success: false, error: 'session mismatch' }, 400)
    }

    const record = await recordAnalyticsEvent({
      userId: share.userId,
      eventName: body.eventName,
      dedupeKey: body.dedupeKey,
      sessionId: share.sessionId,
      entityType: body.entityType,
      entityId: body.entityId,
      startedAt: parseOptionalDate(body.startedAt),
      endedAt: parseOptionalDate(body.endedAt),
      durationMs: body.durationMs,
      properties: {
        ...(body.properties ?? {}),
        source: 'shared_view',
        sharedAnalytics: true,
      },
    }, logger)

    const payload: ApiResponse<AnalyticsEventRecord | null> = { success: true, data: record }
    return c.json(payload)
  },
)

export { shareRoutes, sharedRoutes }
export default shareRoutes
