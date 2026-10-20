import { Hono } from 'hono'
import { z } from 'zod'
import { authMiddleware } from '../middleware/auth.js'
import { requireActiveAccount } from '../middleware/active-account.js'
import { upsertFeedback, getSessionFeedback } from '../services/feedback.js'

const feedbackRoutes = new Hono()
const feedbackSchema = z.object({
  messageId: z.string().uuid(),
  sessionId: z.string().uuid(),
  rating: z.enum(['like', 'dislike']),
})

feedbackRoutes.use('*', authMiddleware)
feedbackRoutes.use('*', requireActiveAccount)

// POST /api/feedback — submit or toggle feedback
feedbackRoutes.post('/', async (c) => {
  const logger = c.get('logger')
  const userId = c.get('userId')
  const body = await c.req.json()

  const parsed = feedbackSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ success: false, error: 'Invalid feedback data' }, 400)
  }

  const { messageId, sessionId, rating } = parsed.data
  const result = await upsertFeedback(messageId, sessionId, userId, rating, logger)
  if (result === 'not_found') {
    return c.json({ success: false, error: '反馈消息不存在' }, 404)
  }
  return c.json({ success: true, data: { rating: result } })
})

// GET /api/feedback/:sessionId — get user's feedback for a session
feedbackRoutes.get('/:sessionId', async (c) => {
  const logger = c.get('logger')
  const userId = c.get('userId')
  const sessionId = c.req.param('sessionId')

  const feedback = await getSessionFeedback(sessionId, userId, logger)
  return c.json({ success: true, data: feedback })
})

export default feedbackRoutes
