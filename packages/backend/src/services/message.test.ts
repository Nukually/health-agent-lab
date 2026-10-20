import assert from 'node:assert/strict'
import test from 'node:test'
import { findEditTruncationCutoffIndex } from './message.js'
import { SYNTHETIC_TOOL_ATTACHMENT_MARKER } from '../utils/repeated-user-message.js'

const u = (content = 'hi') => ({ role: 'user', content })
const a = (content = 'ok') => ({ role: 'assistant', content })
const synthUser = () => ({ role: 'user', content: `${SYNTHETIC_TOOL_ATTACHMENT_MARKER}\n原图` })

// 典型多轮：U1 A1 U2 A2 U3 A3 —— 3 条真实 user 轮次
const conversation = [u('U1'), a('A1'), u('U2'), a('A2'), u('U3'), a('A3')]

test('N=1 命中最新一条 user 消息（编辑最新一轮）', () => {
  // U3 在下标 4
  assert.equal(findEditTruncationCutoffIndex(conversation, 1), 4)
})

test('N=2 命中倒数第二条 user 消息', () => {
  // U2 在下标 2
  assert.equal(findEditTruncationCutoffIndex(conversation, 2), 2)
})

test('N=3 命中最早一条 user 消息', () => {
  // U1 在下标 0
  assert.equal(findEditTruncationCutoffIndex(conversation, 3), 0)
})

test('真实 user 轮次不足 N 时返回 -1', () => {
  assert.equal(findEditTruncationCutoffIndex(conversation, 4), -1)
})

test('N<1 视为非法返回 -1', () => {
  assert.equal(findEditTruncationCutoffIndex(conversation, 0), -1)
})

test('计数跳过 synthetic user（saved_content 病历原图气泡）', () => {
  // U1 A1 [syntheticUser] A2(带原图回答) U2 A3
  // 真实 user 只有 U1(下标0)、U2(下标4)
  const rows = [u('U1'), a('A1'), synthUser(), a('A2'), u('U2'), a('A3')]
  // N=1 → U2 在下标 4
  assert.equal(findEditTruncationCutoffIndex(rows, 1), 4)
  // N=2 → U1 在下标 0（中间 synthetic 不计数）
  assert.equal(findEditTruncationCutoffIndex(rows, 2), 0)
  // 只有 2 条真实 user，N=3 → -1
  assert.equal(findEditTruncationCutoffIndex(rows, 3), -1)
})

test('空会话返回 -1', () => {
  assert.equal(findEditTruncationCutoffIndex([], 1), -1)
})
