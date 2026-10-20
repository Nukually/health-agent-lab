import assert from 'node:assert/strict'
import test from 'node:test'
import type { ChatMessage } from '../state/session.js'
import {
  areLatestTwoRealUserMessagesIdentical,
  countRealUserMessages,
  extractLatestRealUserMessageText,
  findLatestRealUserMessageIndex,
  hasSyntheticHiddenUserMarker,
  hasSyntheticToolAttachmentMarker,
  SYNTHETIC_SCHEDULED_TODO_TRIGGER_MARKER,
  SYNTHETIC_TOOL_ATTACHMENT_MARKER,
} from './repeated-user-message.js'

function user(content: ChatMessage['content']): ChatMessage {
  return { role: 'user', content }
}

function assistant(content: string): ChatMessage {
  return { role: 'assistant', content }
}

test('detects consecutive identical real user text messages after stripping reminders', () => {
  const messages: ChatMessage[] = [
    user('帮我整理一张卡片'),
    assistant('好的'),
    user(`<system-reminder>\n当前时间\n</system-reminder>\n\n帮我整理一张卡片`),
  ]

  assert.equal(areLatestTwoRealUserMessagesIdentical(messages), true)
})

test('does not treat different image payloads as identical', () => {
  const messages: ChatMessage[] = [
    user([
      { type: 'text', text: '看一下这张图' },
      { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
    ]),
    assistant('好的'),
    user([
      { type: 'text', text: '看一下这张图' },
      { type: 'image_url', image_url: { url: 'https://example.com/b.png' } },
    ]),
  ]

  assert.equal(areLatestTwoRealUserMessagesIdentical(messages), false)
})

test('skips synthetic tool-attachment user messages', () => {
  const messages: ChatMessage[] = [
    user('原问题'),
    assistant('需要读取文档'),
    user(`<system-reminder>\n${SYNTHETIC_TOOL_ATTACHMENT_MARKER}\n</system-reminder>`),
  ]

  assert.equal(findLatestRealUserMessageIndex(messages), 0)
  assert.equal(extractLatestRealUserMessageText(messages), '原问题')
  assert.equal(countRealUserMessages(messages), 1)
})

test('skips scheduled todo trigger messages without treating them as tool attachments', () => {
  const messages: ChatMessage[] = [
    user('原问题'),
    assistant('已安排跟练'),
    user(`<system-reminder>\n${SYNTHETIC_SCHEDULED_TODO_TRIGGER_MARKER}\n[todo:scheduled_session]\n</system-reminder>\n\n到点了，请带我完成这次跟练。`),
  ]

  assert.equal(hasSyntheticHiddenUserMarker(messages[2]!.content as string), true)
  assert.equal(hasSyntheticToolAttachmentMarker(messages[2]!.content as string), false)
  assert.equal(findLatestRealUserMessageIndex(messages), 0)
  assert.equal(extractLatestRealUserMessageText(messages), '原问题')
  assert.equal(countRealUserMessages(messages), 1)
})
