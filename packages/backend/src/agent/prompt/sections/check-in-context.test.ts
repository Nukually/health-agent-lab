import assert from 'node:assert/strict'
import test from 'node:test'
import { checkInDraftCardsContext, checkInSchemasContext } from './check-in-context.js'

test('check-in context tells the agent not to save cards by text intent', () => {
  const emptyContext = checkInSchemasContext([])
  const schemaContext = checkInSchemasContext([
    {
      id: 'schema-1',
      userId: 'user-1',
      categoryKey: 'ci_diet',
      categoryName: '饮食记录',
      displayMode: 'calendar',
      categoryDescription: null,
      aliases: ['饮食'],
      schemaVersion: 1,
      schemaHash: 'hash',
      a2uiSchema: {
        version: 1,
        kind: 'check_in_card',
        categoryKey: 'ci_diet',
        categoryName: '饮食记录',
        displayMode: 'calendar',
        titleTemplate: '饮食记录',
        aliases: ['饮食'],
        fields: [
          { key: 'meal_type', label: '餐次', type: 'choice', options: ['早餐', '午餐', '晚餐'] },
          { key: 'food_content', label: '食物内容', type: 'text' },
        ],
        layout: [],
      },
      status: 'active',
      createdFromSessionId: null,
      createdFromMessageId: null,
      createdFromToolCallId: null,
      createdAt: '2026-05-20T00:00:00.000Z',
      updatedAt: '2026-05-20T00:00:00.000Z',
      lastUsedAt: null,
    },
  ])

  for (const context of [emptyContext, schemaContext]) {
    assert.match(context, /用户只说[“"]保存/)
    assert.match(context, /不要调用打卡工具/)
    assert.match(context, /没有权限替用户保存/)
    assert.match(context, /手动点击/)
  }
})

test('check-in schema context exposes category descriptions without full UI schema fields', () => {
  const context = checkInSchemasContext([
    {
      id: 'schema-1',
      userId: 'user-1',
      categoryKey: 'ci_bp',
      categoryName: '血压打卡',
      displayMode: 'quantitative',
      categoryDescription: '用于记录家庭血压、脉搏和服药状态。',
      aliases: ['血压记录'],
      schemaVersion: 1,
      schemaHash: 'hash',
      a2uiSchema: {
        version: 1,
        kind: 'check_in_card',
        categoryKey: 'ci_bp',
        categoryName: '血压打卡',
        displayMode: 'quantitative',
        titleTemplate: '血压打卡',
        aliases: ['血压记录'],
        fields: [
          { key: 'systolic', label: '收缩压', type: 'number', unit: 'mmHg' },
          { key: 'diastolic', label: '舒张压', type: 'number', unit: 'mmHg' },
        ],
        layout: [],
      },
      status: 'active',
      createdFromSessionId: null,
      createdFromMessageId: null,
      createdFromToolCallId: null,
      createdAt: '2026-05-20T00:00:00.000Z',
      updatedAt: '2026-05-20T00:00:00.000Z',
      lastUsedAt: null,
    },
  ])

  assert.match(context, /血压打卡/)
  assert.match(context, /categoryKey="ci_bp"/)
  assert.match(context, /描述：用于记录家庭血压、脉搏和服药状态。/)
  assert.match(context, /别名：血压记录/)
  assert.doesNotMatch(context, /字段：/)
  assert.doesNotMatch(context, /systolic/)
  assert.doesNotMatch(context, /收缩压/)
})

test('check-in draft context exposes unsaved card ids and merged-edit rules', () => {
  const context = checkInDraftCardsContext([
    {
      id: '04172a0f-c27a-47e5-ab6b-a2be03fd283c',
      categoryName: '旅行记录',
      recordedAt: '2026-05-20T16:00:00.000Z',
      fields: [
        { key: 'destination', label: '目的地', type: 'text', required: true },
        { key: 'activities', label: '活动/行程', type: 'text' },
        { key: 'travel_date', label: '日期', type: 'date' },
      ],
      values: {
        destination: '北京',
        activities: '参观故宫、吃北京烤鸭',
        travel_date: '2026-05-21',
      },
      note: null,
      attachmentCount: 1,
      updatedAt: '2026-05-23T07:04:42.000Z',
    },
  ])

  assert.match(context ?? '', /当前会话未保存打卡卡片/)
  assert.match(context ?? '', /checkInCardId=04172a0f-c27a-47e5-ab6b-a2be03fd283c/)
  assert.match(context ?? '', /分类=旅行记录/)
  assert.match(context ?? '', /目的地\(destination\)=北京/)
  assert.match(context ?? '', /活动\/行程\(activities\)=参观故宫、吃北京烤鸭/)
  assert.match(context ?? '', /图片=1张/)
  assert.match(context ?? '', /supersedesCheckInCardId/)
  assert.match(context ?? '', /合并后的完整新草稿/)
  assert.match(context ?? '', /新增另一条独立记录,不要传/)
  assert.match(context ?? '', /只是要求保存,不要调用打卡工具/)
})
