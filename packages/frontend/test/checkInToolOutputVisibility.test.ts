import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

;(globalThis as typeof globalThis & { localStorage?: Storage; React?: typeof React }).localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
  clear: () => {},
  key: () => null,
  length: 0,
}
;(globalThis as typeof globalThis & { React?: typeof React }).React = React

const {
  shouldRenderCompletedToolOutputBlock,
  shouldRenderPendingToolOutputBlock,
} = await import('../src/components/chat/ToolOutputBlocks.js')
const { default: CheckInInline } = await import('../src/components/chat/CheckInInline.js')

assert.equal(shouldRenderPendingToolOutputBlock('propose_check_in_draft'), false)
assert.equal(shouldRenderPendingToolOutputBlock('propose_check_in_record'), false)
assert.equal(shouldRenderPendingToolOutputBlock('save_check_in_card'), false)
assert.equal(shouldRenderPendingToolOutputBlock('show_intervention_material'), true)

assert.equal(shouldRenderCompletedToolOutputBlock('save_check_in_card'), false)
assert.equal(shouldRenderCompletedToolOutputBlock('propose_check_in_draft'), true)
assert.equal(shouldRenderCompletedToolOutputBlock('propose_check_in_record'), true)

const missingSchemaHtml = renderToStaticMarkup(
  React.createElement(CheckInInline, {
    output: {
      action: 'schema_not_found',
      message: '没有找到匹配的打卡模板,需要先调用 propose_check_in_draft 创建新的打卡模板。',
    },
  }),
)
assert.equal(missingSchemaHtml, '')
assert.doesNotMatch(missingSchemaHtml, /没有找到对应打卡模板/)
assert.doesNotMatch(missingSchemaHtml, /propose_check_in_draft/)

const draftHtml = renderToStaticMarkup(
  React.createElement(CheckInInline, {
    output: {
      action: 'draft_created',
      checkInCardId: '11111111-1111-4111-8111-111111111111',
      status: 'draft',
      draftSchema: {
        version: 1,
        kind: 'check_in_card',
        categoryKey: 'sleep',
        categoryName: '睡眠记录',
        displayMode: 'calendar',
        titleTemplate: '睡眠记录',
        aliases: ['睡眠'],
        fields: [
          { key: 'sleep_hours', label: '睡眠时长', type: 'number', unit: '小时' },
        ],
        layout: [],
      },
      draftValues: { sleep_hours: 6 },
      draftAttachments: [
        { url: 'data:image/png;base64,aaa', name: '图片信息 1', mimeType: 'image/png' },
      ],
      message: '已生成打卡卡片草稿,等待用户在卡片里核对并保存。',
    },
  }),
)
assert.match(draftHtml, /睡眠时长/)
assert.match(draftHtml, /保存/)
assert.match(draftHtml, /取消/)
assert.match(draftHtml, /图片信息/)
assert.doesNotMatch(draftHtml, /已帮你整理出 1 条睡眠记录/)
assert.doesNotMatch(draftHtml, /查看并保存/)

const invalidatedHtml = renderToStaticMarkup(
  React.createElement(CheckInInline, {
    output: {
      action: 'draft_created',
      checkInCardId: '22222222-2222-4222-8222-222222222222',
      status: 'invalidated',
      draftSchema: {
        version: 1,
        kind: 'check_in_card',
        categoryKey: 'sleep',
        categoryName: '睡眠记录',
        displayMode: 'calendar',
        titleTemplate: '睡眠记录',
        aliases: ['睡眠'],
        fields: [
          { key: 'sleep_hours', label: '睡眠时长', type: 'number', unit: '小时' },
        ],
        layout: [],
      },
      draftValues: { sleep_hours: 6 },
      draftAttachments: [],
      message: '已生成打卡卡片草稿,等待用户在卡片里核对并保存。',
    },
  }),
)
assert.match(invalidatedHtml, /已失效/)
assert.doesNotMatch(invalidatedHtml, /保存打卡/)
assert.doesNotMatch(invalidatedHtml, /取消/)

console.log('check-in tool output visibility tests passed')
