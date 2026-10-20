/**
 * Account Deletion Service — 账号注销与数据清理
 *
 * 两个场景：
 * 1. 账号注销：15 天冷静期后硬删（purgeAccount）
 * 2. 健康档案清理：立即硬删医疗档案 + 病历图片（purgeMedicalData）
 *
 * 注销策略遵循 GB/T 35273-2020 第 8.5 条："注销后应删除个人信息或作匿名化处理"。
 */

import { and, eq, inArray, lt, sql } from 'drizzle-orm'
import { getDb } from '../db/client.js'
import {
  users,
  chatSessions,
  messages,
  messageFeedback,
  shareTokens,
  medicalRecords,
  medicalDocuments,
  userDailyMemories,
  userProfilesMemory,
} from '../db/schema/index.js'
import { deleteUserMedicalFiles } from '../lib/oss.js'
import { getKV } from '../lib/redis.js'
import type { Logger } from '../lib/logger.js'

export type UserStatus = 'active' | 'pending_deletion'

/** 标记用户为待注销状态（进入冷静期） */
export async function requestAccountDeletion(
  userId: string,
  logger: Logger,
): Promise<void> {
  const db = getDb()
  await db
    .update(users)
    .set({ status: 'pending_deletion', deletionRequestedAt: new Date() })
    .where(eq(users.id, userId))
  logger.info({ userId }, 'account_deletion_requested')
}

/** 冷静期内撤销注销 */
export async function cancelAccountDeletion(
  userId: string,
  logger: Logger,
): Promise<void> {
  const db = getDb()
  await db
    .update(users)
    .set({ status: 'active', deletionRequestedAt: null })
    .where(eq(users.id, userId))
  logger.info({ userId }, 'account_deletion_cancelled')
}

/** 查询用户状态与注销时间 */
export async function getAccountStatus(
  userId: string,
): Promise<{ status: UserStatus; deletionRequestedAt: Date | null; phone: string } | null> {
  const db = getDb()
  const row = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { status: true, deletionRequestedAt: true, phone: true },
  })
  if (!row) return null
  return {
    status: row.status as UserStatus,
    deletionRequestedAt: row.deletionRequestedAt,
    phone: row.phone,
  }
}

/** 查找所有已过冷静期、应执行硬删的用户 ID */
export async function findExpiredDeletions(graceDays: number): Promise<string[]> {
  const db = getDb()
  const cutoff = new Date(Date.now() - graceDays * 24 * 60 * 60 * 1000)
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.status, 'pending_deletion'),
        lt(users.deletionRequestedAt, cutoff),
      ),
    )
  return rows.map((r) => r.id)
}

/**
 * 硬删账号全部数据。
 *
 * 执行顺序（从子表到父表，避免外键冲突）：
 *   message_feedback → share_tokens → messages → chat_sessions
 *   → medical_documents → medical_records
 *   → user_daily_memories → user_profiles_memory → users
 *
 * OSS 图片在事务提交后异步清理，失败不影响 DB 删除。
 */
export async function purgeAccount(userId: string, logger: Logger): Promise<void> {
  const db = getDb()

  // 事务前拿到 phone，便于清理验证码 Redis key
  const userRow = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { phone: true },
  })

  await db.transaction(async (tx) => {
    // 1. 该用户所有 sessionId
    const sessionRows = await tx
      .select({ id: chatSessions.id })
      .from(chatSessions)
      .where(eq(chatSessions.userId, userId))
    const sessionIds = sessionRows.map((r) => r.id)

    // 2. message_feedback — 按 userId 清
    await tx.delete(messageFeedback).where(eq(messageFeedback.userId, userId))

    // 3. share_tokens + messages — 通过 sessionId
    if (sessionIds.length > 0) {
      await tx.delete(shareTokens).where(inArray(shareTokens.sessionId, sessionIds))
      await tx.delete(messages).where(inArray(messages.sessionId, sessionIds))
    }

    // 4. chat_sessions
    await tx.delete(chatSessions).where(eq(chatSessions.userId, userId))

    // 5. medical 相关
    await tx.delete(medicalDocuments).where(eq(medicalDocuments.userId, userId))
    await tx.delete(medicalRecords).where(eq(medicalRecords.userId, userId))

    // 6. 记忆
    await tx.delete(userDailyMemories).where(eq(userDailyMemories.userId, userId))
    await tx.delete(userProfilesMemory).where(eq(userProfilesMemory.userId, userId))

    // 7. 最后删 users
    await tx.delete(users).where(eq(users.id, userId))
  })

  logger.info({ userId }, 'account_purged_db')

  // OSS 清理（事务外，失败不回滚 DB）
  try {
    const ossResult = await deleteUserMedicalFiles(userId)
    logger.info({ userId, ...ossResult }, 'account_purged_oss')
  } catch (err: any) {
    logger.error({ userId, error: err.message }, 'oss purge failed')
  }

  // Redis 验证码 key 清理
  if (userRow?.phone) {
    try {
      await getKV().del(`sms:code:${userRow.phone}`)
    } catch (err: any) {
      logger.warn({ userId, error: err.message }, 'redis code cleanup failed')
    }
  }

  logger.info({ userId }, 'account_purged_complete')
}

/**
 * 清理用户健康档案（保留账号）。
 *
 * 范围：medical_records + medical_documents + OSS 病历图片。
 * 不触碰：对话、记忆、画像、账号。
 */
export async function purgeMedicalData(userId: string, logger: Logger): Promise<void> {
  const db = getDb()

  await db.transaction(async (tx) => {
    await tx.delete(medicalDocuments).where(eq(medicalDocuments.userId, userId))
    await tx.delete(medicalRecords).where(eq(medicalRecords.userId, userId))
  })

  logger.info({ userId }, 'medical_purged_db')

  try {
    const ossResult = await deleteUserMedicalFiles(userId)
    logger.info({ userId, ...ossResult }, 'medical_purged_oss')
  } catch (err: any) {
    logger.error({ userId, error: err.message }, 'oss medical purge failed')
  }
}
