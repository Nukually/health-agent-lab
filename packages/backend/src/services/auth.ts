import jwt from 'jsonwebtoken'
import { createHash, randomBytes } from 'node:crypto'
import { and, eq, gt, isNull } from 'drizzle-orm'
import { getDb } from '../db/client.js'
import { refreshSessions, users } from '../db/schema/index.js'
import { getEnv } from '../env.js'
import type { Logger } from '../lib/logger.js'
import { safeRecordAnalyticsEvent } from './analytics.js'
import type { ResolvedChannelAttribution } from './channel.js'
import { safeTrackBackendEvent, type TrackingRequestContext } from './tracking.js'

export interface LoginDeviceInfo {
  deviceName: string
  userAgent: string | null
}

const ACCESS_TOKEN_EXPIRY = '15m'
const REFRESH_SESSION_DAYS = 30
export const REFRESH_SESSION_TTL_SECONDS = REFRESH_SESSION_DAYS * 24 * 60 * 60
export const REFRESH_TOKEN_COOKIE_NAME = 'cx_refresh'

export interface JwtPayload {
  userId: string
  phone: string
}

export function signToken(payload: JwtPayload): string {
  const env = getEnv()
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRY })
}

export function verifyToken(token: string): JwtPayload {
  const env = getEnv()
  return jwt.verify(token, env.JWT_SECRET) as JwtPayload
}

export interface AuthUser {
  id: string
  phone: string
  nickname: string | null
  avatarUrl: string | null
  birthday: string | null
  gender: string | null
  currentConcern: import('@health-agent/shared').CurrentConcern | null
  channelPartnerId?: string | null
  channelAgentId?: string | null
  channelQrCodeId?: string | null
  channelAttributedAt?: Date | null
}

export interface RefreshSessionMeta {
  deviceName?: string | null
  userAgent?: string | null
}

export interface IssuedRefreshSession {
  token: string
  expiresAt: Date
}

function toAuthUser(user: typeof users.$inferSelect): AuthUser {
  return {
    id: user.id,
    phone: user.phone,
    nickname: user.nickname,
    avatarUrl: user.avatarUrl,
    birthday: user.birthday,
    gender: user.gender,
    currentConcern: user.currentConcern,
    channelPartnerId: user.channelPartnerId,
    channelAgentId: user.channelAgentId,
    channelQrCodeId: user.channelQrCodeId,
    channelAttributedAt: user.channelAttributedAt,
  }
}

function refreshExpiresAt(now = new Date()): Date {
  return new Date(now.getTime() + REFRESH_SESSION_TTL_SECONDS * 1000)
}

function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function newRefreshToken(): string {
  return randomBytes(32).toString('base64url')
}

function trimMeta(meta?: RefreshSessionMeta) {
  return {
    deviceName: meta?.deviceName ? meta.deviceName.slice(0, 100) : null,
    userAgent: meta?.userAgent ? meta.userAgent.slice(0, 500) : null,
  }
}

export async function createRefreshSession(
  userId: string,
  logger: Logger,
  meta?: RefreshSessionMeta,
): Promise<IssuedRefreshSession> {
  const db = getDb()
  const token = newRefreshToken()
  const expiresAt = refreshExpiresAt()
  const sessionMeta = trimMeta(meta)

  await db.insert(refreshSessions).values({
    userId,
    tokenHash: hashRefreshToken(token),
    deviceName: sessionMeta.deviceName,
    userAgent: sessionMeta.userAgent,
    expiresAt,
  })

  logger.info({ userId, expiresAt: expiresAt.toISOString() }, 'refresh session created')
  return { token, expiresAt }
}

export async function refreshAccessSession(
  token: string,
  logger: Logger,
  meta?: RefreshSessionMeta,
): Promise<{
  accessToken: string
  refreshToken: string
  refreshExpiresAt: Date
  user: AuthUser
} | null> {
  const db = getDb()
  const now = new Date()
  const nextExpiresAt = refreshExpiresAt(now)
  const sessionMeta = trimMeta(meta)

  return db.transaction(async (tx) => {
    const [session] = await tx
      .update(refreshSessions)
      .set({
        lastUsedAt: now,
        expiresAt: nextExpiresAt,
        deviceName: sessionMeta.deviceName,
        userAgent: sessionMeta.userAgent,
      })
      .where(and(
        eq(refreshSessions.tokenHash, hashRefreshToken(token)),
        isNull(refreshSessions.revokedAt),
        gt(refreshSessions.expiresAt, now),
      ))
      .returning()

    if (!session) {
      logger.warn('refresh session missing, expired, or revoked')
      return null
    }

    const user = await tx.query.users.findFirst({
      where: eq(users.id, session.userId),
    })

    if (!user) {
      logger.warn({ userId: session.userId }, 'refresh session user missing')
      return null
    }

    logger.info({ userId: user.id }, 'refresh session renewed')
    return {
      accessToken: signToken({ userId: user.id, phone: user.phone }),
      refreshToken: token,
      refreshExpiresAt: nextExpiresAt,
      user: toAuthUser(user),
    }
  })
}

export async function revokeRefreshSession(token: string | undefined, logger: Logger): Promise<void> {
  if (!token) return

  const db = getDb()
  const now = new Date()
  const rows = await db
    .update(refreshSessions)
    .set({ revokedAt: now })
    .where(and(
      eq(refreshSessions.tokenHash, hashRefreshToken(token)),
      isNull(refreshSessions.revokedAt),
    ))
    .returning({ id: refreshSessions.id, userId: refreshSessions.userId })

  if (rows.length > 0) {
    logger.info({ userId: rows[0].userId }, 'refresh session revoked')
  }
}

export async function findUserByPhone(phone: string): Promise<AuthUser | null> {
  const db = getDb()
  const user = await db.query.users.findFirst({
    where: eq(users.phone, phone),
  })
  if (!user) return null
  return toAuthUser(user)
}

export async function findUserById(userId: string): Promise<AuthUser | null> {
  const db = getDb()
  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
  })
  if (!user) return null
  return toAuthUser(user)
}

export async function findOrCreateUser(
  phone: string,
  logger: Logger,
  deviceInfo?: LoginDeviceInfo,
  channelAttribution?: ResolvedChannelAttribution | null,
  trackingContext?: TrackingRequestContext,
): Promise<AuthUser & { isNew: boolean }> {
  const db = getDb()

  const existingRow = await db.query.users.findFirst({
    where: eq(users.phone, phone),
  })
  const existing = existingRow ? toAuthUser(existingRow) : null

  if (existing) {
    const shouldAttachChannel = Boolean(
      channelAttribution &&
      !existing.channelPartnerId &&
      !existing.channelAgentId &&
      !existing.channelQrCodeId,
    )
    const now = new Date()
    const [updated] = await db
      .update(users)
      .set({
        lastLoginAt: now,
        ...(shouldAttachChannel && channelAttribution
          ? {
              channelPartnerId: channelAttribution.partnerId,
              channelAgentId: channelAttribution.agentId,
              channelQrCodeId: channelAttribution.qrCodeId,
              channelAttributedAt: now,
            }
          : {}),
      })
      .where(eq(users.id, existing.id))
      .returning()

    logger.info({
      userId: existing.id,
      phone,
      channelAttributed: shouldAttachChannel,
      channelAttributionIgnored: Boolean(channelAttribution && !shouldAttachChannel),
    }, 'existing user login')
    if (deviceInfo) {
      const event = {
        userId: existing.id,
        eventName: 'user_login',
        properties: {
          deviceName: deviceInfo.deviceName,
          userAgent: deviceInfo.userAgent,
          ...(channelAttribution ? { channelCode: channelAttribution.channelCode } : {}),
        },
      } as const
      void safeRecordAnalyticsEvent(event, logger)
      safeTrackBackendEvent(event, logger, trackingContext)
    }
    return {
      ...(updated ? toAuthUser(updated) : existing),
      isNew: false,
    }
  }

  const now = new Date()
  const [newUser] = await db
    .insert(users)
    .values({
      phone,
      ...(channelAttribution
        ? {
            channelPartnerId: channelAttribution.partnerId,
            channelAgentId: channelAttribution.agentId,
            channelQrCodeId: channelAttribution.qrCodeId,
            channelAttributedAt: now,
          }
        : {}),
    })
    .returning()
  logger.info({ userId: newUser.id, phone, channelAttributed: Boolean(channelAttribution) }, 'new user created')
  if (deviceInfo) {
    const event = {
      userId: newUser.id,
      eventName: 'user_login',
      properties: {
        deviceName: deviceInfo.deviceName,
        userAgent: deviceInfo.userAgent,
        ...(channelAttribution ? { channelCode: channelAttribution.channelCode } : {}),
      },
    } as const
    void safeRecordAnalyticsEvent(event, logger)
    safeTrackBackendEvent(event, logger, trackingContext)
  }
  return {
    ...toAuthUser(newUser),
    isNew: true,
  }
}

export async function checkNeedsProfile(userId: string): Promise<boolean> {
  const db = getDb()
  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { currentConcern: true },
  })
  return !user?.currentConcern
}
