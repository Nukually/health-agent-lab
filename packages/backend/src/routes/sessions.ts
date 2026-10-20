import { Hono } from 'hono'
import { authMiddleware } from '../middleware/auth.js'
import { requireActiveAccount } from '../middleware/active-account.js'
import { createSession, listSessions, getSession, deleteSession } from '../services/session.js'
import { getSessionMessages } from '../services/message.js'
import { isFirstActivationConversationSession } from '../services/first-activation.js'

const sessionRoutes = new Hono()

sessionRoutes.use('*', authMiddleware)
sessionRoutes.use('*', requireActiveAccount)

// GET /api/sessions
// Query: ?before=<ISO updatedAt>&limit=<1..100, default 30>
sessionRoutes.get('/', async (c) => {
  const logger = c.get('logger')
  const userId = c.get('userId')

  const beforeRaw = c.req.query('before')
  const limitRaw = c.req.query('limit')

  let before: Date | undefined
  if (beforeRaw) {
    const d = new Date(beforeRaw)
    if (Number.isNaN(d.getTime())) {
      return c.json({ success: false, error: 'invalid before cursor' }, 400)
    }
    before = d
  }

  let limit: number | undefined
  if (limitRaw !== undefined) {
    const n = Number(limitRaw)
    if (!Number.isFinite(n) || n < 1 || n > 100) {
      return c.json({ success: false, error: 'limit must be 1..100' }, 400)
    }
    limit = Math.floor(n)
  }

  const { items, hasMore, nextCursor } = await listSessions(userId, logger, { before, limit })

  return c.json({
    success: true,
    data: { items, hasMore, nextCursor },
  })
})

// POST /api/sessions
sessionRoutes.post('/', async (c) => {
  const logger = c.get('logger')
  const userId = c.get('userId')
  const body = await c.req.json().catch(() => ({}))

  const session = await createSession(userId, body.title, logger)

  return c.json({
    success: true,
    data: {
      id: session.id,
      title: session.title,
      messageCount: session.messageCount,
      updatedAt: session.updatedAt.toISOString(),
    },
  })
})

// GET /api/sessions/:id — session detail with paginated messages
// Query: ?before=<ISO createdAt>&limit=<1..100, default 30>
sessionRoutes.get('/:id', async (c) => {
  const logger = c.get('logger')
  const userId = c.get('userId')
  const sessionId = c.req.param('id')

  const beforeRaw = c.req.query('before')
  const limitRaw = c.req.query('limit')
  const focusMessageIdRaw = c.req.query('focusMessageId')

  let before: Date | undefined
  if (beforeRaw) {
    const d = new Date(beforeRaw)
    if (Number.isNaN(d.getTime())) {
      return c.json({ success: false, error: 'invalid before cursor' }, 400)
    }
    before = d
  }

  let limit: number | undefined
  if (limitRaw !== undefined) {
    const n = Number(limitRaw)
    if (!Number.isFinite(n) || n < 1 || n > 100) {
      return c.json({ success: false, error: 'limit must be 1..100' }, 400)
    }
    limit = Math.floor(n)
  }

  const focusMessageId = focusMessageIdRaw && /^[0-9a-f-]{36}$/i.test(focusMessageIdRaw)
    ? focusMessageIdRaw
    : undefined

  const session = await getSession(sessionId, logger)
  if (!session || session.userId !== userId) {
    return c.json({ success: false, error: 'session not found' }, 404)
  }

  const { messages: msgs, hasMore, oldestCreatedAt } = await getSessionMessages(
    sessionId,
    logger,
    { before, limit, userId, focusMessageId },
  )
  const firstActivationConversation = !before
    ? await isFirstActivationConversationSession(sessionId)
    : undefined

  return c.json({
    success: true,
    data: {
      id: session.id,
      title: session.title,
      messageCount: session.messageCount,
      updatedAt: session.updatedAt.toISOString(),
      isFirstActivationConversation: firstActivationConversation,
      messages: msgs,
      hasMore,
      oldestCreatedAt,
    },
  })
})

// DELETE /api/sessions/:id
sessionRoutes.delete('/:id', async (c) => {
  const logger = c.get('logger')
  const userId = c.get('userId')
  const sessionId = c.req.param('id')

  const deleted = await deleteSession(sessionId, userId, logger)
  if (!deleted) {
    return c.json({ success: false, error: 'session not found' }, 404)
  }

  return c.json({ success: true })
})

export default sessionRoutes
