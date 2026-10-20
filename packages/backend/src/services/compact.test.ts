import assert from 'node:assert/strict'
import test from 'node:test'
import type { ChatMessage } from '../state/session.js'
import { buildCompactionMemoryReviewMessages, buildCompactionPrompt } from './compact.js'

test('buildCompactionPrompt preserves durable background and preference section', () => {
  const messages: ChatMessage[] = [
    { role: 'user', content: '我长期睡眠不好，请以后尽量回答得简短一点' },
    { role: 'assistant', content: '我会尽量简洁，并关注你的睡眠问题。' },
  ]

  const prompt = buildCompactionPrompt(null, messages)

  assert.match(prompt, /以下五个维度/)
  assert.match(prompt, /### 持续性背景与偏好/)
  assert.match(prompt, /长期背景/)
  assert.match(prompt, /沟通偏好/)
})

test('buildCompactionMemoryReviewMessages keeps user and assistant text for reviewer', () => {
  const messages: ChatMessage[] = [
    { role: 'system', content: 'system' },
    { role: 'user', content: '我最近睡眠不好', dbId: 'user-1' },
    { role: 'tool', content: '{"ok":true}' },
    { role: 'assistant', content: '先记录睡眠情况。' },
  ]

  assert.deepEqual(buildCompactionMemoryReviewMessages(messages), [
    { role: 'user', content: '我最近睡眠不好', dbId: 'user-1' },
    { role: 'assistant', content: '先记录睡眠情况。', dbId: undefined },
  ])
})
