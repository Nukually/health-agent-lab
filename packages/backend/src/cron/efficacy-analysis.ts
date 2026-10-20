import { getEnv } from '../env.js'
import {
  getActiveSessionsPendingEfficacyAnalysis,
  getIncrementalMessagesForAnalysis,
  recordEfficacyAnalysisFailure,
  upsertEfficacyAnalysisStateOnSuccess,
} from '../services/efficacy-records.js'
import { analyzeSessionEfficacy } from '../services/efficacy-reviewer.js'
import { redactSensitiveLogText } from '../utils/log-redaction.js'
import { withCronLock } from './lock.js'
import type { Logger } from '../lib/logger.js'

const LOCK_TTL_SECONDS = 30 * 60
const BATCH_LIMIT = 50
const BATCH_DELAY_MS = 2_000

/**
 * 扫描"停止活跃 ≥N 小时 且 有未分析新消息"的 session，逐个做增量疗效分析。
 * 复用 withCronLock 防多实例；单 session 错误隔离；失败不推进水位，下周期自动重试。
 */
export async function runEfficacyAnalysisSweep(logger: Logger): Promise<void> {
  if (!getEnv().EFFICACY_ANALYSIS_ENABLED) return
  const log = logger.child({ module: 'efficacy-analysis' })

  await withCronLock('efficacy-analysis', 'global', LOCK_TTL_SECONDS, log, async () => {
    const inactiveHours = getEnv().EFFICACY_INACTIVE_HOURS
    const pending = await getActiveSessionsPendingEfficacyAnalysis({ inactiveHours, limit: BATCH_LIMIT })
    if (pending.length === 0) {
      log.info('no sessions pending efficacy analysis')
      return
    }

    log.info({ sessionCount: pending.length, inactiveHours }, 'starting efficacy analysis sweep')
    const stats = { analyzed: 0, created: 0, updated: 0, touched: 0, skipped: 0, empty: 0, errors: 0 }

    for (const row of pending) {
      try {
        const { messages, maxCreatedAt, lastUserMessageId } = await getIncrementalMessagesForAnalysis(
          row.sessionId,
          row.analyzedUpToCreatedAt,
        )
        if (messages.length === 0) {
          // 全是合成/被清洗掉的消息：仍推进水位到本批 maxCreatedAt（若有），避免每周期重扫。
          if (maxCreatedAt) {
            await upsertEfficacyAnalysisStateOnSuccess({ sessionId: row.sessionId, userId: row.userId, analyzedUpToCreatedAt: maxCreatedAt })
          }
          stats.empty++
        } else {
          const result = await analyzeSessionEfficacy({
            userId: row.userId,
            sessionId: row.sessionId,
            messages,
            lastUserMessageId,
            now: new Date(),
            logger: log,
          })
          if (maxCreatedAt) {
            await upsertEfficacyAnalysisStateOnSuccess({ sessionId: row.sessionId, userId: row.userId, analyzedUpToCreatedAt: maxCreatedAt })
          }
          stats.analyzed++
          stats.created += result.created
          stats.updated += result.updated
          stats.touched += result.touched
          stats.skipped += result.skipped
        }
      } catch (err: any) {
        stats.errors++
        const message = redactSensitiveLogText(err?.message ?? String(err))
        await recordEfficacyAnalysisFailure({ sessionId: row.sessionId, userId: row.userId, error: message }).catch(() => {})
        log.error({ sessionId: row.sessionId, error: message }, 'efficacy analysis failed for session')
      }

      await new Promise((r) => setTimeout(r, BATCH_DELAY_MS))
    }

    log.info({ totalSessions: pending.length, ...stats }, 'efficacy analysis sweep completed')
  })
}
