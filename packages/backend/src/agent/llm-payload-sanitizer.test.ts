import assert from 'node:assert/strict'
import test from 'node:test'
import type { LLMMessage } from '../api/types.js'
import { sanitizeLLMPayloadMessages } from './llm-payload-sanitizer.js'

test('sanitizeLLMPayloadMessages leaves stable payload unchanged', () => {
  const messages: LLMMessage[] = [
    { role: 'user', content: '请看一下我的报告' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'call-1',
          type: 'function',
          function: { name: 'saved_content', arguments: '{"action":"read","id":"C-1"}' },
        },
      ],
    },
    { role: 'tool', content: '报告内容摘要', tool_call_id: 'call-1' },
  ]

  const result = sanitizeLLMPayloadMessages(messages)

  assert.equal(result.changed, false)
  assert.equal(result.messages, messages)
  assert.deepEqual(result.stats, {
    droppedInvalidRoleMessages: 0,
    removedOrphanToolResults: 0,
    insertedMissingToolResults: 0,
  })
})

test('sanitizeLLMPayloadMessages removes orphan tool results', () => {
  const messages = [
    { role: 'user', content: '你好' },
    { role: 'tool', content: '孤儿工具结果', tool_call_id: 'missing-call' },
  ] as LLMMessage[]

  const result = sanitizeLLMPayloadMessages(messages)

  assert.equal(result.changed, true)
  assert.equal(result.stats.removedOrphanToolResults, 1)
  assert.deepEqual(result.messages, [{ role: 'user', content: '你好' }])
})

test('sanitizeLLMPayloadMessages treats delayed tool results as orphaned', () => {
  const messages: LLMMessage[] = [
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'call-1',
          type: 'function',
          function: { name: 'saved_content', arguments: '{}' },
        },
      ],
    },
    { role: 'user', content: '先继续' },
    { role: 'tool', content: '迟到的工具结果', tool_call_id: 'call-1' },
  ]

  const result = sanitizeLLMPayloadMessages(messages)

  assert.equal(result.changed, true)
  assert.equal(result.stats.insertedMissingToolResults, 1)
  assert.equal(result.stats.removedOrphanToolResults, 1)
  assert.equal(result.messages[1].role, 'tool')
  assert.equal(result.messages[1].tool_call_id, 'call-1')
  assert.equal(result.messages[2], messages[1])
  assert.equal(result.messages.length, 3)
})

test('sanitizeLLMPayloadMessages inserts deterministic stub for missing tool result', () => {
  const messages: LLMMessage[] = [
    { role: 'user', content: '请读取材料' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'call-1',
          type: 'function',
          function: { name: 'saved_content', arguments: '{"action":"read","id":"C-1"}' },
        },
      ],
    },
    { role: 'user', content: '继续' },
  ]

  const result = sanitizeLLMPayloadMessages(messages)

  assert.equal(result.changed, true)
  assert.equal(result.stats.insertedMissingToolResults, 1)
  assert.equal(result.messages[2].role, 'tool')
  assert.equal(result.messages[2].tool_call_id, 'call-1')
  assert.match(result.messages[2].content as string, /^\[tool_result_unavailable:/)
  assert.equal(result.messages[3], messages[2])
})

test('sanitizeLLMPayloadMessages drops invalid roles before structural repair', () => {
  const messages = [
    { role: 'user', content: '你好' },
    { role: 'developer', content: '非法角色' },
  ] as unknown as LLMMessage[]

  const result = sanitizeLLMPayloadMessages(messages)

  assert.equal(result.changed, true)
  assert.equal(result.stats.droppedInvalidRoleMessages, 1)
  assert.deepEqual(result.messages, [{ role: 'user', content: '你好' }])
})
