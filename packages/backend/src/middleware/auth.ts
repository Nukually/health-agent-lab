import { createMiddleware } from 'hono/factory'
import { verifyToken, type JwtPayload } from '../services/auth.js'

declare module 'hono' {
  interface ContextVariableMap {
    userId: string
    jwtPayload: JwtPayload
  }
}

export const authMiddleware = createMiddleware(async (c, next) => {
  const logger = c.get('logger')

  const authHeader = c.req.header('Authorization')
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    logger.warn('missing or invalid authorization header')
    return c.json({ success: false, error: '未登录' }, 401)
  }

  const token = authHeader.slice(7)

  try {
    const payload = verifyToken(token)
    c.set('userId', payload.userId)
    c.set('jwtPayload', payload)

    // Enrich logger with userId for all downstream log calls
    c.set('logger', logger.child({ userId: payload.userId }))

    await next()
  } catch (err) {
    logger.warn({ err }, 'jwt verification failed')
    return c.json({ success: false, error: '登录已过期，请重新登录' }, 401)
  }
})
