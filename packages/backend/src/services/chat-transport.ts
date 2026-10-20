import type { ChatTransportMode, ChatTransportUaBucket } from '@health-agent/shared'
import type { Logger } from '../lib/logger.js'
import { getKV } from '../lib/redis.js'

const SYNC_FALLBACK_TTL_SECONDS = 24 * 60 * 60

function buildSyncFallbackKey(userId: string, uaBucket: ChatTransportUaBucket): string {
  return `chat:transport:sync:${userId}:${uaBucket}`
}

export function getChatTransportUaBucket(userAgent?: string | null): ChatTransportUaBucket {
  if (!userAgent) return 'default'
  if (/(iPhone|iPad|iPod)/i.test(userAgent)) return 'ios_webkit'
  return 'default'
}

export async function getChatTransportMode(
  userId: string,
  userAgent?: string | null,
): Promise<{ mode: ChatTransportMode; uaBucket: ChatTransportUaBucket }> {
  const uaBucket = getChatTransportUaBucket(userAgent)
  if (uaBucket === 'default') {
    return { mode: 'stream', uaBucket }
  }

  const kv = getKV()
  const marked = await kv.get(buildSyncFallbackKey(userId, uaBucket))
  return {
    mode: marked ? 'sync' : 'stream',
    uaBucket,
  }
}

export async function markChatSyncFallback(
  userId: string,
  userAgent: string | null | undefined,
  logger: Logger,
  reason: string,
): Promise<void> {
  const uaBucket = getChatTransportUaBucket(userAgent)
  if (uaBucket === 'default') return

  const kv = getKV()
  await kv.set(
    buildSyncFallbackKey(userId, uaBucket),
    JSON.stringify({
      reason,
      uaBucket,
      markedAt: new Date().toISOString(),
    }),
    SYNC_FALLBACK_TTL_SECONDS,
  )

  logger.info(
    { userId, uaBucket, ttlSeconds: SYNC_FALLBACK_TTL_SECONDS, reason },
    'chat transport downgraded to sync',
  )
}
