import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildActiveTodoReminder,
  classifyTodoReplyText,
  detectTodoPlanConflicts,
  normalizeCourseDays,
  parseTodoDateTime,
  renderActiveTodoPlansForPrompt,
  renderTodosMarkdown,
  shouldRetainTodoItemAfterPlanStop,
  todoItemsToCarryIntoUpdatedPlan,
  validateTodoInputsAreFuture,
} from './todos.js'

test('renders todos markdown grouped by date and completion state', () => {
  const markdown = renderTodosMarkdown([
    {
      date: '2026-05-29',
      time: '12:00',
      showPrompt: '中午做 1 分钟手指伸展',
      status: 'pending',
      feedback: null,
    },
    {
      date: '2026-05-28',
      time: '08:00',
      showPrompt: '早上做 3 分钟晨僵缓解动作',
      status: 'completed',
      feedback: 'better',
    },
    {
      date: '2026-05-30',
      time: '08:00',
      showPrompt: '第三天手指操',
      status: 'not_practiced',
      feedback: null,
    },
  ])

  assert.match(markdown, /^2026-05-28:\n\[x\] 08:00 早上做 3 分钟晨僵缓解动作\n  - feedback: 变好/m)
  assert.match(markdown, /2026-05-29:\n\[\] 12:00 中午做 1 分钟手指伸展/m)
  assert.match(markdown, /2026-05-30:\n\[-\] 08:00 第三天手指操/m)
})

test('parses todo date and time in Asia Shanghai timezone', () => {
  const dueAt = parseTodoDateTime({
    date: '2026-05-28',
    time: '08:00',
    timezone: 'Asia/Shanghai',
  })

  assert.equal(dueAt.toISOString(), '2026-05-28T00:00:00.000Z')
})

test('rejects elapsed todo times when creating future course days', () => {
  const now = new Date('2026-06-03T08:30:00.000Z')

  assert.throws(
    () => validateTodoInputsAreFuture({
      timezone: 'Asia/Shanghai',
      now,
      todos: [
        {
          date: '2026-06-03',
          time: '12:00',
          showPrompt: '今天做手指麻木跟练。',
          prompt: '带用户完成手指麻木跟练。',
        },
        {
          date: '2026-06-04',
          time: '12:00',
          showPrompt: '第二天做手指麻木跟练。',
          prompt: '带用户完成手指麻木跟练。',
        },
        {
          date: '2026-06-05',
          time: '12:00',
          showPrompt: '第三天做手指麻木跟练。',
          prompt: '带用户完成手指麻木跟练。',
        },
      ],
    }),
    /todos\[0\].*已经过去.*从明天开始生成 N 条未来 todo/,
  )
})

test('allows same-day todo times that are still in the future', () => {
  const now = new Date('2026-06-03T08:30:00.000Z')

  assert.doesNotThrow(() => validateTodoInputsAreFuture({
    timezone: 'Asia/Shanghai',
    now,
    todos: [
      {
        date: '2026-06-03',
        time: '18:00',
        showPrompt: '傍晚做手指麻木跟练。',
        prompt: '带用户完成手指麻木跟练。',
      },
    ],
  }))
})

test('normalizes course days within one-to-one-hundred bounds', () => {
  assert.equal(normalizeCourseDays(1), 1)
  assert.equal(normalizeCourseDays(3), 3)
  assert.equal(normalizeCourseDays('2' as unknown as number), 2)
  assert.equal(normalizeCourseDays(100), 100)
  assert.equal(normalizeCourseDays(0), null)
  assert.equal(normalizeCourseDays(101), null)
})

test('classifies todo user replies into decision completion and feedback', () => {
  assert.deepEqual(classifyTodoReplyText('做完了，感觉好些了'), {
    status: 'completed',
    feedback: 'better',
  })
  assert.deepEqual(classifyTodoReplyText('现在不方便，先不做'), {
    status: 'not_practiced',
    feedback: null,
  })
  assert.deepEqual(classifyTodoReplyText('做了，但是更痛了'), {
    status: 'completed',
    feedback: 'worse',
  })
  assert.deepEqual(classifyTodoReplyText('好的，开始吧'), {
    status: 'started',
    feedback: null,
  })
})

test('builds active todo reminder for the next agent turn', () => {
  const reminder = buildActiveTodoReminder({
    planTitle: '晨僵 3 天跟练',
    todoDate: '2026-05-28',
    todoTime: '08:00',
    showPrompt: '早上做 3 分钟晨僵缓解动作',
    prompt: '带用户完成晨僵缓解跟练，并在结束后询问缓解情况。',
    replyClassification: {
      status: 'completed',
      feedback: 'better',
    },
  })

  assert.match(reminder, /\[todo:active_followup\]/)
  assert.match(reminder, /晨僵 3 天跟练/)
  assert.match(reminder, /带用户完成晨僵缓解跟练/)
  assert.match(reminder, /status=completed/)
  assert.match(reminder, /feedback=better/)
})

test('renders active todo plans with ids for plan replacement decisions', () => {
  const reminder = renderActiveTodoPlansForPrompt([
    {
      id: '606d5007-dcde-4a3b-9125-eeffd877b80d',
      title: '手腕关节痛 3天跟练',
      status: 'not_started',
      targetSideEffect: '手腕关节痛',
      resourceRefId: '1-5',
      courseDays: 3,
      todos: [
        {
          id: 'todo-1',
          date: '2026-06-02',
          time: '18:00',
          showPrompt: '今天做手腕关节痛跟练。',
          status: 'pending',
          feedback: null,
        },
      ],
    },
  ])

  assert.ok(reminder)
  assert.match(reminder, /\[todo:active_plans\]/)
  assert.match(reminder, /plan_id=606d5007-dcde-4a3b-9125-eeffd877b80d/)
  assert.match(reminder, /target_side_effect=手腕关节痛/)
  assert.match(reminder, /用户要求调整、换方案、提高或降低强度时/)
  assert.match(reminder, /todos action=update/)
  assert.match(reminder, /已执行的 todo 只保留在旧计划历史中/)
  assert.match(reminder, /不要直接 action=create/)
  assert.doesNotMatch(reminder, /todo_id=/)
  assert.doesNotMatch(reminder, /action=advance/)
})

test('detects active todo plan conflicts before creating a new plan', () => {
  const conflicts = detectTodoPlanConflicts({
    title: '手指关节痛 1天跟练',
    targetSideEffect: '手指关节痛',
    sourceType: 'video_resource',
    sourceId: 'video-new',
    resourceRefId: '2-1',
    dedupeKey: 'new-hand-plan',
    todos: [
      {
        date: '2026-06-03',
        time: '15:20',
        showPrompt: '新的手指关节痛跟练。',
        prompt: '带用户完成新的手指关节痛跟练。',
      },
    ],
    existingPlans: [
      {
        id: '606d5007-dcde-4a3b-9125-eeffd877b80d',
        title: '手指关节痛 3天跟练',
        status: 'not_started',
        targetSideEffect: '手指关节痛',
        sourceType: 'intervention',
        sourceId: 'intervention-old',
        resourceRefId: '1-5',
        dedupeKey: 'old-hand-plan',
        todos: [
          {
            date: '2026-06-03',
            time: '15:06',
            showPrompt: '今天做手指关节痛缓解跟练。',
            status: 'pending',
          },
        ],
      },
    ],
  })

  assert.equal(conflicts.length, 2)
  assert.ok(conflicts.some((conflict) => conflict.type === 'same_target_active_plan'))
  const timeConflict = conflicts.find((conflict) => conflict.type === 'time_slot_overlap')
  assert.ok(timeConflict)
  assert.equal(timeConflict.planId, '606d5007-dcde-4a3b-9125-eeffd877b80d')
  assert.deepEqual(timeConflict.overlapTimes, [
    {
      newTime: '2026-06-03 15:20',
      existingTime: '2026-06-03 15:06',
      existingTodoPrompt: '今天做手指关节痛缓解跟练。',
      deltaMinutes: 14,
    },
  ])
})

test('detects duplicate todo plan sources before creating a new plan', () => {
  const conflicts = detectTodoPlanConflicts({
    title: '晨僵 3天跟练',
    targetSideEffect: '晨僵',
    sourceType: 'intervention',
    sourceId: 'intervention-1',
    resourceRefId: '1-1',
    dedupeKey: 'same-resource-plan',
    todos: [
      {
        date: '2026-06-03',
        time: '08:00',
        showPrompt: '新的晨僵跟练。',
        prompt: '带用户完成晨僵跟练。',
      },
    ],
    existingPlans: [
      {
        id: '5b271462-2321-4bc0-9d06-d428b14f0f95',
        title: '晨僵 3天跟练',
        status: 'in_progress',
        targetSideEffect: '晨僵',
        sourceType: 'intervention',
        sourceId: 'intervention-1',
        resourceRefId: '1-1',
        dedupeKey: 'same-resource-plan',
        todos: [
          {
            date: '2026-06-04',
            time: '08:00',
            showPrompt: '第二天晨僵跟练。',
            status: 'pending',
          },
        ],
      },
    ],
  })

  assert.ok(conflicts.some((conflict) => conflict.type === 'duplicate_source'))
  assert.match(
    conflicts.find((conflict) => conflict.type === 'duplicate_source')?.reason ?? '',
    /相同来源/,
  )
})

test('retains closed or started todo items when a plan is stopped', () => {
  assert.equal(shouldRetainTodoItemAfterPlanStop({ status: 'completed' }), true)
  assert.equal(shouldRetainTodoItemAfterPlanStop({ status: 'not_practiced' }), true)
  assert.equal(shouldRetainTodoItemAfterPlanStop({ status: 'started' }), true)
  assert.equal(shouldRetainTodoItemAfterPlanStop({ status: 'pending' }), false)
  assert.equal(shouldRetainTodoItemAfterPlanStop({ status: 'notified' }), false)
})

test('does not copy completed days from a five-day plan into a two-day replacement plan', () => {
  const oldItems = [
    { id: 'old-day-1', date: '2026-06-03', status: 'completed' as const },
    { id: 'old-day-2', date: '2026-06-04', status: 'completed' as const },
    { id: 'old-day-3', date: '2026-06-05', status: 'pending' as const },
    { id: 'old-day-4', date: '2026-06-06', status: 'pending' as const },
    { id: 'old-day-5', date: '2026-06-07', status: 'pending' as const },
  ]

  assert.deepEqual(todoItemsToCarryIntoUpdatedPlan(oldItems), [])
})
