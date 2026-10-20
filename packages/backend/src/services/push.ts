import { and, desc, eq, gt, inArray } from 'drizzle-orm'
import type { PushPlatform } from '@health-agent/shared'
import { getDb } from '../db/client.js'
import { pushLogs } from '../db/schema/index.js'
import type { Logger } from '../lib/logger.js'
import {
  JPushDisabledError,
  JPushRequestError,
  sendJPushNotification,
  type JPushPlatform,
  type JPushSendResult,
} from './jpush.js'
import { listActivePushDevices } from './push-device.js'

type ActivePushDevice = Awaited<ReturnType<typeof listActivePushDevices>>[number]

interface JPushBatch {
  platforms: JPushPlatform[]
  registrationIds: string[]
  apnsProduction?: boolean
}

export interface PushToUserInput {
  title: string
  alert: string
  route?: string | null
  type: string
  entityType?: string | null
  entityId?: string | null
  dedupeKey?: string | null
  platforms?: PushPlatform[]
  timeToLiveSec?: number
}

export interface PushToUserResult {
  status: 'sent' | 'skipped' | 'failed'
  reason?: string
  logId?: string
  msgId?: string
  sendno?: string
  deviceCount?: number
}

function trimText(value: string | null | undefined, max: number): string | null {
  const trimmed = value?.trim()
  if (!trimmed) return null
  return trimmed.slice(0, max)
}

function normalizeRoute(route: string | null | undefined): string | null {
  const trimmed = trimText(route, 500)
  if (!trimmed) return null
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://') || trimmed.startsWith('//')) return null
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`
}

function toJPushPlatform(platform: PushPlatform): JPushPlatform | null {
  if (platform === 'android') return 'android'
  if (platform === 'ios') return 'ios'
  // 极光服务端 REST API 使用 hmos 表示鸿蒙平台；当前 Android/iOS 推送默认不会命中。
  if (platform === 'harmony') return 'hmos'
  return null
}

function uniquePlatforms(devices: ActivePushDevice[]): JPushPlatform[] {
  return [
    ...new Set(devices.map((d) => toJPushPlatform(d.platform)).filter((p): p is JPushPlatform => p != null)),
  ]
}

function buildJPushBatches(devices: ActivePushDevice[]): JPushBatch[] {
  const batches: JPushBatch[] = []
  const nonIosDevices = devices.filter((device) => device.platform !== 'ios')
  const iosProductionDevices = devices.filter((device) =>
    device.platform === 'ios' && device.apnsEnvironment === 'production'
  )
  const iosDevelopmentDevices = devices.filter((device) =>
    device.platform === 'ios' && device.apnsEnvironment === 'development'
  )
  const iosUnknownDevices = devices.filter((device) =>
    device.platform === 'ios' && !device.apnsEnvironment
  )

  if (nonIosDevices.length > 0) {
    batches.push({
      platforms: uniquePlatforms(nonIosDevices),
      registrationIds: nonIosDevices.map((device) => device.registrationId),
    })
  }
  if (iosProductionDevices.length > 0) {
    batches.push({
      platforms: ['ios'],
      registrationIds: iosProductionDevices.map((device) => device.registrationId),
      apnsProduction: true,
    })
  }
  if (iosDevelopmentDevices.length > 0) {
    batches.push({
      platforms: ['ios'],
      registrationIds: iosDevelopmentDevices.map((device) => device.registrationId),
      apnsProduction: false,
    })
  }
  if (iosUnknownDevices.length > 0) {
    batches.push({
      platforms: ['ios'],
      registrationIds: iosUnknownDevices.map((device) => device.registrationId),
    })
  }

  return batches.filter((batch) => batch.platforms.length > 0 && batch.registrationIds.length > 0)
}

async function recentlySent(userId: string, dedupeKey: string): Promise<boolean> {
  const db = getDb()
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000)
  const rows = await db.select({ id: pushLogs.id }).from(pushLogs).where(and(
    eq(pushLogs.userId, userId),
    eq(pushLogs.dedupeKey, dedupeKey),
    inArray(pushLogs.status, ['pending', 'sent']),
    gt(pushLogs.createdAt, since),
  )).orderBy(desc(pushLogs.createdAt)).limit(1)
  return rows.length > 0
}

export async function pushToUser(
  userId: string,
  input: PushToUserInput,
  logger: Logger,
): Promise<PushToUserResult> {
  const db = getDb()
  const dedupeKey = trimText(input.dedupeKey, 160)
  if (dedupeKey && await recentlySent(userId, dedupeKey)) {
    logger.info({ dedupeKey }, 'push skipped by dedupe')
    return { status: 'skipped', reason: 'dedupe' }
  }

  const platforms: PushPlatform[] = input.platforms?.length ? input.platforms : ['android', 'ios']
  const devices = await listActivePushDevices(userId, { platforms, provider: 'jpush' })
  if (devices.length === 0) {
    logger.info({ userId, platforms }, 'push skipped: no active devices')
    return { status: 'skipped', reason: 'no_active_device', deviceCount: 0 }
  }

  const batches = buildJPushBatches(devices)
  if (batches.length === 0) {
    logger.info({ userId, platforms }, 'push skipped: no supported jpush platform')
    return { status: 'skipped', reason: 'unsupported_platform', deviceCount: devices.length }
  }

  const route = normalizeRoute(input.route)
  const extras = {
    route: route ?? '',
    type: input.type,
    entityType: input.entityType ?? '',
    entityId: input.entityId ?? '',
    dedupeKey: dedupeKey ?? '',
    sentAt: new Date().toISOString(),
  }

  const platformSet = new Set(devices.map((d) => d.platform))
  const logPlatform = platformSet.size === 1
    ? [...platformSet][0]
    : 'all'

  const [log] = await db.insert(pushLogs).values({
    userId,
    platform: logPlatform,
    provider: 'jpush',
    audienceType: 'registration_id',
    audienceValue: `${devices.length} device(s)`,
    title: input.title.slice(0, 120),
    alert: input.alert.slice(0, 500),
    route,
    dedupeKey,
    status: 'pending',
    payload: {
      extras,
      platforms,
      registrationIdCount: devices.length,
      batches: batches.map((batch) => ({
        platforms: batch.platforms,
        registrationIdCount: batch.registrationIds.length,
        apnsProduction: batch.apnsProduction ?? null,
      })),
    },
  }).returning()

  try {
    const results: Array<JPushSendResult & { batch: JPushBatch }> = []
    for (const batch of batches) {
      const result = await sendJPushNotification({
        platforms: batch.platforms,
        registrationIds: batch.registrationIds,
        title: input.title,
        alert: input.alert,
        extras,
        timeToLiveSec: input.timeToLiveSec,
        apnsProduction: batch.apnsProduction,
      }, logger)
      results.push({ ...result, batch })
    }

    const firstResult = results[0]
    const providerResponse = {
      batches: results.map((result) => ({
        platforms: result.batch.platforms,
        registrationIdCount: result.batch.registrationIds.length,
        apnsProduction: result.batch.apnsProduction ?? null,
        sendno: result.sendno,
        msgId: result.msgId,
        raw: result.raw,
      })),
    }

    await db.update(pushLogs).set({
      status: 'sent',
      providerMsgId: firstResult?.msgId ?? null,
      providerSendno: firstResult?.sendno ?? null,
      providerResponse,
      updatedAt: new Date(),
    }).where(eq(pushLogs.id, log.id))

    return {
      status: 'sent',
      logId: log.id,
      msgId: firstResult?.msgId,
      sendno: firstResult?.sendno,
      deviceCount: devices.length,
    }
  } catch (err: any) {
    const status = err instanceof JPushDisabledError ? 'skipped' : 'failed'
    const errorCode = err instanceof JPushRequestError
      ? `HTTP_${err.status}`
      : err?.name ?? 'PUSH_ERROR'
    const errorMessage = err?.message ?? String(err)

    await db.update(pushLogs).set({
      status,
      errorCode,
      errorMessage: errorMessage.slice(0, 1000),
      providerResponse: err instanceof JPushRequestError && err.body && typeof err.body === 'object'
        ? err.body as Record<string, unknown>
        : null,
      updatedAt: new Date(),
    }).where(eq(pushLogs.id, log.id))

    logger.warn({ err: errorMessage, status }, 'push send failed')
    return { status, reason: errorCode, logId: log.id, deviceCount: devices.length }
  }
}
