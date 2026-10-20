import assert from 'node:assert/strict'
import test from 'node:test'
import { getClientToolInput, getClientToolOutput } from './tool-call-client.js'

test('risk grading tool input is exposed with Chinese level for process UI', () => {
  assert.deepEqual(
    getClientToolInput('grade_medical_risk', {
      reason: '化疗后发热，需要排除感染。',
      level: 'A',
      category: 'current_symptom',
    }),
    {
      analysis: '化疗后发热，需要排除感染。',
      level: '紧急就医/安全兜底',
      category: '当前症状',
    },
  )
})

test('risk grading tool exposes level labels without internal codes', () => {
  assert.deepEqual(
    ['S', 'A', 'B0', 'B1', 'C'].map((level) =>
      getClientToolInput('grade_medical_risk', {
        reason: '测试分级展示。',
        level,
        category: 'other_medical',
      }),
    ).map((input) => (input as any).level),
    ['危急安全风险', '紧急就医/安全兜底', '尽快线下评估', '近期复诊/联系医生', '低风险'],
  )
})

test('risk grading tool output is hidden from client cards', () => {
  assert.equal(
    getClientToolOutput('grade_medical_risk', '处置策略：先处理安全边界。'),
    null,
  )
})

test('load_skill input exposes skill name and Chinese display name for the timeline', () => {
  assert.deepEqual(
    getClientToolInput('load_skill', { name: 'side-effect-course-management' }),
    { name: 'side-effect-course-management', displayName: '副作用疗程管理' },
  )
  // 未注册技能：保留 name，无 displayName，前端回退通用文案
  assert.deepEqual(
    getClientToolInput('load_skill', { name: 'unknown-skill' }),
    { name: 'unknown-skill' },
  )
  assert.equal(getClientToolInput('load_skill', {}), null)
})

test('generate_plan input and output are exposed for resource rendering', () => {
  assert.deepEqual(
    getClientToolInput('generate_plan', { search_query: '潮热 夜间发作' }),
    { searchQuery: '潮热 夜间发作' },
  )
  assert.deepEqual(
    getClientToolOutput('generate_plan', {
      kind: 'medical_risk_resources',
      resources: [],
    }),
    {
      kind: 'medical_risk_resources',
      resources: [],
    },
  )
})

test('medical_literature_search input and output are exposed for citations', () => {
  assert.deepEqual(
    getClientToolInput('medical_literature_search', { query: '乳腺癌 潮热 指南' }),
    { query: '乳腺癌 潮热 指南' },
  )
  assert.deepEqual(
    getClientToolOutput('medical_literature_search', {
      kind: 'medical_risk_resources',
      resources: [],
      literatureSearch: {
        kind: 'medical_literature_search',
        query: '乳腺癌 潮热 指南',
        searchedCount: 1,
        selectedCount: 0,
        allSources: [],
        selectedSources: [],
      },
    }),
    {
      kind: 'medical_risk_resources',
      resources: [],
      literatureSearch: {
        kind: 'medical_literature_search',
        query: '乳腺癌 潮热 指南',
        searchedCount: 1,
        selectedCount: 0,
        allSources: [],
        selectedSources: [],
      },
    },
  )
})

test('saved_content show output is exposed only when it carries resources', () => {
  assert.deepEqual(
    getClientToolOutput('saved_content', {
      kind: 'medical_risk_resources',
      resources: [],
    }),
    {
      kind: 'medical_risk_resources',
      resources: [],
    },
  )
  assert.equal(
    getClientToolOutput('saved_content', { action: 'read', id: 'A-1' }),
    null,
  )
})

test('schedule tool create input is exposed with a compact summary', () => {
  assert.deepEqual(
    getClientToolInput('schedule', {
      action: 'create',
      task: '喝水提醒',
      time: '2026-05-20T11:30:00+08:00',
      message: '到点喝水',
    }),
    {
      action: 'create',
      taskName: '喝水提醒',
      dueAt: '2026-05-20T11:30:00+08:00',
    },
  )
})

test('schedule tool delete input is exposed like legacy scheduled task updates', () => {
  assert.deepEqual(
    getClientToolInput('schedule', {
      action: 'delete',
      id: 3,
      brief: '取消明天的提醒',
    }),
    {
      action: 'delete',
      taskId: 3,
      taskName: null,
      dueAt: null,
      status: 'deleted',
    },
  )
})

test('todos tool output exposes card fields and strips internal agent prompt', () => {
  assert.deepEqual(
    getClientToolOutput('todos', {
      kind: 'todos',
      action: 'create',
      message: '已为你安排 3 天手指关节缓解跟练。',
      plan: {
        id: 'plan-1',
        title: '3 天手指关节缓解跟练',
        status: 'in_progress',
        timezone: 'Asia/Shanghai',
        sourceType: 'intervention',
        courseDays: 3,
        targetSideEffect: '手指关节痛',
        todosMd: '- 内部 markdown',
        todos: [
          {
            id: 'todo-1',
            date: '2026-05-31',
            time: '09:00',
            showPrompt: '早上好，做一组手指关节唤醒吧。',
            prompt: '内部执行指令：带用户完成跟练并询问反馈。',
            scheduleId: 'sch-1',
            status: 'pending',
          },
        ],
      },
    }),
    {
      kind: 'todos',
      action: 'create',
      plan: {
        id: 'plan-1',
        title: '3 天手指关节缓解跟练',
        status: 'in_progress',
        sourceType: 'intervention',
        sourceId: null,
        resourceRefId: null,
        courseDays: 3,
        targetSideEffect: '手指关节痛',
        todos: [
          {
            id: 'todo-1',
            date: '2026-05-31',
            time: '09:00',
            showPrompt: '早上好，做一组手指关节唤醒吧。',
            status: 'pending',
            feedback: null,
          },
        ],
      },
    },
  )
})
