import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assignStableScheduledTaskDisplayIds,
  buildScheduledTodoRawResponse,
  buildScheduledTodoSyntheticUserContent,
  deriveScheduledTodoAutoCloseState,
  isScheduledTodoMetadata,
  parseScheduledTimeInput,
  refineScheduledTaskNameForCreate,
  renderFutureScheduledTasksForFollowupContext,
  renderFutureScheduledTasksForTool,
  renderScheduledTaskCreationResultForTool,
  renderScheduledTaskUpdateResultForTool,
  scheduledTodoMetadataFromRawResponse,
  shouldSkipOverdueScheduledTask,
  validateScheduledProactiveDueAt,
} from './scheduled-proactive-message.js'
import { SYNTHETIC_SCHEDULED_TODO_TRIGGER_MARKER } from '../utils/repeated-user-message.js'

test('scheduled proactive message validates future time', () => {
  const now = new Date('2026-05-12T02:00:00.000Z') // Asia/Shanghai 10:00

  assert.equal(
    validateScheduledProactiveDueAt({
      now,
      dueAt: new Date('2026-05-12T02:10:00.000Z'),
      timeSource: 'ai_inferred_default',
    }),
    null,
  )
  assert.equal(
    validateScheduledProactiveDueAt({
      now,
      dueAt: new Date('2026-05-12T03:00:00.000Z'),
      timeSource: 'ai_inferred_default',
    }),
    null,
  )
  assert.equal(
    validateScheduledProactiveDueAt({
      now,
      dueAt: new Date('2026-05-12T01:59:00.000Z'),
      timeSource: 'ai_inferred_default',
    }),
    'time 必须是未来时间',
  )
})

test('scheduled proactive message accepts explicit future user time', () => {
  assert.equal(
    validateScheduledProactiveDueAt({
      now: new Date('2026-05-12T02:00:00.000Z'),
      dueAt: new Date('2026-05-12T02:05:00.000Z'),
      timeSource: 'user_explicit',
    }),
    null,
  )
})

test('scheduled todo metadata is embedded in assistant raw response', () => {
  const metadata = {
    type: 'todo_item' as const,
    todoPlanId: 'plan-1',
    todoItemId: 'item-1',
  }

  assert.equal(isScheduledTodoMetadata(metadata), true)

  const rawResponse = buildScheduledTodoRawResponse({
    scheduledMessageId: 'schedule-1',
    metadata,
  })

  assert.deepEqual(scheduledTodoMetadataFromRawResponse(rawResponse), metadata)
  assert.equal(scheduledTodoMetadataFromRawResponse({ kind: 'other' }), null)
})

test('scheduled todo trigger builds hidden user context for the new session', () => {
  const content = buildScheduledTodoSyntheticUserContent({
    triggeredAt: new Date('2026-06-02T06:16:00.000Z'),
    plan: {
      id: 'plan-1',
      title: '手指晨僵缓解·3天跟练',
      targetSideEffect: '手指晨僵',
      courseDays: 3,
      todosMd: '- 6月2日 09:00 第一天手指操',
      resourceRefId: '1-4',
    } as any,
    item: {
      id: 'todo-1',
      todoDate: '2026-06-02',
      todoTime: '09:00',
      showPrompt: '早安，今天的手指晨僵跟练开始啦。',
      prompt: '带用户完成2分钟手指操，并询问完成后的体感。',
    } as any,
    items: [
      {
        id: 'todo-1',
        todoDate: '2026-06-02',
        todoTime: '09:00',
        showPrompt: '早安，今天的手指晨僵跟练开始啦。',
        prompt: '带用户完成2分钟手指操，并询问完成后的体感。',
      },
      {
        id: 'todo-2',
        todoDate: '2026-06-03',
        todoTime: '09:00',
        showPrompt: '第二天手指操提醒。',
        prompt: '继续带用户完成手指操。',
      },
    ] as any,
    resource: {
      id: 'todo-resource',
      kind: 'video_resource',
      title: '2分钟手指操视频',
    } as any,
  })

  assert.match(content, /^<system-reminder>/)
  assert.match(content, /\[scheduled-todo:trigger\]/)
  assert.match(content, /<trigger_reason>/)
  assert.match(content, /当前触发时间：2026-06-02 14:16/)
  assert.match(content, /当前会话由跟练周期计划的定时任务自动触发/)
  assert.match(content, /<goal>/)
  assert.match(content, /引导用户完成「手指晨僵缓解·3天跟练」中的本次跟练/)
  assert.match(content, /本次目标是完成第 1\/2 次跟练/)
  assert.match(content, /<todos>/)
  assert.match(content, /计划名称：手指晨僵缓解·3天跟练/)
  assert.match(content, /当前进度：0\/2 已完成/)
  assert.match(content, /<current_todo>/)
  assert.match(content, /todo_id: todo-1/)
  assert.match(content, /提醒文案：早安，今天的手指晨僵跟练开始啦。/)
  assert.match(content, /执行要求：带用户完成2分钟手指操，并询问完成后的体感。/)
  assert.match(content, /<resource>/)
  assert.match(content, /resource_ref_id: todo-resource/)
  assert.match(content, /资源类型：video_resource/)
  assert.match(content, /资源标题：2分钟手指操视频/)
  assert.match(content, /引用方式：<resource_ref id="todo-resource" \/>/)
  assert.match(content, /<execution_workflow>/)
  assert.match(content, /立即调用 `load_skill`，name=side-effect-course-management/)
  assert.equal(content.includes(SYNTHETIC_SCHEDULED_TODO_TRIGGER_MARKER), true)
  assert.match(content, /带我完成这次跟练/)
  assert.doesNotMatch(content, /todo_time=/)
  assert.doesNotMatch(content, /当前状态：notified/)
  assert.doesNotMatch(content, /资源时长/)
})

test('scheduled todo auto-close treats started items as completed and untouched items as not practiced', () => {
  assert.deepEqual(deriveScheduledTodoAutoCloseState({ status: 'started' }), {
    status: 'completed',
    closedReason: 'auto_completed_before_next_trigger',
  })
  assert.deepEqual(deriveScheduledTodoAutoCloseState({ status: 'notified' }), {
    status: 'not_practiced',
    closedReason: 'auto_not_practiced_before_next_trigger',
  })
  assert.deepEqual(deriveScheduledTodoAutoCloseState({ status: 'pending' }), {
    status: 'not_practiced',
    closedReason: 'auto_not_practiced_before_next_trigger',
  })
})

test('scheduled proactive message parses daily and weekly cron time', () => {
  const now = new Date('2026-05-12T02:00:00.000Z') // Asia/Shanghai Tuesday 10:00

  const daily = parseScheduledTimeInput({ time: '0 10 * * *', now })
  assert.equal(daily.scheduleType, 'cron')
  assert.equal(daily.cronExpression, '0 10 * * *')
  assert.equal(daily.timezone, 'Asia/Shanghai')
  assert.equal(daily.dueAt.toISOString(), '2026-05-13T02:00:00.000Z')

  const weekly = parseScheduledTimeInput({ time: '0 10 * * 3', now })
  assert.equal(weekly.scheduleType, 'cron')
  assert.equal(weekly.dueAt.toISOString(), '2026-05-13T02:00:00.000Z')
})

test('scheduled proactive message parses finite same-day two-hour cron', () => {
  const now = new Date('2026-05-14T01:00:00.000Z') // Asia/Shanghai 09:00
  const parsed = parseScheduledTimeInput({
    time: '0 0 */2 14 5 * 2026',
    now,
  })

  assert.equal(parsed.scheduleType, 'cron')
  assert.equal(parsed.dueAt.toISOString(), '2026-05-14T02:00:00.000Z')
})

test('scheduled proactive message rejects invalid or too frequent cron', () => {
  assert.throws(
    () => parseScheduledTimeInput({ time: '* * * * *', now: new Date('2026-05-12T02:00:00.000Z') }),
    /最小间隔不能低于 5 分钟/,
  )
  assert.throws(
    () => parseScheduledTimeInput({ time: 'bad bad bad bad bad', now: new Date('2026-05-12T02:00:00.000Z') }),
    /cron 表达式不合法/,
  )
})

test('renders future scheduled task ids for tool output', () => {
  const rendered = renderFutureScheduledTasksForTool([
    {
      taskId: 1,
      rowId: 'task-row-1',
      purpose: 'intervention_completion_reminder',
      taskName: '完成恶心跟练卡',
      message: '记得回来完成跟练。',
      createdAt: '2026-05-12T02:00:00.000Z',
      dueAt: '2026-05-12T12:00:00.000Z',
      scheduleType: 'once',
      cronExpression: null,
      timezone: 'Asia/Shanghai',
      status: 'pending',
      entityType: 'intervention_material_engagement',
      entityId: 'engagement-1',
    },
  ])

  assert.match(rendered, /ID 1/)
  assert.match(rendered, /稳定编号/)
  assert.match(rendered, /完成恶心跟练卡/)
  assert.match(rendered, /2026-05-12T12:00:00.000Z/)
  assert.match(rendered, /记得回来完成跟练/)
})

test('assigns stable scheduled task display ids across deleted or sent history', () => {
  const ids = assignStableScheduledTaskDisplayIds([
    { id: 'sent-task', createdAt: new Date('2026-05-12T02:00:00.000Z') },
    { id: 'pending-task', createdAt: new Date('2026-05-12T02:01:00.000Z') },
    { id: 'later-task', createdAt: new Date('2026-05-12T02:02:00.000Z') },
  ])

  assert.equal(ids.get('sent-task'), 1)
  assert.equal(ids.get('pending-task'), 2)
  assert.equal(ids.get('later-task'), 3)
})

test('breaks scheduled task display id ties by row id', () => {
  const ids = assignStableScheduledTaskDisplayIds([
    { id: 'b-task', createdAt: new Date('2026-05-12T02:00:00.000Z') },
    { id: 'a-task', createdAt: new Date('2026-05-12T02:00:00.000Z') },
  ])

  assert.equal(ids.get('a-task'), 1)
  assert.equal(ids.get('b-task'), 2)
})

test('skips overdue scheduled tasks outside grace window', () => {
  const now = new Date('2026-05-12T02:03:00.000Z')

  assert.equal(
    shouldSkipOverdueScheduledTask(new Date('2026-05-12T02:01:00.000Z'), now),
    false,
  )
  assert.equal(
    shouldSkipOverdueScheduledTask(new Date('2026-05-12T02:00:59.999Z'), now),
    true,
  )
})

test('renders empty future scheduled task list for tool output', () => {
  assert.equal(renderFutureScheduledTasksForTool([]), '当前没有未来定时任务。')
})

test('renders future scheduled task context for followup generation', () => {
  const rendered = renderFutureScheduledTasksForFollowupContext([
    {
      taskId: 1,
      rowId: 'task-row-1',
      purpose: 'custom',
      taskName: '他莫西芬用药提醒',
      message: '记得按时吃他莫西芬。',
      createdAt: '2026-05-12T02:00:00.000Z',
      dueAt: '2026-05-12T12:00:00.000Z',
      scheduleType: 'cron',
      cronExpression: '0 20 * * *',
      timezone: 'Asia/Shanghai',
      status: 'pending',
      entityType: null,
      entityId: null,
    },
  ])

  assert.match(rendered, /避免重复追问/)
  assert.match(rendered, /他莫西芬用药提醒/)
})

test('refines low-specificity scheduled task names', () => {
  assert.equal(
    refineScheduledTaskNameForCreate({
      taskName: '化疗后吃饭提醒',
      purpose: 'custom',
      messageContent: '半小时后提醒我吃饭。',
      metadata: null,
    }),
    '吃饭提醒',
  )

  assert.equal(
    refineScheduledTaskNameForCreate({
      taskName: '化疗期间他莫西芬用药提醒',
      purpose: 'custom',
      messageContent: '晚上提醒我吃他莫西芬。',
      metadata: null,
    }),
    '他莫西芬用药提醒',
  )

  assert.equal(
    refineScheduledTaskNameForCreate({
      taskName: '5月20日乳腺外科复查提醒',
      purpose: 'custom',
      messageContent: '5月20日提醒我去乳腺外科复查。',
      metadata: null,
    }),
    '5月20日乳腺外科复查提醒',
  )

  assert.equal(
    refineScheduledTaskNameForCreate({
      taskName: '跟练提醒',
      purpose: 'intervention_completion_reminder',
      messageContent: '晚点提醒我回来完成跟练。',
      metadata: { sideEffect: '恶心' },
    }),
    '完成恶心跟练卡',
  )

  assert.equal(
    refineScheduledTaskNameForCreate({
      taskName: '用药提醒',
      purpose: 'custom',
      messageContent: '晚上提醒我吃他莫西芬。',
      metadata: null,
    }),
    '他莫西芬用药提醒',
  )
})

test('renders scheduled task creation result with previous tasks and conflict guidance', () => {
  const rendered = renderScheduledTaskCreationResultForTool({
    currentTask: {
      taskId: 2,
      taskName: '医院复诊提醒',
      dueAt: '2026-05-13T00:30:00.000Z',
      status: 'pending',
      message: '明早8:30记得去医院复诊。',
    },
    previousTasks: [
      {
        taskId: 1,
        rowId: 'task-row-1',
        purpose: 'custom',
        taskName: '复查提醒',
        message: '明天记得复查。',
        createdAt: '2026-05-12T02:00:00.000Z',
        dueAt: '2026-05-13T00:20:00.000Z',
        scheduleType: 'once',
        cronExpression: null,
        timezone: 'Asia/Shanghai',
        status: 'pending',
        entityType: null,
        entityId: null,
      },
    ],
  })

  assert.match(rendered, /本次新增/)
  assert.match(rendered, /医院复诊提醒/)
  assert.match(rendered, /用户此前已有未来任务/)
  assert.match(rendered, /复查提醒/)
  assert.match(rendered, /若有冲突，先向用户确认/)
  assert.match(rendered, /schedule action=update/)
  assert.match(rendered, /action=delete/)
})

test('renders first scheduled task creation guidance with client environment', () => {
  const rendered = renderScheduledTaskCreationResultForTool({
    currentTask: {
      taskId: 1,
      taskName: '今晚喝水提醒',
      dueAt: '2026-05-12T14:00:00.000Z',
      status: 'pending',
      message: '今晚10点记得喝水。',
    },
    previousTasks: [],
    isFirstScheduledTaskCreation: true,
    clientEnvironment: {
      platform: 'ios',
      label: 'iOS',
    },
  })

  assert.match(rendered, /首次提醒创建后的用户可见说明/)
  assert.match(rendered, /手机日历/)
  assert.match(rendered, /App 到时间也会发送消息推送/)
  assert.match(rendered, /通知权限/)
  assert.match(rendered, /日历权限/)
  assert.match(rendered, /TestFlight/)
  assert.doesNotMatch(rendered, /安卓用户/)
  assert.doesNotMatch(rendered, /鸿蒙用户/)
})

test('renders first scheduled task creation guidance for native app without install prompt', () => {
  const rendered = renderScheduledTaskCreationResultForTool({
    currentTask: {
      taskId: 1,
      taskName: '每天吃药提醒',
      dueAt: '2026-05-12T01:00:00.000Z',
      status: 'pending',
      message: '每天上午9点记得吃药。',
    },
    previousTasks: [],
    isFirstScheduledTaskCreation: true,
    clientEnvironment: {
      platform: 'ios',
      label: 'iOS App',
      source: 'native_bridge',
      isNativeApp: true,
    },
  })

  assert.match(rendered, /手机日历/)
  assert.match(rendered, /通知权限/)
  assert.match(rendered, /日历权限/)
  assert.match(rendered, /iOS App/)
  assert.match(rendered, /正在使用Health Agent Lab App/)
  assert.doesNotMatch(rendered, /TestFlight/)
  assert.doesNotMatch(rendered, /测试邀请/)
  assert.doesNotMatch(rendered, /测试 APK/)
  assert.doesNotMatch(rendered, /尚未安装/)
})

test('renders mobile app guidance for web scheduled task creation without active app device', () => {
  const rendered = renderScheduledTaskCreationResultForTool({
    currentTask: {
      taskId: 1,
      taskName: '开会提醒',
      dueAt: '2026-05-15T10:09:00.000Z',
      status: 'pending',
      message: '提醒你去开会啦。',
    },
    previousTasks: [],
    shouldRecommendMobileApp: true,
  })

  assert.match(rendered, /移动端提醒建议/)
  assert.match(rendered, /网页无法直接写入手机系统日历/)
  assert.match(rendered, /Health Agent Lab App/)
  assert.match(rendered, /通知权限/)
})

test('renders manual calendar update guidance when calendar external id is missing', () => {
  const rendered = renderScheduledTaskUpdateResultForTool({
    taskId: 1,
    dueAt: '2026-05-13T00:30:00.000Z',
    status: 'pending',
    requiresManualCalendarUpdate: true,
  })

  assert.match(rendered, /已更新定时任务 ID：1/)
  assert.match(rendered, /没有拿到系统日历事件 ID/)
  assert.match(rendered, /手机日历中手动处理/)

  const normal = renderScheduledTaskUpdateResultForTool({
    taskId: 1,
    dueAt: '2026-05-13T00:30:00.000Z',
    status: 'pending',
  })
  assert.doesNotMatch(normal, /手机日历同步提醒/)
  assert.doesNotMatch(normal, /日历|同步|手动处理/)
})
