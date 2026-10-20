import { and, asc, desc, eq, inArray, lt } from 'drizzle-orm'
import type {
  TodoFeedback,
  MedicalRiskResource,
  MedicalRiskResourceTodoContext,
  TodoFeedbackResponse,
  TodoItemPlayableResource,
  TodoPlanAction,
  TodoPlanConflict,
  TodoItemClosedReason,
  TodoItemStatus,
  TodoPlanSourceType,
  TodoStartResponse,
  TodoPlanStatus,
  TodoToolConflictOutput,
  TodoToolOutput,
  TodoToolPlanOutput,
  TodoToolPlanSummary,
  TodoToolTodoSummary,
} from '@health-agent/shared'
import { getDb } from '../db/client.js'
import { chatSessions, messages, todoItems, todoPlans } from '../db/schema/index.js'
import type { Logger } from '../lib/logger.js'
import { appendPendingSystemReminder } from './pending-system-reminders.js'
import { findResourceToolCallIdInSession } from './intervention-material-engagement.js'
import { refreshInterventionToolOutput } from './intervention-material-runtime.js'
import {
  cancelScheduledProactiveMessagesByIds,
  scheduleProactiveMessage,
  scheduledTodoMetadataFromRawResponse,
} from './scheduled-proactive-message.js'

const DEFAULT_TODO_TIMEZONE = 'Asia/Shanghai'
const ACTIVE_PLAN_STATUSES = ['not_started', 'in_progress'] satisfies TodoPlanStatus[]
const TODO_CONFLICT_WINDOW_MINUTES = 30
const FEEDBACK_LABELS: Record<TodoFeedback, string> = {
  better: '变好',
  same: '没变化',
  worse: '变差',
}

type TodoPlanRow = typeof todoPlans.$inferSelect
type TodoItemRow = typeof todoItems.$inferSelect

export interface TodoInput {
  date: string
  time: string
  showPrompt: string
  prompt: string
}

export interface CreateTodoPlanInput {
  userId: string
  sessionId: string
  title: string
  timezone?: string | null
  sourceType?: TodoPlanSourceType | null
  sourceId?: string | null
  resourceRefId?: string | null
  courseDays?: number | null
  targetSideEffect?: string | null
  resourceSnapshot?: MedicalRiskResource | null
  dedupeKey?: string | null
  todos: TodoInput[]
  skipConflictCheck?: boolean
}

export interface StopTodoPlanInput {
  userId: string
  planId: string
  reason?: string | null
}

export interface UpdateTodoPlanInput {
  userId: string
  sessionId: string
  planId: string
  title: string
  timezone?: string | null
  sourceType?: TodoPlanSourceType | null
  sourceId?: string | null
  resourceRefId?: string | null
  courseDays?: number | null
  targetSideEffect?: string | null
  resourceSnapshot?: MedicalRiskResource | null
  dedupeKey?: string | null
  todos: TodoInput[]
  reason?: string | null
}

export interface RecordTodoFeedbackInput {
  userId: string
  sessionId: string
  planId: string
  todoItemId: string
  feedback: TodoFeedback
}

export interface RecordTodoStartInput {
  userId: string
  sessionId: string
  planId: string
  todoItemId: string
}

export interface TodoReplyClassification {
  status: TodoItemStatus | null
  feedback: TodoFeedback | null
}

export interface ActiveTodoPlanPromptSummary {
  id: string
  title: string
  status: TodoPlanStatus
  targetSideEffect?: string | null
  resourceRefId?: string | null
  courseDays?: number | null
  todos: Array<{
    id: string
    date: string
    time: string
    showPrompt: string
    status: TodoItemStatus
    feedback?: TodoFeedback | null
  }>
}

export interface TodoPlanConflictCandidate {
  id: string
  title: string
  status: TodoPlanStatus
  targetSideEffect?: string | null
  sourceType?: TodoPlanSourceType | null
  sourceId?: string | null
  resourceRefId?: string | null
  dedupeKey?: string | null
  todos: Array<{
    date: string
    time: string
    showPrompt: string
    status: TodoItemStatus
  }>
}

export function parseTodoDateTime(input: {
  date: string
  time: string
  timezone?: string | null
}): Date {
  const date = input.date.trim()
  const time = input.time.trim()
  const timezone = input.timezone?.trim() || DEFAULT_TODO_TIMEZONE
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('todo.date 必须是 YYYY-MM-DD')
  if (!/^\d{2}:\d{2}$/.test(time)) throw new Error('todo.time 必须是 HH:mm')
  const [hour, minute] = time.split(':').map(Number)
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) throw new Error('todo.time 不是合法时间')
  if (timezone !== 'Asia/Shanghai') throw new Error('当前 todos 仅支持 Asia/Shanghai 时区')

  const dueAt = new Date(`${date}T${time}:00+08:00`)
  if (!Number.isFinite(dueAt.getTime())) throw new Error('todo.date/time 不是合法时间')
  return dueAt
}

export function validateTodoInputsAreFuture(input: {
  todos: TodoInput[]
  timezone?: string | null
  now?: Date
}): void {
  const now = input.now ?? new Date()
  const timezone = input.timezone?.trim() || DEFAULT_TODO_TIMEZONE
  for (const [index, todo] of input.todos.entries()) {
    const dueAt = parseTodoDateTime({ date: todo.date, time: todo.time, timezone })
    if (dueAt.getTime() <= now.getTime()) {
      throw new Error(
        `todos[${index}] 的时间 ${todo.date.trim()} ${todo.time.trim()} 已经过去；todos 只能包含未来待执行时间。若用户要求未来 N 天且今天该时间已过，请从明天开始生成 N 条未来 todo。`,
      )
    }
  }
}

function trimText(value: string | null | undefined, max: number): string | null {
  const trimmed = value?.trim()
  if (!trimmed) return null
  return trimmed.slice(0, max)
}

export function normalizeCourseDays(value: unknown): number | null {
  if (value == null) return null
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim()
      ? Number(value)
      : Number.NaN
  if (!Number.isFinite(parsed)) return null
  const days = Math.floor(parsed)
  return days >= 1 && days <= 100 ? days : null
}

function normalizeSourceType(value: TodoPlanSourceType | null | undefined): TodoPlanSourceType {
  return value === 'intervention' || value === 'video_resource' ? value : 'custom'
}

function toIso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null
}

function todoDateToString(value: TodoItemRow['todoDate']): string {
  return String(value)
}

function isTodoClosed(status: TodoItemStatus): boolean {
  return status === 'completed' || status === 'not_practiced'
}

function normalizedConflictText(value: string | null | undefined): string {
  return (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s　·•，,。.!！?？:：;；\-_/\\()[\]（）【】"'“”‘’]/g, '')
}

function isSimilarTarget(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = normalizedConflictText(a)
  const right = normalizedConflictText(b)
  if (!left || !right) return false
  if (left === right) return true
  return left.length >= 2 && right.length >= 2 && (left.includes(right) || right.includes(left))
}

function todoMinuteValue(date: string, time: string): number | null {
  try {
    const dueAt = parseTodoDateTime({ date, time, timezone: DEFAULT_TODO_TIMEZONE })
    return Math.floor(dueAt.getTime() / 60000)
  } catch {
    return null
  }
}

function todoTimeLabel(date: string, time: string): string {
  return `${date} ${time}`
}

function hasDuplicateSource(input: {
  sourceType?: TodoPlanSourceType | null
  sourceId?: string | null
  resourceRefId?: string | null
  dedupeKey?: string | null
}, plan: TodoPlanConflictCandidate): boolean {
  const dedupeKey = normalizedConflictText(input.dedupeKey)
  if (dedupeKey && dedupeKey === normalizedConflictText(plan.dedupeKey)) return true
  const sourceId = normalizedConflictText(input.sourceId)
  return Boolean(input.sourceType && sourceId && input.sourceType === plan.sourceType && sourceId === normalizedConflictText(plan.sourceId))
}

export function detectTodoPlanConflicts(input: {
  title: string
  targetSideEffect?: string | null
  sourceType?: TodoPlanSourceType | null
  sourceId?: string | null
  resourceRefId?: string | null
  dedupeKey?: string | null
  todos: TodoInput[]
  existingPlans: TodoPlanConflictCandidate[]
  excludePlanId?: string | null
}): TodoPlanConflict[] {
  const conflicts: TodoPlanConflict[] = []
  const activePlans = input.existingPlans.filter((plan) =>
    plan.id !== input.excludePlanId && (ACTIVE_PLAN_STATUSES as readonly TodoPlanStatus[]).includes(plan.status)
  )

  for (const plan of activePlans) {
    if (hasDuplicateSource(input, plan)) {
      conflicts.push({
        type: 'duplicate_source',
        planId: plan.id,
        planTitle: plan.title,
        targetSideEffect: plan.targetSideEffect,
        reason: '已有相同来源的进行中跟练计划。',
      })
    }

    if (isSimilarTarget(input.targetSideEffect, plan.targetSideEffect)) {
      conflicts.push({
        type: 'same_target_active_plan',
        planId: plan.id,
        planTitle: plan.title,
        targetSideEffect: plan.targetSideEffect,
        reason: '已有同一不适或副作用的进行中跟练计划。',
      })
    }

    const overlapTimes = []
    for (const newTodo of input.todos) {
      const newMinute = todoMinuteValue(newTodo.date, newTodo.time)
      if (newMinute == null) continue
      for (const existingTodo of plan.todos) {
        if (isTodoClosed(existingTodo.status)) continue
        const existingMinute = todoMinuteValue(existingTodo.date, existingTodo.time)
        if (existingMinute == null) continue
        const deltaMinutes = Math.abs(newMinute - existingMinute)
        if (deltaMinutes > TODO_CONFLICT_WINDOW_MINUTES) continue
        overlapTimes.push({
          newTime: todoTimeLabel(newTodo.date, newTodo.time),
          existingTime: todoTimeLabel(existingTodo.date, existingTodo.time),
          existingTodoPrompt: existingTodo.showPrompt,
          deltaMinutes,
        })
      }
    }

    if (overlapTimes.length > 0) {
      conflicts.push({
        type: 'time_slot_overlap',
        planId: plan.id,
        planTitle: plan.title,
        targetSideEffect: plan.targetSideEffect,
        reason: `已有跟练计划在 ${TODO_CONFLICT_WINDOW_MINUTES} 分钟窗口内安排了待执行提醒。`,
        overlapTimes,
      })
    }
  }

  return conflicts
}

export function shouldRetainTodoItemAfterPlanStop(input: { status: TodoItemStatus }): boolean {
  return input.status === 'started' || isTodoClosed(input.status)
}

export function todoItemsToCarryIntoUpdatedPlan<T extends { status: TodoItemStatus }>(_items: T[]): T[] {
  return []
}

function todoStatusMark(status: TodoItemStatus): string {
  if (status === 'completed') return 'x'
  if (status === 'not_practiced') return '-'
  return ''
}

function todoPlanStatusForItems(plan: TodoPlanRow, items: TodoItemRow[]): TodoPlanStatus {
  const allClosed = items.length > 0 && items.every((item) => isTodoClosed(item.status))
  if (allClosed) return 'completed'
  return plan.status === 'not_started' ? 'in_progress' : plan.status
}

function todoClosedReasonForStatus(status: TodoItemStatus): TodoItemClosedReason | null {
  if (status === 'completed') return 'feedback'
  if (status === 'not_practiced') return 'user_not_practiced'
  return null
}

function todoToSummary(row: TodoItemRow): TodoToolTodoSummary {
  return {
    id: row.id,
    date: todoDateToString(row.todoDate),
    time: row.todoTime,
    showPrompt: row.showPrompt,
    prompt: row.prompt,
    scheduleId: row.scheduleId,
    status: row.status,
    feedback: row.feedback,
    notifiedAt: toIso(row.notifiedAt),
    startedAt: toIso(row.startedAt),
    completedAt: toIso(row.completedAt),
    closedReason: row.closedReason,
  }
}

function planToSummary(plan: TodoPlanRow, items: TodoItemRow[]): TodoToolPlanSummary {
  return {
    id: plan.id,
    title: plan.title,
    status: plan.status,
    timezone: plan.timezone,
    sourceType: plan.sourceType,
    sourceId: plan.sourceId,
    resourceRefId: plan.resourceRefId,
    courseDays: plan.courseDays,
    targetSideEffect: plan.targetSideEffect,
    dedupeKey: plan.dedupeKey,
    todosMd: plan.todosMd,
    todos: items.map(todoToSummary),
    createdAt: plan.createdAt.toISOString(),
    updatedAt: plan.updatedAt.toISOString(),
    startedAt: toIso(plan.startedAt),
    completedAt: toIso(plan.completedAt),
    stoppedAt: toIso(plan.stoppedAt),
  }
}

export function renderTodosMarkdown(
  todos: Array<{
    date: string
    time: string
    showPrompt: string
    status: TodoItemStatus
    feedback?: TodoFeedback | null
  }>,
): string {
  const sorted = [...todos].sort((a, b) =>
    a.date.localeCompare(b.date) || a.time.localeCompare(b.time)
  )
  const lines: string[] = []
  let currentDate: string | null = null
  for (const todo of sorted) {
    if (todo.date !== currentDate) {
      if (lines.length > 0) lines.push('')
      lines.push(`${todo.date}:`)
      currentDate = todo.date
    }
    lines.push(`[${todoStatusMark(todo.status)}] ${todo.time} ${todo.showPrompt}`)
    if (todo.feedback) lines.push(`  - feedback: ${FEEDBACK_LABELS[todo.feedback]}`)
  }
  return lines.join('\n')
}

export function classifyTodoReplyText(text: string): TodoReplyClassification {
  const normalized = text.trim().toLowerCase()
  const hasWorse = /(更痛|更疼|变差|加重|更严重|恶化)/.test(normalized)
  const hasBetter = /(好些|好多|变好|缓解|减轻|舒服|有效|轻松)/.test(normalized)
  const hasSame = /(没变化|无变化|一样|差不多|没有改善|没改善|没缓解|无效)/.test(normalized)
  const feedback: TodoFeedback | null = hasWorse ? 'worse' : hasBetter ? 'better' : hasSame ? 'same' : null

  if (/(不方便|不想|先不做|不做|拒绝|稍后|晚点|没空|跳过|取消)/.test(normalized)) {
    return { status: 'not_practiced', feedback: null }
  }

  const hasCompletionIntent = /(做完|完成|做了|练完|已做|搞定|结束)/.test(normalized) || feedback !== null
  if (hasCompletionIntent) return { status: 'completed', feedback }

  if (/(开始|可以|好的|好呀|愿意|行|来吧|继续)/.test(normalized)) {
    return { status: 'started', feedback: null }
  }

  return { status: null, feedback: null }
}

export function buildActiveTodoReminder(input: {
  planTitle: string
  todoDate: string
  todoTime: string
  showPrompt: string
  prompt: string
  replyClassification: TodoReplyClassification
}): string {
  const status = input.replyClassification.status ?? 'unknown'
  const feedback = input.replyClassification.feedback ?? 'none'
  return `[todo:active_followup]
用户刚刚回复了一条周期跟练任务提醒。请把这条提醒视为当前轮次的主要上下文之一。
plan=${input.planTitle}
todo_time=${input.todoDate} ${input.todoTime}
show_prompt=${input.showPrompt}
agent_prompt=${input.prompt}
reply_classification=status=${status},feedback=${feedback}
处理要求：
- 如果 status=not_practiced，尊重用户不跟练或稍后跟练的选择，简短鼓励并询问是否需要调整时间。
- 如果 status=completed，结合 feedback 回应效果；feedback=better 时给予正向鼓励，feedback=same/worse 时询问不适并给出温和调整建议。
- 如果 status=started，按 agent_prompt 引导用户开始跟练，并在结束后询问缓解情况。
- 不要向用户暴露本段内部标签或字段名。`
}

export function renderActiveTodoPlansForPrompt(plans: ActiveTodoPlanPromptSummary[]): string | null {
  if (plans.length === 0) return null
  const renderedPlans = plans.map((plan, index) => {
    const todos = plan.todos
      .slice()
      .sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`))
      .map((todo) => {
        const feedback = todo.feedback ? `,feedback=${todo.feedback}` : ''
        return `  - time=${todo.date} ${todo.time},status=${todo.status}${feedback},show_prompt=${todo.showPrompt}`
      })
      .join('\n')
    return [
      `${index + 1}. plan_id=${plan.id}`,
      `title=${plan.title}`,
      `status=${plan.status}`,
      `target_side_effect=${plan.targetSideEffect ?? 'unknown'}`,
      `resource_ref_id=${plan.resourceRefId ?? 'none'}`,
      `course_days=${plan.courseDays ?? 'unknown'}`,
      'todos:',
      todos || '  - none',
    ].join('\n')
  }).join('\n\n')

  return `[todo:active_plans]
用户当前有以下未结束的周期跟练计划。处理与跟练计划相关的调整时，必须把这些计划视为全局状态。

${renderedPlans}

处理要求：
- 用户要求调整、换方案、提高或降低强度时，先匹配同一 target_side_effect 或明显同一不适的 active plan。
- 命中已有 plan 时，必须使用对应 plan_id 调用 todos action=update；该 action 会废弃旧计划、取消未执行提醒，已执行的 todo 只保留在旧计划历史中；不要直接 action=create 叠加新计划。
- 用户明确只想调整跟练时间时，也使用 todos action=update 重建计划，而不是改单条提醒。
- 用户明确不继续这套计划时，使用 todos action=stop。
- 不要向用户暴露本段内部标签或字段名。`
}

export async function listActiveTodoPlansForPrompt(userId: string, limit = 5): Promise<string | null> {
  const plans = await getDb().query.todoPlans.findMany({
    where: and(eq(todoPlans.userId, userId), inArray(todoPlans.status, ACTIVE_PLAN_STATUSES)),
    orderBy: desc(todoPlans.updatedAt),
    limit,
  })
  if (plans.length === 0) return null

  const summaries: ActiveTodoPlanPromptSummary[] = []
  for (const plan of plans) {
    const items = await getDb().query.todoItems.findMany({
      where: eq(todoItems.planId, plan.id),
      orderBy: asc(todoItems.todoDate),
    })
    summaries.push({
      id: plan.id,
      title: plan.title,
      status: plan.status,
      targetSideEffect: plan.targetSideEffect,
      resourceRefId: plan.resourceRefId,
      courseDays: plan.courseDays,
      todos: items.map((item) => ({
        id: item.id,
        date: todoDateToString(item.todoDate),
        time: item.todoTime,
        showPrompt: item.showPrompt,
        status: item.status,
        feedback: item.feedback,
      })),
    })
  }

  return renderActiveTodoPlansForPrompt(summaries)
}

const TODO_PLAN_LIST_LIMIT = 50

/** 「我的提醒」跟练计划 Tab：列出当前用户的跟练计划（含每日 todos）。 */
export async function listTodoPlansForUser(userId: string): Promise<TodoToolPlanSummary[]> {
  const db = getDb()
  const plans = await db.query.todoPlans.findMany({
    where: eq(todoPlans.userId, userId),
    orderBy: desc(todoPlans.updatedAt),
    limit: TODO_PLAN_LIST_LIMIT,
  })
  const summaries: TodoToolPlanSummary[] = []
  for (const plan of plans) {
    const items = await db.query.todoItems.findMany({
      where: eq(todoItems.planId, plan.id),
      orderBy: [asc(todoItems.todoDate), asc(todoItems.todoTime), asc(todoItems.createdAt)],
    })
    summaries.push(planToSummary(plan, items))
  }
  return summaries
}

/**
 * 取某条 todo 事项的可播放资源（日历详情点播）。
 * 干预素材刷新签名 URL 并解析原会话 toolCallId 以复用「开始跟练」交互；视频类直接返回快照。
 */
export async function getTodoItemPlayableResource(
  userId: string,
  todoItemId: string,
  logger: Logger,
): Promise<TodoItemPlayableResource | null> {
  const db = getDb()
  const item = await db.query.todoItems.findFirst({
    where: and(eq(todoItems.id, todoItemId), eq(todoItems.userId, userId)),
  })
  if (!item) return null
  const plan = await db.query.todoPlans.findFirst({
    where: and(eq(todoPlans.id, item.planId), eq(todoPlans.userId, userId)),
  })
  if (!plan) return null

  const snapshot = plan.resourceSnapshot as MedicalRiskResource | null
  if (!snapshot) return null

  const todoContext: MedicalRiskResourceTodoContext = {
    planId: plan.id,
    todoId: item.id,
    scheduledMessageId: item.scheduleId,
    feedback: item.feedback,
    status: item.status,
  }

  const toolCallId = await findResourceToolCallIdInSession(plan.sessionId, snapshot.id)

  if (snapshot.kind === 'intervention_material') {
    const refreshed = await refreshInterventionToolOutput(snapshot.material, logger)
    return {
      kind: 'intervention_material',
      sessionId: plan.sessionId,
      toolCallId,
      output: refreshed ?? snapshot.material,
      todoContext,
    }
  }

  if (snapshot.kind === 'internal_video') {
    return {
      kind: 'internal_video',
      sessionId: plan.sessionId,
      toolCallId,
      resource: snapshot,
      todoContext,
    }
  }

  return {
    kind: 'video_resource',
    sessionId: plan.sessionId,
    resource: { ...snapshot, todoContext },
    todoContext,
  }
}

async function loadPlanWithItems(planId: string, userId: string): Promise<{
  plan: TodoPlanRow
  items: TodoItemRow[]
} | null> {
  const db = getDb()
  const plan = await db.query.todoPlans.findFirst({
    where: and(eq(todoPlans.id, planId), eq(todoPlans.userId, userId)),
  })
  if (!plan) return null
  const items = await db.query.todoItems.findMany({
    where: eq(todoItems.planId, plan.id),
    orderBy: [asc(todoItems.todoDate), asc(todoItems.todoTime), asc(todoItems.createdAt)],
  })
  return { plan, items }
}

async function refreshPlanMarkdown(plan: TodoPlanRow): Promise<{ plan: TodoPlanRow; items: TodoItemRow[] }> {
  const db = getDb()
  const items = await db.query.todoItems.findMany({
    where: eq(todoItems.planId, plan.id),
    orderBy: [asc(todoItems.todoDate), asc(todoItems.todoTime), asc(todoItems.createdAt)],
  })
  const todosMd = renderTodosMarkdown(items.map((item) => ({
    date: todoDateToString(item.todoDate),
    time: item.todoTime,
    showPrompt: item.showPrompt,
    status: item.status,
    feedback: item.feedback,
  })))
  const [updatedPlan] = await db.update(todoPlans)
    .set({ todosMd, updatedAt: new Date() })
    .where(eq(todoPlans.id, plan.id))
    .returning()
  return { plan: updatedPlan ?? { ...plan, todosMd }, items }
}

function buildTodoOutput(params: {
  action: TodoPlanAction
  plan: TodoPlanRow
  items: TodoItemRow[]
  previousPlanId?: string | null
  message: string
}): TodoToolPlanOutput {
  return {
    kind: 'todos',
    action: params.action,
    plan: planToSummary(params.plan, params.items),
    previousPlanId: params.previousPlanId,
    message: params.message,
  }
}

function buildTodoConflictOutput(conflicts: TodoPlanConflict[]): TodoToolConflictOutput {
  return {
    kind: 'todos_conflict',
    action: 'create',
    sourceAction: 'create',
    conflicts,
    message: '检测到新的跟练计划与已有计划冲突，尚未创建。',
    nextAction: 'ask_user_question',
  }
}

async function listActiveTodoPlanConflictCandidates(userId: string): Promise<TodoPlanConflictCandidate[]> {
  const db = getDb()
  const plans = await db.query.todoPlans.findMany({
    where: and(eq(todoPlans.userId, userId), inArray(todoPlans.status, ACTIVE_PLAN_STATUSES)),
    orderBy: desc(todoPlans.updatedAt),
  })
  const result: TodoPlanConflictCandidate[] = []
  for (const plan of plans) {
    const items = await db.query.todoItems.findMany({
      where: eq(todoItems.planId, plan.id),
      orderBy: [asc(todoItems.todoDate), asc(todoItems.todoTime), asc(todoItems.createdAt)],
    })
    result.push({
      id: plan.id,
      title: plan.title,
      status: plan.status,
      targetSideEffect: plan.targetSideEffect,
      sourceType: plan.sourceType,
      sourceId: plan.sourceId,
      resourceRefId: plan.resourceRefId,
      dedupeKey: plan.dedupeKey,
      todos: items.map((item) => ({
        date: todoDateToString(item.todoDate),
        time: item.todoTime,
        showPrompt: item.showPrompt,
        status: item.status,
      })),
    })
  }
  return result
}

export async function createTodoPlan(input: CreateTodoPlanInput, logger: Logger): Promise<TodoToolOutput> {
  const title = trimText(input.title, 160)
  if (!title) throw new Error('title 不能为空')
  const timezone = trimText(input.timezone, 64) ?? DEFAULT_TODO_TIMEZONE
  if (timezone !== DEFAULT_TODO_TIMEZONE) throw new Error('当前 todos 仅支持 Asia/Shanghai 时区')
  if (!Array.isArray(input.todos) || input.todos.length === 0) throw new Error('todos 不能为空')

  const db = getDb()
  const dedupeKey = trimText(input.dedupeKey, 160)
  const resourceRefId = trimText(input.resourceRefId, 80)
  const courseDays = normalizeCourseDays(input.courseDays)
  const targetSideEffect = trimText(input.targetSideEffect, 120)
  const sourceType = normalizeSourceType(input.sourceType)
  const sourceId = trimText(input.sourceId, 160)
  const now = new Date()
  validateTodoInputsAreFuture({ todos: input.todos, timezone, now })
  if (!input.skipConflictCheck) {
    const conflicts = detectTodoPlanConflicts({
      title,
      targetSideEffect,
      sourceType,
      sourceId,
      resourceRefId,
      dedupeKey,
      todos: input.todos,
      existingPlans: await listActiveTodoPlanConflictCandidates(input.userId),
    })
    if (conflicts.length > 0) {
      return buildTodoConflictOutput(conflicts)
    }
  }

  const [plan] = await db.insert(todoPlans).values({
    userId: input.userId,
    sessionId: input.sessionId,
    title,
    timezone,
    sourceType,
    sourceId,
    resourceRefId,
    courseDays,
    targetSideEffect,
    resourceSnapshot: input.resourceSnapshot ?? null,
    dedupeKey,
    createdAt: now,
    updatedAt: now,
  }).returning()

  const createdScheduleIds: string[] = []
  try {
    for (const rawTodo of input.todos) {
      const showPrompt = trimText(rawTodo.showPrompt, 500)
      const prompt = trimText(rawTodo.prompt, 4000)
      if (!showPrompt) throw new Error('todo.show_prompt 不能为空')
      if (!prompt) throw new Error('todo.prompt 不能为空')
      const dueAt = parseTodoDateTime({ date: rawTodo.date, time: rawTodo.time, timezone })

      const [item] = await db.insert(todoItems).values({
        planId: plan.id,
        userId: input.userId,
        sessionId: input.sessionId,
        todoDate: rawTodo.date,
        todoTime: rawTodo.time,
        showPrompt,
        prompt,
        createdAt: now,
        updatedAt: now,
      }).returning()

      const schedule = await scheduleProactiveMessage({
        userId: input.userId,
        sessionId: input.sessionId,
        purpose: 'custom',
        timeSource: 'user_explicit',
        scheduleType: 'once',
        timezone,
        taskName: title,
        dueAt,
        messageContent: showPrompt,
        pushAlert: showPrompt,
        entityType: 'todo_item',
        entityId: item.id,
        dedupeKey: `todo_item:${item.id}`,
        metadata: {
          type: 'todo_item',
          todoPlanId: plan.id,
          todoItemId: item.id,
          resourceRefId,
          courseDays,
          targetSideEffect,
          resource: input.resourceSnapshot ?? null,
        },
      }, logger)
      createdScheduleIds.push(schedule.id)

      await db.update(todoItems)
        .set({ scheduleId: schedule.id, updatedAt: new Date() })
        .where(eq(todoItems.id, item.id))
    }
  } catch (err) {
    await cancelScheduledProactiveMessagesByIds({ userId: input.userId, ids: createdScheduleIds }, logger)
    await db.update(todoPlans)
      .set({
        status: 'stopped',
        stoppedReason: 'create_failed',
        stoppedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(todoPlans.id, plan.id))
    throw err
  }

  const refreshed = await refreshPlanMarkdown(plan)
  logger.info({ todoPlanId: refreshed.plan.id, todoCount: refreshed.items.length }, 'todo plan created')
  return buildTodoOutput({
    action: 'create',
    plan: refreshed.plan,
    items: refreshed.items,
    message: `已创建跟练计划「${title}」，并为每个 todo 创建了提醒。`,
  })
}

export async function stopTodoPlan(input: StopTodoPlanInput, logger: Logger): Promise<TodoToolOutput> {
  const loaded = await loadPlanWithItems(input.planId, input.userId)
  if (!loaded) throw new Error('未找到这份跟练计划')

  const scheduleIds = loaded.items
    .filter((item) => !shouldRetainTodoItemAfterPlanStop(item) && item.scheduleId)
    .map((item) => item.scheduleId as string)
  const canceledCount = await cancelScheduledProactiveMessagesByIds({
    userId: input.userId,
    ids: scheduleIds,
  }, logger)

  const db = getDb()
  const now = new Date()
  await db.update(todoItems)
    .set({
      status: 'completed',
      completedAt: now,
      closedReason: 'auto_completed_before_next_trigger',
      updatedAt: now,
    })
    .where(and(
      eq(todoItems.planId, loaded.plan.id),
      eq(todoItems.userId, input.userId),
      eq(todoItems.status, 'started'),
    ))

  await db.delete(todoItems)
    .where(and(
      eq(todoItems.planId, loaded.plan.id),
      eq(todoItems.userId, input.userId),
      inArray(todoItems.status, ['pending', 'notified'] satisfies TodoItemStatus[]),
    ))

  const [updatedPlan] = await db.update(todoPlans)
    .set({
      status: 'stopped',
      stoppedReason: trimText(input.reason, 500),
      stoppedAt: now,
      updatedAt: now,
    })
    .where(and(eq(todoPlans.id, loaded.plan.id), eq(todoPlans.userId, input.userId)))
    .returning()

  const refreshed = await refreshPlanMarkdown(updatedPlan ?? loaded.plan)
  return buildTodoOutput({
    action: 'stop',
    plan: refreshed.plan,
    items: refreshed.items,
    message: `已终止跟练计划，并取消 ${canceledCount} 条未执行提醒；未执行的 todo 已移除，已闭合的 todo 已保留。`,
  })
}

export async function updateTodoPlan(input: UpdateTodoPlanInput, logger: Logger): Promise<TodoToolOutput> {
  const loaded = await loadPlanWithItems(input.planId, input.userId)
  if (!loaded) throw new Error('未找到这份跟练计划')
  validateTodoInputsAreFuture({
    todos: input.todos,
    timezone: input.timezone,
  })

  await stopTodoPlan({
    userId: input.userId,
    planId: input.planId,
    reason: input.reason ?? 'update_plan',
  }, logger)
  const created = await createTodoPlan({
    userId: input.userId,
    sessionId: input.sessionId,
    title: input.title,
    timezone: input.timezone,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    resourceRefId: input.resourceRefId,
    courseDays: input.courseDays,
    targetSideEffect: input.targetSideEffect,
    resourceSnapshot: input.resourceSnapshot,
    dedupeKey: input.dedupeKey,
    todos: input.todos,
    skipConflictCheck: true,
  }, logger)
  if (created.kind === 'todos_conflict') return created

  const carriedItems = todoItemsToCarryIntoUpdatedPlan(loaded.items)
  if (carriedItems.length > 0) {
    const now = new Date()
    await getDb().insert(todoItems).values(carriedItems.map((item) => {
      const status: TodoItemStatus = item.status === 'started' ? 'completed' : item.status
      return {
        planId: created.plan.id,
        userId: input.userId,
        sessionId: input.sessionId,
        scheduleId: null,
        todoDate: todoDateToString(item.todoDate),
        todoTime: item.todoTime,
        showPrompt: item.showPrompt,
        prompt: item.prompt,
        status,
        feedback: item.feedback,
        notifiedAt: item.notifiedAt,
        startedAt: item.startedAt,
        completedAt: item.completedAt ?? now,
        closedReason: item.closedReason ?? (item.status === 'started'
          ? 'auto_completed_before_next_trigger'
          : todoClosedReasonForStatus(status)),
        createdAt: now,
        updatedAt: now,
      }
    }))

    await getDb().update(todoPlans)
      .set({
        status: 'in_progress',
        startedAt: loaded.plan.startedAt ?? carriedItems[0]?.completedAt ?? now,
        updatedAt: now,
      })
      .where(and(eq(todoPlans.id, created.plan.id), eq(todoPlans.userId, input.userId)))
  }

  const refreshedLoaded = await loadPlanWithItems(created.plan.id, input.userId)
  if (!refreshedLoaded) throw new Error('新跟练计划创建后读取失败')
  const refreshed = await refreshPlanMarkdown(refreshedLoaded.plan)

  return buildTodoOutput({
    action: 'update',
    plan: refreshed.plan,
    items: refreshed.items,
    previousPlanId: input.planId,
    message: `已废弃原计划并重建新的跟练计划「${created.plan.title}」，旧计划中已执行的 todo 仍保留在旧计划历史中。`,
  })
}

export async function consumeScheduledTodoReminderForTurn(input: {
  userId: string
  sessionId: string
  latestUserMessageId: string | null
  latestUserMessageContent: string
}, logger: Logger): Promise<string | null> {
  if (!input.latestUserMessageId) return null
  const db = getDb()
  const latestUser = await db.query.messages.findFirst({
    where: and(
      eq(messages.id, input.latestUserMessageId),
      eq(messages.sessionId, input.sessionId),
      eq(messages.role, 'user'),
    ),
  })
  if (!latestUser) return null

  const latestAssistant = await db.query.messages.findFirst({
    where: and(
      eq(messages.sessionId, input.sessionId),
      eq(messages.role, 'assistant'),
      lt(messages.createdAt, latestUser.createdAt),
    ),
    orderBy: desc(messages.createdAt),
  })
  const metadata = scheduledTodoMetadataFromRawResponse(latestAssistant?.rawResponse)
  if (!metadata) return null

  const item = await db.query.todoItems.findFirst({
    where: and(
      eq(todoItems.id, metadata.todoItemId),
      eq(todoItems.planId, metadata.todoPlanId),
      eq(todoItems.userId, input.userId),
    ),
  })
  const plan = await db.query.todoPlans.findFirst({
    where: and(
      eq(todoPlans.id, metadata.todoPlanId),
      eq(todoPlans.userId, input.userId),
    ),
  })
  if (!item || !plan || plan.status === 'stopped' || plan.status === 'completed') return null

  const classification = classifyTodoReplyText(input.latestUserMessageContent)
  const now = new Date()
  const itemPatch: Partial<typeof todoItems.$inferInsert> = {
    notifiedAt: item.notifiedAt ?? now,
    updatedAt: now,
  }
  if (classification.status) itemPatch.status = classification.status
  if (classification.status === 'started') itemPatch.startedAt = item.startedAt ?? now
  if (classification.feedback) itemPatch.feedback = classification.feedback
  if (classification.status && isTodoClosed(classification.status)) {
    itemPatch.completedAt = item.completedAt ?? now
    itemPatch.closedReason = todoClosedReasonForStatus(classification.status)
  }

  const [updatedItem] = await db.update(todoItems)
    .set(itemPatch)
    .where(and(eq(todoItems.id, item.id), eq(todoItems.userId, input.userId)))
    .returning()

  const allItems = await db.query.todoItems.findMany({
    where: eq(todoItems.planId, plan.id),
    orderBy: [asc(todoItems.todoDate), asc(todoItems.todoTime), asc(todoItems.createdAt)],
  })
  const mergedItems = allItems.map((candidate) =>
    candidate.id === item.id && updatedItem ? updatedItem : candidate
  )
  const allDone = mergedItems.length > 0 && mergedItems.every((candidate) => isTodoClosed(candidate.status))
  const nextStatus = todoPlanStatusForItems(plan, mergedItems)
  const todosMd = renderTodosMarkdown(mergedItems.map((candidate) => ({
    date: todoDateToString(candidate.todoDate),
    time: candidate.todoTime,
    showPrompt: candidate.showPrompt,
    status: candidate.status,
    feedback: candidate.feedback,
  })))

  await db.update(todoPlans)
    .set({
      status: nextStatus,
      todosMd,
      startedAt: plan.startedAt ?? now,
      completedAt: allDone ? (plan.completedAt ?? now) : plan.completedAt,
      updatedAt: now,
    })
    .where(and(eq(todoPlans.id, plan.id), eq(todoPlans.userId, input.userId)))

  logger.info({
    todoPlanId: plan.id,
    todoItemId: item.id,
    status: classification.status,
    feedback: classification.feedback,
  }, 'scheduled todo reply consumed')

  const activeItem = updatedItem ?? item
  return buildActiveTodoReminder({
    planTitle: plan.title,
    todoDate: todoDateToString(activeItem.todoDate),
    todoTime: activeItem.todoTime,
    showPrompt: activeItem.showPrompt,
    prompt: activeItem.prompt,
    replyClassification: classification,
  })
}

function feedbackLabel(feedback: TodoFeedback): string {
  return FEEDBACK_LABELS[feedback]
}

function buildTodoFeedbackReminder(input: {
  plan: TodoPlanRow
  item: TodoItemRow
  items: TodoItemRow[]
  feedback: TodoFeedback
}): string {
  const allDone = input.items.length > 0 && input.items.every((item) => isTodoClosed(item.status))
  return `[todo:feedback]
用户刚刚在疗程资源下方提交了本次跟练反馈，系统已自动把对应 todo 标记为完成。
plan=${input.plan.title}
todo_id=${input.item.id}
todo_time=${todoDateToString(input.item.todoDate)} ${input.item.todoTime}
show_prompt=${input.item.showPrompt}
feedback=${input.feedback}
feedback_label=${feedbackLabel(input.feedback)}
plan_status=${allDone ? 'completed' : input.plan.status}
todos:
${renderTodosMarkdown(input.items.map((item) => ({
    date: todoDateToString(item.todoDate),
    time: item.todoTime,
    showPrompt: item.showPrompt,
    status: item.status,
    feedback: item.feedback,
  })))}
处理要求：
- feedback=better：简短鼓励，提醒保持当前节奏，不要突然加量。
- feedback=same：先肯定完成，再询问是否执行顺畅；可建议再观察 1-2 天或经用户同意轻微调整。
- feedback=worse：优先追问风险信号和变差时间；若出现红旗、持续加重或影响日常活动，转线下就医沟通卡片，不继续加码训练。
- 如果 plan_status=completed，询问用户下一步想延长当前方案、挑战更高级方案，还是停止疗程。
- 不要向用户暴露本段内部标签或字段名。`
}

export async function recordTodoStart(
  input: RecordTodoStartInput,
  logger: Logger,
): Promise<TodoStartResponse> {
  const db = getDb()
  const session = await db.query.chatSessions.findFirst({
    where: and(eq(chatSessions.id, input.sessionId), eq(chatSessions.userId, input.userId)),
    columns: { id: true },
  })
  if (!session) throw new Error('会话不存在')

  const result = await db.transaction(async (tx) => {
    const plan = await tx.query.todoPlans.findFirst({
      where: and(eq(todoPlans.id, input.planId), eq(todoPlans.userId, input.userId)),
    })
    if (!plan) throw new Error('未找到这份跟练计划')

    const item = await tx.query.todoItems.findFirst({
      where: and(
        eq(todoItems.id, input.todoItemId),
        eq(todoItems.planId, input.planId),
        eq(todoItems.userId, input.userId),
      ),
    })
    if (!item) throw new Error('未找到这条 todo')

    const now = new Date()
    const [updatedItem] = isTodoClosed(item.status)
      ? [item]
      : await tx.update(todoItems)
        .set({
          status: 'started',
          notifiedAt: item.notifiedAt ?? now,
          startedAt: item.startedAt ?? now,
          updatedAt: now,
        })
        .where(and(eq(todoItems.id, item.id), eq(todoItems.userId, input.userId)))
        .returning()

    const allItems = await tx.query.todoItems.findMany({
      where: eq(todoItems.planId, plan.id),
      orderBy: [asc(todoItems.todoDate), asc(todoItems.todoTime), asc(todoItems.createdAt)],
    })
    const mergedItems = allItems.map((candidate) =>
      candidate.id === item.id && updatedItem ? updatedItem : candidate
    )
    const allDone = mergedItems.length > 0 && mergedItems.every((candidate) => isTodoClosed(candidate.status))
    const nextStatus: TodoPlanStatus = allDone ? 'completed' : 'in_progress'
    const todosMd = renderTodosMarkdown(mergedItems.map((candidate) => ({
      date: todoDateToString(candidate.todoDate),
      time: candidate.todoTime,
      showPrompt: candidate.showPrompt,
      status: candidate.status,
      feedback: candidate.feedback,
    })))

    const [updatedPlan] = await tx.update(todoPlans)
      .set({
        status: nextStatus,
        todosMd,
        startedAt: plan.startedAt ?? now,
        completedAt: allDone ? (plan.completedAt ?? now) : plan.completedAt,
        updatedAt: now,
      })
      .where(and(eq(todoPlans.id, plan.id), eq(todoPlans.userId, input.userId)))
      .returning()

    return {
      plan: updatedPlan ?? { ...plan, status: nextStatus, todosMd },
      item: updatedItem ?? item,
      items: mergedItems,
    }
  })

  logger.info({
    todoPlanId: result.plan.id,
    todoItemId: result.item.id,
  }, 'todo start recorded')

  return {
    plan: planToSummary(result.plan, result.items),
    todo: todoToSummary(result.item),
  }
}

export async function recordTodoFeedback(
  input: RecordTodoFeedbackInput,
  logger: Logger,
): Promise<TodoFeedbackResponse> {
  const db = getDb()
  const session = await db.query.chatSessions.findFirst({
    where: and(eq(chatSessions.id, input.sessionId), eq(chatSessions.userId, input.userId)),
    columns: { id: true },
  })
  if (!session) throw new Error('会话不存在')

  const result = await db.transaction(async (tx) => {
    const plan = await tx.query.todoPlans.findFirst({
      where: and(eq(todoPlans.id, input.planId), eq(todoPlans.userId, input.userId)),
    })
    if (!plan) throw new Error('未找到这份跟练计划')

    const item = await tx.query.todoItems.findFirst({
      where: and(
        eq(todoItems.id, input.todoItemId),
        eq(todoItems.planId, input.planId),
        eq(todoItems.userId, input.userId),
      ),
    })
    if (!item) throw new Error('未找到这条 todo')

    const now = new Date()
    const [updatedItem] = await tx.update(todoItems)
      .set({
        status: 'completed',
        feedback: input.feedback,
        notifiedAt: item.notifiedAt ?? now,
        startedAt: item.startedAt ?? now,
        completedAt: item.completedAt ?? now,
        closedReason: 'feedback',
        updatedAt: now,
      })
      .where(and(eq(todoItems.id, item.id), eq(todoItems.userId, input.userId)))
      .returning()

    const allItems = await tx.query.todoItems.findMany({
      where: eq(todoItems.planId, plan.id),
      orderBy: [asc(todoItems.todoDate), asc(todoItems.todoTime), asc(todoItems.createdAt)],
    })
    const mergedItems = allItems.map((candidate) =>
      candidate.id === item.id && updatedItem ? updatedItem : candidate
    )
    const allDone = mergedItems.length > 0 && mergedItems.every((candidate) => isTodoClosed(candidate.status))
    const nextStatus = todoPlanStatusForItems(plan, mergedItems)
    const todosMd = renderTodosMarkdown(mergedItems.map((candidate) => ({
      date: todoDateToString(candidate.todoDate),
      time: candidate.todoTime,
      showPrompt: candidate.showPrompt,
      status: candidate.status,
      feedback: candidate.feedback,
    })))

    const [updatedPlan] = await tx.update(todoPlans)
      .set({
        status: nextStatus,
        todosMd,
        startedAt: plan.startedAt ?? now,
        completedAt: allDone ? (plan.completedAt ?? now) : plan.completedAt,
        updatedAt: now,
      })
      .where(and(eq(todoPlans.id, plan.id), eq(todoPlans.userId, input.userId)))
      .returning()

    return {
      plan: updatedPlan ?? { ...plan, status: nextStatus, todosMd },
      item: updatedItem ?? item,
      items: mergedItems,
    }
  })

  await appendPendingSystemReminder(
    input.sessionId,
    buildTodoFeedbackReminder({
      plan: result.plan,
      item: result.item,
      items: result.items,
      feedback: input.feedback,
    }),
    logger,
  )

  logger.info({
    todoPlanId: result.plan.id,
    todoItemId: result.item.id,
    feedback: input.feedback,
  }, 'todo feedback recorded')

  return {
    plan: planToSummary(result.plan, result.items),
    todo: todoToSummary(result.item),
  }
}
