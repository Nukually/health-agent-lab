import assert from 'node:assert/strict'
import test from 'node:test'
import { getToolUiMeta, TOOL_UI_MANIFEST } from '../src/constants/tools.js'

test('risk grading tool UI metadata displays as risk grading', () => {
  assert.equal(TOOL_UI_MANIFEST.grade_medical_risk.title, '风险分级')
  assert.equal(TOOL_UI_MANIFEST.grade_medical_risk.renderKind, 'default')
  assert.equal(getToolUiMeta('grade_medical_risk').activeLabel, '风险分级中...')
  assert.equal(TOOL_UI_MANIFEST.generate_plan.title, '生成干预方案')
  assert.equal(getToolUiMeta('generate_plan').activeLabel, '方案生成中...')
  assert.equal(TOOL_UI_MANIFEST.medical_literature_search.title, '检索医学资料')
  assert.equal(getToolUiMeta('medical_literature_search').activeLabel, '医学资料检索中...')
})

test('check-in schema lookup displays as getting a check-in template', () => {
  assert.equal(TOOL_UI_MANIFEST.get_check_in_schema.title, '获取打卡模板')
  assert.equal(TOOL_UI_MANIFEST.get_check_in_schema.renderKind, 'default')
  assert.equal(getToolUiMeta('get_check_in_schema').activeLabel, '获取打卡模板中...')
  assert.equal(getToolUiMeta('get_check_in_schema').doneLabel, '已获取打卡模板')
})

test('todos tool UI metadata displays as todo plan tracking', () => {
  assert.equal(TOOL_UI_MANIFEST.todos.title, '任务跟练')
  assert.equal(TOOL_UI_MANIFEST.todos.renderKind, 'todos')
  assert.equal(getToolUiMeta('todos').doneLabel, '已处理跟练任务')
})
