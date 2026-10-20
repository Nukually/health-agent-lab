import { Hono } from 'hono'
import { z } from 'zod'
import {
  type ApiResponse,
  type TodoFeedbackResponse,
  type TodoItemResourceResponse,
  type TodoPlanListResponse,
  type TodoStartResponse,
} from '@health-agent/shared'
import { authMiddleware } from '../middleware/auth.js'
import { requireActiveAccount } from '../middleware/active-account.js'
import {
  getTodoItemPlayableResource,
  listTodoPlansForUser,
  recordTodoFeedback,
  recordTodoStart,
} from '../services/todos.js'

const todosRoutes = new Hono()

todosRoutes.use('*', authMiddleware)
todosRoutes.use('*', requireActiveAccount)

todosRoutes.get('/plans', async (c) => {
  const userId = c.get('userId')
  const plans = await listTodoPlansForUser(userId)
  return c.json<ApiResponse<TodoPlanListResponse>>({
    success: true,
    data: { plans },
  })
})

todosRoutes.get('/items/:todoItemId/resource', async (c) => {
  const logger = c.get('logger')
  const userId = c.get('userId')
  const todoItemId = c.req.param('todoItemId')
  const resource = await getTodoItemPlayableResource(userId, todoItemId, logger)
  return c.json<ApiResponse<TodoItemResourceResponse>>({
    success: true,
    data: { resource },
  })
})

const feedbackSchema = z.object({
  sessionId: z.string().uuid(),
  planId: z.string().uuid(),
  feedback: z.enum(['better', 'same', 'worse']),
})

const startSchema = z.object({
  sessionId: z.string().uuid(),
  planId: z.string().uuid(),
})

todosRoutes.post('/items/:todoItemId/start', async (c) => {
  const logger = c.get('logger')
  const userId = c.get('userId')
  const todoItemId = c.req.param('todoItemId')
  const body = await c.req.json().catch(() => ({}))
  const parsed = startSchema.safeParse(body)

  if (!parsed.success) {
    return c.json({ success: false, error: '开始跟练参数无效' }, 400)
  }

  const data = await recordTodoStart({
    userId,
    sessionId: parsed.data.sessionId,
    planId: parsed.data.planId,
    todoItemId,
  }, logger)

  return c.json<ApiResponse<TodoStartResponse>>({
    success: true,
    data,
  })
})

todosRoutes.post('/items/:todoItemId/feedback', async (c) => {
  const logger = c.get('logger')
  const userId = c.get('userId')
  const todoItemId = c.req.param('todoItemId')
  const body = await c.req.json().catch(() => ({}))
  const parsed = feedbackSchema.safeParse(body)

  if (!parsed.success) {
    return c.json({ success: false, error: '反馈参数无效' }, 400)
  }

  const data = await recordTodoFeedback({
    userId,
    sessionId: parsed.data.sessionId,
    planId: parsed.data.planId,
    todoItemId,
    feedback: parsed.data.feedback,
  }, logger)

  return c.json<ApiResponse<TodoFeedbackResponse>>({
    success: true,
    data,
  })
})

export default todosRoutes
