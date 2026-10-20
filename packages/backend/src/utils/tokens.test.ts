import assert from 'node:assert/strict'
import test from 'node:test'
import type { ChatMessage } from '../state/session.js'
import { estimateMessageTokens, estimateTextTokens } from './tokens.js'

test('assistant token estimation ignores persisted whole-turn tokenCount', () => {
  const content = 'A'.repeat(800)
  const message: ChatMessage = {
    role: 'assistant',
    content,
    tokenCount: 22046,
  }

  assert.equal(estimateMessageTokens(message), estimateTextTokens(content))
})

test('assistant token estimation includes native tool_calls payload', () => {
  const content = '正在调用工具'
  const args = JSON.stringify({ note: 'B'.repeat(2000) })
  const toolCall = {
    id: 'call_123',
    type: 'function' as const,
    function: {
      name: 'saved_content',
      arguments: args,
    },
  }
  const message: ChatMessage = {
    role: 'assistant',
    content,
    toolCalls: [toolCall],
    tokenCount: 99999,
  }

  const expected = estimateTextTokens(content) + estimateTextTokens(JSON.stringify(toolCall))
  assert.equal(estimateMessageTokens(message), expected)
})

test('non-assistant messages still prefer persisted tokenCount', () => {
  const message: ChatMessage = {
    role: 'tool',
    content: '很长很长的工具输出'.repeat(500),
    tokenCount: 321,
  }

  assert.equal(estimateMessageTokens(message), 321)
})
