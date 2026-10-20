import type { Context } from 'hono'
import { createMiddleware } from 'hono/factory'
import { getKV } from '../lib/redis.js'
import { getEnv } from '../env.js'

interface RateLimitOptions {
  windowMs: number
  max: number
  keyPrefix: string
  keyExtractor?: (c: Context) => string
  enabledInNonProd?: boolean
}

export function rateLimitMiddleware(opts: RateLimitOptions) {
  return createMiddleware(async (c, next) => {
    if (getEnv().DEPLOY_ENV !== 'prod' && !opts.enabledInNonProd) return next()

    const logger = c.get('logger')
    const kv = getKV()

    const identifier = opts.keyExtractor
      ? opts.keyExtractor(c)
      : c.req.header('x-forwarded-for') || 'unknown'
    const key = `${opts.keyPrefix}:${identifier}`

    const current = await kv.incr(key)
    if (current === 1) {
      await kv.pexpire(key, opts.windowMs)
    }

    if (current > opts.max) {
      logger.warn({ identifier, current, max: opts.max, prefix: opts.keyPrefix }, 'rate limit exceeded')
      return c.json({ success: false, error: '请求过于频繁，请稍后再试', code: 'USER_RATE_LIMITED' }, 429)
    }

    await next()
  })
}
