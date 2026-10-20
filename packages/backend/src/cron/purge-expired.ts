/**
 * Purge Expired Deletions — 每日扫描并硬删已过冷静期的账号
 *
 * 合规依据：GB/T 35273-2020 注销账户后应及时删除或匿名化用户信息。
 */

import { findExpiredDeletions, purgeAccount } from '../services/account-deletion.js'
import type { Logger } from '../lib/logger.js'

export const DELETION_GRACE_DAYS = 15

export async function runPurgeExpiredDeletions(logger: Logger): Promise<void> {
  const log = logger.child({ module: 'cron-purge-expired' })
  log.info({ graceDays: DELETION_GRACE_DAYS }, 'purge-expired cron started')

  const userIds = await findExpiredDeletions(DELETION_GRACE_DAYS)
  log.info({ count: userIds.length }, 'found expired deletions')

  let success = 0
  let failed = 0

  for (const userId of userIds) {
    try {
      await purgeAccount(userId, log)
      success++
    } catch (err: any) {
      log.error({ userId, error: err.message }, 'purge account failed')
      failed++
    }
    // 间隔 2s 防并发压力
    await new Promise((r) => setTimeout(r, 2000))
  }

  log.info({ total: userIds.length, success, failed }, 'purge-expired cron finished')
}
