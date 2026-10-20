/**
 * KV Store — Redis / 内存 fallback
 *
 * 开发环境可不启动 Redis，自动降级为内存存储
 * 当前仅用于验证码 + 限流，内存完全够用
 * 生产环境必须配置 REDIS_URL
 */

import Redis from 'ioredis'
import { rootLogger } from './logger.js'

const logger = rootLogger.child({ module: 'kv' })

// ======== 统一接口 ========

export interface KVStore {
  get(key: string): Promise<string | null>
  set(key: string, value: string, ttlSeconds?: number): Promise<void>
  setNX(key: string, value: string, ttlSeconds?: number): Promise<boolean>
  del(key: string): Promise<void>
  delIfValue(key: string, value: string): Promise<boolean>
  incr(key: string): Promise<number>
  pexpire(key: string, ms: number): Promise<void>
  /** Push a value to the head of a list (FIFO consumer uses rpop). */
  lpush(key: string, value: string): Promise<number>
  /** Non-blocking pop from the tail of a list. Returns null when empty. */
  rpop(key: string): Promise<string | null>
  /** Current list length, used for stats / health. */
  llen(key: string): Promise<number>
}

// ======== 内存实现 ========

function createMemoryKV(): KVStore {
  const store = new Map<string, { value: string; expiresAt?: number }>()
  const counters = new Map<string, { count: number; expiresAt?: number }>()
  const lists = new Map<string, string[]>()

  function isExpired(expiresAt?: number): boolean {
    return expiresAt !== undefined && Date.now() > expiresAt
  }

  logger.info('using in-memory KV store (no Redis)')

  return {
    async get(key) {
      const entry = store.get(key)
      if (!entry || isExpired(entry.expiresAt)) {
        store.delete(key)
        return null
      }
      return entry.value
    },

    async set(key, value, ttlSeconds) {
      store.set(key, {
        value,
        expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : undefined,
      })
    },

    async setNX(key, value, ttlSeconds) {
      const entry = store.get(key)
      if (entry && !isExpired(entry.expiresAt)) return false

      store.set(key, {
        value,
        expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : undefined,
      })
      return true
    },

    async del(key) {
      store.delete(key)
      counters.delete(key)
    },

    async delIfValue(key, value) {
      const entry = store.get(key)
      if (!entry || isExpired(entry.expiresAt) || entry.value !== value) return false
      store.delete(key)
      counters.delete(key)
      return true
    },

    async incr(key) {
      const entry = counters.get(key)
      if (!entry || isExpired(entry.expiresAt)) {
        counters.set(key, { count: 1, expiresAt: entry?.expiresAt })
        return 1
      }
      entry.count++
      return entry.count
    },

    async pexpire(key, ms) {
      const entry = counters.get(key)
      if (entry) {
        entry.expiresAt = Date.now() + ms
      }
    },

    async lpush(key, value) {
      const list = lists.get(key) ?? []
      list.unshift(value)
      lists.set(key, list)
      return list.length
    },

    async rpop(key) {
      const list = lists.get(key)
      if (!list || list.length === 0) return null
      const value = list.pop() ?? null
      if (list.length === 0) lists.delete(key)
      return value
    },

    async llen(key) {
      return lists.get(key)?.length ?? 0
    },
  }
}

// ======== Redis 实现 ========

interface RedisConfig {
  host: string
  port: number
  password?: string
  db?: number
}

function createRedisKV(config: RedisConfig | string): KVStore {
  let client: InstanceType<typeof Redis> | null = null

  function getClient() {
    if (!client) {
      if (typeof config === 'string') {
        client = new Redis(config, { maxRetriesPerRequest: 3, lazyConnect: true })
      } else {
        client = new Redis({
          host: config.host,
          port: config.port,
          password: config.password,
          db: config.db ?? 0,
          maxRetriesPerRequest: 3,
          lazyConnect: true,
        })
      }
      client.on('connect', () => logger.info('redis connected'))
      client.on('error', (err: Error) => logger.error({ err }, 'redis error'))
    }
    return client
  }

  logger.info('using Redis KV store')

  return {
    async get(key) {
      return getClient().get(key)
    },

    async set(key, value, ttlSeconds) {
      if (ttlSeconds) {
        await getClient().set(key, value, 'EX', ttlSeconds)
      } else {
        await getClient().set(key, value)
      }
    },

    async setNX(key, value, ttlSeconds) {
      const result = ttlSeconds
        ? await getClient().set(key, value, 'EX', ttlSeconds, 'NX')
        : await getClient().set(key, value, 'NX')
      return result === 'OK'
    },

    async del(key) {
      await getClient().del(key)
    },

    async delIfValue(key, value) {
      const result = await getClient().eval(
        'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end',
        1,
        key,
        value,
      )
      return result === 1
    },

    async incr(key) {
      return getClient().incr(key)
    },

    async pexpire(key, ms) {
      await getClient().pexpire(key, ms)
    },

    async lpush(key, value) {
      return getClient().lpush(key, value)
    },

    async rpop(key) {
      return getClient().rpop(key)
    },

    async llen(key) {
      return getClient().llen(key)
    },
  }
}

// ======== 工厂 ========

let kv: KVStore | null = null

export function getKV(): KVStore {
  if (!kv) {
    const redisHost = process.env.REDIS_HOST
    const redisUrl = process.env.REDIS_URL

    if (redisHost) {
      // 优先用独立参数连接（避免密码特殊字符的 URL 编码问题）
      kv = createRedisKV({
        host: redisHost,
        port: parseInt(process.env.REDIS_PORT || '6379'),
        password: process.env.REDIS_PASSWORD,
        db: parseInt(process.env.REDIS_DB || '0'),
      })
    } else if (redisUrl) {
      kv = createRedisKV(redisUrl)
    } else {
      kv = createMemoryKV()
    }
  }
  return kv
}

// 保留旧接口兼容（逐步迁移）
export function getRedis(): any {
  return getKV()
}
