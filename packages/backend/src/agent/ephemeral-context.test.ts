import assert from 'node:assert/strict'
import test from 'node:test'
import {
  appendEphemeralContextsToLatestUser,
  prependContextsToUserContent,
  shouldAppendMemoryRecallEphemerally,
  shouldPersistMemoryRecallContext,
} from './ephemeral-context.js'
import type { LLMMessage } from '../api/types.js'

test('memory recall context is injected into system reminder so user input stays last', () => {
  const messages: LLMMessage[] = [
    { role: 'system', content: 'profile memory' },
    { role: 'user', content: '我最近睡不好' },
  ]

  const result = appendEphemeralContextsToLatestUser(messages, [
    '<memory-context>\n历史记忆\n</memory-context>',
  ])

  assert.equal(messages[1].content, '我最近睡不好')
  assert.notEqual(result, messages)
  assert.equal(
    result[1].content,
    '<system-reminder>\n<memory-context>\n历史记忆\n</memory-context>\n</system-reminder>\n\n我最近睡不好',
  )
})

test('memory recall context is appended inside existing system reminder', () => {
  const messages: LLMMessage[] = [
    { role: 'user', content: '<system-reminder>\n当前时间\n</system-reminder>\n\n我喜欢喝啥' },
  ]

  const result = appendEphemeralContextsToLatestUser(messages, [
    '<memory-context>\n历史记忆\n</memory-context>',
  ])

  assert.equal(
    result[0].content,
    '<system-reminder>\n当前时间\n\n<memory-context>\n历史记忆\n</memory-context>\n</system-reminder>\n\n我喜欢喝啥',
  )
})

test('persisted memory recall content uses the same reminder-contained memory order', () => {
  const result = prependContextsToUserContent(
    '<system-reminder>\n当前时间\n</system-reminder>\n\n用户真实问题',
    ['<memory-context>\n召回记忆\n</memory-context>'],
  )

  assert.equal(
    result,
    '<system-reminder>\n当前时间\n\n<memory-context>\n召回记忆\n</memory-context>\n</system-reminder>\n\n用户真实问题',
  )
})

test('memory recall persist flag maps to payload and persistence behavior', () => {
  assert.equal(shouldAppendMemoryRecallEphemerally(true), false)
  assert.equal(shouldPersistMemoryRecallContext(true), true)

  assert.equal(shouldAppendMemoryRecallEphemerally(false), true)
  assert.equal(shouldPersistMemoryRecallContext(false), false)
})
