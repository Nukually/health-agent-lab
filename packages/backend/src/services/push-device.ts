import { and, desc, eq, inArray, isNull, ne } from 'drizzle-orm'
import { getDb } from '../db/client.js'
import { pushDevices } from '../db/schema/index.js'
import type {
  ApnsEnvironment,
  NotificationPermissionStatus,
  PushDeviceRecord,
  PushPlatform,
  PushProvider,
} from '@health-agent/shared'
import type { Logger } from '../lib/logger.js'

export interface BindPushDeviceInput {
  userId: string
  platform: PushPlatform
  provider?: PushProvider
  registrationId: string
  deviceId?: string | null
  appVersion?: string | null
  apnsEnvironment?: ApnsEnvironment | null
  apnsTokenRegistered?: boolean | null
  apnsTokenRegisteredAt?: string | null
  apnsRegistrationError?: string | null
  pushEnabled?: boolean
  notificationPermission?: NotificationPermissionStatus
}

export interface UnbindPushDeviceInput {
  userId: string
  platform: PushPlatform
  provider?: PushProvider
  registrationId: string
}

function serialize(row: typeof pushDevices.$inferSelect): PushDeviceRecord {
  return {
    id: row.id,
    userId: row.userId,
    platform: row.platform,
    provider: row.provider,
    registrationId: row.registrationId,
    deviceId: row.deviceId ?? null,
    appVersion: row.appVersion ?? null,
    apnsEnvironment: row.apnsEnvironment ?? null,
    pushEnabled: row.pushEnabled,
    notificationPermission: row.notificationPermission,
    lastSeenAt: row.lastSeenAt.toISOString(),
    unboundAt: row.unboundAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

function normalizeText(value: string | null | undefined, max: number): string | null {
  const trimmed = value?.trim()
  if (!trimmed) return null
  return trimmed.slice(0, max)
}

export async function bindPushDevice(
  input: BindPushDeviceInput,
  logger: Logger,
): Promise<PushDeviceRecord> {
  const db = getDb()
  const now = new Date()
  const provider = input.provider ?? 'jpush'
  const registrationId = input.registrationId.trim()
  const deviceId = normalizeText(input.deviceId, 256)

  const [row] = await db.insert(pushDevices).values({
    userId: input.userId,
    platform: input.platform,
    provider,
    registrationId,
    deviceId,
    appVersion: normalizeText(input.appVersion, 64),
    apnsEnvironment: input.platform === 'ios' ? (input.apnsEnvironment ?? null) : null,
    pushEnabled: input.pushEnabled ?? true,
    notificationPermission: input.notificationPermission ?? 'unknown',
    lastSeenAt: now,
    unboundAt: null,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: [pushDevices.provider, pushDevices.platform, pushDevices.registrationId],
    set: {
      userId: input.userId,
      deviceId,
      appVersion: normalizeText(input.appVersion, 64),
      apnsEnvironment: input.platform === 'ios' ? (input.apnsEnvironment ?? null) : null,
      pushEnabled: input.pushEnabled ?? true,
      notificationPermission: input.notificationPermission ?? 'unknown',
      lastSeenAt: now,
      unboundAt: null,
      updatedAt: now,
    },
  }).returning()

  let unboundStaleCount = 0
  if (deviceId) {
    const staleRows = await db.update(pushDevices).set({
      pushEnabled: false,
      unboundAt: now,
      updatedAt: now,
    }).where(and(
      eq(pushDevices.userId, input.userId),
      eq(pushDevices.platform, input.platform),
      eq(pushDevices.provider, provider),
      eq(pushDevices.deviceId, deviceId),
      ne(pushDevices.registrationId, registrationId),
      isNull(pushDevices.unboundAt),
    )).returning({ id: pushDevices.id })
    unboundStaleCount = staleRows.length
  }

  logger.info({
    platform: input.platform,
    provider,
    pushDeviceId: row.id,
    apnsTokenRegistered: input.apnsTokenRegistered ?? null,
    unboundStaleCount,
  }, 'push device bound')
  return serialize(row)
}

export async function unbindPushDevice(
  input: UnbindPushDeviceInput,
  logger: Logger,
): Promise<boolean> {
  const db = getDb()
  const now = new Date()
  const provider = input.provider ?? 'jpush'

  const rows = await db.update(pushDevices).set({
    pushEnabled: false,
    unboundAt: now,
    updatedAt: now,
  }).where(and(
    eq(pushDevices.userId, input.userId),
    eq(pushDevices.platform, input.platform),
    eq(pushDevices.provider, provider),
    eq(pushDevices.registrationId, input.registrationId.trim()),
  )).returning({ id: pushDevices.id })

  logger.info({ platform: input.platform, provider, count: rows.length }, 'push device unbound')
  return rows.length > 0
}

export async function listPushDevicesForUser(userId: string): Promise<PushDeviceRecord[]> {
  const db = getDb()
  const rows = await db.select().from(pushDevices)
    .where(eq(pushDevices.userId, userId))
    .orderBy(desc(pushDevices.updatedAt))
  return rows.map(serialize)
}

export async function listActivePushDevices(
  userId: string,
  options?: {
    platforms?: PushPlatform[]
    provider?: PushProvider
  },
): Promise<Array<typeof pushDevices.$inferSelect>> {
  const db = getDb()
  const provider = options?.provider ?? 'jpush'
  const conditions = [
    eq(pushDevices.userId, userId),
    eq(pushDevices.provider, provider),
    eq(pushDevices.pushEnabled, true),
    ne(pushDevices.notificationPermission, 'denied'),
    isNull(pushDevices.unboundAt),
  ]

  if (options?.platforms?.length) {
    conditions.push(inArray(pushDevices.platform, options.platforms))
  }

  return db.select().from(pushDevices).where(and(...conditions))
}

export async function updatePushPreferences(
  userId: string,
  input: {
    pushEnabled: boolean
    platform?: PushPlatform
    provider?: PushProvider
    registrationId?: string
  },
  logger: Logger,
): Promise<number> {
  const db = getDb()
  const now = new Date()
  const conditions = [eq(pushDevices.userId, userId)]
  if (input.platform) conditions.push(eq(pushDevices.platform, input.platform))
  if (input.provider) conditions.push(eq(pushDevices.provider, input.provider))
  if (input.registrationId) conditions.push(eq(pushDevices.registrationId, input.registrationId.trim()))

  const rows = await db.update(pushDevices).set({
    pushEnabled: input.pushEnabled,
    updatedAt: now,
    ...(input.pushEnabled ? { unboundAt: null } : {}),
  }).where(and(...conditions)).returning({ id: pushDevices.id })

  logger.info({ count: rows.length, pushEnabled: input.pushEnabled }, 'push preferences updated')
  return rows.length
}
