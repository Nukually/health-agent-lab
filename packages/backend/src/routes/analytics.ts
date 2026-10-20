import { Hono } from 'hono'
import { z } from 'zod'
import {
  ANALYTICS_EVENT_NAMES,
  NATIVE_ANALYTICS_EVENT_NAMES,
  type AnalyticsEventRequest,
  type AnalyticsEventRecord,
  type ApiResponse,
  type NativeAnalyticsEventRecord,
  type NativeAnalyticsEventsRequest,
} from '@health-agent/shared'
import { authMiddleware } from '../middleware/auth.js'
import { requireActiveAccount } from '../middleware/active-account.js'
import { rateLimitMiddleware } from '../middleware/rate-limit.js'
import { getSession } from '../services/session.js'
import { recordAnalyticsEvent } from '../services/analytics.js'
import { recordNativeAnalyticsEvents } from '../services/native-analytics.js'
import { verifyToken } from '../services/auth.js'

const analyticsRoutes = new Hono()

const analyticsEventSchema = z.object({
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

const nativeGeoSchema = z.object({
  source: z.enum(['device_coarse', 'unknown']).nullable().optional(),
  country: z.string().trim().max(80).nullable().optional(),
  province: z.string().trim().max(120).nullable().optional(),
  city: z.string().trim().max(120).nullable().optional(),
  precision: z.enum(['country', 'province', 'city', 'unknown']).nullable().optional(),
  resolvedAt: z.string().datetime().nullable().optional(),
})

const nativeAnalyticsEventSchema = z.object({
  eventName: z.enum(NATIVE_ANALYTICS_EVENT_NAMES),
  dedupeKey: z.string().trim().max(180).nullable().optional(),
  entityType: z.string().trim().max(80).nullable().optional(),
  entityId: z.string().trim().max(160).nullable().optional(),
  startedAt: z.string().datetime().nullable().optional(),
  endedAt: z.string().datetime().nullable().optional(),
  durationMs: z.number().int().nonnegative().max(24 * 60 * 60 * 1000).nullable().optional(),
  properties: z.record(z.unknown()).nullable().optional(),
  geo: nativeGeoSchema.nullable().optional(),
})

const nativeAnalyticsEventsSchema = z.object({
  installId: z.string().trim().min(8).max(120),
  app: z.object({
    platform: z.enum(['android', 'ios', 'harmony']),
    appSessionId: z.string().trim().max(120).nullable().optional(),
    appVersion: z.string().trim().max(80).nullable().optional(),
    versionCode: z.union([z.string().trim().max(80), z.number()]).nullable().optional(),
    buildNumber: z.union([z.string().trim().max(80), z.number()]).nullable().optional(),
    channel: z.string().trim().max(80).nullable().optional(),
  }),
  device: z.object({
    osVersion: z.string().trim().max(80).nullable().optional(),
    sdkInt: z.number().int().nonnegative().max(10_000).nullable().optional(),
    manufacturer: z.string().trim().max(120).nullable().optional(),
    model: z.string().trim().max(120).nullable().optional(),
    webViewVersion: z.string().trim().max(160).nullable().optional(),
    bridgeVersion: z.string().trim().max(40).nullable().optional(),
    bridgeModules: z.array(z.string().trim().max(40)).max(30).nullable().optional(),
  }).nullable().optional(),
  events: z.array(nativeAnalyticsEventSchema).min(1).max(20),
}) satisfies z.ZodType<NativeAnalyticsEventsRequest>

function parseOptionalDate(value: string | null | undefined): Date | null {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function optionalUserIdFromAuthHeader(authHeader: string | undefined): string | null {
  if (!authHeader?.startsWith('Bearer ')) return null
  try {
    return verifyToken(authHeader.slice(7)).userId
  } catch {
    return null
  }
}

analyticsRoutes.post(
  '/native-events',
  rateLimitMiddleware({
    windowMs: 1_000,
    max: 10,
    keyPrefix: 'rl:native-analytics-events',
    keyExtractor: (c) => {
      const bodyInstallId = c.req.header('x-install-id')
      return bodyInstallId || c.req.header('x-forwarded-for') || 'unknown'
    },
  }),
  async (c) => {
    const logger = c.get('logger')
    const parsed = nativeAnalyticsEventsSchema.safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) {
      return c.json({ success: false, error: parsed.error.issues[0]?.message ?? '参数错误' }, 400)
    }

    const userId = optionalUserIdFromAuthHeader(c.req.header('Authorization'))
    const records = await recordNativeAnalyticsEvents({
      ...parsed.data,
      userId,
    }, logger)
    const payload: ApiResponse<NativeAnalyticsEventRecord[]> = { success: true, data: records }
    return c.json(payload)
  },
)

analyticsRoutes.use('*', authMiddleware)
analyticsRoutes.use('*', requireActiveAccount)

analyticsRoutes.post(
  '/events',
  rateLimitMiddleware({
    windowMs: 1_000,
    max: 20,
    keyPrefix: 'rl:analytics-events',
    keyExtractor: (c) => c.get('userId'),
  }),
  async (c) => {
    const logger = c.get('logger')
    const userId = c.get('userId')
    const parsed = analyticsEventSchema.safeParse(await c.req.json().catch(() => ({})))

    if (!parsed.success) {
      return c.json({ success: false, error: parsed.error.issues[0]?.message ?? '参数错误' }, 400)
    }

    const body = parsed.data
    if (body.sessionId) {
      const session = await getSession(body.sessionId, logger)
      if (!session || session.userId !== userId) {
        return c.json({ success: false, error: '会话不存在' }, 404)
      }
    }

    const record = await recordAnalyticsEvent({
      userId,
      eventName: body.eventName,
      dedupeKey: body.dedupeKey,
      sessionId: body.sessionId,
      entityType: body.entityType,
      entityId: body.entityId,
      startedAt: parseOptionalDate(body.startedAt),
      endedAt: parseOptionalDate(body.endedAt),
      durationMs: body.durationMs,
      properties: body.properties,
    }, logger)

    const payload: ApiResponse<AnalyticsEventRecord | null> = { success: true, data: record }
    return c.json(payload)
  },
)

export default analyticsRoutes
