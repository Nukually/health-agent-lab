import { Hono } from 'hono'
import { z } from 'zod'
import { and, desc, eq, or } from 'drizzle-orm'
import type { ApiResponse, PushDeviceListResponse, PushDeviceRecord } from '@health-agent/shared'
import { authMiddleware } from '../middleware/auth.js'
import { requireActiveAccount } from '../middleware/active-account.js'
import { rateLimitMiddleware } from '../middleware/rate-limit.js'
import { getEnv } from '../env.js'
import { getDb } from '../db/client.js'
import { chatSessions, messages, pushDevices, pushLogs, shareTokens } from '../db/schema/index.js'
import {
  bindPushDevice,
  listPushDevicesForUser,
  unbindPushDevice,
  updatePushPreferences,
} from '../services/push-device.js'
import { pushToUser } from '../services/push.js'
import { queryJPushMessageStatus, queryJPushReceivedReport, type JPushReportResult } from '../services/jpush.js'

const pushRoutes = new Hono()

pushRoutes.use('*', authMiddleware)
pushRoutes.use('*', requireActiveAccount)

const platformSchema = z.enum(['android', 'ios', 'harmony'])
const providerSchema = z.enum(['jpush', 'apns', 'fcm', 'hms'])
const permissionSchema = z.enum(['granted', 'denied', 'unknown'])
const apnsEnvironmentSchema = z.enum(['development', 'production'])

const bindDeviceSchema = z.object({
  platform: platformSchema,
  provider: providerSchema.optional().default('jpush'),
  registrationId: z.string().trim().min(8).max(512),
  deviceId: z.string().trim().max(256).nullable().optional(),
  appVersion: z.string().trim().max(64).nullable().optional(),
  apnsEnvironment: apnsEnvironmentSchema.nullable().optional(),
  apnsTokenRegistered: z.boolean().nullable().optional(),
  apnsTokenRegisteredAt: z.string().trim().max(80).nullable().optional(),
  apnsRegistrationError: z.string().trim().max(500).nullable().optional(),
  pushEnabled: z.boolean().optional().default(true),
  notificationPermission: permissionSchema.optional().default('unknown'),
})

const unbindDeviceSchema = z.object({
  platform: platformSchema,
  provider: providerSchema.optional().default('jpush'),
  registrationId: z.string().trim().min(8).max(512),
})

const preferenceSchema = z.object({
  pushEnabled: z.boolean(),
  platform: platformSchema.optional(),
  provider: providerSchema.optional(),
  registrationId: z.string().trim().min(8).max(512).optional(),
})

const testSendSchema = z.object({
  title: z.string().trim().min(1).max(120).default('Health Agent Lab'),
  alert: z.string().trim().min(1).max(500).default('你有一条新的健康消息'),
  route: z.string().trim().max(500).optional(),
  type: z.string().trim().min(1).max(80).default('test'),
  entityType: z.string().trim().max(80).optional(),
  entityId: z.string().trim().max(160).optional(),
  dedupeKey: z.string().trim().max(160).optional(),
  platforms: z.array(platformSchema).min(1).max(3).optional(),
})

const diagnosticQuerySchema = z.object({
  shareToken: z.string().uuid().optional(),
  pushLogId: z.string().uuid().optional(),
}).refine((value) => value.shareToken || value.pushLogId, {
  message: 'shareToken 或 pushLogId 至少提供一个',
})

function isProdDeploy() {
  const env = getEnv()
  return env.DEPLOY_ENV === 'prod'
}

function maskRegistrationId(registrationId: string) {
  const trimmed = registrationId.trim()
  if (trimmed.length <= 12) return `${trimmed.slice(0, 4)}...`
  return `${trimmed.slice(0, 8)}...${trimmed.slice(-4)}`
}

function compactContent(content: string | null, max = 160) {
  const trimmed = content?.trim()
  if (!trimmed) return ''
  return trimmed.length > max ? `${trimmed.slice(0, max)}...` : trimmed
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}

function extractProviderMsgIds(log: typeof pushLogs.$inferSelect): string[] {
  const ids: string[] = []
  if (log.providerMsgId) ids.push(log.providerMsgId)

  const response = log.providerResponse
  if (isRecord(response)) {
    for (const key of ['msg_id', 'msgId']) {
      const value = response[key]
      if (typeof value === 'string' || typeof value === 'number') ids.push(String(value))
    }

    if (Array.isArray(response.batches)) {
      for (const batch of response.batches) {
        if (!isRecord(batch)) continue
        for (const key of ['msg_id', 'msgId']) {
          const value = batch[key]
          if (typeof value === 'string' || typeof value === 'number') ids.push(String(value))
        }
        if (!isRecord(batch.raw)) continue
        for (const key of ['msg_id', 'msgId']) {
          const value = batch.raw[key]
          if (typeof value === 'string' || typeof value === 'number') ids.push(String(value))
        }
      }
    }
  }

  return uniqueStrings(ids)
}

function isLikelyRegistrationId(value: string) {
  return value.length >= 16 && !value.includes('_') && /^[A-Za-z0-9-]+$/.test(value)
}

function sanitizeJPushReportBody(body: unknown): unknown {
  if (Array.isArray(body)) return body.map(sanitizeJPushReportBody)
  if (!isRecord(body)) return body

  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(body)) {
    const safeKey = isLikelyRegistrationId(key) ? maskRegistrationId(key) : key
    out[safeKey] = sanitizeJPushReportBody(value)
  }
  return out
}

function sanitizeJPushReport(result: JPushReportResult | null): JPushReportResult | null {
  if (!result) return null
  return { ...result, body: sanitizeJPushReportBody(result.body) }
}

pushRoutes.post(
  '/devices/bind',
  rateLimitMiddleware({
    windowMs: 1_000,
    max: 5,
    keyPrefix: 'rl:push-bind',
    keyExtractor: (c) => c.get('userId'),
  }),
  async (c) => {
    const logger = c.get('logger')
    const userId = c.get('userId')
    const parsed = bindDeviceSchema.safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) {
      return c.json({ success: false, error: parsed.error.issues[0]?.message ?? '参数错误' }, 400)
    }

    const record = await bindPushDevice({ userId, ...parsed.data }, logger)
    const payload: ApiResponse<PushDeviceRecord> = { success: true, data: record }
    return c.json(payload)
  },
)

pushRoutes.post('/devices/unbind', async (c) => {
  const logger = c.get('logger')
  const userId = c.get('userId')
  const parsed = unbindDeviceSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) {
    return c.json({ success: false, error: parsed.error.issues[0]?.message ?? '参数错误' }, 400)
  }

  const ok = await unbindPushDevice({ userId, ...parsed.data }, logger)
  return c.json({ success: true, data: { unbound: ok } })
})

pushRoutes.get('/devices/me', async (c) => {
  const userId = c.get('userId')
  const devices = await listPushDevicesForUser(userId)
  const payload: ApiResponse<PushDeviceListResponse> = { success: true, data: { items: devices } }
  return c.json(payload)
})

pushRoutes.post('/preferences', async (c) => {
  const logger = c.get('logger')
  const userId = c.get('userId')
  const parsed = preferenceSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) {
    return c.json({ success: false, error: parsed.error.issues[0]?.message ?? '参数错误' }, 400)
  }

  const count = await updatePushPreferences(userId, parsed.data, logger)
  return c.json({ success: true, data: { updated: count } })
})

// Dev-only 诊断：把分享 token / push log 映射到真实会话、设备绑定和 JPush batch 参数。
pushRoutes.get('/diagnostics', async (c) => {
  if (isProdDeploy()) {
    return c.json({ success: false, error: 'push diagnostics disabled in production' }, 403)
  }

  const userId = c.get('userId')
  const parsed = diagnosticQuerySchema.safeParse({
    shareToken: c.req.query('shareToken'),
    pushLogId: c.req.query('pushLogId'),
  })
  if (!parsed.success) {
    return c.json({ success: false, error: parsed.error.issues[0]?.message ?? '参数错误' }, 400)
  }

  const db = getDb()
  let resolvedUserId: string | null = null
  let sessionDetail: Record<string, unknown> | null = null
  let messageDetail: Record<string, unknown> | null = null
  let route: string | null = null

  if (parsed.data.shareToken) {
    const [share] = await db.select({
      sessionId: shareTokens.sessionId,
      upToMessageId: shareTokens.upToMessageId,
      sessionUserId: chatSessions.userId,
      sessionTitle: chatSessions.title,
      sessionCreatedAt: chatSessions.createdAt,
      messageRole: messages.role,
      messageContent: messages.content,
      messageCreatedAt: messages.createdAt,
    }).from(shareTokens)
      .innerJoin(chatSessions, eq(chatSessions.id, shareTokens.sessionId))
      .innerJoin(messages, eq(messages.id, shareTokens.upToMessageId))
      .where(eq(shareTokens.token, parsed.data.shareToken))
      .limit(1)

    if (!share || share.sessionUserId !== userId) {
      return c.json({ success: false, error: 'not found' }, 404)
    }

    resolvedUserId = share.sessionUserId
    route = `/chat/${share.sessionId}?focusMessageId=${share.upToMessageId}`
    sessionDetail = {
      id: share.sessionId,
      title: share.sessionTitle,
      createdAt: share.sessionCreatedAt.toISOString(),
    }
    messageDetail = {
      id: share.upToMessageId,
      role: share.messageRole,
      contentPreview: compactContent(share.messageContent),
      createdAt: share.messageCreatedAt.toISOString(),
    }
  }

  let requestedLogId = parsed.data.pushLogId ?? null
  if (requestedLogId) {
    const [log] = await db.select({
      id: pushLogs.id,
      userId: pushLogs.userId,
      route: pushLogs.route,
    }).from(pushLogs).where(eq(pushLogs.id, requestedLogId)).limit(1)

    if (!log || log.userId !== userId) {
      return c.json({ success: false, error: 'not found' }, 404)
    }
    resolvedUserId = log.userId
    route = route ?? log.route
  }

  if (!resolvedUserId) {
    return c.json({ success: false, error: 'not found' }, 404)
  }

  const devices = await db.select({
    id: pushDevices.id,
    platform: pushDevices.platform,
    provider: pushDevices.provider,
    pushEnabled: pushDevices.pushEnabled,
    notificationPermission: pushDevices.notificationPermission,
    apnsEnvironment: pushDevices.apnsEnvironment,
    appVersion: pushDevices.appVersion,
    registrationId: pushDevices.registrationId,
    lastSeenAt: pushDevices.lastSeenAt,
    unboundAt: pushDevices.unboundAt,
    updatedAt: pushDevices.updatedAt,
  }).from(pushDevices)
    .where(eq(pushDevices.userId, resolvedUserId))
    .orderBy(desc(pushDevices.updatedAt))
    .limit(20)

  const logConditions = [eq(pushLogs.userId, resolvedUserId)]
  const focusedConditions = [
    requestedLogId ? eq(pushLogs.id, requestedLogId) : null,
    route ? eq(pushLogs.route, route) : null,
  ].filter((condition): condition is NonNullable<typeof condition> => condition != null)
  if (focusedConditions.length > 0) {
    logConditions.push(or(...focusedConditions)!)
  }

  const focusedLogs = focusedConditions.length > 0
    ? await db.select().from(pushLogs)
      .where(and(...logConditions))
      .orderBy(desc(pushLogs.createdAt))
      .limit(10)
    : []

  const recentLogs = await db.select().from(pushLogs)
    .where(eq(pushLogs.userId, resolvedUserId))
    .orderBy(desc(pushLogs.createdAt))
    .limit(10)

  const serializeLog = (log: typeof pushLogs.$inferSelect) => ({
    id: log.id,
    status: log.status,
    errorCode: log.errorCode,
    errorMessage: log.errorMessage,
    providerMsgId: log.providerMsgId,
    providerSendno: log.providerSendno,
    platform: log.platform,
    route: log.route,
    dedupeKey: log.dedupeKey,
    payload: log.payload,
    providerResponse: log.providerResponse,
    createdAt: log.createdAt.toISOString(),
    updatedAt: log.updatedAt.toISOString(),
  })

  const reportMsgIds = uniqueStrings(focusedLogs.flatMap(extractProviderMsgIds))
  const activeJPushDevices = devices
    .filter((device) =>
      device.provider === 'jpush' &&
      device.pushEnabled &&
      device.notificationPermission !== 'denied' &&
      !device.unboundAt
    )
  const activeRegistrationIds = activeJPushDevices.map((device) => device.registrationId)
  const report = reportMsgIds.length > 0
    ? {
      received: sanitizeJPushReport(await queryJPushReceivedReport(reportMsgIds).catch((err: any) => ({
        ok: false,
        status: 0,
        endpoint: 'jpush-report:/received',
        body: { error: err?.message ?? String(err) },
      }))),
      messageStatuses: await Promise.all(reportMsgIds.slice(0, 10).map(async (msgId) => ({
        msgId,
        report: sanitizeJPushReport(await queryJPushMessageStatus(msgId, activeRegistrationIds).catch((err: any) => ({
          ok: false,
          status: 0,
          endpoint: 'jpush-report:/status/message',
          body: { error: err?.message ?? String(err) },
        }))),
      }))),
    }
    : null

  return c.json({
    success: true,
    data: {
      input: parsed.data,
      session: sessionDetail,
      message: messageDetail,
      route,
      devices: devices.map((device) => ({
        ...device,
        registrationId: maskRegistrationId(device.registrationId),
        activeForJPush: activeJPushDevices.some((active) => active.id === device.id),
        lastSeenAt: device.lastSeenAt.toISOString(),
        unboundAt: device.unboundAt?.toISOString() ?? null,
        updatedAt: device.updatedAt.toISOString(),
      })),
      focusedLogs: focusedLogs.map(serializeLog),
      recentLogs: recentLogs.map(serializeLog),
      jpushReport: report,
    },
  })
})

// 手动联调用：非 production/prod 环境可由登录用户给自己发测试推送。
pushRoutes.post('/test/send', async (c) => {
  if (isProdDeploy()) {
    return c.json({ success: false, error: 'test push disabled in production' }, 403)
  }

  const logger = c.get('logger')
  const userId = c.get('userId')
  const parsed = testSendSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) {
    return c.json({ success: false, error: parsed.error.issues[0]?.message ?? '参数错误' }, 400)
  }

  const result = await pushToUser(userId, parsed.data, logger)
  return c.json({ success: true, data: result })
})

export default pushRoutes
