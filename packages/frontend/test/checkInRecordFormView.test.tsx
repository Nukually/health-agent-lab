import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { CheckInA2uiSchema, CheckInRecord } from '@health-agent/shared'

;(globalThis as typeof globalThis & { React?: typeof React }).React = React
const { getCheckInRecordEditableFormProps } = await import('../src/pages/checkInRecordFormView.js')
const {
  applyUpdatedCheckInRecord,
  createCheckInRecordEditState,
} = await import('../src/pages/checkInRecordFormView.js')
const { default: CheckInEditableForm } = await import('../src/lib/a2ui/EditableForm.js')

const schema: CheckInA2uiSchema = {
  version: 1,
  kind: 'check_in_card',
  categoryKey: 'travel',
  categoryName: '外出/旅行记录',
  displayMode: 'calendar',
  titleTemplate: '外出/旅行记录',
  aliases: ['外出', '旅行'],
  fields: [
    { key: 'destination', label: '目的地', type: 'text', required: true },
    { key: 'activity', label: '主要活动', type: 'text' },
    { key: 'food', label: '吃了什么', type: 'text' },
    { key: 'hotel', label: '住宿', type: 'text' },
    { key: 'duration', label: '时长', type: 'text' },
  ],
  layout: [],
}

const record: CheckInRecord = {
  id: 'record-1',
  userId: 'user-1',
  schemaId: 'schema-1',
  categoryKey: 'travel',
  schemaVersion: 1,
  title: '外出/旅行记录',
  recordedAt: '2026-05-19T14:04:00.000Z',
  recordedByType: 'agent',
  recordedByName: '橙',
  sourceSessionId: 'session-1',
  sourceMessageId: 'message-1',
  toolCallId: 'tool-1',
  valuesJson: {
    destination: '上海外滩',
    activity: '游览外滩',
    food: '灌汤包、奶茶',
    hotel: '和平饭店',
    duration: '一晚',
  },
  attachmentsJson: [],
  renderedA2uiSchema: {
    version: 1,
    kind: 'check_in_record',
    title: '外出/旅行记录',
    categoryKey: 'travel',
    categoryName: '外出/旅行记录',
    recordedAt: '2026-05-19T14:04:00.000Z',
    blocks: [
      { type: 'kv_list', items: [{ key: 'destination', label: '目的地', value: '上海外滩' }] },
      { type: 'note', text: '去了上海外滩，吃了灌汤包和奶茶，在和平饭店住了一晚。' },
    ],
  },
  schemaSnapshot: schema,
  tags: ['旅行'],
  createdAt: '2026-05-19T14:04:00.000Z',
  updatedAt: '2026-05-19T14:04:00.000Z',
}

const props = getCheckInRecordEditableFormProps(record)

assert.equal(props.schema, schema)
assert.equal(props.values, record.valuesJson)
assert.equal(props.attachments, record.attachmentsJson)
assert.equal(props.note, '去了上海外滩，吃了灌汤包和奶茶，在和平饭店住了一晚。')
assert.deepEqual(props.tags, ['旅行'])
assert.equal(props.statusLabel, '已保存')
assert.equal(props.readOnly, true)

const html = renderToStaticMarkup(
  <CheckInEditableForm
    {...props}
    onChangeValue={() => {}}
    onChangeNote={() => {}}
    onSubmit={() => {}}
  />,
)

assert.match(html, /外出\/旅行记录/)
assert.match(html, /已保存/)
assert.match(html, /目的地 \*/)
assert.match(html, /<textarea[^>]*>上海外滩<\/textarea>/)
assert.match(html, /灌汤包、奶茶/)
assert.match(html, /disabled/)
assert.doesNotMatch(html, /保存打卡/)

const editState = createCheckInRecordEditState(record)
assert.equal(editState.recordId, 'record-1')
assert.deepEqual(editState.values, record.valuesJson)
assert.equal(editState.note, '去了上海外滩，吃了灌汤包和奶茶，在和平饭店住了一晚。')
assert.deepEqual(editState.tags, ['旅行'])
assert.notEqual(editState.values, record.valuesJson)

const updatedRecord = {
  ...record,
  id: 'record-1',
  valuesJson: { ...record.valuesJson, activity: '散步' },
  updatedAt: '2026-05-19T15:00:00.000Z',
}
assert.deepEqual(
  applyUpdatedCheckInRecord([{ ...record, id: 'other-record' }, record], updatedRecord).map((item) => item.updatedAt),
  ['2026-05-19T14:04:00.000Z', '2026-05-19T15:00:00.000Z'],
)
assert.equal(
  getCheckInRecordEditableFormProps({
    ...record,
    renderedA2uiSchema: { ...record.renderedA2uiSchema, blocks: [] },
  }).note,
  '',
)

console.log('check-in record form view tests passed')
