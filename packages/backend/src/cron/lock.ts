import { randomUUID } from 'node:crypto'
import { getKV } from '../lib/redis.js'
import type { Logger } from '../lib/logger.js'

const LOCK_PREFIX = 'lock:cron:'

export async function withCronLock<T>(
  name: string,
  key: string,
  ttlSeconds: number,
  logger: Logger,
  fn: () => Promise<T>,
): Promise<T | null> {
  const kv = getKV()
  const lockKey = `${LOCK_PREFIX}${name}:${key}`
  const token = randomUUID()

  const acquired = await kv.setNX(lockKey, token, ttlSeconds)
  if (!acquired) {
    logger.info({ lockKey }, 'cron lock already held, skipping run')
    return null
  }

  try {
    logger.info({ lockKey, ttlSeconds }, 'cron lock acquired')
    return await fn()
  } finally {
    // 避免长任务超过 TTL 后误删其他进程新拿到的锁。
    if (await kv.delIfValue(lockKey, token)) {
      logger.info({ lockKey }, 'cron lock released')
    }
  }
}
