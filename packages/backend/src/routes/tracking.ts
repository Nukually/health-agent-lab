import { Hono } from 'hono'
import { z } from 'zod'
import {
  TRACKING_EVENT_PLATFORMS,
  TRACKING_EVENT_SOURCES,
  type ApiResponse,
  type TrackingEventRawRecord,
  type TrackingEventsRequestV2,
} from '@health-agent/shared'
import { rateLimitMiddleware } from '../middleware/rate-limit.js'
import { verifyToken } from '../services/auth.js'
import { recordTrackingEvents, trackingRequestContextFromHeaders } from '../services/tracking.js'

const trackingRoutes = new Hono()

const trackingEventSchema = z.object({
  eventId: z.string().trim().min(8).max(120),
  eventName: z.string().trim().min(1).max(120),
  eventVersion: z.string().trim().min(1).max(40),
  eventTime: z.string().datetime(),
  source: z.enum(TRACKING_EVENT_SOURCES),
  platform: z.enum(TRACKING_EVENT_PLATFORMS).nullable().optional(),
  installId: z.string().trim().max(120).nullable().optional(),
  userId: z.string().uuid().nullable().optional(),
  appSessionId: z.string().trim().max(120).nullable().optional(),
  webSessionId: z.string().trim().max(120).nullable().optional(),
  traceId: z.string().trim().max(120).nullable().optional(),
  requestId: z.string().trim().max(120).nullable().optional(),
  chatSessionId: z.string().uuid().nullable().optional(),
  entityType: z.string().trim().max(80).nullable().optional(),
  entityId: z.string().trim().max(160).nullable().optional(),
  route: z.string().trim().max(240).nullable().optional(),
  appVersion: z.string().trim().max(80).nullable().optional(),
  buildNumber: z.union([z.string().trim().max(80), z.number()]).nullable().optional(),
  channel: z.string().trim().max(80).nullable().optional(),
  properties: z.record(z.unknown()).nullable().optional(),
})

const trackingEventsSchema = z.object({
  events: z.array(trackingEventSchema).min(1).max(20),
}) satisfies z.ZodType<TrackingEventsRequestV2>

function optionalUserIdFromAuthHeader(authHeader: string | undefined): string | null {
  if (!authHeader?.startsWith('Bearer ')) return null
  try {
    return verifyToken(authHeader.slice(7)).userId
  } catch {
    return null
  }
}

trackingRoutes.post(
  '/events',
  rateLimitMiddleware({
    windowMs: 1_000,
    max: 20,
    keyPrefix: 'rl:tracking-events',
    keyExtractor: (c) => c.req.header('x-install-id') || c.req.header('x-forwarded-for') || 'unknown',
  }),
  async (c) => {
    const logger = c.get('logger')
    const parsed = trackingEventsSchema.safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) {
      return c.json({ success: false, error: parsed.error.issues[0]?.message ?? '参数错误' }, 400)
    }

    const requestId = c.get('requestId')
    const requestContext = trackingRequestContextFromHeaders((name) => c.req.header(name), requestId)
    const userId = optionalUserIdFromAuthHeader(c.req.header('Authorization'))
    const records = await recordTrackingEvents({
      events: parsed.data.events.map((event) => ({
        ...event,
        installId: event.installId ?? requestContext.installId,
        appSessionId: event.appSessionId ?? requestContext.appSessionId,
        webSessionId: event.webSessionId ?? requestContext.webSessionId,
        traceId: event.traceId ?? requestContext.traceId,
        requestId: event.requestId ?? requestContext.requestId ?? requestId,
      })),
      userId,
    }, logger)
    const payload: ApiResponse<TrackingEventRawRecord[]> = { success: true, data: records }
    return c.json(payload)
  },
)

export default trackingRoutes
