/**
 * 夜间结构化档案抽取 — 每日凌晨 3:30 跑
 *
 * 与 consolidation 完全独立：独立 cron、独立 try/catch、不共享统计。
 * 输入：用户昨日全部 user messages + 用户上传图片/病历原图
 * 输出：user_daily_structured_profiles 表每用户一条快照
 * LLM：固定走 backup（Moonshot Kimi）
 */

import { getActiveUserIdsForDate } from '../services/memory.js'
import { extractDailyStructuredProfile } from '../services/structured-profile.js'
import type { Logger } from '../lib/logger.js'
import { withCronLock } from './lock.js'

const BATCH_DELAY_MS = 2_000
const LOCK_TTL_SECONDS = 2 * 60 * 60

function shanghaiDateStr(date: Date): string {
  return date.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' })
}

export async function runNightlyStructuredProfiling(logger: Logger): Promise<void> {
  const yesterday = new Date()
  yesterday.setDate(yesterday.getDate() - 1)
  const dateStr = shanghaiDateStr(yesterday)

  await withCronLock('structured-profiling', dateStr, LOCK_TTL_SECONDS, logger, async () => {
    await runNightlyStructuredProfilingForDate(dateStr, logger)
  })
}

async function runNightlyStructuredProfilingForDate(
  dateStr: string,
  logger: Logger,
): Promise<void> {
  const userIds = await getActiveUserIdsForDate(dateStr, logger)

  if (userIds.length === 0) {
    logger.info({ date: dateStr }, 'no active users for structured profiling')
    return
  }

  logger.info(
    { date: dateStr, userCount: userIds.length },
    'starting nightly structured profiling',
  )

  const stats = {
    updated: 0,
    skippedNoInput: 0,
    skippedNoSignal: 0,
    failed: 0,
    errors: 0,
    totalAttempts: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
  }

  for (const userId of userIds) {
    try {
      const result = await extractDailyStructuredProfile(userId, dateStr, logger)
      if (result.kind === 'updated') {
        stats.updated++
        stats.totalAttempts += result.attempts
        stats.totalInputTokens += result.inputTokens ?? 0
        stats.totalOutputTokens += result.outputTokens ?? 0
      } else if (result.kind === 'skipped_no_input') {
        stats.skippedNoInput++
      } else if (result.kind === 'skipped_no_signal') {
        stats.skippedNoSignal++
        stats.totalInputTokens += result.inputTokens ?? 0
        stats.totalOutputTokens += result.outputTokens ?? 0
      } else if (result.kind === 'failed') {
        stats.failed++
        stats.totalAttempts += result.attempts
        logger.error(
          { userId, attempts: result.attempts, lastError: result.lastError },
          'structured profile extract failed after retries',
        )
      }
    } catch (err: any) {
      stats.errors++
      logger.error({ userId, error: err.message }, 'structured profiling threw for user')
    }

    await new Promise((r) => setTimeout(r, BATCH_DELAY_MS))
  }

  logger.info(
    { date: dateStr, totalUsers: userIds.length, ...stats },
    'nightly structured profiling completed',
  )
}
