/**
 * Cron Jobs — 定时任务注册
 *
 * croner: 纯 Node.js 进程内定时器，不依赖系统 cron。
 * 只要 Node 进程存活就正常工作。
 */

import { Cron } from 'croner'
import { rootLogger } from '../lib/logger.js'
import { runNightlyStructuredProfiling } from './structured-profile.js'
import { runPurgeExpiredDeletions } from './purge-expired.js'
import { runDueScheduledProactiveMessages } from '../services/scheduled-proactive-message.js'
import { runDoctorBindingAutoApprove } from './doctor-binding.js'
import { runEfficacyAnalysisSweep } from './efficacy-analysis.js'
import { runInterventionDemandMerge } from './intervention-demand-merge.js'

const logger = rootLogger.child({ module: 'cron' })

export function startCronJobs(): void {
  // 每天凌晨 3:30 AM Asia/Shanghai — 个性化结构化档案抽取（独立于 consolidation，走 backup LLM）
  const structuredProfileJob = new Cron(
    '30 3 * * *',
    { timezone: 'Asia/Shanghai' },
    async () => {
      logger.info('nightly structured profiling cron triggered')
      try {
        await runNightlyStructuredProfiling(logger)
      } catch (err: any) {
        logger.error({ error: err.message }, 'nightly structured profiling cron failed')
      }
    },
  )

  // 每天凌晨 4:00 AM Asia/Shanghai — 硬删已过冷静期的注销账号（避开 3AM Profile 合并）
  const purgeJob = new Cron(
    '0 4 * * *',
    { timezone: 'Asia/Shanghai' },
    async () => {
      logger.info('purge-expired cron triggered')
      try {
        await runPurgeExpiredDeletions(logger)
      } catch (err: any) {
        logger.error({ error: err.message }, 'purge-expired cron failed')
      }
    },
  )

  // 每 30 分钟自动通过超过 7 天未处理的医患解绑申请。
  const doctorBindingAutoApproveJob = new Cron(
    '*/30 * * * *',
    { timezone: 'Asia/Shanghai' },
    async () => {
      try {
        await runDoctorBindingAutoApprove(logger)
      } catch (err: any) {
        logger.error({ error: err.message }, 'doctor binding auto approve cron failed')
      }
    },
  )

  // 每分钟扫描到期的通用主动消息。任务自身用 Redis lock 防多实例重复执行。
  const scheduledProactiveMessageJob = new Cron(
    '* * * * *',
    { timezone: 'Asia/Shanghai' },
    async () => {
      try {
        await runDueScheduledProactiveMessages(logger)
      } catch (err: any) {
        logger.error({ error: err.message }, 'scheduled proactive message cron failed')
      }
    },
  )

  // 每 30 分钟扫描停止活跃 ≥N 小时的 session，做增量干预方案疗效分析。任务自身用 Redis lock 防多实例。
  const efficacyAnalysisJob = new Cron(
    '*/30 * * * *',
    { timezone: 'Asia/Shanghai' },
    async () => {
      try {
        await runEfficacyAnalysisSweep(logger)
      } catch (err: any) {
        logger.error({ error: err.message }, 'efficacy analysis cron failed')
      }
    },
  )

  // 每天凌晨 2:00 AM Asia/Shanghai — 干预方案需求合并（避开 3:30 档案 / 4:00 purge）。任务自身用 Redis lock 防多实例。
  const interventionDemandMergeJob = new Cron(
    '0 2 * * *',
    { timezone: 'Asia/Shanghai' },
    async () => {
      try {
        await runInterventionDemandMerge(logger)
      } catch (err: any) {
        logger.error({ error: err.message }, 'intervention demand merge cron failed')
      }
    },
  )

  logger.info(
    {
      structuredProfileNext: structuredProfileJob.nextRun()?.toISOString(),
      purgeNext: purgeJob.nextRun()?.toISOString(),
      doctorBindingAutoApproveNext: doctorBindingAutoApproveJob.nextRun()?.toISOString(),
      scheduledProactiveMessageNext: scheduledProactiveMessageJob.nextRun()?.toISOString(),
      efficacyAnalysisNext: efficacyAnalysisJob.nextRun()?.toISOString(),
      interventionDemandMergeNext: interventionDemandMergeJob.nextRun()?.toISOString(),
    },
    'cron jobs registered',
  )
}
