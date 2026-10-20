import assert from 'node:assert/strict'
import test from 'node:test'
import {
  mergeEventsForReminder,
  renderEventsReminderWithMaps,
  type SessionEvent,
} from './session-events.js'

const TS = Date.parse('2026-04-27T02:05:00Z') // Asia/Shanghai 2026-04-27 10:05

test('renders external page changes with field diffs and Shanghai timestamp', () => {
  const events: SessionEvent[] = [
    {
      type: 'external_page_changed',
      ts: TS,
      page: 'personal_info',
      action: 'profile_saved',
      fieldChanges: [
        { field: 'nickname', fieldLabel: '昵称', fromValue: '助手', toValue: '谢浩' },
      ],
    },
  ]

  const rendered = renderEventsReminderWithMaps(events).text

  assert.match(rendered, /^用户对话期间操作记录：/)
  assert.match(rendered, /用户在本次对话session期间更新了个人信息、档案或我的收藏夹；后续回复优先以这些变更后的状态为准。已落库或删除的内容无需再次更新。/)
  assert.match(rendered, /用户在「个人信息」将“昵称”从「助手」修改为「谢浩」，保存时间：2026-04-27 10:05。/)
})

test('appends temporary doc and card short ids without overriding frozen mappings', () => {
  const events: SessionEvent[] = [
    {
      type: 'external_page_changed',
      ts: TS,
      page: 'medical_records',
      action: 'medical_document_uploaded',
      document: {
        docId: 'doc-new',
        title: '病理报告',
        documentDate: '2026-04-26',
        documentType: 'pathology',
        hospital: 'Health Agent Lab医院',
        pageCount: 2,
      },
    },
    {
      type: 'external_page_changed',
      ts: TS,
      page: 'materials',
      action: 'communication_card_updated',
      card: { cardId: 'card-new', title: '复诊沟通卡', cardDate: '2026-04-27' },
      fieldChanges: [
        { field: 'visitPurpose', fieldLabel: '就诊目标', fromValue: '复诊', toValue: '复查用药副作用' },
      ],
    },
  ]
  const docIdMap = new Map([['d-1', 'doc-old']])
  const communicationCardIdMap = new Map([['c-1', 'card-old']])

  const result = renderEventsReminderWithMaps(events, { docIdMap, communicationCardIdMap })

  assert.equal(result.docIdMap.get('d-1'), 'doc-old')
  assert.equal(result.docIdMap.get('d-2'), 'doc-new')
  assert.equal(result.communicationCardIdMap.get('c-1'), 'card-old')
  assert.equal(result.communicationCardIdMap.get('c-2'), 'card-new')
  assert.match(result.text, /\[d-2\] 病理报告 \| 就诊\/检查日期 2026-04-26 \| 病理报告 \| Health Agent Lab医院 \| 2页/)
  assert.match(result.text, /沟通卡片 \[c-2\] 《复诊沟通卡》 \| 2026-04-27/)
})

test('reuses existing temporary id for an already frozen document', () => {
  const events: SessionEvent[] = [
    {
      type: 'external_page_changed',
      ts: TS,
      page: 'medical_records',
      action: 'medical_document_uploaded',
      document: { docId: 'doc-existing', title: '门诊病历', pageCount: 1 },
    },
  ]
  const docIdMap = new Map([['d-1', 'doc-existing']])

  const result = renderEventsReminderWithMaps(events, { docIdMap })

  assert.equal(result.docIdMap.size, 1)
  assert.match(result.text, /\[d-1\] 门诊病历 \| 1页/)
})

test('renders material deletions for frozen conversation reminders', () => {
  const events: SessionEvent[] = [
    {
      type: 'external_page_changed',
      ts: TS,
      page: 'materials',
      action: 'communication_card_deleted',
      card: { cardId: 'card-existing', title: '复诊沟通卡', cardDate: '2026-04-27' },
    },
    {
      type: 'external_page_changed',
      ts: TS,
      page: 'materials',
      action: 'intervention_material_deleted',
      interventionMaterial: {
        engagementId: 'eng-1',
        materialCode: '1-1',
        title: '漱口+坐位恢复',
        sideEffect: '恶心',
        scene: '呕吐后',
      },
    },
  ]
  const communicationCardIdMap = new Map([['c-1', 'card-existing']])

  const result = renderEventsReminderWithMaps(events, { communicationCardIdMap })

  assert.equal(result.communicationCardIdMap.get('c-1'), 'card-existing')
  assert.match(result.text, /取消收藏了沟通卡片 \[c-1\] 《复诊沟通卡》 \| 2026-04-27，操作时间：2026-04-27 10:05。/)
  assert.match(result.text, /这张卡片已不在我的收藏夹中，不要再读取或当作已保存卡片引用。/)
  assert.match(result.text, /取消收藏了跟练卡 《漱口\+坐位恢复》 \| 编号 1-1 \| 恶心 · 呕吐后，操作时间：2026-04-27 10:05。/)
  assert.match(result.text, /这张跟练卡已不在我的收藏夹中，不要再当作已保存跟练卡引用。/)
})

test('renders medical document and image deletion reminders', () => {
  const events: SessionEvent[] = [
    {
      type: 'external_page_changed',
      ts: TS,
      page: 'medical_records',
      action: 'medical_document_deleted',
      document: {
        docId: 'doc-existing',
        title: '乳腺超声筛查报告',
        documentType: 'imaging',
        pageCount: 2,
      },
    },
    {
      type: 'external_page_changed',
      ts: TS,
      page: 'medical_records',
      action: 'medical_document_image_deleted',
      document: {
        docId: 'doc-kept',
        title: '病理报告',
        pageCount: 1,
        imageIndex: 1,
      },
    },
  ]
  const docIdMap = new Map([['d-1', 'doc-existing'], ['d-2', 'doc-kept']])

  const result = renderEventsReminderWithMaps(events, { docIdMap })

  assert.match(result.text, /删除了一份病历：乳腺超声筛查报告 \| 影像报告 \| 2页/)
  assert.match(result.text, /这份病历已不在健康档案中，不要再调用 saved_content 读取或当作已保存病历引用。/)
  assert.match(result.text, /删除了病历 病理报告 \| 1页 的第 2 张图片/)
  assert.match(result.text, /被删除的图片已不在病历原图中；如果之后读取这份病历，只能基于剩余图片/)
})

test('renders communication card events as context, not a session-level tool ban', () => {
  const events: SessionEvent[] = [
    {
      type: 'communication_card_generated',
      ts: TS,
      cardTitle: '乳腺结节随访沟通卡',
      cardDate: '2026-04-28',
    },
  ]

  const rendered = renderEventsReminderWithMaps(events).text

  assert.match(rendered, /^本会话历史增量记录（仅作上下文；是否调用工具仍按本轮用户请求判断）：/)
  assert.match(rendered, /生成的卡片“乳腺结节随访沟通卡”用户未点击保存。/)
  assert.doesNotMatch(rendered, /无需再次调用相同工具/)
})

test('renders schedule confirmed event for the next-turn reminder', () => {
  const events: SessionEvent[] = [
    { type: 'schedule_confirmed', ts: TS, scheduleAction: 'add', scheduleTaskName: '吃药提醒' },
  ]

  const rendered = renderEventsReminderWithMaps(events).text

  assert.match(rendered, /用户已确认并执行提醒操作：设置提醒「吃药提醒」。/)
})

test('renders schedule rejected event instructing AI to re-confirm next steps', () => {
  const events: SessionEvent[] = [
    { type: 'schedule_rejected', ts: TS, scheduleAction: 'delete', scheduleTaskName: '复诊提醒' },
  ]

  const rendered = renderEventsReminderWithMaps(events).text

  assert.match(rendered, /用户拒绝了这次提醒操作（删除提醒「复诊提醒」），请和用户确认后续步骤，不要声称已完成或已设置成功。/)
})

test('merges user external events only when newer than prompt snapshot', () => {
  const sessionEvents: SessionEvent[] = [
    { type: 'profile_rejected', ts: TS - 10_000, field: 'medicationDuration' },
  ]
  const userExternalEvents: SessionEvent[] = [
    {
      type: 'external_page_changed',
      ts: TS - 1_000,
      page: 'personal_info',
      action: 'profile_saved',
      fieldChanges: [
        { field: 'nickname', fieldLabel: '昵称', fromValue: 'A', toValue: 'B' },
      ],
    },
    {
      type: 'external_page_changed',
      ts: TS + 1_000,
      page: 'medical_records',
      action: 'medical_profile_saved',
      fieldChanges: [
        { field: 'medicationDuration', fieldLabel: '用药时长', fromValue: '', toValue: '1个月内' },
      ],
    },
  ]

  const merged = mergeEventsForReminder(sessionEvents, userExternalEvents, TS)

  assert.equal(merged.length, 2)
  assert.equal(merged[0].type, 'profile_rejected')
  assert.equal(merged[1].type, 'external_page_changed')
  assert.equal(merged[1].action, 'medical_profile_saved')
})
