import { Hono } from 'hono'
import { z } from 'zod'
import type { Logger } from 'pino'
import type {
  ApiResponse,
  ScheduledTaskListResponse,
  ScheduledTaskMutationResponse,
  ScheduledTaskCalendarSyncPendingResponse,
  ScheduledTaskCalendarSyncReportResponse,
} from '@health-agent/shared'
import { authMiddleware } from '../middleware/auth.js'
import { requireActiveAccount } from '../middleware/active-account.js'
import {
  listManageableScheduledTasks,
  listPendingScheduledTaskCalendarSyncPlans,
  recordScheduledTaskCalendarSyncResult,
  updateScheduledTaskById,
  scheduleProactiveMessage,
  updateScheduledTaskByDisplayId,
} from '../services/scheduled-proactive-message.js'
import {
  findLatestConsumedCompletionReminderIntent,
  markCompletionReminderIntentScheduled,
} from '../services/intervention-followup-intent.js'
import { appendSessionEvent } from '../services/session-events.js'
import { applyScheduleConfirmationToMessage } from '../services/message.js'
import { getSession } from '../services/session.js'
import { safeRecordAnalyticsEvent } from '../services/analytics.js'
import { safeTrackBackendEvent } from '../services/tracking.js'

const scheduledTaskRoutes = new Hono()

scheduledTaskRoutes.use('*', authMiddleware)
scheduledTaskRoutes.use('*', requireActiveAccount)

const platformSchema = z.enum(['android', 'ios', 'harmony'])

const pendingSchema = z.object({
  platform: platformSchema,
  deviceKey: z.string().trim().min(1).max(256),
})

const reportSchema = z.object({
  scheduledTaskId: z.string().uuid(),
  platform: platformSchema,
  deviceKey: z.string().trim().min(1).max(256),
  planHash: z.string().trim().min(1).max(120),
  action: z.enum(['upsert', 'delete']),
  status: z.enum(['synced', 'failed', 'deleted']),
  externalIds: z.array(z.string().trim().min(1).max(256)).max(100).optional(),
  error: z.string().trim().max(1000).nullable().optional(),
})

const taskIdSchema = z.string().uuid()

const updateTaskSchema = z.object({
  taskName: z.string().trim().min(1).max(120).optional(),
  message: z.string().trim().min(1).max(800).optional(),
  scheduleType: z.enum(['once', 'cron']).optional(),
  dueAt: z.string().trim().datetime().optional(),
  cronExpression: z.string().trim().min(1).max(160).nullable().optional(),
  timezone: z.string().trim().min(1).max(64).nullable().optional(),
  appNotifyEnabled: z.boolean().optional(),
  calendarSyncEnabled: z.boolean().optional(),
})

scheduledTaskRoutes.get('/', async (c) => {
  const userId = c.get('userId')
  const data = await listManageableScheduledTasks(userId)
  const payload: ApiResponse<ScheduledTaskListResponse> = { success: true, data }
  return c.json(payload)
})

scheduledTaskRoutes.put('/:id', async (c) => {
  const logger = c.get('logger')
  const userId = c.get('userId')
  const id = taskIdSchema.safeParse(c.req.param('id'))
  if (!id.success) {
    return c.json({ success: false, error: '提醒 ID 不合法' }, 400)
  }
  const parsed = updateTaskSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) {
    return c.json({ success: false, error: parsed.error.issues[0]?.message ?? '参数错误' }, 400)
  }

  try {
    const item = await updateScheduledTaskById(
      {
        userId,
        id: id.data,
        taskName: parsed.data.taskName,
        message: parsed.data.message,
        dueAt: parsed.data.dueAt ? new Date(parsed.data.dueAt) : null,
        scheduleType: parsed.data.scheduleType,
        cronExpression: parsed.data.cronExpression,
        timezone: parsed.data.timezone,
        appNotifyEnabled: parsed.data.appNotifyEnabled,
        calendarSyncEnabled: parsed.data.calendarSyncEnabled,
      },
      logger,
    )
    const payload: ApiResponse<ScheduledTaskMutationResponse> = { success: true, data: { item } }
    return c.json(payload)
  } catch (err) {
    return c.json({ success: false, error: err instanceof Error ? err.message : '更新提醒失败' }, 400)
  }
})

scheduledTaskRoutes.delete('/:id', async (c) => {
  const logger = c.get('logger')
  const userId = c.get('userId')
  const id = taskIdSchema.safeParse(c.req.param('id'))
  if (!id.success) {
    return c.json({ success: false, error: '提醒 ID 不合法' }, 400)
  }

  try {
    const item = await updateScheduledTaskById(
      {
        userId,
        id: id.data,
        status: 'deleted',
      },
      logger,
    )
    const payload: ApiResponse<ScheduledTaskMutationResponse> = { success: true, data: { item } }
    return c.json(payload)
  } catch (err) {
    return c.json({ success: false, error: err instanceof Error ? err.message : '删除提醒失败' }, 400)
  }
})

scheduledTaskRoutes.post('/calendar-sync/pending', async (c) => {
  const userId = c.get('userId')
  const parsed = pendingSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) {
    return c.json({ success: false, error: parsed.error.issues[0]?.message ?? '参数错误' }, 400)
  }

  const data = await listPendingScheduledTaskCalendarSyncPlans({
    userId,
    platform: parsed.data.platform,
    deviceKey: parsed.data.deviceKey,
  })
  const payload: ApiResponse<ScheduledTaskCalendarSyncPendingResponse> = { success: true, data }
  return c.json(payload)
})

scheduledTaskRoutes.post('/calendar-sync/report', async (c) => {
  const userId = c.get('userId')
  const parsed = reportSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) {
    return c.json({ success: false, error: parsed.error.issues[0]?.message ?? '参数错误' }, 400)
  }

  const saved = await recordScheduledTaskCalendarSyncResult(userId, parsed.data)
  const payload: ApiResponse<ScheduledTaskCalendarSyncReportResponse> = { success: true, data: { saved } }
  return c.json(payload)
})

// ─── Agent 确认卡：schedule 工具 add/update/delete 需用户点击确认后才落库 ───

async function resolveOwnedSessionId(
  userId: string,
  sessionId: unknown,
  logger: Logger,
): Promise<string | null> {
  if (typeof sessionId !== 'string' || !sessionId) return null
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionId)) {
    logger.warn({ userId }, 'schedule confirmation session event skipped: invalid session id')
    return null
  }
  const session = await getSession(sessionId, logger)
  if (!session || session.userId !== userId) {
    logger.warn({ userId }, 'schedule confirmation session event skipped: session not found or not owner')
    return null
  }
  return sessionId
}

const pendingTaskSchema = z.object({
  action: z.enum(['add', 'update', 'delete']),
  targetTaskId: z.number().int().positive().nullable(),
  taskName: z.string().trim().min(1).max(120).nullable(),
  message: z.string().trim().min(1).max(800).nullable(),
  dueAt: z.string().trim().datetime().nullable(),
  scheduleType: z.enum(['once', 'cron']).nullable(),
  cronExpression: z.string().trim().min(1).max(160).nullable(),
  timezone: z.string().trim().min(1).max(64).nullable(),
})

const confirmSchema = z.object({
  confirmationId: z.string().trim().min(1).max(64),
  toolCallId: z.string().trim().min(1).max(128).optional(),
  messageId: z.string().trim().uuid().optional(),
  sessionId: z.string().trim().min(1).optional(),
  pendingTask: pendingTaskSchema,
})

const rejectSchema = z.object({
  confirmationId: z.string().trim().min(1).max(64),
  toolCallId: z.string().trim().min(1).max(128).optional(),
  messageId: z.string().trim().uuid().optional(),
  sessionId: z.string().trim().min(1).optional(),
  action: z.enum(['add', 'update', 'delete']),
  taskName: z.string().trim().min(1).max(120).nullable().optional(),
})

// POST /api/scheduled-tasks/confirm — 用户在确认卡点"确认"后调用，真正落库
scheduledTaskRoutes.post('/confirm', async (c) => {
  const logger = c.get('logger')
  const userId = c.get('userId')
  const parsed = confirmSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) {
    return c.json({ success: false, error: parsed.error.issues[0]?.message ?? '参数错误' }, 400)
  }
  const { pendingTask, sessionId } = parsed.data

  // 执行后拿到目标提醒的真实 UUID（add 新建 / update/delete 命中行），仅用于前端结果卡深链跳转；
  // 模型只用简单编号 targetTaskId，UUID 不进 LLM 上下文。delete 后行已软删，不暴露跳转 id。
  let scheduledTaskId: string | undefined
  try {
    if (pendingTask.action === 'add') {
      if (!pendingTask.dueAt) throw new Error('缺少提醒时间')
      const sid = typeof sessionId === 'string' ? sessionId : ''
      const completionReminderIntent = sid
        ? await findLatestConsumedCompletionReminderIntent(userId, sid)
        : null
      const scheduleType = pendingTask.scheduleType ?? 'once'
      const dedupeKey = completionReminderIntent
        ? `intervention_completion_reminder:${completionReminderIntent.engagementId}`
        : `scheduled_proactive:${sid}:${scheduleType}:${pendingTask.cronExpression ?? pendingTask.dueAt}:${(pendingTask.message ?? '').slice(0, 40)}`
      const row = await scheduleProactiveMessage({
        userId,
        sessionId: sid,
        purpose: completionReminderIntent ? 'intervention_completion_reminder' : 'custom',
        taskName: pendingTask.taskName ?? '',
        dueAt: new Date(pendingTask.dueAt),
        scheduleType,
        cronExpression: pendingTask.cronExpression,
        timezone: pendingTask.timezone,
        timeSource: 'user_explicit',
        messageContent: pendingTask.message ?? '',
        pushAlert: pendingTask.message ?? '',
        entityType: completionReminderIntent ? 'intervention_material_engagement' : null,
        entityId: completionReminderIntent?.engagementId ?? null,
        dedupeKey,
        metadata: completionReminderIntent?.metadata ?? null,
      }, logger)
      if (completionReminderIntent) {
        await markCompletionReminderIntentScheduled(completionReminderIntent.intentId)
      }
      scheduledTaskId = row.id
      logger.info({ userId, scheduledMessageId: row.id }, 'schedule confirmation: task created')
    } else {
      if (!pendingTask.targetTaskId) throw new Error('缺少目标任务 ID')
      const row = await updateScheduledTaskByDisplayId({
        userId,
        taskId: pendingTask.targetTaskId,
        taskName: pendingTask.action === 'delete' ? null : pendingTask.taskName,
        message: pendingTask.action === 'delete' ? null : pendingTask.message,
        dueAt: pendingTask.dueAt ? new Date(pendingTask.dueAt) : null,
        scheduleType: pendingTask.scheduleType,
        cronExpression: pendingTask.cronExpression,
        timezone: pendingTask.timezone,
        status: pendingTask.action === 'delete' ? 'deleted' : null,
      }, logger)
      // delete 后提醒已软删，详情页查不到，不提供跳转 id；update 命中行可跳转
      if (pendingTask.action === 'update') scheduledTaskId = row.id
      logger.info({ userId, taskId: pendingTask.targetTaskId, action: pendingTask.action }, 'schedule confirmation: task updated')
    }

    // 记录 session-event，下一轮 LLM 通过 <system-reminder> 感知"已确认并执行"
    const ownedSessionId = await resolveOwnedSessionId(userId, sessionId, logger)
    if (ownedSessionId) {
      await appendSessionEvent(
        ownedSessionId,
        { type: 'schedule_confirmed', scheduleAction: pendingTask.action, scheduleTaskName: pendingTask.taskName },
        logger,
      )
      // 把终态写进该 assistant 消息的 processTimeline，供历史页/分享页只读重放
      if (parsed.data.messageId && parsed.data.toolCallId) {
        await applyScheduleConfirmationToMessage(
          { sessionId: ownedSessionId, messageId: parsed.data.messageId, toolCallId: parsed.data.toolCallId, status: 'confirmed', scheduledTaskId },
          logger,
        )
      }
    }

    const analyticsEvent = {
      userId,
      sessionId: ownedSessionId ?? (typeof sessionId === 'string' ? sessionId : null),
      eventName: 'schedule_confirmation_confirmed',
      dedupeKey: parsed.data.confirmationId,
      entityType: 'scheduled_task',
      entityId: pendingTask.targetTaskId != null ? String(pendingTask.targetTaskId) : null,
      properties: {
        confirmationId: parsed.data.confirmationId,
        toolCallId: parsed.data.toolCallId ?? null,
        action: pendingTask.action,
      },
    } as const
    await safeRecordAnalyticsEvent(analyticsEvent, logger)
    safeTrackBackendEvent(analyticsEvent, logger, c.get('trackingContext'))

    return c.json({ success: true, data: { action: pendingTask.action, taskId: scheduledTaskId ?? null } })
  } catch (err) {
    logger.warn({ userId, err }, 'schedule confirmation execute failed')
    return c.json({ success: false, error: err instanceof Error ? err.message : '提醒操作执行失败' }, 400)
  }
})

// POST /api/scheduled-tasks/reject — 用户在确认卡点"拒绝"后调用，仅登记，不落库
scheduledTaskRoutes.post('/reject', async (c) => {
  const logger = c.get('logger')
  const userId = c.get('userId')
  const parsed = rejectSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) {
    return c.json({ success: false, error: parsed.error.issues[0]?.message ?? '参数错误' }, 400)
  }
  const { action, taskName, sessionId } = parsed.data

  const ownedSessionId = await resolveOwnedSessionId(userId, sessionId, logger)
  if (ownedSessionId) {
    await appendSessionEvent(
      ownedSessionId,
      { type: 'schedule_rejected', scheduleAction: action, scheduleTaskName: taskName ?? null },
      logger,
    )
    // 把"已拒绝"终态写进该 assistant 消息的 processTimeline，供历史页/分享页只读重放
    if (parsed.data.messageId && parsed.data.toolCallId) {
      await applyScheduleConfirmationToMessage(
        { sessionId: ownedSessionId, messageId: parsed.data.messageId, toolCallId: parsed.data.toolCallId, status: 'rejected' },
        logger,
      )
    }
  }

  const analyticsEvent = {
    userId,
    sessionId: ownedSessionId ?? (typeof sessionId === 'string' ? sessionId : null),
    eventName: 'schedule_confirmation_rejected',
    dedupeKey: parsed.data.confirmationId,
    entityType: 'scheduled_task',
    entityId: null,
    properties: {
      confirmationId: parsed.data.confirmationId,
      toolCallId: parsed.data.toolCallId ?? null,
      action,
    },
  } as const
  await safeRecordAnalyticsEvent(analyticsEvent, logger)
  safeTrackBackendEvent(analyticsEvent, logger, c.get('trackingContext'))

  return c.json({ success: true, data: { action } })
})

export default scheduledTaskRoutes
