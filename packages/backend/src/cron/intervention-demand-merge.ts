import { getEnv } from '../env.js'
import { runDemandMergeBatch } from '../services/intervention-demand-merger.js'
import { withCronLock } from './lock.js'
import type { Logger } from '../lib/logger.js'

const LOCK_TTL_SECONDS = 30 * 60

/**
 * 干预方案需求合并：用 LLM 把 generate_plan 采集的原始需求归并/去重/计数到聚合需求。
 * 复用 withCronLock 防多实例；单批处理，剩余 pending 下周期继续。
 */
export async function runInterventionDemandMerge(logger: Logger): Promise<void> {
  if (!getEnv().INTERVENTION_DEMAND_MERGE_ENABLED) return
  const log = logger.child({ module: 'intervention-demand-merge' })

  await withCronLock('intervention-demand-merge', 'global', LOCK_TTL_SECONDS, log, async () => {
    await runDemandMergeBatch(log)
  })
}
