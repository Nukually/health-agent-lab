import { Hono } from 'hono'
import { z } from 'zod'
import { authMiddleware } from '../middleware/auth.js'
import { requireActiveAccount } from '../middleware/active-account.js'
import {
  createMessageFavorite,
  deleteMessageFavorite,
  getSessionMessageFavoriteIds,
  listMessageFavorites,
} from '../services/message-favorite.js'

const messageFavoriteRoutes = new Hono()

const createFavoriteSchema = z.object({
  sessionId: z.string().uuid(),
  messageId: z.string().uuid(),
})

messageFavoriteRoutes.use('*', authMiddleware)
messageFavoriteRoutes.use('*', requireActiveAccount)

messageFavoriteRoutes.get('/', async (c) => {
  const logger = c.get('logger')
  const userId = c.get('userId')

  const beforeRaw = c.req.query('before')
  const limitRaw = c.req.query('limit')
  let before: Date | undefined
  if (beforeRaw) {
    const parsed = new Date(beforeRaw)
    if (Number.isNaN(parsed.getTime())) {
      return c.json({ success: false, error: 'invalid before cursor' }, 400)
    }
    before = parsed
  }

  let limit: number | undefined
  if (limitRaw !== undefined) {
    const parsed = Number(limitRaw)
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > 100) {
      return c.json({ success: false, error: 'limit must be 1..100' }, 400)
    }
    limit = Math.floor(parsed)
  }

  const result = await listMessageFavorites(userId, logger, { before, limit })
  return c.json({ success: true, data: result })
})

messageFavoriteRoutes.get('/session/:sessionId', async (c) => {
  const logger = c.get('logger')
  const userId = c.get('userId')
  const sessionId = c.req.param('sessionId')
  if (!z.string().uuid().safeParse(sessionId).success) {
    return c.json({ success: false, error: 'invalid session id' }, 400)
  }

  const messageIds = await getSessionMessageFavoriteIds(userId, sessionId, logger)
  return c.json({ success: true, data: { messageIds } })
})

messageFavoriteRoutes.post('/', async (c) => {
  const logger = c.get('logger')
  const userId = c.get('userId')
  const parsed = createFavoriteSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) {
    return c.json({ success: false, error: 'Invalid favorite data' }, 400)
  }

  const result = await createMessageFavorite(
    userId,
    parsed.data.sessionId,
    parsed.data.messageId,
    logger,
  )

  if (result.status === 'not_found') {
    return c.json({ success: false, error: '收藏消息不存在' }, 404)
  }
  if (result.status === 'invalid_target') {
    return c.json({ success: false, error: '只能收藏已完成的 AI 回复' }, 400)
  }
  if (!('favorite' in result)) {
    return c.json({ success: false, error: '收藏失败' }, 500)
  }
  return c.json({ success: true, data: { favorite: result.favorite, status: result.status } })
})

messageFavoriteRoutes.delete('/:messageId', async (c) => {
  const logger = c.get('logger')
  const userId = c.get('userId')
  const messageId = c.req.param('messageId')
  const sessionId = c.req.query('sessionId')
  if (!z.string().uuid().safeParse(messageId).success || !z.string().uuid().safeParse(sessionId).success) {
    return c.json({ success: false, error: 'invalid favorite target' }, 400)
  }

  const deleted = await deleteMessageFavorite(userId, sessionId!, messageId, logger)
  return c.json({ success: true, data: { deleted } })
})

export default messageFavoriteRoutes
