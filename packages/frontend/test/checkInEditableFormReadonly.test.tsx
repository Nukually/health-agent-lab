import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { CheckInA2uiSchema } from '@health-agent/shared'

;(globalThis as typeof globalThis & { React?: typeof React }).React = React
const {
  default: CheckInEditableForm,
  findMissingCheckInRequiredFieldLabels,
} = await import('../src/lib/a2ui/EditableForm.js')

const schema: CheckInA2uiSchema = {
  version: 1,
  kind: 'check_in_card',
  categoryKey: 'sleep',
  categoryName: '睡眠记录',
  displayMode: 'calendar',
  titleTemplate: '睡眠记录',
  aliases: ['睡眠'],
  fields: [
    { key: 'sleep_hours', label: '睡眠时长', type: 'number', unit: '小时', required: true },
    { key: 'wake_count', label: '夜间觉醒次数', type: 'number', unit: '次' },
    { key: 'quality', label: '睡眠质量', type: 'choice', options: ['很好', '一般', '较差'] },
    { key: 'fell_asleep_at', label: '入睡时间', type: 'text' },
    { key: 'meal_plan', label: '食谱内容', type: 'text' },
  ],
  layout: [],
}

const html = renderToStaticMarkup(
  <CheckInEditableForm
    schema={schema}
    values={{
      sleep_hours: 7,
      wake_count: 1,
      meal_plan: '早餐:燕麦牛奶+水煮蛋+小番茄 午餐:米饭+清蒸鱼+青菜 晚餐:杂粮粥+豆腐',
    }}
    attachments={[
      { url: 'data:image/png;base64,abc', name: '本轮图片 1', mimeType: 'image/png' },
      { url: 'data:image/jpeg;base64,def', name: '本轮图片 2', mimeType: 'image/jpeg' },
    ]}
    note=""
    tags={[]}
    helperText="已为你生成新的打卡卡片;请你核对/补全后保存。"
    statusLabel="已保存"
    readOnly
    onChangeValue={() => {}}
    onChangeNote={() => {}}
    onSubmit={() => {}}
  />,
)

assert.match(html, /睡眠时长/)
assert.match(html, /夜间觉醒次数/)
assert.match(html, /睡眠质量/)
assert.match(html, /入睡时间/)
assert.match(html, /食谱内容/)
assert.match(html, /value="7"/)
assert.match(html, /value="1"/)
assert.match(html, /<textarea rows="3"[^>]*>早餐:燕麦牛奶/)
assert.match(html, /<textarea[^>]*disabled[^>]*>早餐:燕麦牛奶/)
assert.doesNotMatch(html, /<input[^>]*value="早餐:燕麦牛奶/)
assert.match(html, /disabled/)
assert.match(html, /已保存/)
assert.match(html, /图片信息/)
assert.match(html, /查看图片信息 1/)
assert.match(html, /查看图片信息 2/)
assert.doesNotMatch(html, /本轮上传图片/)
assert.doesNotMatch(html, /本轮图片/)
assert.doesNotMatch(html, /保存打卡/)

const titleTemplateSchema: CheckInA2uiSchema = {
  version: 1,
  kind: 'check_in_card',
  categoryKey: 'meal',
  categoryName: '饮食记录',
  displayMode: 'calendar',
  titleTemplate: '{meal_type}记录',
  aliases: [],
  fields: [
    { key: 'meal_type', label: '餐次', type: 'choice', options: ['早餐', '午餐', '晚餐'], required: true },
    { key: 'main_food', label: '主食', type: 'text' },
  ],
  layout: [],
}

const titleTemplateHtml = renderToStaticMarkup(
  <CheckInEditableForm
    schema={titleTemplateSchema}
    values={{ meal_type: '早餐', main_food: '面包' }}
    attachments={[]}
    note=""
    tags={[]}
    statusLabel="待保存"
    onChangeValue={() => {}}
    onChangeNote={() => {}}
    onSubmit={() => {}}
  />,
)

assert.match(titleTemplateHtml, /<h3[^>]*>饮食记录<\/h3>/)
assert.doesNotMatch(titleTemplateHtml, /\{meal_type\}/)
assert.doesNotMatch(titleTemplateHtml, /早餐记录/)

assert.deepEqual(
  findMissingCheckInRequiredFieldLabels(schema, { sleep_hours: '', wake_count: 1 }),
  ['睡眠时长'],
)
assert.deepEqual(
  findMissingCheckInRequiredFieldLabels(schema, { sleep_hours: 0, wake_count: 1 }),
  [],
)

console.log('check-in editable form readonly tests passed')
