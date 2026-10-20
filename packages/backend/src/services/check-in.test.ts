import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyRecordedAtToRecordDateFields,
  buildCheckInCardToolOutput,
  buildCheckInDedupeKey,
  buildFallbackCheckInSchemaDraft,
  buildCheckInRecordUpdatePayload,
  buildReplacementCheckInSchemaDraft,
  canInvalidateSupersededCheckInCard,
  enhanceCheckInValuesFromSourceText,
  extractCheckInAttachmentsFromMessageContent,
  extractCheckInSourceTextFromMessageContent,
  findCheckInSchemaMatch,
  shouldReplaceExistingCheckInSchema,
  shouldUpgradeStoredCheckInSchema,
  mergeCheckInCardValues,
  normalizeCheckInSchemaDraft,
  orderCheckInSchemasForDisplay,
  renderCheckInRecordSchema,
  resolveCheckInDraftNote,
  resolveCheckInRecordRecordedAt,
  resolveCheckInRecordedAt,
  resolveOptionalUserRecordDate,
  validateCheckInRequiredFields,
} from './check-in.js'
import type { CheckInA2uiSchema, CheckInRecord } from '@health-agent/shared'

test('normalizes a dynamic check-in schema into controlled A2UI blocks', () => {
  const schema = normalizeCheckInSchemaDraft({
    categoryName: '化疗后恶心记录',
    categoryDescription: '记录化疗后的恶心、呕吐、进食和缓解方式',
    aliases: ['恶心打卡', ' 化疗恶心 ', '恶心打卡'],
    fields: [
      { key: 'nausea_level', label: '恶心程度', type: 'number', unit: '分', required: true },
      { key: 'vomit_count', label: '呕吐次数', type: 'number', unit: '次' },
      { key: 'meal_status', label: '进食情况', type: 'text' },
      { key: 'relief_action', label: '缓解方式', type: 'text' },
    ],
    layout: [
      { type: 'metric_grid', bind: ['nausea_level', 'vomit_count'] },
      { type: 'kv_list', bind: ['meal_status', 'relief_action'] },
      { type: 'note', bind: 'note' },
      { type: 'unknown_block', bind: ['nausea_level'] },
    ],
  })

  assert.equal(schema.kind, 'check_in_card')
  assert.equal(schema.categoryName, '化疗后恶心记录')
  assert.equal(schema.displayMode, 'quantitative')
  assert.deepEqual(schema.aliases, ['恶心打卡', '化疗恶心'])
  assert.deepEqual(schema.layout.map((block) => block.type), ['metric_grid', 'kv_list', 'note', 'image_gallery', 'tags'])
  assert.equal(schema.fields[0]?.key, 'nausea_level')
})

test('derives a category description for new dynamic check-in schemas', () => {
  const schema = normalizeCheckInSchemaDraft({
    categoryName: '血压打卡',
    displayMode: 'quantitative',
    fields: [
      { key: 'systolic', label: '收缩压', type: 'number', unit: 'mmHg' },
      { key: 'diastolic', label: '舒张压', type: 'number', unit: 'mmHg' },
      { key: 'pulse', label: '脉搏', type: 'number', unit: '次/分' },
    ],
  })

  assert.equal(schema.categoryDescription, '用于记录血压打卡，核心字段：收缩压、舒张压、脉搏。')
})

test('honors calendar display mode for non-quantifiable categories', () => {
  const schema = normalizeCheckInSchemaDraft({
    categoryName: '一日三餐记录',
    displayMode: 'calendar',
    fields: [
      { key: 'meal_name', label: '餐次', type: 'choice', options: ['早餐', '午餐', '晚餐'] },
      { key: 'meal_content', label: '吃了什么', type: 'text' },
    ],
  })

  assert.equal(schema.displayMode, 'calendar')
  assert.deepEqual(schema.layout.map((block) => block.type), ['kv_list', 'note', 'image_gallery', 'tags'])
})

test('renders records with the same layout while changing only values', () => {
  const schema = normalizeCheckInSchemaDraft({
    categoryName: '来曲唑服药记录',
    fields: [
      { key: 'taken_at', label: '服药时间', type: 'text', required: true },
      { key: 'missed', label: '是否漏服', type: 'boolean' },
    ],
    layout: [
      { type: 'kv_list', bind: ['taken_at', 'missed'] },
      { type: 'note', bind: 'note' },
    ],
  })

  const first = renderCheckInRecordSchema({
    schema,
    title: '来曲唑服药记录',
    recordedAt: '2026-05-18T08:00:00.000Z',
    values: { taken_at: '早上 8 点', missed: false },
    note: '无明显不适。',
    attachments: [],
    tags: ['用药'],
  })
  const second = renderCheckInRecordSchema({
    schema,
    title: '来曲唑服药记录',
    recordedAt: '2026-05-19T08:10:00.000Z',
    values: { taken_at: '早上 8 点 10 分', missed: false },
    note: '继续按时服药。',
    attachments: [],
    tags: ['用药'],
  })

  assert.deepEqual(first.blocks.map((block) => block.type), second.blocks.map((block) => block.type))
  assert.notEqual(JSON.stringify(first), JSON.stringify(second))
  assert.match(JSON.stringify(first), /早上 8 点/)
  assert.match(JSON.stringify(second), /早上 8 点 10 分/)
})

test('falls back to category name for dynamic check-in title templates', () => {
  const schema = normalizeCheckInSchemaDraft({
    categoryName: '饮食记录',
    displayMode: 'calendar',
    titleTemplate: '{meal_type}记录',
    fields: [
      { key: 'meal_type', label: '餐次', type: 'choice', options: ['早餐', '午餐', '晚餐'], required: true },
      { key: 'main_food', label: '主食', type: 'text' },
    ],
  })

  const rendered = renderCheckInRecordSchema({
    schema,
    title: schema.titleTemplate,
    recordedAt: '2026-05-25T00:00:00.000Z',
    values: { meal_type: '早餐', main_food: '面包' },
    attachments: [],
  })

  assert.equal(rendered.title, '饮食记录')
})

test('renders uploaded images for legacy schemas without an image layout block', () => {
  const schema = normalizeCheckInSchemaDraft({
    categoryName: '化疗后恶心记录',
    fields: [
      { key: 'nausea_level', label: '恶心程度', type: 'number', unit: '分' },
      { key: 'relief_action', label: '缓解方式', type: 'text' },
    ],
    layout: [
      { type: 'metric_grid', bind: ['nausea_level'] },
      { type: 'kv_list', bind: ['relief_action'] },
    ],
  })

  const legacySchema = {
    ...schema,
    layout: schema.layout.filter((block) => block.type !== 'image_gallery'),
  }
  const rendered = renderCheckInRecordSchema({
    schema: legacySchema,
    title: '化疗后恶心记录',
    recordedAt: '2026-05-19T03:30:00.000Z',
    values: { nausea_level: 4, relief_action: '喝姜茶' },
    attachments: [{ url: 'data:image/jpeg;base64,abc', name: '午后记录照片', mimeType: 'image/jpeg' }],
    tags: [],
  })

  assert.deepEqual(rendered.blocks.map((block) => block.type), ['metric_grid', 'kv_list', 'image_gallery'])
})

test('preserves complete data image URLs in rendered attachments', () => {
  const schema = normalizeCheckInSchemaDraft({
    categoryName: '恢复照片记录',
    fields: [
      { key: 'memo', label: '备注', type: 'text' },
    ],
    layout: [
      { type: 'kv_list', bind: ['memo'] },
      { type: 'image_gallery', bind: 'attachments' },
    ],
  })
  const dataUrl = `data:image/jpeg;base64,${'a'.repeat(45_000)}`

  const rendered = renderCheckInRecordSchema({
    schema,
    title: '恢复照片记录',
    recordedAt: '2026-05-19T03:30:00.000Z',
    values: { memo: '午后照片' },
    attachments: [{ url: dataUrl, name: '图片信息 1', mimeType: 'image/jpeg' }],
  })
  const imageBlock = rendered.blocks.find((block) => block.type === 'image_gallery')

  assert.equal(imageBlock?.type, 'image_gallery')
  assert.equal(imageBlock.images[0]?.url, dataUrl)
})

test('dedupe key is stable for the same source message and semantic values', () => {
  const left = buildCheckInDedupeKey({
    userId: 'user-1',
    sourceMessageId: 'message-1',
    categoryKey: 'chemotherapy-nausea',
    values: { nausea_level: 2, vomit_count: 0 },
  })
  const right = buildCheckInDedupeKey({
    userId: 'user-1',
    sourceMessageId: 'message-1',
    categoryKey: 'chemotherapy-nausea',
    values: { vomit_count: 0, nausea_level: 2 },
  })

  assert.equal(left, right)
})

test('builds persistent check-in card tool output with stable card id', () => {
  const schema = normalizeCheckInSchemaDraft({
    categoryName: '体重记录',
    displayMode: 'quantitative',
    fields: [
      { key: 'weight_kg', label: '体重', type: 'number', unit: 'kg', required: true },
    ],
  })

  const output = buildCheckInCardToolOutput({
    id: '11111111-1111-4111-8111-111111111111',
    status: 'draft',
    schemaActionHint: 'create',
    schema,
    values: { weight_kg: 56.4 },
    attachments: [],
    note: null,
    tags: [],
    recordedAt: '2026-05-19T10:00:00.000Z',
    message: '已生成打卡卡片,等待用户核对后保存。',
  })

  assert.equal(output.action, 'draft_created')
  assert.equal(output.checkInCardId, '11111111-1111-4111-8111-111111111111')
  assert.equal(output.status, 'draft')
  assert.equal(output.isSave, undefined)
  assert.equal(output.draftToken, undefined)
  assert.equal(output.draftRendered?.kind, 'check_in_record')
  assert.deepEqual(output.draftValues, { weight_kg: 56.4 })
})

test('check-in card output remains a user-confirmed draft', () => {
  const schema = normalizeCheckInSchemaDraft({
    categoryName: '饮食记录',
    displayMode: 'calendar',
    fields: [
      { key: 'meal_type', label: '餐次', type: 'text', required: true },
      { key: 'food_items', label: '吃了什么', type: 'text', required: true },
    ],
  })

  const output = buildCheckInCardToolOutput({
    id: '11111111-1111-4111-8111-111111111111',
    status: 'draft',
    schemaActionHint: 'create',
    schema,
    values: { meal_type: '早餐', food_items: '鸡蛋、牛奶' },
    attachments: [],
    note: null,
    tags: [],
    recordedAt: '2026-05-20T00:00:00.000Z',
    message: '已生成打卡卡片草稿,等待用户核对后保存。',
  })

  assert.equal(output.isSave, undefined)
  assert.equal(output.status, 'draft')
  assert.equal(output.checkInCardId, '11111111-1111-4111-8111-111111111111')
})

test('builds a fallback schema draft when record category is missing', () => {
  const schema = normalizeCheckInSchemaDraft(buildFallbackCheckInSchemaDraft({
    categoryQuery: '关节疼痛记录',
    draftValues: {
      pain_level: 4,
      location: '左肩',
      affects_sleep: true,
    },
  }))

  assert.equal(schema.categoryName, '关节疼痛记录')
  assert.equal(schema.displayMode, 'quantitative')
  assert.deepEqual(
    schema.fields.map((field) => [field.key, field.label, field.type]),
    [
      ['pain_level', '疼痛程度', 'number'],
      ['location', '部位', 'text'],
      ['affects_sleep', '是否影响睡眠', 'boolean'],
    ],
  )
})

test('localizes common vital-sign fallback field labels', () => {
  const schema = normalizeCheckInSchemaDraft(buildFallbackCheckInSchemaDraft({
    categoryQuery: '血压记录',
    draftValues: {
      systolic: 151,
      diastolic: 86,
      pulse: 88,
      medication_taken: false,
    },
  }))

  assert.deepEqual(
    schema.fields.map((field) => field.label),
    ['收缩压', '舒张压', '脉搏', '是否服药'],
  )
})

test('normalizes English or mixed field labels into Chinese labels', () => {
  const schema = normalizeCheckInSchemaDraft({
    categoryName: '饮食打卡',
    fields: [
      { key: 'staple', label: 'staple / 饮食内容', type: 'text' },
      { key: 'protein', label: 'protein', type: 'text' },
      { key: 'vegetable', label: 'vegetable', type: 'text' },
      { key: 'bloating', label: 'bloating', type: 'boolean' },
      { key: 'unknown_signal', label: 'unknown signal', type: 'text' },
    ],
  })

  assert.deepEqual(
    schema.fields.map((field) => field.label),
    ['主食', '蛋白质类', '蔬菜', '是否腹胀', '记录内容'],
  )
  assert.equal(schema.fields.some((field) => /[A-Za-z]/.test(field.label)), false)
})

test('normalizes record date fields to date while keeping plain text fields as textarea-backed text', () => {
  const schema = normalizeCheckInSchemaDraft({
    categoryName: '天气记录',
    fields: [
      { key: 'record_date', label: '记录日期', type: 'text', required: true },
      { key: 'time', label: '时间', type: 'text' },
      { key: 'weather', label: '天气情况', type: 'text', required: true },
    ],
  })

  assert.deepEqual(
    schema.fields.map((field) => [field.key, field.label, field.type]),
    [
      ['record_date', '记录日期', 'date'],
      ['time', '时间', 'text'],
      ['weather', '天气情况', 'text'],
    ],
  )
})

test('renders legacy schemas with Chinese labels even when stored labels are English', () => {
  const rendered = renderCheckInRecordSchema({
    schema: {
      version: 1,
      kind: 'check_in_card',
      categoryKey: 'ci_medication',
      categoryName: '服药打卡',
      displayMode: 'calendar',
      titleTemplate: '服药打卡',
      aliases: [],
      fields: [
        { key: 'medication_name', label: 'medication / name', type: 'text' },
        { key: 'missed', label: 'missed', type: 'boolean' },
        { key: 'side_effect', label: 'side / effect', type: 'text' },
      ],
      layout: [{ type: 'kv_list', bind: ['medication_name', 'missed', 'side_effect'] }],
    },
    recordedAt: '2026-05-27T00:00:00.000Z',
    values: {
      medication_name: '他莫昔芬',
      missed: false,
      side_effect: '轻微恶心',
    },
    attachments: [],
    tags: [],
  })
  const firstBlock = rendered.blocks[0]

  assert.equal(firstBlock?.type, 'kv_list')
  assert.deepEqual(
    firstBlock?.type === 'kv_list' ? firstBlock.items.map((item) => item.label) : [],
    ['药物名称', '是否漏服', '不适反应'],
  )
})

test('uses source facts over mismatched fields for a new dynamic category', () => {
  const sourceText = '记录服药打卡：他莫昔芬20mg，早饭后吃了，没有漏服，轻微恶心。'
  const schema = normalizeCheckInSchemaDraft(buildFallbackCheckInSchemaDraft({
    categoryQuery: '他莫昔芬用药记录',
    draftValues: {
      meal_type: '早餐',
      food_content: '没有漏服、轻微恶心',
    },
    sourceText,
    fallbackSchema: {
      categoryName: '他莫昔芬用药记录',
      displayMode: 'calendar',
      fields: [
        { key: 'meal_type', label: '餐次', type: 'choice', options: ['早餐', '午餐', '晚餐', '加餐'], required: true },
        { key: 'food_content', label: '食物内容', type: 'text', required: true },
      ],
    },
  }))
  const values = enhanceCheckInValuesFromSourceText({}, schema, sourceText)

  assert.deepEqual(
    schema.fields.map((field) => [field.label, field.type, field.unit ?? null]),
    [
      ['剂量', 'number', 'mg'],
      ['名称', 'text', null],
      ['时间', 'text', null],
      ['是否漏服', 'boolean', null],
      ['补充情况', 'text', null],
    ],
  )
  const missedKey = schema.fields.find((field) => field.label === '是否漏服')?.key
  assert.deepEqual(values, {
    dose: 20,
    item_name: '他莫昔芬',
    time: '早饭后',
    ...(missedKey ? { [missedKey]: false } : {}),
    detail: '轻微恶心',
  })
})

test('replaces existing polluted schema when source facts contradict draft keys', () => {
  const existing = normalizeCheckInSchemaDraft({
    categoryName: '他莫昔芬用药记录',
    displayMode: 'calendar',
    fields: [
      { key: 'meal_type', label: '餐次', type: 'choice', options: ['早餐', '午餐', '晚餐', '加餐'], required: true },
      { key: 'food_content', label: '食物内容', type: 'text', required: true },
    ],
  })
  const sourceText = '再记一次服药打卡：他莫昔芬20mg，晚饭后吃了，今天没有漏服，只有轻微恶心。'

  assert.equal(shouldReplaceExistingCheckInSchema({
    existing,
    categoryQuery: '他莫昔芬用药记录',
    draftValues: {
      meal_type: '晚餐',
      food_content: '今天没有漏服、只有轻微恶心',
    },
    sourceText,
    fallbackSchema: null,
  }), true)

  const replacement = normalizeCheckInSchemaDraft(buildReplacementCheckInSchemaDraft({
    existing,
    categoryQuery: '他莫昔芬用药记录',
    draftValues: {
      meal_type: '晚餐',
      food_content: '今天没有漏服、只有轻微恶心',
    },
    sourceText,
    fallbackSchema: null,
  }))
  const values = enhanceCheckInValuesFromSourceText({}, replacement, sourceText)

  assert.deepEqual(
    replacement.fields.map((field) => field.label),
    ['剂量', '名称', '时间', '是否漏服', '补充情况'],
  )
  assert.equal(values.dose, 20)
  assert.equal(values.item_name, '他莫昔芬')
  assert.equal(values.time, '晚饭后')
  assert.equal(values.detail, '轻微恶心')
})

test('does not treat taking medication as a food record when repairing medication schemas', () => {
  const existing = normalizeCheckInSchemaDraft({
    categoryName: '服药打卡',
    displayMode: 'calendar',
    fields: [
      { key: 'medication_name', label: 'medication / name', type: 'text', required: true },
      { key: 'dose', label: '剂量', type: 'text' },
      { key: 'time', label: '时间', type: 'text' },
      { key: 'missed', label: 'missed', type: 'boolean' },
      { key: 'side_effect', label: 'side / effect', type: 'text' },
    ],
  })
  const sourceText = '今晚睡前他莫昔芬20mg已经吃了，今天没有漏服，没有明显不适，继续生成服药打卡卡片。'

  assert.equal(shouldReplaceExistingCheckInSchema({
    existing,
    categoryQuery: '服药打卡',
    draftValues: {
      meal_type: '晚餐',
      food_content: '今天没有漏服、没有明显不适、继续生成服药打卡卡片',
    },
    sourceText,
    fallbackSchema: null,
  }), true)

  const replacement = normalizeCheckInSchemaDraft(buildReplacementCheckInSchemaDraft({
    existing,
    categoryQuery: '服药打卡',
    draftValues: {
      meal_type: '晚餐',
      food_content: '今天没有漏服、没有明显不适、继续生成服药打卡卡片',
    },
    sourceText,
    fallbackSchema: null,
  }))
  const values = enhanceCheckInValuesFromSourceText({}, replacement, sourceText)

  assert.notDeepEqual(
    replacement.fields.map((field) => field.label),
    ['餐次', '食物内容'],
  )
  assert.ok(replacement.fields.some((field) => field.label === '名称'))
  assert.ok(replacement.fields.some((field) => field.label === '剂量'))
  assert.equal(values.item_name, '他莫昔芬')
  assert.equal(values.dose, 20)
})

test('keeps blood pressure facts when source text mentions taking antihypertensive medicine', () => {
  const sourceText = '现在再给我生成一次血压打卡：收缩压151，舒张压86，脉搏88，已经吃了降压药。'
  const existing = normalizeCheckInSchemaDraft({
    categoryName: '血压打卡',
    displayMode: 'quantitative',
    fields: [
      { key: 'mmhg', label: '记录内容', type: 'number' },
      { key: 'mmhg_2', label: '记录内容', type: 'number' },
      { key: 'field_3', label: '记录内容', type: 'number' },
    ],
  })

  const replacement = normalizeCheckInSchemaDraft(buildReplacementCheckInSchemaDraft({
    existing,
    categoryQuery: '血压打卡',
    draftValues: {
      mmhg: 151,
      mmhg_2: 86,
      field_3: 88,
      food_content: '降压药',
    },
    sourceText,
    fallbackSchema: null,
  }))
  const values = enhanceCheckInValuesFromSourceText({}, replacement, sourceText)

  assert.notDeepEqual(
    replacement.fields.map((field) => field.label),
    ['餐次', '食物内容'],
  )
  assert.ok(replacement.fields.some((field) => field.label === '收缩压'))
  assert.ok(replacement.fields.some((field) => field.label === '舒张压'))
  assert.ok(replacement.fields.some((field) => field.label === '脉搏'))
  assert.equal(values.systolic, 151)
  assert.equal(values.diastolic, 86)
  assert.equal(values.pulse, 88)
})

test('keeps explicit quality descriptions from source text when fallback schema omits them', () => {
  const sourceText = '昨晚23点半睡，早上6点醒，睡了6.5小时，夜里醒了2次，睡眠质量一般，请生成睡眠打卡卡片。'
  const schema = normalizeCheckInSchemaDraft(buildFallbackCheckInSchemaDraft({
    categoryQuery: '睡眠记录',
    sourceText,
    fallbackSchema: {
      categoryName: '睡眠记录',
      displayMode: 'calendar',
      fields: [
        { key: 'sleep_hours', label: '睡了', type: 'number', unit: '小时' },
        { key: 'wake_count', label: '夜里醒了', type: 'number', unit: '次' },
        { key: 'time', label: '时间', type: 'text' },
      ],
    },
  }))
  const values = enhanceCheckInValuesFromSourceText({}, schema, sourceText)

  assert.ok(schema.fields.some((field) => field.label === '睡眠质量'))
  const qualityKey = schema.fields.find((field) => field.label === '睡眠质量')?.key
  assert.equal(qualityKey ? values[qualityKey] : undefined, '一般')
})

test('keeps explicit location phrases in source-derived observation cards', () => {
  const sourceText = '请生成伤口观察打卡卡片：右侧腋下切口轻微发红，疼痛2分，没有渗液，没有发热。'
  const schema = normalizeCheckInSchemaDraft(buildFallbackCheckInSchemaDraft({
    categoryQuery: '伤口观察记录',
    sourceText,
    fallbackSchema: {
      categoryName: '伤口观察记录',
      displayMode: 'calendar',
      fields: [
        { key: 'content', label: '记录内容', type: 'text' },
      ],
    },
  }))
  const values = enhanceCheckInValuesFromSourceText({}, schema, sourceText)

  assert.deepEqual(
    schema.fields.map((field) => field.label),
    ['疼痛', '部位', '是否渗液', '补充情况'],
  )
  assert.equal(values.location, '右侧腋下切口')
})

test('adds missing source location to an existing observation schema', () => {
  const existing = normalizeCheckInSchemaDraft({
    categoryName: '伤口观察记录',
    displayMode: 'calendar',
    fields: [
      { key: 'pain', label: '疼痛', type: 'number', unit: '分', required: true },
      { key: 'exudate', label: '是否渗液', type: 'boolean' },
      { key: 'detail', label: '补充情况', type: 'text' },
    ],
  })
  const sourceText = '右侧腋下切口轻微发红，疼痛2分，没有渗液，没有发热，请生成打卡卡片。'

  assert.equal(shouldReplaceExistingCheckInSchema({
    existing,
    categoryQuery: '伤口观察记录',
    draftValues: {
      pain: 2,
      exudate: false,
      detail: '轻微发红',
    },
    sourceText,
    fallbackSchema: null,
  }), true)

  const replacement = normalizeCheckInSchemaDraft(buildReplacementCheckInSchemaDraft({
    existing,
    categoryQuery: '伤口观察记录',
    draftValues: {
      pain: 2,
      exudate: false,
      detail: '轻微发红',
    },
    sourceText,
    fallbackSchema: null,
  }))

  assert.deepEqual(replacement.fields.map((field) => field.label), ['疼痛', '是否渗液', '补充情况', '部位'])
})

test('localizes low-quality travel schema field labels', () => {
  const schema = normalizeCheckInSchemaDraft({
    categoryName: '旅行记录',
    displayMode: 'calendar',
    fields: [
      { key: 'destination', label: 'destination', type: 'text', required: true },
      { key: 'activities', label: 'activities', type: 'text' },
      { key: 'accommodation', label: 'accommodation', type: 'text' },
      { key: 'travel_date', label: 'travel / 日期', type: 'date' },
      { key: 'record_date', label: 'record / 日期', type: 'date' },
    ],
  })

  assert.deepEqual(
    schema.fields.map((field) => [field.key, field.label, field.type]),
    [
      ['destination', '目的地', 'text'],
      ['activities', '活动/行程', 'text'],
      ['accommodation', '住宿', 'text'],
      ['travel_date', '日期', 'date'],
      ['record_date', '记录日期', 'date'],
    ],
  )
})

test('replaces low-quality travel schema with localized labels', () => {
  const existing = normalizeCheckInSchemaDraft({
    categoryName: '旅行记录',
    displayMode: 'calendar',
    fields: [
      { key: 'destination', label: 'destination', type: 'text', required: true },
      { key: 'activities', label: 'activities', type: 'text' },
      { key: 'accommodation', label: 'accommodation', type: 'text' },
      { key: 'travel_date', label: 'travel / 日期', type: 'date' },
    ],
  })

  assert.equal(shouldReplaceExistingCheckInSchema({
    existing: {
      ...existing,
      fields: [
        { key: 'destination', label: 'destination', type: 'text', required: true },
        { key: 'activities', label: 'activities', type: 'text' },
        { key: 'accommodation', label: 'accommodation', type: 'text' },
        { key: 'travel_date', label: 'travel / 日期', type: 'date' },
      ],
    },
    categoryQuery: '旅行记录',
    draftValues: {
      destination: '北京',
      activities: '参观故宫、吃北京烤鸭',
      accommodation: '北京四季酒店',
      travel_date: '2026-05-21',
    },
    sourceText: '备注加一下 超级开心',
    fallbackSchema: null,
  }), true)

  const replacement = normalizeCheckInSchemaDraft(buildReplacementCheckInSchemaDraft({
    existing: {
      ...existing,
      fields: [
        { key: 'destination', label: 'destination', type: 'text', required: true },
        { key: 'activities', label: 'activities', type: 'text' },
        { key: 'accommodation', label: 'accommodation', type: 'text' },
        { key: 'travel_date', label: 'travel / 日期', type: 'date' },
      ],
    },
    categoryQuery: '旅行记录',
    sourceText: '备注加一下 超级开心',
  }))

  assert.deepEqual(
    replacement.fields.map((field) => [field.key, field.label, field.type]),
    [
      ['destination', '目的地', 'text'],
      ['activities', '活动/行程', 'text'],
      ['accommodation', '住宿', 'text'],
      ['travel_date', '日期', 'date'],
    ],
  )
})

test('upgrades stored travel schema when replacement fixes English labels', () => {
  const existing: CheckInA2uiSchema = {
    ...normalizeCheckInSchemaDraft({
      categoryName: '旅行记录',
      displayMode: 'calendar',
      fields: [
        { key: 'destination', label: '目的地', type: 'text', required: true },
        { key: 'activities', label: '活动/行程', type: 'text' },
        { key: 'accommodation', label: '住宿', type: 'text' },
        { key: 'travel_date', label: '日期', type: 'date' },
      ],
    }),
    fields: [
      { key: 'destination', label: 'destination', type: 'text', required: true },
      { key: 'activities', label: 'activities', type: 'text' },
      { key: 'accommodation', label: 'accommodation', type: 'text' },
      { key: 'travel_date', label: 'travel / 日期', type: 'date' },
    ],
  }
  const replacement = normalizeCheckInSchemaDraft(buildReplacementCheckInSchemaDraft({
    existing,
    categoryQuery: '旅行记录',
  }))

  assert.equal(shouldUpgradeStoredCheckInSchema(existing, replacement), true)
})

test('fallback schema draft remains usable when only a category is known', () => {
  const schema = normalizeCheckInSchemaDraft(buildFallbackCheckInSchemaDraft({
    categoryQuery: '伤口照片',
    draftValues: {},
  }))

  assert.equal(schema.categoryName, '伤口照片')
  assert.equal(schema.displayMode, 'calendar')
  assert.deepEqual(schema.fields.map((field) => [field.key, field.label, field.type]), [
    ['content', '记录内容', 'text'],
  ])
})

test('replaces low-quality diet schema with a Chinese food-content card', () => {
  const existing = normalizeCheckInSchemaDraft({
    categoryName: '饮食记录',
    displayMode: 'calendar',
    fields: [
      { key: 'drink', label: 'drink', type: 'text' },
      { key: 'time', label: '时间', type: 'text' },
    ],
  })
  const sourceText = '帮我记录一下我的早餐，我今早吃了一个鸡蛋，两片面包'

  assert.equal(shouldReplaceExistingCheckInSchema({
    existing,
    categoryQuery: '饮食记录',
    draftValues: {},
    sourceText,
    fallbackSchema: null,
  }), true)

  const replacement = normalizeCheckInSchemaDraft(buildReplacementCheckInSchemaDraft({
    existing,
    categoryQuery: '饮食记录',
    draftValues: {},
    sourceText,
    fallbackSchema: null,
  }))
  const values = enhanceCheckInValuesFromSourceText({}, replacement, sourceText)

  assert.deepEqual(
    replacement.fields.map((field) => [field.key, field.label, field.type]),
    [
      ['meal_type', '餐次', 'choice'],
      ['food_content', '食物内容', 'text'],
    ],
  )
  assert.deepEqual(values, {
    meal_type: '早餐',
    food_content: '一个鸡蛋、两片面包',
  })
})

test('keeps a good existing diet schema instead of replacing it', () => {
  const existing = normalizeCheckInSchemaDraft({
    categoryName: '饮食记录',
    displayMode: 'calendar',
    fields: [
      { key: 'meal_type', label: '餐次', type: 'choice', options: ['早餐', '午餐', '晚餐'] },
      { key: 'food_content', label: '食物内容', type: 'text' },
    ],
  })

  assert.equal(shouldReplaceExistingCheckInSchema({
    existing,
    categoryQuery: '饮食记录',
    draftValues: { meal_type: '早餐', food_content: '鸡蛋、面包' },
    sourceText: '早餐吃了鸡蛋、面包',
    fallbackSchema: null,
  }), false)
})

test('replaces a polluted schema when explicit draft values cannot be covered', () => {
  const existing = normalizeCheckInSchemaDraft({
    categoryName: '睡眠记录',
    displayMode: 'calendar',
    fields: [
      { key: 'meal_type', label: '餐次', type: 'choice', options: ['早餐', '午餐', '晚餐', '加餐'], required: true },
      { key: 'food_content', label: '食物内容', type: 'text', required: true },
    ],
  })
  const draftValues = {
    sleep_hours: 6.5,
    wake_count: 2,
  }

  assert.equal(shouldReplaceExistingCheckInSchema({
    existing,
    categoryQuery: '睡眠记录',
    draftValues,
    sourceText: '昨晚睡了6.5小时，中间醒了2次',
    fallbackSchema: null,
  }), true)

  const replacement = normalizeCheckInSchemaDraft(buildReplacementCheckInSchemaDraft({
    existing,
    categoryQuery: '睡眠记录',
    draftValues,
    sourceText: '昨晚睡了6.5小时，中间醒了2次',
    fallbackSchema: null,
  }))
  const values = enhanceCheckInValuesFromSourceText(draftValues, replacement, '昨晚睡了6.5小时，中间醒了2次')

  assert.deepEqual(
    replacement.fields.map((field) => [field.key, field.type]),
    [
      ['sleep_hours', 'number'],
      ['wake_count', 'number'],
    ],
  )
  assert.deepEqual(values, draftValues)
})

test('extends a matching schema when fallback fields cover more explicit values', () => {
  const existing = normalizeCheckInSchemaDraft({
    categoryName: '运动记录',
    displayMode: 'quantitative',
    fields: [
      { key: 'duration_min', label: '运动时长', type: 'number', unit: '分钟' },
    ],
  })
  const draftValues = {
    duration_min: 30,
    intensity: '中等',
  }

  assert.equal(shouldReplaceExistingCheckInSchema({
    existing,
    categoryQuery: '运动记录',
    draftValues,
    sourceText: '今天运动30分钟，强度中等',
    fallbackSchema: {
      categoryName: '运动记录',
      displayMode: 'quantitative',
      fields: [
        { key: 'duration_min', label: '运动时长', type: 'number', unit: '分钟' },
        { key: 'intensity', label: '运动强度', type: 'text' },
      ],
    },
  }), true)

  const replacement = normalizeCheckInSchemaDraft(buildReplacementCheckInSchemaDraft({
    existing,
    categoryQuery: '运动记录',
    draftValues,
    sourceText: '今天运动30分钟，强度中等',
    fallbackSchema: {
      categoryName: '运动记录',
      displayMode: 'quantitative',
      fields: [
        { key: 'duration_min', label: '运动时长', type: 'number', unit: '分钟' },
        { key: 'intensity', label: '运动强度', type: 'text' },
      ],
    },
  }))
  const values = enhanceCheckInValuesFromSourceText(draftValues, replacement, '今天运动30分钟，强度中等')

  assert.deepEqual(replacement.fields.map((field) => field.key), ['duration_min', 'intensity'])
  assert.deepEqual(values, draftValues)
})

test('adds explicit draft value fields that are missing from fallback fields', () => {
  const existing = normalizeCheckInSchemaDraft({
    categoryName: '运动记录',
    displayMode: 'quantitative',
    fields: [
      { key: 'duration_min', label: '运动时长', type: 'number', unit: '分钟' },
    ],
  })
  const draftValues = {
    duration_min: 30,
    intensity: '中等',
  }

  const replacement = normalizeCheckInSchemaDraft(buildReplacementCheckInSchemaDraft({
    existing,
    categoryQuery: '运动记录',
    draftValues,
    sourceText: '今天运动30分钟，强度中等',
    fallbackSchema: {
      categoryName: '运动记录',
      displayMode: 'quantitative',
      fields: [
        { key: 'duration_min', label: '运动时长', type: 'number', unit: '分钟' },
      ],
    },
  }))
  const values = enhanceCheckInValuesFromSourceText(draftValues, replacement, '今天运动30分钟，强度中等')

  assert.deepEqual(replacement.fields.map((field) => field.key), ['duration_min', 'intensity'])
  assert.deepEqual(values, draftValues)
})

test('adds explicit source facts when fallback fields only cover part of exercise content', () => {
  const sourceText = '运动打卡：下午散步20分钟，大概2000步，感觉轻微乏力，没有胸闷。'
  const draftValues = {
    value_5517b6: 20,
    flag_566e3c: false,
    detail: '轻微乏力',
  }

  const replacement = normalizeCheckInSchemaDraft(buildFallbackCheckInSchemaDraft({
    categoryQuery: '运动打卡',
    draftValues,
    sourceText,
    fallbackSchema: {
      categoryName: '运动打卡',
      displayMode: 'quantitative',
      fields: [
        { key: 'value_5517b6', label: '下午散步', type: 'number', unit: '分钟', required: true },
        { key: 'flag_566e3c', label: '是否胸闷', type: 'boolean' },
        { key: 'detail', label: '补充情况', type: 'text' },
      ],
    },
  }))
  const values = enhanceCheckInValuesFromSourceText(draftValues, replacement, sourceText)

  assert.deepEqual(
    replacement.fields.map((field) => [field.key, field.label, field.type, field.unit ?? null]),
    [
      ['value_5517b6', '下午散步', 'number', '分钟'],
      ['flag_566e3c', '是否胸闷', 'boolean', null],
      ['detail', '补充情况', 'text', null],
      ['step_count', '步数', 'number', '步'],
      ['time', '时间', 'text', null],
      ['activity_type', '运动类型', 'text', null],
    ],
  )
  assert.equal(values.step_count, 2000)
  assert.equal(values.activity_type, '散步')
  assert.equal(values.value_5517b6, 20)
})

test('uses fallback fields instead of a polluted schema even when values are empty', () => {
  const existing = normalizeCheckInSchemaDraft({
    categoryName: '伤口观察',
    displayMode: 'calendar',
    fields: [
      { key: 'meal_type', label: '餐次', type: 'choice', options: ['早餐', '午餐', '晚餐', '加餐'], required: true },
      { key: 'food_content', label: '食物内容', type: 'text', required: true },
    ],
  })
  const fallbackSchema = {
    categoryName: '伤口观察',
    displayMode: 'calendar' as const,
    fields: [
      { key: 'wound_location', label: '伤口位置', type: 'text' as const },
      { key: 'redness', label: '是否发红', type: 'boolean' as const },
      { key: 'exudate', label: '是否渗液', type: 'boolean' as const },
    ],
  }

  assert.equal(shouldReplaceExistingCheckInSchema({
    existing,
    categoryQuery: '伤口观察',
    draftValues: {},
    sourceText: '帮我建一个伤口观察打卡，之后记录位置、发红和渗液情况',
    fallbackSchema,
  }), true)

  const replacement = normalizeCheckInSchemaDraft(buildReplacementCheckInSchemaDraft({
    existing,
    categoryQuery: '伤口观察',
    draftValues: {},
    sourceText: '帮我建一个伤口观察打卡，之后记录位置、发红和渗液情况',
    fallbackSchema,
  }))

  assert.deepEqual(replacement.fields.map((field) => field.key), ['wound_location', 'redness', 'exudate'])
})

test('uses fallback fields to extend an existing schema even when values are empty', () => {
  const existing = normalizeCheckInSchemaDraft({
    categoryName: '症状记录',
    displayMode: 'calendar',
    fields: [
      { key: 'symptom', label: '症状', type: 'text' },
    ],
  })
  const fallbackSchema = {
    categoryName: '症状记录',
    displayMode: 'calendar' as const,
    fields: [
      { key: 'symptom', label: '症状', type: 'text' as const },
      { key: 'severity', label: '严重程度', type: 'number' as const, unit: '分' },
    ],
  }

  assert.equal(shouldReplaceExistingCheckInSchema({
    existing,
    categoryQuery: '症状记录',
    draftValues: {},
    sourceText: '以后症状记录里也想记一下严重程度',
    fallbackSchema,
  }), true)

  const replacement = normalizeCheckInSchemaDraft(buildReplacementCheckInSchemaDraft({
    existing,
    categoryQuery: '症状记录',
    draftValues: {},
    sourceText: '以后症状记录里也想记一下严重程度',
    fallbackSchema,
  }))

  assert.deepEqual(replacement.fields.map((field) => field.key), ['symptom', 'severity'])
})

test('upgrades stored schema when a same-category replacement has incompatible fields', () => {
  const existing = normalizeCheckInSchemaDraft({
    categoryName: '睡眠记录',
    displayMode: 'calendar',
    fields: [
      { key: 'meal_type', label: '餐次', type: 'choice', options: ['早餐', '午餐', '晚餐', '加餐'], required: true },
      { key: 'food_content', label: '食物内容', type: 'text', required: true },
    ],
  })
  const replacement = normalizeCheckInSchemaDraft({
    categoryName: '睡眠记录',
    displayMode: 'quantitative',
    fields: [
      { key: 'sleep_hours', label: '睡眠时长', type: 'number', unit: '小时' },
      { key: 'wake_count', label: '夜醒次数', type: 'number', unit: '次' },
    ],
  })

  assert.equal(shouldUpgradeStoredCheckInSchema(existing, replacement), true)
})

test('upgrades stored diet schema when replacement fixes English-only fields', () => {
  const existing = normalizeCheckInSchemaDraft({
    categoryName: '饮食记录',
    displayMode: 'calendar',
    fields: [
      { key: 'drink', label: 'drink', type: 'text' },
      { key: 'time', label: '时间', type: 'text' },
    ],
  })
  const replacement = normalizeCheckInSchemaDraft(buildReplacementCheckInSchemaDraft({
    existing,
    categoryQuery: '饮食记录',
    sourceText: '早餐吃了一个鸡蛋，两片面包',
  }))

  assert.equal(shouldUpgradeStoredCheckInSchema(existing, replacement), true)
})

test('only current-session draft check-in cards can be superseded', () => {
  const base = {
    userId: 'user-1',
    sessionId: 'session-1',
    status: 'draft',
  }

  assert.equal(canInvalidateSupersededCheckInCard({
    card: base,
    userId: 'user-1',
    sessionId: 'session-1',
  }), true)
  assert.equal(canInvalidateSupersededCheckInCard({
    card: { ...base, status: 'saved' },
    userId: 'user-1',
    sessionId: 'session-1',
  }), false)
  assert.equal(canInvalidateSupersededCheckInCard({
    card: { ...base, status: 'invalidated' },
    userId: 'user-1',
    sessionId: 'session-1',
  }), false)
  assert.equal(canInvalidateSupersededCheckInCard({
    card: base,
    userId: 'user-2',
    sessionId: 'session-1',
  }), false)
  assert.equal(canInvalidateSupersededCheckInCard({
    card: base,
    userId: 'user-1',
    sessionId: 'session-2',
  }), false)
})

test('orders recently used check-in schemas before legacy schemas without lastUsedAt', () => {
  const legacy = {
    categoryName: '外出/旅行记录',
    lastUsedAt: null,
    updatedAt: new Date('2026-05-19T10:00:00.000Z'),
  }
  const latest = {
    categoryName: '天气记录',
    lastUsedAt: new Date('2026-05-20T04:02:25.000Z'),
    updatedAt: new Date('2026-05-20T04:02:25.000Z'),
  }
  const olderUsed = {
    categoryName: '睡眠记录',
    lastUsedAt: new Date('2026-05-20T03:00:00.000Z'),
    updatedAt: new Date('2026-05-20T03:00:00.000Z'),
  }

  assert.deepEqual(
    orderCheckInSchemasForDisplay([legacy, olderUsed, latest]).map((row) => row.categoryName),
    ['天气记录', '睡眠记录', '外出/旅行记录'],
  )
})

test('matches check-in schemas by exact categoryKey before fuzzy category names', () => {
  const diet = normalizeCheckInSchemaDraft({
    categoryName: '饮食记录',
    displayMode: 'calendar',
    fields: [
      { key: 'meal_type', label: '餐次', type: 'choice', options: ['早餐', '午餐', '晚餐'] },
      { key: 'food_content', label: '食物内容', type: 'text' },
    ],
  })
  const medication = normalizeCheckInSchemaDraft({
    categoryName: '服药打卡',
    displayMode: 'calendar',
    fields: [
      { key: 'medication_name', label: '药物名称', type: 'text' },
      { key: 'dose', label: '剂量', type: 'number', unit: 'mg' },
    ],
  })

  const result = findCheckInSchemaMatch([
    {
      id: 'diet-schema',
      userId: 'user-1',
      categoryKey: diet.categoryKey,
      categoryName: diet.categoryName,
      categoryDescription: null,
      displayMode: diet.displayMode,
      aliases: [],
      schemaVersion: 1,
      a2uiSchema: diet,
      schemaHash: 'diet-hash',
      status: 'active',
      lastUsedAt: null,
      createdFromSessionId: null,
      createdFromMessageId: null,
      createdFromToolCallId: null,
      createdAt: '2026-05-27T00:00:00.000Z',
      updatedAt: '2026-05-27T00:00:00.000Z',
    },
    {
      id: 'med-schema',
      userId: 'user-1',
      categoryKey: medication.categoryKey,
      categoryName: medication.categoryName,
      categoryDescription: null,
      displayMode: medication.displayMode,
      aliases: ['吃药记录'],
      schemaVersion: 1,
      a2uiSchema: medication,
      schemaHash: 'med-hash',
      status: 'active',
      lastUsedAt: null,
      createdFromSessionId: null,
      createdFromMessageId: null,
      createdFromToolCallId: null,
      createdAt: '2026-05-27T00:00:00.000Z',
      updatedAt: '2026-05-27T00:00:00.000Z',
    },
  ], {
    categoryQuery: '饮食记录',
    categoryKey: medication.categoryKey,
  })

  assert.equal(result.action, 'matched')
  assert.equal(result.schema?.categoryName, '服药打卡')
})

test('resolves check-in recordedAt from semantic date only', () => {
  const fromDate = resolveCheckInRecordedAt({
    recordedAt: '2026-05-20',
    fallbackNow: new Date('2026-05-20T04:02:15.000Z'),
  })
  const fallback = resolveCheckInRecordedAt({
    recordedAt: null,
    fallbackNow: new Date('2026-05-20T04:02:15.000Z'),
  })

  assert.equal(fromDate.toISOString(), '2026-05-19T16:00:00.000Z')
  assert.equal(fallback.toISOString(), '2026-05-20T04:02:15.000Z')
  assert.throws(
    () => resolveCheckInRecordedAt({ recordedAt: '2026-05-21T09:30:00+08:00' }),
    /YYYY-MM-DD/,
  )
  assert.throws(
    () => resolveCheckInRecordedAt({ recordedAt: '2026-02-31' }),
    /有效日期/,
  )
})

test('rejects future dates as historical check-in records', () => {
  assert.throws(
    () => resolveCheckInRecordedAt({
      recordedAt: '2026-05-23',
      fallbackNow: new Date('2026-05-22T04:02:15.000Z'),
    }),
    /未来日期不可保存为历史打卡/,
  )
  assert.throws(
    () => resolveCheckInRecordRecordedAt({
      explicitRecordedAt: '2026-05-23',
      fallbackNow: new Date('2026-05-22T04:02:15.000Z'),
    }),
    /未来日期不可保存为历史打卡/,
  )
})

test('preserves stored recordedAt unless an explicit record edit date is provided', () => {
  const storedDraftDate = '2026-05-20T16:00:00.000Z'

  assert.equal(
    resolveOptionalUserRecordDate(null, storedDraftDate).toISOString(),
    storedDraftDate,
  )
  assert.equal(
    resolveOptionalUserRecordDate('2026-05-22', storedDraftDate).toISOString(),
    '2026-05-21T16:00:00.000Z',
  )
})

test('derives the record date from a date field when recordedAt is omitted', () => {
  const schema = normalizeCheckInSchemaDraft({
    categoryName: '天气记录',
    displayMode: 'calendar',
    fields: [
      { key: 'date', label: '日期', type: 'date', required: true },
      { key: 'weather', label: '天气情况', type: 'text', required: true },
    ],
  })

  assert.equal(
    resolveCheckInRecordRecordedAt({
      schema,
      values: { date: '2026/05/19', weather: '晴转多云' },
      storedRecordedAt: '2026-05-20T07:08:00.000Z',
    }).toISOString(),
    '2026-05-18T16:00:00.000Z',
  )
  assert.equal(
    resolveCheckInRecordRecordedAt({
      explicitRecordedAt: '2026-05-18',
      schema,
      values: { date: '2026-05-19', weather: '晴转多云' },
      storedRecordedAt: '2026-05-20T07:08:00.000Z',
    }).toISOString(),
    '2026-05-17T16:00:00.000Z',
  )
})

test('prefills visible record date fields from fixed draft recordedAt', () => {
  const schema = normalizeCheckInSchemaDraft({
    categoryName: '天气记录',
    displayMode: 'calendar',
    fields: [
      { key: 'date', label: '日期', type: 'date', required: true },
      { key: 'location', label: '地点', type: 'text' },
      { key: 'weather', label: '天气', type: 'text' },
    ],
  })

  assert.deepEqual(
    applyRecordedAtToRecordDateFields(schema, { location: '上海', weather: '阴天' }, '2026-05-20T16:00:00.000Z'),
    { date: '2026-05-21', location: '上海', weather: '阴天' },
  )
  assert.deepEqual(
    applyRecordedAtToRecordDateFields(schema, { date: '2026-05-19', location: '杭州' }, '2026-05-20T16:00:00.000Z'),
    { date: '2026-05-19', location: '杭州' },
  )
})

test('maps Chinese field labels into schema keys when merging check-in values', () => {
  const schema = normalizeCheckInSchemaDraft({
    categoryName: '外出/旅行记录',
    displayMode: 'calendar',
    fields: [
      { key: 'destination', label: '目的地', type: 'text', required: true },
      { key: 'activity', label: '主要活动', type: 'text' },
      { key: 'food', label: '吃了什么', type: 'text' },
      { key: 'hotel', label: '住宿', type: 'text' },
      { key: 'duration', label: '时长', type: 'text' },
    ],
  })

  const values = mergeCheckInCardValues(
    { destination: '北京', food: '北京烤鸭' },
    { 住宿: '北京四季酒店', 时长: '一晚', ignored: '不要入库' } as any,
    schema,
  )

  assert.deepEqual(values, {
    destination: '北京',
    food: '北京烤鸭',
    hotel: '北京四季酒店',
    duration: '一晚',
  })
})

test('accepts note from draftValues when draftNote is omitted', () => {
  assert.equal(resolveCheckInDraftNote('', { note: '超级开心' }), '超级开心')
  assert.equal(resolveCheckInDraftNote(null, { 备注: '有点累' } as any), '有点累')
  assert.equal(resolveCheckInDraftNote('直接备注', { note: '不应覆盖' }), '直接备注')
})

test('conservatively fills food check-in fields from explicit source text', () => {
  const schema = normalizeCheckInSchemaDraft({
    categoryName: '饮食记录',
    displayMode: 'calendar',
    fields: [
      { key: 'meal_type', label: '餐次', type: 'choice', options: ['早餐', '午餐', '晚餐', '加餐'], required: true },
      { key: 'main_dish', label: '主食', type: 'text' },
      { key: 'protein', label: '蛋白质', type: 'text' },
      { key: 'vegetables', label: '蔬菜', type: 'text' },
      { key: 'soup', label: '汤品', type: 'text' },
      { key: 'fruit', label: '水果', type: 'text' },
    ],
  })

  assert.deepEqual(
    enhanceCheckInValuesFromSourceText(
      { fruit: '苹果' },
      schema,
      '我昨天晚上吃了米饭、煎鸡蛋、清炒青菜、豆腐汤和苹果，图片是这张测试图。请记录下。',
    ),
    {
      meal_type: '晚餐',
      main_dish: '米饭',
      protein: '煎鸡蛋',
      vegetables: '清炒青菜',
      soup: '豆腐汤',
      fruit: '苹果',
    },
  )
})

test('corrects obvious food field class mistakes from explicit source text', () => {
  const schema = normalizeCheckInSchemaDraft({
    categoryName: '饮食记录',
    displayMode: 'calendar',
    fields: [
      { key: 'meal_type', label: '餐次', type: 'choice', options: ['早餐', '午餐', '晚餐', '加餐'], required: true },
      { key: 'main_food', label: '主食', type: 'text' },
      { key: 'protein', label: '蛋白质', type: 'text' },
    ],
  })

  assert.deepEqual(
    enhanceCheckInValuesFromSourceText(
      { meal_type: '早餐', main_food: '两个鸡蛋', protein: '鸡蛋' },
      schema,
      '今天早餐吃了半碗粥和两个鸡蛋，帮我记录一下。',
    ),
    {
      meal_type: '早餐',
      main_food: '半碗粥',
      protein: '两个鸡蛋',
    },
  )
})

test('keeps generic food content separate from food-suffixed category fields', () => {
  const schema = normalizeCheckInSchemaDraft({
    categoryName: '饮食记录',
    displayMode: 'calendar',
    fields: [
      { key: 'food', label: '饮食内容', type: 'text' },
      { key: 'main_food', label: '主食', type: 'text' },
      { key: 'protein_food', label: '蛋白质', type: 'text' },
    ],
  })

  assert.deepEqual(
    enhanceCheckInValuesFromSourceText({}, schema, '早餐吃了半碗粥和两个鸡蛋。'),
    {
      food: '半碗粥、两个鸡蛋',
      main_food: '半碗粥',
      protein_food: '两个鸡蛋',
    },
  )
})

test('extracts current user text from reminder-injected multimodal message content', () => {
  const content = JSON.stringify([
    {
      type: 'text',
      text: '<system-reminder>\n内部上下文\n</system-reminder>\n\n我昨天晚上吃了米饭、煎鸡蛋和苹果，请记录下。',
    },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
  ])

  assert.equal(
    extractCheckInSourceTextFromMessageContent(content),
    '我昨天晚上吃了米饭、煎鸡蛋和苹果，请记录下。',
  )
})

test('extracts multiple image attachments from persisted multimodal message content', () => {
  const content = JSON.stringify([
    { type: 'text', text: '请记录这顿饭' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,aaa' } },
    { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,bbb' } },
  ])

  assert.deepEqual(extractCheckInAttachmentsFromMessageContent(content), [
    { url: 'data:image/png;base64,aaa', name: '图片信息 1', mimeType: 'image/png' },
    { url: 'data:image/jpeg;base64,bbb', name: '图片信息 2', mimeType: 'image/jpeg' },
  ])
})

test('validates required check-in fields before saving', () => {
  const schema = normalizeCheckInSchemaDraft({
    categoryName: '外出/旅行记录',
    displayMode: 'calendar',
    fields: [
      { key: 'destination', label: '目的地', type: 'text', required: true },
      { key: 'stayed_over', label: '是否住宿', type: 'boolean', required: true },
      { key: 'food', label: '吃了什么', type: 'text' },
    ],
  })

  assert.deepEqual(
    validateCheckInRequiredFields(schema, { destination: '   ', stayed_over: false }),
    ['目的地'],
  )
  assert.deepEqual(
    validateCheckInRequiredFields(schema, { destination: '北京', stayed_over: false }),
    [],
  )
})

test('builds an edited check-in record payload without assessment metadata', () => {
  const schema = normalizeCheckInSchemaDraft({
    categoryName: '外出/旅行记录',
    displayMode: 'calendar',
    fields: [
      { key: 'destination', label: '目的地', type: 'text', required: true },
      { key: 'activity', label: '主要活动', type: 'text' },
      { key: 'food', label: '吃了什么', type: 'text' },
    ],
  })
  const rendered = renderCheckInRecordSchema({
    schema,
    title: '外出/旅行记录',
    recordedAt: '2026-05-19T14:04:00.000Z',
    values: { destination: '上海外滩', activity: '游览外滩', food: '灌汤包' },
    note: '原备注',
  })
  const record: CheckInRecord = {
    id: 'record-1',
    userId: 'user-1',
    schemaId: 'schema-1',
    categoryKey: schema.categoryKey,
    schemaVersion: 1,
    title: '外出/旅行记录',
    recordedAt: '2026-05-19T14:04:00.000Z',
    recordedByType: 'user',
    recordedByName: '本人提交',
    sourceSessionId: null,
    sourceMessageId: null,
    toolCallId: null,
    valuesJson: { destination: '上海外滩', activity: '游览外滩', food: '灌汤包' },
    attachmentsJson: [],
    renderedA2uiSchema: rendered,
    schemaSnapshot: schema,
    tags: ['旅行'],
    createdAt: '2026-05-19T14:04:00.000Z',
    updatedAt: '2026-05-19T14:04:00.000Z',
  }

  const payload = buildCheckInRecordUpdatePayload({
    record,
    values: { destination: '上海外滩', activity: '散步', food: '灌汤包、奶茶', ignored: '不要入库' } as any,
    note: '更新后的备注',
    tags: ['旅行', '旅行', '外出'],
  })

  assert.deepEqual(payload.valuesJson, {
    destination: '上海外滩',
    activity: '散步',
    food: '灌汤包、奶茶',
  })
  assert.deepEqual(payload.tags, ['旅行', '外出'])
  assert.equal(JSON.stringify(payload).includes('assessment'), false)
  assert.equal('rating' in payload, false)
  assert.equal('summary' in payload, false)
  assert.equal('summaryStatus' in payload, false)
  assert.equal('summarizedAt' in payload, false)
  assert.match(JSON.stringify(payload.renderedA2uiSchema), /更新后的备注/)
})

test('builds record update payload with YYYY-MM-DD as the user-facing record date', () => {
  const schema = normalizeCheckInSchemaDraft({
    categoryName: '天气记录',
    displayMode: 'calendar',
    fields: [
      { key: 'weather', label: '天气', type: 'text', required: true },
    ],
  })
  const rendered = renderCheckInRecordSchema({
    schema,
    recordedAt: '2026-05-20T04:02:00.000Z',
    values: { weather: '多云' },
  })
  const record: CheckInRecord = {
    id: 'record-date',
    userId: 'user-1',
    schemaId: 'schema-1',
    categoryKey: schema.categoryKey,
    schemaVersion: schema.version,
    recordedByType: 'agent',
    recordedByName: 'Agent 代为保存',
    sourceSessionId: 'session-1',
    sourceMessageId: 'message-1',
    toolCallId: 'tool-1',
    title: rendered.title,
    recordedAt: '2026-05-20T04:02:00.000Z',
    valuesJson: { weather: '多云' },
    attachmentsJson: [],
    renderedA2uiSchema: rendered,
    schemaSnapshot: schema,
    tags: [],
    createdAt: '2026-05-20T04:02:00.000Z',
    updatedAt: '2026-05-20T04:02:00.000Z',
  }

  const payload = buildCheckInRecordUpdatePayload({
    record,
    recordedAt: '2026-05-21',
  })

  assert.equal(payload.recordedAt.toISOString(), '2026-05-20T16:00:00.000Z')
  assert.equal(payload.renderedA2uiSchema.recordedAt, '2026-05-20T16:00:00.000Z')
})
