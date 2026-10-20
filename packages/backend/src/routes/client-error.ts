/**
 * Client-side error reporting endpoint
 *
 * 前端 fetch / SSE reader 抛异常时 fire-and-forget 上报,用于对账
 * "前端显示错误但后端日志没挂"的场景。仅写 pino 日志,不落库。
 */

import { Hono } from 'hono'
import { z } from 'zod'
import { authMiddleware } from '../middleware/auth.js'
import { markChatSyncFallback } from '../services/chat-transport.js'

const clientErrorRoutes = new Hono()

clientErrorRoutes.use('*', authMiddleware)

const STACK_MAX = 2048

const clientErrorSchema = z.object({
  sessionId: z.string().uuid().optional(),
  errorName: z.string().max(128),
  errorMessage: z.string().max(1024),
  errorStack: z.string().max(STACK_MAX).optional(),
  phase: z.string().max(64),
  userAgent: z.string().max(512).optional(),
  url: z.string().max(1024).optional(),
  nativeBridgeAvailable: z.boolean().optional(),
})

function shouldDowngradeTransport(data: z.infer<typeof clientErrorSchema>): boolean {
  if (data.nativeBridgeAvailable) return false
  if (data.phase !== 'fetch-or-reader') return false
  if (data.errorName !== 'TypeError') return false
  const lowered = data.errorMessage.toLowerCase()
  return lowered === 'load failed' || lowered === 'illegal access'
}

clientErrorRoutes.post('/', async (c) => {
  const logger = c.get('logger')
  const userId = c.get('userId')

  const body = await c.req.json().catch(() => null)
  const parsed = clientErrorSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ success: false, error: 'invalid payload' }, 400)
  }

  const data = parsed.data
  logger.info(
    {
      module: 'client-error',
      userId,
      sessionId: data.sessionId,
      errorName: data.errorName,
      errorMessage: data.errorMessage,
      errorStack: data.errorStack,
      phase: data.phase,
      userAgent: data.userAgent,
      url: data.url,
      nativeBridgeAvailable: data.nativeBridgeAvailable,
    },
    'client-side error reported',
  )

  if (shouldDowngradeTransport(data)) {
    try {
      await markChatSyncFallback(userId, data.userAgent, logger, `${data.phase}:${data.errorMessage}`)
    } catch (err: any) {
      logger.warn(
        { userId, error: err?.message ?? String(err) },
        'failed to downgrade chat transport after client error',
      )
    }
  }

  return c.json({ success: true })
})

export default clientErrorRoutes
