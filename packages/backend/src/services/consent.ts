import { eq, and, desc } from 'drizzle-orm'
import { getDb } from '../db/client.js'
import { userConsents } from '../db/schema/index.js'
import type { Logger } from '../lib/logger.js'
import type { ConsentType, UserConsent } from '@health-agent/shared'

/**
 * 记录一次授权。对同一 (userId, type, version) 幂等（ON CONFLICT DO NOTHING）。
 */
export async function recordConsent(
  userId: string,
  type: ConsentType,
  version: string,
  meta: { ipAddress?: string; userAgent?: string },
  logger: Logger,
): Promise<void> {
  const db = getDb()
  await db
    .insert(userConsents)
    .values({
      userId,
      consentType: type,
      version,
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    })
    .onConflictDoNothing({ target: [userConsents.userId, userConsents.consentType, userConsents.version] })
  logger.info({ userId, type, version }, 'consent recorded')
}

/**
 * 返回用户所有类型的最近一次授权记录（每类型取 agreedAt 最新）。
 * 前端据此判断 hasConsent(type, version)。
 */
export async function listConsents(userId: string): Promise<UserConsent[]> {
  const db = getDb()
  const rows = await db
    .select({
      type: userConsents.consentType,
      version: userConsents.version,
      agreedAt: userConsents.agreedAt,
    })
    .from(userConsents)
    .where(eq(userConsents.userId, userId))
    .orderBy(desc(userConsents.agreedAt))

  // 每个 consentType 只保留最新一条
  const seen = new Set<string>()
  const result: UserConsent[] = []
  for (const row of rows) {
    if (seen.has(row.type)) continue
    seen.add(row.type)
    result.push({
      type: row.type as ConsentType,
      version: row.version,
      agreedAt: row.agreedAt.toISOString(),
    })
  }
  return result
}

export async function hasConsent(
  userId: string,
  type: ConsentType,
  version: string,
): Promise<boolean> {
  const db = getDb()
  const row = await db.query.userConsents.findFirst({
    where: and(
      eq(userConsents.userId, userId),
      eq(userConsents.consentType, type),
      eq(userConsents.version, version),
    ),
    columns: { id: true },
  })
  return !!row
}
