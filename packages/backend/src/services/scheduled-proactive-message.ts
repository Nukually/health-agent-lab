import { createHash, randomUUID } from 'node:crypto'
import { and, asc, eq, gt, inArray, lte, type SQL } from 'drizzle-orm'
import { Cron } from 'croner'
import type {
  PushPlatform,
  ScheduledProactiveMessageScheduleType,
  ScheduledProactiveMessagePurpose,
  ScheduledProactiveMessageStatus,
  ScheduledProactiveMessageTimeSource,
  ScheduledTaskCalendarSyncAction,
  ScheduledTaskListResponse,
  ScheduledTaskManageItem,
  ScheduledTaskCalendarSyncPendingResponse,
  ScheduledTaskCalendarSyncPlan,
  ScheduledTaskCalendarSyncReportRequest,
  MedicalRiskResource,
  ToolCallRecord,
  TodoItemClosedReason,
  TodoItemStatus,
  TodoPlanStatus,
} from '@health-agent/shared'
import { getDb } from '../db/client.js'
import {
  chatSessions,
  messages,
  scheduledProactiveMessages,
  scheduledTaskCalendarLinks,
  todoItems,
  todoPlans,
  users,
} from '../db/schema/index.js'
import type { Logger } from '../lib/logger.js'
import { withCronLock } from '../cron/lock.js'
import { estimateTextTokens } from '../utils/tokens.js'
import { pushToUser } from './push.js'
import { listActivePushDevices } from './push-device.js'
import type { ResolvedClientEnvironment } from './client-environment.js'
import { SYNTHETIC_SCHEDULED_TODO_TRIGGER_MARKER } from '../utils/repeated-user-message.js'

const SCHEDULED_BATCH_LIMIT = 20
const SCHEDULED_LOCK_TTL_SECONDS = 55
const MAX_ATTEMPTS = 3
const FUTURE_TASK_LIMIT = 100
const OVERDUE_SEND_GRACE_MS = 2 * 60 * 1000
const DEFAULT_SCHEDULE_TIMEZONE = 'Asia/Shanghai'
const MIN_CRON_INTERVAL_MS = 5 * 60 * 1000
const CALENDAR_EVENT_DURATION_MS = 30 * 60 * 1000
const CALENDAR_OCCURRENCE_LIMIT = 100
const CALENDAR_OCCURRENCE_WINDOW_MS = 90 * 24 * 60 * 60 * 1000
const PURPOSES = new Set<ScheduledProactiveMessagePurpose>([
  'intervention_completion_reminder',
  'medication_reminder',
  'review_reminder',
  'custom',
])
const TIME_SOURCES = new Set<ScheduledProactiveMessageTimeSource>([
  'user_explicit',
  'ai_inferred_default',
])

type ScheduledRow = typeof scheduledProactiveMessages.$inferSelect

export interface ScheduledTodoMetadata {
  type: 'todo_item'
  todoPlanId: string
  todoItemId: string
  resourceRefId?: string | null
  courseDays?: number | null
  targetSideEffect?: string | null
  resource?: MedicalRiskResource | null
}

export interface ScheduledTodoRawResponse {
  kind: 'scheduled_todo'
  scheduledMessageId: string
  metadata: ScheduledTodoMetadata
}

export interface FutureScheduledTaskSummary {
  taskId: number
  rowId: string
  purpose: ScheduledProactiveMessagePurpose
  taskName: string
  message: string
  createdAt: string
  dueAt: string
  scheduleType: ScheduledProactiveMessageScheduleType
  cronExpression: string | null
  timezone: string
  status: ScheduledProactiveMessageStatus
  entityType: string | null
  entityId: string | null
}

export interface ParsedScheduledTimeInput {
  scheduleType: ScheduledProactiveMessageScheduleType
  dueAt: Date
  cronExpression: string | null
  timezone: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

export function isScheduledTodoMetadata(value: unknown): value is ScheduledTodoMetadata {
  if (!isRecord(value)) return false
  return value.type === 'todo_item'
    && typeof value.todoPlanId === 'string'
    && value.todoPlanId.length > 0
    && typeof value.todoItemId === 'string'
    && value.todoItemId.length > 0
}

export function buildScheduledTodoRawResponse(input: {
  scheduledMessageId: string
  metadata: ScheduledTodoMetadata
}): ScheduledTodoRawResponse {
  return {
    kind: 'scheduled_todo',
    scheduledMessageId: input.scheduledMessageId,
    metadata: input.metadata,
  }
}

export function scheduledTodoMetadataFromRawResponse(value: unknown): ScheduledTodoMetadata | null {
  if (!isRecord(value) || value.kind !== 'scheduled_todo') return null
  return isScheduledTodoMetadata(value.metadata) ? value.metadata : null
}

function toManageItem(row: ScheduledRow): ScheduledTaskManageItem {
  return {
    id: row.id,
    taskName: row.taskName,
    message: row.messageContent,
    purpose: row.purpose,
    scheduleType: row.scheduleType,
    dueAt: row.dueAt.toISOString(),
    cronExpression: row.cronExpression,
    timezone: row.timezone || DEFAULT_SCHEDULE_TIMEZONE,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    appNotifyEnabled: row.appNotifyEnabled,
    calendarSyncEnabled: row.calendarSyncEnabled,
  }
}

const LOW_SPECIFICITY_TASK_NAMES = new Set([
  '提醒',
  '定时提醒',
  '用药提醒',
  '服药提醒',
  '吃药提醒',
  '复查提醒',
  '检查提醒',
  '跟练提醒',
  '练习提醒',
  '完成提醒',
  '完成跟练',
  '完成跟练卡',
])

const OVER_INFERRED_TASK_CONTEXT_PREFIXES = [
  '化疗后',
  '化疗期间',
  '化疗中',
  '放疗后',
  '放疗期间',
  '放疗中',
  '靶向治疗后',
  '靶向治疗期间',
  '靶向后',
  '靶向期间',
  '内分泌治疗后',
  '内分泌治疗期间',
  '免疫治疗后',
  '免疫治疗期间',
  '手术后',
  '术后',
  '乳腺癌治疗后',
  '乳腺癌术后',
  '乳腺结节随访期',
]

const MEDICATION_NAME_PATTERNS = [
  '他莫西芬',
  '他莫昔芬',
  '托瑞米芬',
  '来曲唑',
  '阿那曲唑',
  '依西美坦',
  '卡培他滨',
  '吡咯替尼',
  '曲妥珠单抗',
  '帕妥珠单抗',
  '戈舍瑞林',
  '亮丙瑞林',
  '氟维司群',
  '奥拉帕利',
  '阿贝西利',
  '瑞波西利',
]

function trimText(value: string | null | undefined, max: number): string | null {
  const trimmed = value?.trim()
  if (!trimmed) return null
  return trimmed.slice(0, max)
}

function normalizeCronExpression(value: string): string {
  return value.trim().replace(/\s+/g, ' ')
}

function cronParts(value: string): string[] {
  return normalizeCronExpression(value).split(' ').filter(Boolean)
}

function looksLikeCronExpression(value: string): boolean {
  const parts = cronParts(value)
  return parts.length >= 5 && parts.length <= 7
}

function parseCronNextRuns(params: {
  expression: string
  timezone?: string
  now?: Date
  count: number
}): Date[] {
  const timezone = params.timezone ?? DEFAULT_SCHEDULE_TIMEZONE
  const now = params.now ?? new Date()
  const job = new Cron(params.expression, { timezone, paused: true })
  return job.nextRuns(params.count, now).filter((date): date is Date =>
    date instanceof Date && Number.isFinite(date.getTime()))
}

function validateCronExpression(params: {
  expression: string
  timezone?: string
  now?: Date
}): { dueAt: Date; error: string | null } {
  const expression = normalizeCronExpression(params.expression)
  const parts = cronParts(expression)
  if (parts.length < 5 || parts.length > 7) {
    return { dueAt: new Date(NaN), error: 'cron 表达式必须是 5、6 或 7 个字段' }
  }

  try {
    const nextRuns = parseCronNextRuns({
      expression,
      timezone: params.timezone,
      now: params.now,
      count: 2,
    })
    const dueAt = nextRuns[0]
    if (!dueAt) return { dueAt: new Date(NaN), error: 'cron 表达式没有未来触发时间' }
    const next = nextRuns[1]
    if (next && next.getTime() - dueAt.getTime() < MIN_CRON_INTERVAL_MS) {
      return { dueAt, error: 'cron 表达式触发过于频繁，最小间隔不能低于 5 分钟' }
    }
    return { dueAt, error: null }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { dueAt: new Date(NaN), error: `cron 表达式不合法：${message}` }
  }
}

export function parseScheduledTimeInput(params: {
  time: string
  now?: Date
  timezone?: string
}): ParsedScheduledTimeInput {
  const raw = params.time.trim()
  if (!raw) throw new Error('time 不能为空')
  const timezone = trimText(params.timezone, 64) ?? DEFAULT_SCHEDULE_TIMEZONE

  if (looksLikeCronExpression(raw)) {
    const cronExpression = normalizeCronExpression(raw)
    const { dueAt, error } = validateCronExpression({
      expression: cronExpression,
      timezone,
      now: params.now,
    })
    if (error) throw new Error(error)
    return {
      scheduleType: 'cron',
      dueAt,
      cronExpression,
      timezone,
    }
  }

  const dueAt = new Date(raw)
  const validationError = validateScheduledProactiveDueAt({
    dueAt,
    now: params.now,
    timeSource: 'user_explicit',
  })
  if (validationError) throw new Error(validationError)
  return {
    scheduleType: 'once',
    dueAt,
    cronExpression: null,
    timezone,
  }
}

function nextCronDueAtAfter(row: ScheduledRow, after: Date): Date | null {
  if (row.scheduleType !== 'cron' || !row.cronExpression) return null
  const nextRuns = parseCronNextRuns({
    expression: row.cronExpression,
    timezone: row.timezone || DEFAULT_SCHEDULE_TIMEZONE,
    now: after,
    count: 1,
  })
  return nextRuns[0] ?? null
}

function buildChatRoute(sessionId: string, messageId: string): string {
  return `/chat/${sessionId}?focusMessageId=${encodeURIComponent(messageId)}`
}

function futureTaskStatuses(): ScheduledProactiveMessageStatus[] {
  return ['pending', 'processing']
}

export function assignStableScheduledTaskDisplayIds<T extends { id: string; createdAt: Date }>(
  rows: readonly T[],
): Map<string, number> {
  const sorted = [...rows].sort((a, b) =>
    a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id)
  )
  return new Map(sorted.map((row, index) => [row.id, index + 1]))
}

export function shouldSkipOverdueScheduledTask(
  dueAt: Date,
  now = new Date(),
  graceMs = OVERDUE_SEND_GRACE_MS,
): boolean {
  return now.getTime() - dueAt.getTime() > graceMs
}

function metadataText(metadata: Record<string, unknown> | null | undefined, key: string): string | null {
  const value = metadata?.[key]
  if (typeof value !== 'string') return null
  return trimText(value, 40)
}

function isLowSpecificityTaskName(taskName: string): boolean {
  return LOW_SPECIFICITY_TASK_NAMES.has(taskName.replace(/\s+/g, ''))
}

function stripOverInferredTaskContextPrefix(taskName: string): string {
  const compact = taskName.replace(/\s+/g, '')
  const prefix = OVER_INFERRED_TASK_CONTEXT_PREFIXES.find((item) => compact.startsWith(item))
  if (!prefix) return taskName

  const stripped = compact.slice(prefix.length)
  if (!stripped || stripped === '提醒') return taskName
  return stripped.slice(0, 120)
}

function inferMedicationTaskName(text: string): string | null {
  const hit = MEDICATION_NAME_PATTERNS.find((name) => text.includes(name))
  return hit ? `${hit}用药提醒` : null
}

export function refineScheduledTaskNameForCreate(input: {
  taskName: string
  purpose: ScheduledProactiveMessagePurpose
  messageContent: string
  metadata?: Record<string, unknown> | null
}): string {
  const rawTaskName = trimText(input.taskName, 120)
  const taskName = rawTaskName ? stripOverInferredTaskContextPrefix(rawTaskName) : null
  if (!taskName) throw new Error('task 不能为空')
  if (!isLowSpecificityTaskName(taskName)) return taskName

  if (input.purpose === 'intervention_completion_reminder') {
    const sideEffect = metadataText(input.metadata, 'sideEffect')
    if (sideEffect) return `完成${sideEffect}跟练卡`.slice(0, 120)

    const actionName = metadataText(input.metadata, 'actionName')
    if (actionName && actionName !== '这张跟练卡') return `完成${actionName}跟练卡`.slice(0, 120)
  }

  const medicationTaskName = inferMedicationTaskName(`${taskName}\n${input.messageContent}`)
  if (medicationTaskName) return medicationTaskName

  return taskName
}

export async function listFutureScheduledTasks(
  userId: string,
  now = new Date(),
): Promise<FutureScheduledTaskSummary[]> {
  const rows = await getDb().query.scheduledProactiveMessages.findMany({
    where: eq(scheduledProactiveMessages.userId, userId),
    orderBy: [
      asc(scheduledProactiveMessages.createdAt),
      asc(scheduledProactiveMessages.id),
    ],
  })
  const displayIds = assignStableScheduledTaskDisplayIds(rows)

  return rows
    .filter((row) =>
      futureTaskStatuses().includes(row.status) && row.dueAt.getTime() > now.getTime()
    )
    .slice(0, FUTURE_TASK_LIMIT)
    .map((row) => ({
      taskId: displayIds.get(row.id) ?? 0,
      rowId: row.id,
      purpose: row.purpose,
      taskName: row.taskName,
      message: row.messageContent,
      createdAt: row.createdAt.toISOString(),
      dueAt: row.dueAt.toISOString(),
      status: row.status,
      scheduleType: row.scheduleType,
      cronExpression: row.cronExpression,
      timezone: row.timezone,
      entityType: row.entityType,
      entityId: row.entityId,
    }))
}

export async function listManageableScheduledTasks(
  userId: string,
  now = new Date(),
): Promise<ScheduledTaskListResponse> {
  const rows = await getDb().query.scheduledProactiveMessages.findMany({
    where: and(
      eq(scheduledProactiveMessages.userId, userId),
      inArray(scheduledProactiveMessages.status, futureTaskStatuses()),
      gt(scheduledProactiveMessages.dueAt, now),
    ),
    orderBy: asc(scheduledProactiveMessages.dueAt),
    limit: FUTURE_TASK_LIMIT,
  })

  const periodic: ScheduledTaskManageItem[] = []
  const timeline: ScheduledTaskManageItem[] = []
  for (const row of rows) {
    // 跟练计划的每日子提醒（entityType=todo_item）单独在「跟练计划」Tab 的月历里展示，
    // 不再平铺混入普通提醒列表。
    if (row.entityType === 'todo_item') continue
    const item = toManageItem(row)
    if (row.scheduleType === 'cron') periodic.push(item)
    else timeline.push(item)
  }
  return { periodic, timeline }
}

function scheduleLabel(item: {
  scheduleType: ScheduledProactiveMessageScheduleType
  cronExpression: string | null
  timezone: string
}): string {
  if (item.scheduleType === 'cron') {
    return `cron｜${item.cronExpression ?? '未记录'}｜时区：${item.timezone || DEFAULT_SCHEDULE_TIMEZONE}`
  }
  return '一次性'
}

export function renderFutureScheduledTasksForTool(items: FutureScheduledTaskSummary[]): string {
  if (items.length === 0) return '当前没有未来定时任务。'
  return [
    '当前未来定时任务（ID 是用户维度稳定编号，历史已删除/已发送任务会占号，不一定连续）：',
    ...items.map((item) =>
      `- ID ${item.taskId}｜任务：${item.taskName}｜类型：${scheduleLabel(item)}｜状态：${item.status}｜创建时间：${item.createdAt}｜下一次触发时间：${item.dueAt}｜消息：${item.message}`
    ),
  ].join('\n')
}

export function renderScheduledTaskCreationResultForTool(params: {
  currentTask: {
    taskId: number | string | null
    taskName: string
    dueAt: string
    status: ScheduledProactiveMessageStatus
    message: string
  }
  previousTasks: FutureScheduledTaskSummary[]
  wasAlreadyExisting?: boolean
  isFirstScheduledTaskCreation?: boolean
  clientEnvironment?: ResolvedClientEnvironment
  shouldRecommendMobileApp?: boolean
}): string {
  const taskId = params.currentTask.taskId ?? '未知'
  const env = params.clientEnvironment
  const firstCreationGuidance = params.isFirstScheduledTaskCreation
    ? renderFirstScheduledTaskCreationGuidance(env)
    : []
  const mobileAppGuidance = params.shouldRecommendMobileApp && !params.isFirstScheduledTaskCreation
    ? [
        '移动端提醒建议：请在最终回复里简短提醒用户：当前是在网页端设置提醒；网页无法直接写入手机系统日历，也无法直接发出手机本机提醒。如需手机提醒更稳妥，请安装或打开Health Agent Lab App，并开启通知权限。',
      ]
    : []
  return [
    '定时任务创建结果：',
    `${params.wasAlreadyExisting ? '本次任务（已存在，未重复新增）' : '本次新增'}：ID ${taskId}｜任务：${params.currentTask.taskName}｜状态：${params.currentTask.status}｜下一次触发时间：${params.currentTask.dueAt}｜消息：${params.currentTask.message}`,
    ...firstCreationGuidance,
    ...mobileAppGuidance,
    '用户此前已有未来任务：',
    ...(params.previousTasks.length > 0
      ? params.previousTasks.map((item) =>
          `- ID ${item.taskId}｜任务：${item.taskName}｜类型：${scheduleLabel(item)}｜状态：${item.status}｜创建时间：${item.createdAt}｜下一次触发时间：${item.dueAt}｜消息：${item.message}`
        )
      : ['- 无']),
    '后续处理提醒：请检查本次任务与此前任务是否重复、时间过近或主题冲突。若有冲突，先向用户确认要保留、修改还是取消哪一个；用户确认后再调用 schedule action=update 更新任务，或用 action=delete 删除对应任务。不要自行删除用户此前任务。',
  ].join('\n')
}

function renderFirstScheduledTaskCreationGuidance(
  clientEnvironment: ResolvedClientEnvironment | undefined,
): string[] {
  const label = clientEnvironment?.label ?? '未知'
  const permissionLine = '- 请提醒用户打开Health Agent Lab的通知权限；如果系统询问日历权限，也请允许，这样提醒才能写入手机日历并按时触达。'

  if (clientEnvironment?.isNativeApp) {
    return [
      '首次提醒创建后的用户可见说明：',
      '- 请在最终回复里自然提醒用户：这条提醒会设置到用户的手机日历里，同时Health Agent Lab App 到时间也会发送消息推送。',
      permissionLine,
      `- 当前识别的用户环境：${label}。已确认用户正在使用Health Agent Lab App；最终回复不要再引导获取客户端或测试版本。`,
    ]
  }

  return [
    '首次提醒创建后的用户可见说明：',
    '- 请在最终回复里自然提醒用户：在Health Agent Lab App 内，这条提醒会设置到用户的手机日历里，同时 App 到时间也会发送消息推送。',
    permissionLine,
    `- 当前识别的用户环境：${label}。${installGuidanceForClientEnvironment(clientEnvironment)}`,
  ]
}

function installGuidanceForClientEnvironment(
  clientEnvironment: ResolvedClientEnvironment | undefined,
): string {
  switch (clientEnvironment?.platform) {
    case 'ios':
      return '如果用户尚未安装 App，可提示 iOS 先下载 TestFlight，再通过Health Agent Lab beta 测试邀请安装。'
    case 'android':
      return '如果用户尚未安装 App，可提示安卓用户使用测试 APK 安装。'
    case 'harmony':
      return '如果用户尚未安装 App，可提示鸿蒙用户通过指定链接安装。'
    default:
      return '如果用户当前不是在 App 内使用，可提示先安装或打开Health Agent Lab App，并登录同一账号。'
  }
}

export function renderScheduledTaskUpdateResultForTool(params: {
  taskId: number
  dueAt: string
  status: ScheduledProactiveMessageStatus
  requiresManualCalendarUpdate?: boolean
}): string {
  const lines = [
    params.status === 'deleted'
      ? `已删除定时任务 ID：${params.taskId}。`
      : `已更新定时任务 ID：${params.taskId}，触发时间：${params.dueAt}。`,
  ]

  if (params.requiresManualCalendarUpdate) {
    lines.push(
      '手机日历同步提醒：这条提醒此前写入移动端日历时没有拿到系统日历事件 ID，Health Agent Lab App 内提醒已更新；但手机系统日历里的对应提醒无法自动修改或删除。请在最终回复里自然提醒用户到手机日历中手动处理这条提醒。',
    )
  }

  return lines.join('\n')
}

export async function hasAnyScheduledTaskForUser(userId: string): Promise<boolean> {
  const db = getDb()
  const row = await db.query.scheduledProactiveMessages.findFirst({
    columns: { id: true },
    where: eq(scheduledProactiveMessages.userId, userId),
    orderBy: asc(scheduledProactiveMessages.createdAt),
  })
  return !!row
}

export function renderFutureScheduledTasksForFollowupContext(items: FutureScheduledTaskSummary[]): string {
  if (items.length === 0) return '用户当前没有未来定时任务。'
  return [
    '用户当前已有未来定时任务（用于避免重复追问或重复创建；ID 是用户维度稳定编号，历史已删除/已发送任务会占号，不一定连续）：',
    ...items.map((item) =>
      `- ID ${item.taskId}｜任务：${item.taskName}｜类型：${scheduleLabel(item)}｜状态：${item.status}｜创建时间：${item.createdAt}｜下一次触发时间：${item.dueAt}｜消息：${item.message}`
    ),
  ].join('\n')
}

export function validateScheduledProactiveDueAt(params: {
  dueAt: Date
  now?: Date
  timeSource: ScheduledProactiveMessageTimeSource
}): string | null {
  const now = params.now ?? new Date()
  const delayMs = params.dueAt.getTime() - now.getTime()
  if (!Number.isFinite(params.dueAt.getTime())) return 'time 不是合法时间'
  if (delayMs <= 0) return 'time 必须是未来时间'
  return null
}

export async function scheduleProactiveMessage(
  input: {
    userId: string
    sessionId: string
    purpose: ScheduledProactiveMessagePurpose
    timeSource: ScheduledProactiveMessageTimeSource
    scheduleType?: ScheduledProactiveMessageScheduleType
    cronExpression?: string | null
    timezone?: string | null
    taskName: string
    dueAt: Date
    messageContent: string
    pushTitle?: string | null
    pushAlert: string
    route?: string | null
    entityType?: string | null
    entityId?: string | null
    dedupeKey?: string | null
    metadata?: Record<string, unknown> | null
  },
  logger: Logger,
): Promise<ScheduledRow> {
  if (!PURPOSES.has(input.purpose)) throw new Error('purpose 不合法')
  if (!TIME_SOURCES.has(input.timeSource)) throw new Error('timeSource 不合法')
  const scheduleType = input.scheduleType ?? 'once'
  if (scheduleType !== 'once' && scheduleType !== 'cron') throw new Error('scheduleType 不合法')
  const timezone = trimText(input.timezone, 64) ?? DEFAULT_SCHEDULE_TIMEZONE
  const cronExpression = scheduleType === 'cron' ? trimText(input.cronExpression, 160) : null
  if (scheduleType === 'cron' && !cronExpression) throw new Error('cronExpression 不能为空')
  if (cronExpression) {
    const { error } = validateCronExpression({ expression: cronExpression, timezone })
    if (error) throw new Error(error)
  }
  const validationError = validateScheduledProactiveDueAt({
    dueAt: input.dueAt,
    timeSource: input.timeSource,
  })
  if (validationError) {
    throw new Error(validationError)
  }

  const messageContent = trimText(input.messageContent, 800)
  const pushAlert = trimText(input.pushAlert, 500)
  if (!messageContent) throw new Error('message 不能为空')
  if (!pushAlert) throw new Error('message 不能为空')
  const taskName = refineScheduledTaskNameForCreate({
    taskName: input.taskName,
    purpose: input.purpose,
    messageContent,
    metadata: input.metadata,
  })

  const db = getDb()
  const dedupeKey = trimText(input.dedupeKey, 160)
  if (dedupeKey) {
    const existing = await db.query.scheduledProactiveMessages.findFirst({
      where: and(
        eq(scheduledProactiveMessages.userId, input.userId),
        eq(scheduledProactiveMessages.dedupeKey, dedupeKey),
        inArray(scheduledProactiveMessages.status, ['pending', 'processing', 'sent'] satisfies ScheduledProactiveMessageStatus[]),
      ),
      orderBy: asc(scheduledProactiveMessages.createdAt),
    })
    if (existing) return existing
  }

  const futureTasks = await listFutureScheduledTasks(input.userId)
  if (futureTasks.length >= FUTURE_TASK_LIMIT) {
    throw new Error('当前已有 100 个未来定时任务，请先删除或修改已有任务。')
  }

  const now = new Date()
  const [row] = await db.insert(scheduledProactiveMessages).values({
    userId: input.userId,
    sessionId: input.sessionId,
    purpose: input.purpose,
    taskName,
    timeSource: input.timeSource,
    scheduleType,
    cronExpression,
    timezone,
    dueAt: input.dueAt,
    messageContent,
    pushTitle: trimText(input.pushTitle, 120) ?? 'Health Agent Lab',
    pushAlert,
    route: trimText(input.route, 500),
    entityType: trimText(input.entityType, 80),
    entityId: trimText(input.entityId, 160),
    dedupeKey,
    metadata: input.metadata ?? null,
    createdAt: now,
    updatedAt: now,
  }).returning()

  logger.info({
    scheduledMessageId: row.id,
    purpose: row.purpose,
    dueAt: row.dueAt.toISOString(),
  }, 'scheduled proactive message created')
  return row
}

export async function updateScheduledTaskByDisplayId(
  input: {
    userId: string
    taskId: number
    taskName?: string | null
    message?: string | null
    dueAt?: Date | null
    scheduleType?: ScheduledProactiveMessageScheduleType | null
    cronExpression?: string | null
    timezone?: string | null
    status?: 'deleted' | null
    appNotifyEnabled?: boolean | null
    calendarSyncEnabled?: boolean | null
  },
  logger: Logger,
): Promise<ScheduledRow> {
  const tasks = await listFutureScheduledTasks(input.userId)
  const target = tasks.find((item) => item.taskId === input.taskId)
  if (!target) throw new Error(`未找到 ID ${input.taskId} 的未来定时任务`)

  const patch: Partial<typeof scheduledProactiveMessages.$inferInsert> = {
    updatedAt: new Date(),
  }
  const taskName = trimText(input.taskName, 120)
  if (taskName) patch.taskName = taskName

  const message = trimText(input.message, 800)
  if (message) {
    patch.messageContent = message
    patch.pushAlert = message.slice(0, 500)
  }
  if (input.appNotifyEnabled != null) {
    patch.appNotifyEnabled = input.appNotifyEnabled
  }
  if (input.calendarSyncEnabled != null) {
    patch.calendarSyncEnabled = input.calendarSyncEnabled
  }

  if (input.dueAt) {
    const scheduleType = input.scheduleType ?? 'once'
    if (scheduleType !== 'once' && scheduleType !== 'cron') throw new Error('scheduleType 不合法')
    const timezone = trimText(input.timezone, 64) ?? DEFAULT_SCHEDULE_TIMEZONE
    const cronExpression = scheduleType === 'cron' ? trimText(input.cronExpression, 160) : null
    if (scheduleType === 'cron' && !cronExpression) throw new Error('cronExpression 不能为空')
    if (cronExpression) {
      const { error } = validateCronExpression({ expression: cronExpression, timezone })
      if (error) throw new Error(error)
    }
    const validationError = validateScheduledProactiveDueAt({
      dueAt: input.dueAt,
      timeSource: 'user_explicit',
    })
    if (validationError) throw new Error(validationError)
    patch.dueAt = input.dueAt
    patch.scheduleType = scheduleType
    patch.cronExpression = cronExpression
    patch.timezone = timezone
    patch.lastDueAt = null
  }

  if (input.status === 'deleted') {
    patch.status = 'deleted'
  }

  if (Object.keys(patch).length <= 1) {
    throw new Error('没有可更新的任务字段')
  }

  const [row] = await getDb().update(scheduledProactiveMessages)
    .set(patch)
    .where(and(
      eq(scheduledProactiveMessages.id, target.rowId),
      eq(scheduledProactiveMessages.userId, input.userId),
      inArray(scheduledProactiveMessages.status, futureTaskStatuses()),
    ))
    .returning()

  if (!row) throw new Error(`未找到 ID ${input.taskId} 的未来定时任务`)
  logger.info({ scheduledMessageId: row.id, taskId: input.taskId, status: row.status }, 'scheduled task updated')
  return row
}

export async function updateScheduledTaskById(
  input: {
    userId: string
    id: string
    taskName?: string | null
    message?: string | null
    dueAt?: Date | null
    scheduleType?: ScheduledProactiveMessageScheduleType | null
    cronExpression?: string | null
    timezone?: string | null
    status?: 'deleted' | null
    appNotifyEnabled?: boolean | null
    calendarSyncEnabled?: boolean | null
  },
  logger: Logger,
): Promise<ScheduledTaskManageItem> {
  const now = new Date()
  const existing = await getDb().query.scheduledProactiveMessages.findFirst({
    where: and(
      eq(scheduledProactiveMessages.id, input.id),
      eq(scheduledProactiveMessages.userId, input.userId),
      inArray(scheduledProactiveMessages.status, futureTaskStatuses()),
      gt(scheduledProactiveMessages.dueAt, now),
    ),
  })
  if (!existing) throw new Error('未找到这条未来提醒')

  const patch: Partial<typeof scheduledProactiveMessages.$inferInsert> = {
    updatedAt: now,
  }
  const taskName = trimText(input.taskName, 120)
  if (taskName) patch.taskName = taskName

  const message = trimText(input.message, 800)
  if (message) {
    patch.messageContent = message
    patch.pushAlert = message.slice(0, 500)
  }
  if (input.appNotifyEnabled != null) {
    patch.appNotifyEnabled = input.appNotifyEnabled
  }
  if (input.calendarSyncEnabled != null) {
    patch.calendarSyncEnabled = input.calendarSyncEnabled
  }

  const scheduleType = input.scheduleType ?? null
  const hasSchedulePatch = Boolean(input.dueAt || scheduleType || input.cronExpression !== undefined || input.timezone !== undefined)
  if (hasSchedulePatch) {
    const nextScheduleType = scheduleType ?? existing.scheduleType
    if (nextScheduleType !== 'once' && nextScheduleType !== 'cron') throw new Error('scheduleType 不合法')
    const timezone = trimText(input.timezone, 64) ?? existing.timezone ?? DEFAULT_SCHEDULE_TIMEZONE
    const cronExpression = nextScheduleType === 'cron'
      ? trimText(input.cronExpression ?? existing.cronExpression, 160)
      : null
    if (nextScheduleType === 'cron' && !cronExpression) throw new Error('cronExpression 不能为空')
    if (cronExpression) {
      const { dueAt, error } = validateCronExpression({ expression: cronExpression, timezone })
      if (error) throw new Error(error)
      patch.dueAt = dueAt
    } else {
      const dueAt = input.dueAt ?? existing.dueAt
      const validationError = validateScheduledProactiveDueAt({
        dueAt,
        timeSource: 'user_explicit',
      })
      if (validationError) throw new Error(validationError)
      patch.dueAt = dueAt
    }
    patch.scheduleType = nextScheduleType
    patch.cronExpression = cronExpression
    patch.timezone = timezone
    patch.lastDueAt = null
  }

  if (input.status === 'deleted') {
    patch.status = 'deleted'
  }

  if (Object.keys(patch).length <= 1) {
    throw new Error('没有可更新的提醒字段')
  }

  const [row] = await getDb().update(scheduledProactiveMessages)
    .set(patch)
    .where(and(
      eq(scheduledProactiveMessages.id, input.id),
      eq(scheduledProactiveMessages.userId, input.userId),
      inArray(scheduledProactiveMessages.status, futureTaskStatuses()),
    ))
    .returning()

  if (!row) throw new Error('未找到这条未来提醒')
  logger.info({ scheduledMessageId: row.id, status: row.status }, 'scheduled task managed from sidebar')
  return toManageItem(row)
}

export async function shouldRecommendMobileAppForScheduledTaskCreation(
  userId: string,
  clientEnvironment: ResolvedClientEnvironment,
): Promise<boolean> {
  if (clientEnvironment.isNativeApp) return false
  const activeDevices = await listActivePushDevices(userId, {
    platforms: ['android', 'ios'],
    provider: 'jpush',
  })
  return activeDevices.length === 0
}

export async function hasCalendarSyncWithoutExternalIdForScheduledTask(
  userId: string,
  scheduledTaskId: string,
): Promise<boolean> {
  const links = await getDb().query.scheduledTaskCalendarLinks.findMany({
    columns: {
      externalIds: true,
    },
    where: and(
      eq(scheduledTaskCalendarLinks.userId, userId),
      eq(scheduledTaskCalendarLinks.scheduledTaskId, scheduledTaskId),
      eq(scheduledTaskCalendarLinks.syncStatus, 'synced'),
    ),
    limit: FUTURE_TASK_LIMIT,
  })
  return links.some((link) => normalizeExternalIds(link.externalIds).length === 0)
}

function isoWeekdayToByDay(day: number): string | null {
  return ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'][day - 1] ?? null
}

function cronDowToIso(day: number): number | null {
  if (day === 0 || day === 7) return 7
  if (day >= 1 && day <= 6) return day
  return null
}

function parseSimpleCronNumber(value: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(value)) return null
  const n = Number(value)
  if (!Number.isInteger(n) || n < min || n > max) return null
  return n
}

function parseSimpleCronDowList(value: string): number[] | null {
  if (value === '*') return []
  const dayMap: Record<string, number> = {
    SUN: 7,
    MON: 1,
    TUE: 2,
    WED: 3,
    THU: 4,
    FRI: 5,
    SAT: 6,
  }
  const result: number[] = []
  for (const part of value.split(',')) {
    const normalized = part.trim().toUpperCase()
    if (!normalized) return null
    const raw = dayMap[normalized] ?? parseSimpleCronNumber(normalized, 0, 7)
    if (raw == null) return null
    const iso = typeof raw === 'number' && raw >= 0 ? cronDowToIso(raw) : null
    if (!iso) return null
    if (!result.includes(iso)) result.push(iso)
  }
  return result.sort((a, b) => a - b)
}

function splitCronForCalendar(expression: string): {
  second: string
  minute: string
  hour: string
  dayOfMonth: string
  month: string
  dayOfWeek: string
  year: string
} | null {
  const parts = cronParts(expression)
  if (parts.length === 5) {
    const [minute, hour, dayOfMonth, month, dayOfWeek] = parts
    return { second: '0', minute, hour, dayOfMonth, month, dayOfWeek, year: '*' }
  }
  if (parts.length === 6) {
    const [second, minute, hour, dayOfMonth, month, dayOfWeek] = parts
    return { second, minute, hour, dayOfMonth, month, dayOfWeek, year: '*' }
  }
  if (parts.length === 7) {
    const [second, minute, hour, dayOfMonth, month, dayOfWeek, year] = parts
    return { second, minute, hour, dayOfMonth, month, dayOfWeek, year }
  }
  return null
}

function cronToCalendarRRule(expression: string): string | null {
  const parts = splitCronForCalendar(expression)
  if (!parts) return null
  if (parts.second !== '0') return null
  if (parts.dayOfMonth !== '*' || parts.month !== '*' || parts.year !== '*') return null

  const minute = parseSimpleCronNumber(parts.minute, 0, 59)
  const hour = parseSimpleCronNumber(parts.hour, 0, 23)
  if (minute == null || hour == null) return null

  if (parts.dayOfWeek === '*') return 'FREQ=DAILY'

  const weekdays = parseSimpleCronDowList(parts.dayOfWeek)
  if (!weekdays?.length) return null
  const byDay = weekdays.map(isoWeekdayToByDay).filter((v): v is string => !!v)
  if (byDay.length !== weekdays.length) return null
  return `FREQ=WEEKLY;BYDAY=${byDay.join(',')}`
}

function buildCalendarOccurrences(row: ScheduledRow): ScheduledTaskCalendarSyncPlan['occurrences'] {
  if (row.scheduleType !== 'cron' || !row.cronExpression) return undefined
  let runs: Date[]
  try {
    runs = parseCronNextRuns({
      expression: row.cronExpression,
      timezone: row.timezone || DEFAULT_SCHEDULE_TIMEZONE,
      now: new Date(),
      count: CALENDAR_OCCURRENCE_LIMIT,
    })
  } catch {
    return undefined
  }
  const until = Date.now() + CALENDAR_OCCURRENCE_WINDOW_MS
  const occurrences = runs
    .filter((date) => date.getTime() <= until)
    .map((date) => ({
      title: row.taskName,
      startTime: date.getTime(),
      endTime: date.getTime() + CALENDAR_EVENT_DURATION_MS,
      description: row.messageContent,
      reminderMinutesBefore: 0,
    }))
  return occurrences.length > 0 ? occurrences : undefined
}

function calendarPlanHash(row: ScheduledRow, action: ScheduledTaskCalendarSyncAction): string {
  const payload = JSON.stringify({
    action,
    id: row.id,
    taskName: row.taskName,
    messageContent: row.messageContent,
    scheduleType: row.scheduleType,
    cronExpression: row.cronExpression,
    timezone: row.timezone,
    dueAt: row.scheduleType === 'once'
      ? row.dueAt.toISOString()
      : row.cronExpression && !cronToCalendarRRule(row.cronExpression)
        ? row.dueAt.toISOString().slice(0, 10)
        : null,
    status: row.status,
  })
  return createHash('sha1').update(payload).digest('hex').slice(0, 24)
}

export function buildScheduledTaskCalendarSyncPlan(
  row: ScheduledRow,
  action: ScheduledTaskCalendarSyncAction = 'upsert',
  replaceExternalIds: string[] = [],
): ScheduledTaskCalendarSyncPlan {
  const schedule = {
    type: row.scheduleType,
    nextDueAt: row.dueAt.toISOString(),
    timezone: row.timezone || DEFAULT_SCHEDULE_TIMEZONE,
    cronExpression: row.cronExpression,
  }
  const base = {
    action,
    scheduledTaskId: row.id,
    planHash: calendarPlanHash(row, action),
    schedule,
    replaceExternalIds,
  }
  if (action === 'delete') return base

  const event = {
    title: row.taskName,
    startTime: row.dueAt.getTime(),
    endTime: row.dueAt.getTime() + CALENDAR_EVENT_DURATION_MS,
    description: row.messageContent,
    reminderMinutesBefore: 0,
  }
  if (row.scheduleType !== 'cron' || !row.cronExpression) {
    return { ...base, event }
  }

  const recurrenceRule = cronToCalendarRRule(row.cronExpression)
  if (recurrenceRule) {
    return {
      ...base,
      event: {
        ...event,
        recurrenceRule,
      },
    }
  }
  return {
    ...base,
    occurrences: buildCalendarOccurrences(row),
  }
}

function isPendingFutureTask(row: ScheduledRow, now: Date): boolean {
  return futureTaskStatuses().includes(row.status) && row.dueAt.getTime() > now.getTime()
}

function normalizeExternalIds(values: unknown): string[] {
  if (!Array.isArray(values)) return []
  return values.map((value) => String(value).trim()).filter(Boolean).slice(0, CALENDAR_OCCURRENCE_LIMIT)
}

export async function listPendingScheduledTaskCalendarSyncPlans(params: {
  userId: string
  platform: PushPlatform
  deviceKey: string
}): Promise<ScheduledTaskCalendarSyncPendingResponse> {
  const deviceKey = trimText(params.deviceKey, 256)
  if (!deviceKey) return { items: [] }

  const db = getDb()
  const now = new Date()
  const [futureTasks, links] = await Promise.all([
    db.query.scheduledProactiveMessages.findMany({
      where: and(
        eq(scheduledProactiveMessages.userId, params.userId),
        inArray(scheduledProactiveMessages.status, futureTaskStatuses()),
        gt(scheduledProactiveMessages.dueAt, now),
      ),
      orderBy: asc(scheduledProactiveMessages.dueAt),
      limit: FUTURE_TASK_LIMIT,
    }),
    db.query.scheduledTaskCalendarLinks.findMany({
      where: and(
        eq(scheduledTaskCalendarLinks.userId, params.userId),
        eq(scheduledTaskCalendarLinks.platform, params.platform),
        eq(scheduledTaskCalendarLinks.deviceKey, deviceKey),
      ),
      limit: FUTURE_TASK_LIMIT * 2,
    }),
  ])
  const linkedTaskIds = [...new Set(links.map((link) => link.scheduledTaskId))]
  const linkedTasks = linkedTaskIds.length > 0
    ? await db.query.scheduledProactiveMessages.findMany({
        where: and(
          eq(scheduledProactiveMessages.userId, params.userId),
          inArray(scheduledProactiveMessages.id, linkedTaskIds),
        ),
        limit: FUTURE_TASK_LIMIT * 2,
      })
    : []
  const mergedTasks = new Map<string, ScheduledRow>()
  for (const task of futureTasks) mergedTasks.set(task.id, task)
  for (const task of linkedTasks) mergedTasks.set(task.id, task)
  const tasks = [...mergedTasks.values()]

  const linkByTaskId = new Map(links.map((link) => [link.scheduledTaskId, link]))
  const taskById = new Map(tasks.map((task) => [task.id, task]))
  const items: ScheduledTaskCalendarSyncPlan[] = []
  const deletePlannedTaskIds = new Set<string>()

  for (const task of tasks) {
    if (!isPendingFutureTask(task, now)) continue
    const link = linkByTaskId.get(task.id)
    const replaceExternalIds = normalizeExternalIds(link?.externalIds)
    if (!task.calendarSyncEnabled) {
      if (link && link.syncStatus !== 'deleted') {
        items.push(buildScheduledTaskCalendarSyncPlan(task, 'delete', replaceExternalIds))
        deletePlannedTaskIds.add(task.id)
      }
      continue
    }
    const plan = buildScheduledTaskCalendarSyncPlan(task, 'upsert', replaceExternalIds)
    if (!link || link.syncStatus !== 'synced' || link.planHash !== plan.planHash) {
      items.push(plan)
    }
  }

  for (const link of links) {
    if (link.syncStatus === 'deleted') continue
    if (deletePlannedTaskIds.has(link.scheduledTaskId)) continue
    const task = taskById.get(link.scheduledTaskId)
    if (!task || task.status === 'deleted' || task.status === 'canceled' || !task.calendarSyncEnabled) {
      const fallbackTask = task ?? {
        id: link.scheduledTaskId,
        userId: params.userId,
        sessionId: '',
        purpose: 'custom',
        taskName: '提醒',
        timeSource: 'user_explicit',
        scheduleType: 'once',
        cronExpression: null,
        timezone: DEFAULT_SCHEDULE_TIMEZONE,
        dueAt: new Date(),
        lastDueAt: null,
        status: 'deleted',
        messageContent: '',
        pushTitle: 'Health Agent Lab',
        pushAlert: '',
        appNotifyEnabled: true,
        calendarSyncEnabled: true,
        route: null,
        entityType: null,
        entityId: null,
        dedupeKey: null,
        metadata: null,
        attemptCount: 0,
        lastError: null,
        sentAt: null,
        messageId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } satisfies ScheduledRow
      items.push(buildScheduledTaskCalendarSyncPlan(
        fallbackTask,
        'delete',
        normalizeExternalIds(link.externalIds),
      ))
    }
  }

  return { items: items.slice(0, FUTURE_TASK_LIMIT) }
}

export async function recordScheduledTaskCalendarSyncResult(
  userId: string,
  input: ScheduledTaskCalendarSyncReportRequest,
): Promise<boolean> {
  const deviceKey = trimText(input.deviceKey, 256)
  if (!deviceKey) return false
  const planHash = trimText(input.planHash, 120)
  if (!planHash) return false
  const status = input.status
  if (!['synced', 'failed', 'deleted'].includes(status)) return false

  const db = getDb()
  const task = await db.query.scheduledProactiveMessages.findFirst({
    where: and(
      eq(scheduledProactiveMessages.id, input.scheduledTaskId),
      eq(scheduledProactiveMessages.userId, userId),
    ),
  })
  if (!task) return false

  const now = new Date()
  const externalIds = status === 'deleted'
    ? []
    : normalizeExternalIds(input.externalIds)
  await db.insert(scheduledTaskCalendarLinks).values({
    userId,
    scheduledTaskId: input.scheduledTaskId,
    platform: input.platform,
    deviceKey,
    externalIds,
    planHash,
    syncStatus: status,
    lastError: status === 'failed' ? trimText(input.error, 1000) : null,
    lastSyncedAt: status === 'failed' ? null : now,
    createdAt: now,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: [
      scheduledTaskCalendarLinks.scheduledTaskId,
      scheduledTaskCalendarLinks.platform,
      scheduledTaskCalendarLinks.deviceKey,
    ],
    set: {
      userId,
      externalIds,
      planHash,
      syncStatus: status,
      lastError: status === 'failed' ? trimText(input.error, 1000) : null,
      lastSyncedAt: status === 'failed' ? null : now,
      updatedAt: now,
    },
  })
  return true
}

export async function cancelScheduledProactiveMessagesForEntity(
  input: {
    userId: string
    entityType: string
    entityId: string
    purpose?: ScheduledProactiveMessagePurpose
  },
  logger: Logger,
): Promise<number> {
  const conditions: SQL[] = [
    eq(scheduledProactiveMessages.userId, input.userId),
    eq(scheduledProactiveMessages.entityType, input.entityType),
    eq(scheduledProactiveMessages.entityId, input.entityId),
    inArray(scheduledProactiveMessages.status, ['pending', 'processing'] satisfies ScheduledProactiveMessageStatus[]),
  ]
  if (input.purpose) conditions.push(eq(scheduledProactiveMessages.purpose, input.purpose))

  const rows = await getDb().update(scheduledProactiveMessages)
    .set({ status: 'canceled', updatedAt: new Date() })
    .where(and(...conditions))
    .returning({ id: scheduledProactiveMessages.id })

  if (rows.length > 0) {
    logger.info({ count: rows.length, entityType: input.entityType, entityId: input.entityId }, 'scheduled proactive messages canceled')
  }
  return rows.length
}

export async function cancelScheduledProactiveMessagesByIds(
  input: {
    userId: string
    ids: string[]
  },
  logger: Logger,
): Promise<number> {
  const ids = [...new Set(input.ids.filter((id) => typeof id === 'string' && id.length > 0))]
  if (ids.length === 0) return 0

  const rows = await getDb().update(scheduledProactiveMessages)
    .set({ status: 'canceled', updatedAt: new Date() })
    .where(and(
      eq(scheduledProactiveMessages.userId, input.userId),
      inArray(scheduledProactiveMessages.id, ids),
      inArray(scheduledProactiveMessages.status, ['pending', 'processing'] satisfies ScheduledProactiveMessageStatus[]),
    ))
    .returning({ id: scheduledProactiveMessages.id })

  if (rows.length > 0) {
    logger.info({ count: rows.length }, 'scheduled proactive messages canceled by ids')
  }
  return rows.length
}

async function claimScheduled(row: ScheduledRow, logger: Logger): Promise<ScheduledRow | null> {
  const [claimed] = await getDb().update(scheduledProactiveMessages)
    .set({ status: 'processing', updatedAt: new Date() })
    .where(and(
      eq(scheduledProactiveMessages.id, row.id),
      eq(scheduledProactiveMessages.status, 'pending'),
    ))
    .returning()

  if (!claimed) {
    logger.info({ scheduledMessageId: row.id }, 'scheduled proactive message skipped: already claimed')
    return null
  }
  return claimed
}

async function markScheduledFailure(row: ScheduledRow, err: unknown, logger: Logger): Promise<void> {
  const attemptCount = row.attemptCount + 1
  const status: ScheduledProactiveMessageStatus = attemptCount >= MAX_ATTEMPTS ? 'failed' : 'pending'
  const message = err instanceof Error ? err.message : String(err)

  await getDb().update(scheduledProactiveMessages)
    .set({
      status,
      attemptCount,
      lastError: message.slice(0, 1000),
      updatedAt: new Date(),
    })
    .where(eq(scheduledProactiveMessages.id, row.id))

  logger.warn({
    scheduledMessageId: row.id,
    status,
    attemptCount,
    error: message,
  }, 'scheduled proactive message failed')
}

async function skipOverdueScheduled(row: ScheduledRow, now: Date, logger: Logger): Promise<void> {
  const overdueMs = now.getTime() - row.dueAt.getTime()
  const nextDueAt = row.scheduleType === 'cron'
    ? nextCronDueAtAfter(row, new Date(now.getTime() + 1000))
    : null
  const status: ScheduledProactiveMessageStatus = row.scheduleType === 'cron' && nextDueAt
    ? 'pending'
    : 'canceled'

  await getDb().update(scheduledProactiveMessages).set({
    status,
    sentAt: null,
    messageId: null,
    lastError: 'overdue_skipped',
    dueAt: nextDueAt ?? row.dueAt,
    lastDueAt: row.dueAt,
    attemptCount: 0,
    updatedAt: now,
  }).where(and(
    eq(scheduledProactiveMessages.id, row.id),
    eq(scheduledProactiveMessages.status, 'processing'),
  ))

  logger.info({
    overdueMs,
    nextDueAt: nextDueAt?.toISOString() ?? null,
    status,
  }, 'scheduled proactive message overdue skipped')
}

type TodoItemRow = typeof todoItems.$inferSelect
type TodoPlanRow = typeof todoPlans.$inferSelect

function todoDateToString(value: TodoItemRow['todoDate']): string {
  return String(value)
}

function formatShanghaiTriggerTime(value: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: DEFAULT_SCHEDULE_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(value)
  const pick = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? ''
  return `${pick('year')}-${pick('month')}-${pick('day')} ${pick('hour')}:${pick('minute')}`
}

function isScheduledTodoClosed(status: TodoItemStatus): boolean {
  return status === 'completed' || status === 'not_practiced'
}

function scheduledTodoMarkdownMark(status: TodoItemStatus): string {
  if (status === 'completed') return 'x'
  if (status === 'not_practiced') return '-'
  return ' '
}

function scheduledPlanStatusForItems(items: TodoItemRow[]): TodoPlanStatus {
  return items.length > 0 && items.every((item) => isScheduledTodoClosed(item.status))
    ? 'completed'
    : 'in_progress'
}

function renderScheduledTodoMarkdown(items: TodoItemRow[]): string {
  return [...items]
    .sort((a, b) =>
      todoDateToString(a.todoDate).localeCompare(todoDateToString(b.todoDate)) ||
      a.todoTime.localeCompare(b.todoTime)
    )
    .map((item) => {
      const feedback = item.feedback ? `，反馈：${item.feedback}` : ''
      return `- [${scheduledTodoMarkdownMark(item.status)}] ${todoDateToString(item.todoDate)} ${item.todoTime} ${item.showPrompt}${feedback}`
    })
    .join('\n')
}

function sortedScheduledTodoItems(items: TodoItemRow[]): TodoItemRow[] {
  return [...items].sort((a, b) =>
    todoDateToString(a.todoDate).localeCompare(todoDateToString(b.todoDate)) ||
    a.todoTime.localeCompare(b.todoTime)
  )
}

export function deriveScheduledTodoAutoCloseState(input: {
  status: TodoItemStatus
}): { status: TodoItemStatus; closedReason: TodoItemClosedReason } {
  if (input.status === 'started') {
    return {
      status: 'completed',
      closedReason: 'auto_completed_before_next_trigger',
    }
  }
  return {
    status: 'not_practiced',
    closedReason: 'auto_not_practiced_before_next_trigger',
  }
}

async function autoClosePriorTodoItemsBeforeScheduledTrigger(input: {
  plan: TodoPlanRow
  currentItem: TodoItemRow
  items: TodoItemRow[]
  now: Date
  logger: Logger
}): Promise<{ plan: TodoPlanRow; items: TodoItemRow[] }> {
  const sorted = sortedScheduledTodoItems(input.items)
  const currentIndex = sorted.findIndex((item) => item.id === input.currentItem.id)
  if (currentIndex <= 0) return { plan: input.plan, items: input.items }

  const priorOpenItems = sorted.slice(0, currentIndex).filter((item) => !isScheduledTodoClosed(item.status))
  if (priorOpenItems.length === 0) return { plan: input.plan, items: input.items }

  const db = getDb()
  const updatedById = new Map<string, TodoItemRow>()
  for (const item of priorOpenItems) {
    const closeState = deriveScheduledTodoAutoCloseState({ status: item.status })
    const [updatedItem] = await db.update(todoItems)
      .set({
        status: closeState.status,
        closedReason: closeState.closedReason,
        feedback: null,
        notifiedAt: item.notifiedAt ?? input.now,
        completedAt: item.completedAt ?? input.now,
        updatedAt: input.now,
      })
      .where(and(eq(todoItems.id, item.id), eq(todoItems.userId, item.userId)))
      .returning()
    if (updatedItem) updatedById.set(updatedItem.id, updatedItem)
  }

  const mergedItems = input.items.map((item) => updatedById.get(item.id) ?? item)
  const nextStatus = scheduledPlanStatusForItems(mergedItems)
  const allDone = nextStatus === 'completed'
  const todosMd = renderScheduledTodoMarkdown(mergedItems)
  const [updatedPlan] = await db.update(todoPlans)
    .set({
      status: nextStatus,
      todosMd,
      startedAt: input.plan.startedAt ?? input.now,
      completedAt: allDone ? input.plan.completedAt ?? input.now : input.plan.completedAt,
      updatedAt: input.now,
    })
    .where(and(eq(todoPlans.id, input.plan.id), eq(todoPlans.userId, input.plan.userId)))
    .returning()

  input.logger.info({
    todoPlanId: input.plan.id,
    currentTodoItemId: input.currentItem.id,
    closedTodoItemCount: priorOpenItems.length,
  }, 'prior scheduled todo items auto-closed before next trigger')

  return {
    plan: updatedPlan ?? { ...input.plan, status: nextStatus, todosMd },
    items: mergedItems,
  }
}

async function markCurrentScheduledTodoNotified(input: {
  item: TodoItemRow
  now: Date
}): Promise<TodoItemRow> {
  if (isScheduledTodoClosed(input.item.status)) return input.item
  const nextStatus: TodoItemStatus = input.item.status === 'started' ? 'started' : 'notified'
  const [updatedItem] = await getDb().update(todoItems)
    .set({
      status: nextStatus,
      notifiedAt: input.item.notifiedAt ?? input.now,
      updatedAt: input.now,
    })
    .where(and(eq(todoItems.id, input.item.id), eq(todoItems.userId, input.item.userId)))
    .returning()
  return updatedItem ?? input.item
}

function scheduledTodoStep(input: { item: TodoItemRow; items: TodoItemRow[] }): { current: number; total: number } {
  const sorted = sortedScheduledTodoItems(input.items)
  const idx = sorted.findIndex((item) => item.id === input.item.id)
  return {
    current: idx >= 0 ? idx + 1 : 1,
    total: sorted.length || 1,
  }
}

function scheduledTodoResourceTitle(resource: MedicalRiskResource): string {
  return resource.kind === 'intervention_material' ? resource.actionName : resource.title
}

function scheduledTodoResourceDescription(resource: MedicalRiskResource): string {
  if (resource.kind === 'intervention_material') {
    return `${resource.sideEffect}｜${resource.scene}｜${resource.actionName}`
  }
  if (resource.kind === 'internal_video') {
    return resource.description || resource.title
  }
  return resource.snippet || resource.title
}

function attachTodoContextToResource(input: {
  resource: MedicalRiskResource
  planId: string
  todoItemId: string
  scheduledMessageId: string
  item: TodoItemRow
}): MedicalRiskResource {
  return {
    ...input.resource,
    id: 'todo-resource',
    todoContext: {
      planId: input.planId,
      todoId: input.todoItemId,
      scheduledMessageId: input.scheduledMessageId,
      feedback: input.item.feedback,
      status: input.item.status,
    },
  } as MedicalRiskResource
}

function renderScheduledTodoResourceOutput(resource: MedicalRiskResource): string {
  if (resource.kind === 'intervention_material') {
    return `可引用干预资源：\n[${resource.id}] 跟练卡｜${resource.sideEffect}｜${resource.scene}｜${resource.actionName}`
  }
  if (resource.kind === 'internal_video') {
    const internalDuration = resource.durationSec > 0 ? `｜时长 ${resource.durationSec}s` : ''
    return `可引用干预资源：\n[${resource.id}] 内部高质量视频｜${resource.title}${internalDuration}`
  }
  const duration = resource.durationSec > 0 ? `｜时长 ${resource.durationSec}s` : ''
  return `可引用干预资源：\n[${resource.id}] 视频｜${resource.title}${duration}｜${resource.url}`
}

function buildScheduledTodoToolCall(input: {
  scheduledMessageId: string
  plan: TodoPlanRow
  resource: MedicalRiskResource
}): ToolCallRecord {
  const toolInput = {
    search_query: input.plan.targetSideEffect ?? input.plan.title,
  }
  return {
    toolCallId: `scheduled_todo_resource_${input.scheduledMessageId.replace(/-/g, '')}`,
    name: 'generate_plan',
    input: toolInput,
    rawArguments: JSON.stringify(toolInput),
    assistantToolCallContent: '',
    assistantStepIndex: 0,
    llmOutput: renderScheduledTodoResourceOutput(input.resource),
    output: {
      kind: 'medical_risk_resources',
      resources: [input.resource],
    },
    durationMs: 0,
  }
}

function buildScheduledTodoSessionReminder(input: {
  triggeredAt: Date
  plan: TodoPlanRow
  item: TodoItemRow
  items: TodoItemRow[]
  resource: MedicalRiskResource | null
}): string {
  const step = scheduledTodoStep(input)
  const completedCount = input.items.filter((item) => isScheduledTodoClosed(item.status)).length
  const resourceId = input.resource?.id ?? input.plan.resourceRefId ?? 'none'
  const resourceType = input.resource?.kind ?? 'none'
  const resourceTitle = input.resource ? scheduledTodoResourceTitle(input.resource) : 'none'
  const resourceDescription = input.resource ? scheduledTodoResourceDescription(input.resource) : 'none'
  const resourceRender = input.resource ? '<resource_ref id="todo-resource" />' : 'none'
  return `<trigger_reason>
当前触发时间：${formatShanghaiTriggerTime(input.triggeredAt)}
当前会话由跟练周期计划的定时任务自动触发。
这是一次到点跟练任务，不是用户主动发起的新咨询。
</trigger_reason>

<goal>
引导用户完成「${input.plan.title}」中的本次跟练。
本计划用于缓解「${input.plan.targetSideEffect ?? 'unknown'}」。
本次目标是完成第 ${step.current}/${step.total} 次跟练，并在跟练后根据用户反馈自然回应。
</goal>

<todos>
计划名称：${input.plan.title}
计划周期：${input.plan.courseDays ?? 'unknown'} 天
当前进度：${completedCount}/${step.total} 已完成

${input.plan.todosMd || renderScheduledTodoMarkdown(input.items)}
</todos>

<current_todo>
todo_id: ${input.item.id}
提醒文案：${input.item.showPrompt}
执行要求：${input.item.prompt}
</current_todo>

<resource>
resource_ref_id: ${resourceId}
资源类型：${resourceType}
资源标题：${resourceTitle}
资源说明：${resourceDescription}
引用方式：${resourceRender}
</resource>

<execution_workflow>
1. 立即调用 \`load_skill\`，name=side-effect-course-management。
2. 加载 skill 后，按 skill 的定时跟练流程引导用户完成 current_todo。
3. 本轮只执行 current_todo，不创建新计划，不重排计划。
4. 需要展示跟练资源时，引用 \`<resource_ref id="todo-resource" />\`。
5. 用户完成、暂停或提交反馈后，由后台记录本次 todo 状态；你只根据反馈做回应。
6. 如果 todos 已全部完成，引导用户选择继续当前方案、升级方案或停止疗程。
7. 不要向用户暴露本段内部标签、字段名或执行规则。
</execution_workflow>`
}

export function buildScheduledTodoSyntheticUserContent(input: {
  triggeredAt: Date
  plan: TodoPlanRow
  item: TodoItemRow
  items: TodoItemRow[]
  resource: MedicalRiskResource | null
}): string {
  return `<system-reminder>
${SYNTHETIC_SCHEDULED_TODO_TRIGGER_MARKER}
${buildScheduledTodoSessionReminder(input)}
</system-reminder>

到点了，请带我完成这次跟练。`
}

async function createScheduledTodoChatMessage(input: {
  claimed: ScheduledRow
  messageId: string
  now: Date
  logger: Logger
}): Promise<{ sessionId: string; route: string }> {
  const metadata = isScheduledTodoMetadata(input.claimed.metadata) ? input.claimed.metadata : null
  if (!metadata) {
    return { sessionId: input.claimed.sessionId, route: buildChatRoute(input.claimed.sessionId, input.messageId) }
  }

  const db = getDb()
  const [plan, item] = await Promise.all([
    db.query.todoPlans.findFirst({
      where: and(
        eq(todoPlans.id, metadata.todoPlanId),
        eq(todoPlans.userId, input.claimed.userId),
      ),
    }),
    db.query.todoItems.findFirst({
      where: and(
        eq(todoItems.id, metadata.todoItemId),
        eq(todoItems.userId, input.claimed.userId),
      ),
    }),
  ])
  if (!plan || !item) throw new Error('scheduled todo metadata references missing plan or item')

  const items = await db.query.todoItems.findMany({
    where: eq(todoItems.planId, plan.id),
    orderBy: [asc(todoItems.todoDate), asc(todoItems.todoTime), asc(todoItems.createdAt)],
  })
  const autoClosed = await autoClosePriorTodoItemsBeforeScheduledTrigger({
    plan,
    currentItem: item,
    items,
    now: input.now,
    logger: input.logger,
  })
  const effectivePlan = autoClosed.plan
  const notifiedItem = await markCurrentScheduledTodoNotified({
    item: autoClosed.items.find((candidate) => candidate.id === item.id) ?? item,
    now: input.now,
  })
  const effectiveItems = autoClosed.items.map((candidate) =>
    candidate.id === notifiedItem.id ? notifiedItem : candidate
  )
  const effectiveItem = notifiedItem
  const resource = metadata.resource
    ? attachTodoContextToResource({
      resource: metadata.resource,
      planId: effectivePlan.id,
      todoItemId: effectiveItem.id,
      scheduledMessageId: input.claimed.id,
      item: effectiveItem,
    })
    : null
  const content = resource
    ? `${input.claimed.messageContent}\n\n<resource_ref id="${resource.id}" />`
    : input.claimed.messageContent
  const assistantTokenCount = estimateTextTokens(content)
  const syntheticUserContent = buildScheduledTodoSyntheticUserContent({
    triggeredAt: input.now,
    plan: effectivePlan,
    item: effectiveItem,
    items: effectiveItems,
    resource,
  })
  const syntheticUserTokenCount = estimateTextTokens(syntheticUserContent)
  const toolCalls = resource
    ? [buildScheduledTodoToolCall({
      scheduledMessageId: input.claimed.id,
      plan: effectivePlan,
      resource,
    })]
    : null
  const assistantCreatedAt = new Date(input.now.getTime() + 1)

  const [session] = await db.insert(chatSessions).values({
    userId: input.claimed.userId,
    title: plan.title,
    messageCount: 2,
    tokenCount: syntheticUserTokenCount + assistantTokenCount,
    updatedAt: assistantCreatedAt,
  }).returning({ id: chatSessions.id })

  await db.insert(messages).values([
    {
      sessionId: session.id,
      role: 'user',
      content: syntheticUserContent,
      tokenCount: syntheticUserTokenCount,
      createdAt: input.now,
    },
    {
      id: input.messageId,
      sessionId: session.id,
      role: 'assistant',
      content,
      rawResponse: buildScheduledTodoRawResponse({
        scheduledMessageId: input.claimed.id,
        metadata,
      }),
      toolCalls,
      tokenCount: assistantTokenCount,
      createdAt: assistantCreatedAt,
    },
  ])

  await db.update(scheduledProactiveMessages).set({
    sessionId: session.id,
    messageId: input.messageId,
    updatedAt: assistantCreatedAt,
  }).where(and(
    eq(scheduledProactiveMessages.id, input.claimed.id),
    eq(scheduledProactiveMessages.status, 'processing'),
  ))

  return {
    sessionId: session.id,
    route: buildChatRoute(session.id, input.messageId),
  }
}

async function processOneScheduled(row: ScheduledRow, logger: Logger): Promise<'sent' | 'skipped' | 'failed'> {
  const log = logger.child({ scheduledMessageId: row.id, sessionId: row.sessionId })
  const claimed = await claimScheduled(row, log)
  if (!claimed) return 'skipped'

  const user = await getDb().query.users.findFirst({
    where: eq(users.id, claimed.userId),
    columns: { status: true },
  })
  if (!user || user.status !== 'active') {
    await getDb().update(scheduledProactiveMessages)
      .set({ status: 'failed', lastError: 'user_not_active', updatedAt: new Date() })
      .where(eq(scheduledProactiveMessages.id, claimed.id))
    return 'skipped'
  }

  try {
    const now = new Date()
    if (shouldSkipOverdueScheduledTask(claimed.dueAt, now)) {
      await skipOverdueScheduled(claimed, now, log)
      return 'skipped'
    }

    if (!claimed.appNotifyEnabled) {
      const nextDueAt = claimed.scheduleType === 'cron'
        ? nextCronDueAtAfter(claimed, new Date(Math.max(now.getTime(), claimed.dueAt.getTime()) + 1000))
        : null
      const nextStatus: ScheduledProactiveMessageStatus = claimed.scheduleType === 'cron' && nextDueAt
        ? 'pending'
        : 'sent'

      await getDb().update(scheduledProactiveMessages).set({
        status: nextStatus,
        sentAt: now,
        messageId: null,
        lastError: null,
        dueAt: nextDueAt ?? claimed.dueAt,
        lastDueAt: claimed.dueAt,
        attemptCount: 0,
        updatedAt: now,
      }).where(and(
        eq(scheduledProactiveMessages.id, claimed.id),
        eq(scheduledProactiveMessages.status, 'processing'),
      ))

      log.info({
        nextDueAt: nextDueAt?.toISOString() ?? null,
      }, 'scheduled proactive message app notification disabled, advanced schedule without push')
      return 'skipped'
    }

    const messageId = claimed.messageId ?? randomUUID()
    let routeSessionId = claimed.sessionId
    let route = claimed.route ?? buildChatRoute(claimed.sessionId, messageId)

    if (!claimed.messageId) {
      if (isScheduledTodoMetadata(claimed.metadata)) {
        const created = await createScheduledTodoChatMessage({
          claimed,
          messageId,
          now,
          logger: log,
        })
        routeSessionId = created.sessionId
        route = created.route
      } else {
        const tokenCount = estimateTextTokens(claimed.messageContent)

        await getDb().transaction(async (tx) => {
          await tx.insert(messages).values({
            id: messageId,
            sessionId: claimed.sessionId,
            role: 'assistant',
            content: claimed.messageContent,
            rawResponse: null,
            tokenCount,
            createdAt: now,
          })

          const session = await tx.query.chatSessions.findFirst({
            where: eq(chatSessions.id, claimed.sessionId),
            columns: { messageCount: true, tokenCount: true },
          })
          if (session) {
            await tx.update(chatSessions).set({
              messageCount: session.messageCount + 1,
              tokenCount: session.tokenCount + tokenCount,
              updatedAt: now,
            }).where(eq(chatSessions.id, claimed.sessionId))
          }

          await tx.update(scheduledProactiveMessages).set({
            messageId,
            updatedAt: now,
          }).where(and(
            eq(scheduledProactiveMessages.id, claimed.id),
            eq(scheduledProactiveMessages.status, 'processing'),
          ))
        })
      }
    }

    const pushResult = await pushToUser(claimed.userId, {
      title: claimed.pushTitle,
      alert: claimed.pushAlert,
      route,
      type: claimed.purpose,
      entityType: claimed.entityType,
      entityId: claimed.entityId,
      dedupeKey: claimed.dedupeKey ?? `scheduled_proactive:${claimed.id}`,
    }, log)

    const nextDueAt = claimed.scheduleType === 'cron'
      ? nextCronDueAtAfter(claimed, new Date(Math.max(now.getTime(), claimed.dueAt.getTime()) + 1000))
      : null
    const nextStatus: ScheduledProactiveMessageStatus = claimed.scheduleType === 'cron' && nextDueAt
      ? 'pending'
      : 'sent'

    await getDb().update(scheduledProactiveMessages).set({
      status: nextStatus,
      sentAt: now,
      messageId: nextStatus === 'pending' ? null : messageId,
      sessionId: routeSessionId,
      lastError: null,
      dueAt: nextDueAt ?? claimed.dueAt,
      lastDueAt: claimed.dueAt,
      attemptCount: 0,
      updatedAt: now,
    }).where(and(
      eq(scheduledProactiveMessages.id, claimed.id),
      eq(scheduledProactiveMessages.status, 'processing'),
    ))

    log.info({
      messageId,
      nextDueAt: nextDueAt?.toISOString() ?? null,
      pushStatus: pushResult.status,
      pushReason: pushResult.reason,
    }, 'scheduled proactive message sent')

    return 'sent'
  } catch (err) {
    await markScheduledFailure(claimed, err, log)
    return 'failed'
  }
}

export async function runDueScheduledProactiveMessages(logger: Logger): Promise<void> {
  const now = new Date()
  await withCronLock('scheduled-proactive-messages', 'due', SCHEDULED_LOCK_TTL_SECONDS, logger, async () => {
    const rows = await getDb().query.scheduledProactiveMessages.findMany({
      where: and(
        eq(scheduledProactiveMessages.status, 'pending'),
        lte(scheduledProactiveMessages.dueAt, now),
      ),
      orderBy: asc(scheduledProactiveMessages.dueAt),
      limit: SCHEDULED_BATCH_LIMIT,
    })

    const stats = { scanned: rows.length, sent: 0, skipped: 0, failed: 0 }
    for (const row of rows) {
      const result = await processOneScheduled(row, logger)
      stats[result]++
    }
    if (stats.scanned > 0) logger.info(stats, 'scheduled proactive messages cron completed')
  })
}

export async function hasFutureScheduledProactiveMessage(params: {
  userId: string
  entityType: string
  entityId: string
  purpose: ScheduledProactiveMessagePurpose
}): Promise<boolean> {
  const rows = await getDb().select({ id: scheduledProactiveMessages.id })
    .from(scheduledProactiveMessages)
    .where(and(
      eq(scheduledProactiveMessages.userId, params.userId),
      eq(scheduledProactiveMessages.entityType, params.entityType),
      eq(scheduledProactiveMessages.entityId, params.entityId),
      eq(scheduledProactiveMessages.purpose, params.purpose),
      inArray(scheduledProactiveMessages.status, ['pending', 'processing'] satisfies ScheduledProactiveMessageStatus[]),
      gt(scheduledProactiveMessages.dueAt, new Date()),
    ))
    .limit(1)
  return rows.length > 0
}
