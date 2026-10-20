import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isAskUserQuestionOptionSelected,
  parseAskUserQuestionAnswerMap,
} from '../src/components/chat/askUserQuestionTimeline.js'

test('parses multi-question answer text into a question→answer map', () => {
  const text = 'Q: 你更倾向哪种强度的方案？\nA: 复杂方案（ref_id: 1-5）\n\nQ: 关节痛具体部位？\nA: 手指'
  const map = parseAskUserQuestionAnswerMap(text)
  assert.equal(map.get('你更倾向哪种强度的方案？'), '复杂方案（ref_id: 1-5）')
  assert.equal(map.get('关节痛具体部位？'), '手指')
})

test('returns empty map for blank input', () => {
  assert.equal(parseAskUserQuestionAnswerMap('').size, 0)
  assert.equal(parseAskUserQuestionAnswerMap(null).size, 0)
})

test('matches selected option by ref_id then by label', () => {
  const answer = '复杂方案（ref_id: 1-5）'
  assert.equal(isAskUserQuestionOptionSelected({ label: '复杂方案', description: '', ref_id: '1-5' }, answer), true)
  assert.equal(isAskUserQuestionOptionSelected({ label: '温和方案', description: '', ref_id: '1-3' }, answer), false)
  // 无 ref_id 时按 label 包含（多选用「、」连接）
  assert.equal(isAskUserQuestionOptionSelected({ label: '手指', description: '' }, '手指、手腕'), true)
  assert.equal(isAskUserQuestionOptionSelected({ label: '脚趾', description: '' }, '手指、手腕'), false)
})
