import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildChatHistorySearchResults,
  buildChatHistorySearchResultsFromTurns,
  formatSearchChatHistoryOutput,
  normalizeSearchChatHistoryArgs,
  SearchChatHistoryUserError,
  type ChatHistoryCandidateForSearch,
  type ChatHistoryMessageForSearch,
  type ChatHistorySessionMeta,
  type TurnSearchRow,
} from './chat-history-search.js'
import { SYNTHETIC_TOOL_ATTACHMENT_MARKER } from '../utils/repeated-user-message.js'

function at(value: string): Date {
  return new Date(value)
}

const SESSION_META: ChatHistorySessionMeta = {
  sessionId: 's-1',
  title: '饮食记录',
  startedAt: at('2026-05-12T01:00:00.000Z'),
  updatedAt: at('2026-05-12T03:00:00.000Z'),
}

function resultFor(
  candidates: ChatHistoryCandidateForSearch[],
  rows: ChatHistoryMessageForSearch[],
  limit = 5,
) {
  return buildChatHistorySearchResults(
    candidates,
    new Map([['s-1', rows]]),
    new Map([['s-1', SESSION_META]]),
    limit,
  )
}

test('buildChatHistorySearchResults rebuilds user to next assistant turn', () => {
  const rows: ChatHistoryMessageForSearch[] = [
    {
      id: 'u-1',
      sessionId: 's-1',
      role: 'user',
      content: `<system-reminder>\n当前时间：2026-05-12\n</system-reminder>\n\n我今天早餐一碗无糖豆腐脑加两个鸡蛋`,
      createdAt: at('2026-05-12T01:10:00.000Z'),
    },
    {
      id: 'a-1',
      sessionId: 's-1',
      role: 'assistant',
      content: '这个早餐蛋白质比较足，可以继续观察饱腹感。',
      createdAt: at('2026-05-12T01:10:05.000Z'),
    },
  ]

  const results = resultFor([
    { messageId: 'u-1', sessionId: 's-1', role: 'user', matchedAt: rows[0].createdAt },
  ], rows)

  assert.equal(results.length, 1)
  assert.equal(results[0].user, '我今天早餐一碗无糖豆腐脑加两个鸡蛋')
  assert.equal(results[0].assistant, '这个早餐蛋白质比较足，可以继续观察饱腹感。')
  assert.equal(results[0].sessionTitle, '饮食记录')
})

test('buildChatHistorySearchResults rebuilds assistant hit to previous real user and skips synthetic user', () => {
  const rows: ChatHistoryMessageForSearch[] = [
    {
      id: 'u-1',
      sessionId: 's-1',
      role: 'user',
      content: '昨天那份病理报告帮我看下',
      createdAt: at('2026-05-12T01:10:00.000Z'),
    },
    {
      id: 'synthetic-1',
      sessionId: 's-1',
      role: 'user',
      content: `${SYNTHETIC_TOOL_ATTACHMENT_MARKER}\n<tool-attachment-meta>{"docs":[]}</tool-attachment-meta>`,
      createdAt: at('2026-05-12T01:10:03.000Z'),
    },
    {
      id: 'a-1',
      sessionId: 's-1',
      role: 'assistant',
      content: '报告里 ER 是阳性，HER2 1+ 通常按阴性看。',
      createdAt: at('2026-05-12T01:10:05.000Z'),
    },
  ]

  const results = resultFor([
    { messageId: 'a-1', sessionId: 's-1', role: 'assistant', matchedAt: rows[2].createdAt },
  ], rows)

  assert.equal(results.length, 1)
  assert.equal(results[0].user, '昨天那份病理报告帮我看下')
  assert.match(results[0].assistant, /HER2 1\+/)
})

test('buildChatHistorySearchResults dedupes multiple hits in the same turn and respects limit', () => {
  const rows: ChatHistoryMessageForSearch[] = [
    { id: 'u-1', sessionId: 's-1', role: 'user', content: '早餐吃了豆腐脑', createdAt: at('2026-05-12T01:00:00.000Z') },
    { id: 'a-1', sessionId: 's-1', role: 'assistant', content: '豆腐脑可以。', createdAt: at('2026-05-12T01:00:05.000Z') },
    { id: 'u-2', sessionId: 's-1', role: 'user', content: '中午吃了鸡肉', createdAt: at('2026-05-12T02:00:00.000Z') },
    { id: 'a-2', sessionId: 's-1', role: 'assistant', content: '鸡肉建议去皮。', createdAt: at('2026-05-12T02:00:05.000Z') },
  ]

  const results = resultFor([
    { messageId: 'a-2', sessionId: 's-1', role: 'assistant', matchedAt: rows[3].createdAt },
    { messageId: 'u-2', sessionId: 's-1', role: 'user', matchedAt: rows[2].createdAt },
    { messageId: 'u-1', sessionId: 's-1', role: 'user', matchedAt: rows[0].createdAt },
  ], rows, 2)

  assert.equal(results.length, 2)
  assert.equal(results[0].user, '中午吃了鸡肉')
  assert.equal(results[1].user, '早餐吃了豆腐脑')
})

test('normalizeSearchChatHistoryArgs clamps limit and validates date range', () => {
  assert.deepEqual(normalizeSearchChatHistoryArgs({
    pattern: '豆腐脑|鸡蛋',
    timeRange: { startDate: '2026-05-12', endDate: '2026-05-13' },
    title: ' 饮食 ',
    limit: 99,
  }), {
    pattern: '豆腐脑|鸡蛋',
    timeRange: { startDate: '2026-05-12', endDate: '2026-05-13' },
    title: '饮食',
    limit: 10,
  })

  assert.throws(
    () => normalizeSearchChatHistoryArgs({ pattern: '饮食', timeRange: { startDate: '2026-05-14', endDate: '2026-05-13' } }),
    SearchChatHistoryUserError,
  )
  assert.throws(
    () => normalizeSearchChatHistoryArgs({ pattern: '饮食', timeRange: { startDate: '2026-02-30' } }),
    SearchChatHistoryUserError,
  )
  assert.throws(
    () => normalizeSearchChatHistoryArgs({ pattern: '   ' }),
    SearchChatHistoryUserError,
  )
})

test('normalizeSearchChatHistoryArgs allows catch-all regex for range queries', () => {
  assert.equal(normalizeSearchChatHistoryArgs({ pattern: '.*' }).pattern, '.*')
})

test('buildChatHistorySearchResultsFromTurns returns complete matched turns', () => {
  const rows: TurnSearchRow[] = [
    {
      session_id: 's-1',
      session_title: '昨日聊天',
      session_started_at: at('2026-05-13T01:00:00.000Z'),
      session_updated_at: at('2026-05-13T01:30:00.000Z'),
      user_message_id: 'u-1',
      user_content: `<system-reminder>\n提醒\n</system-reminder>\n\n昨天我们说了啥，最后一句话是什么`,
      user_created_at: at('2026-05-13T01:10:00.000Z'),
      assistant_message_id: 'a-1',
      assistant_content: '最后一句是：我们明天继续看饮食记录。',
      assistant_created_at: at('2026-05-13T01:10:05.000Z'),
    },
  ]

  const results = buildChatHistorySearchResultsFromTurns(rows)

  assert.equal(results.length, 1)
  assert.equal(results[0].sessionTitle, '昨日聊天')
  assert.equal(results[0].user, '昨天我们说了啥，最后一句话是什么')
  assert.equal(results[0].assistant, '最后一句是：我们明天继续看饮食记录。')
})

test('buildChatHistorySearchResultsFromTurns keeps image placeholders without leaking image urls', () => {
  const imageUrl = 'https://example.com/meal.jpg'
  const rows: TurnSearchRow[] = [
    {
      session_id: 's-1',
      session_title: '午餐记录',
      session_started_at: at('2026-05-14T07:50:00.000Z'),
      session_updated_at: at('2026-05-14T07:56:00.000Z'),
      user_message_id: 'u-1',
      user_content: JSON.stringify([
        { type: 'text', text: '你觉得我今天中午吃的这些怎么样？' },
        { type: 'image_url', image_url: { url: imageUrl } },
      ]),
      user_created_at: at('2026-05-14T07:56:37.000Z'),
      assistant_message_id: 'a-1',
      assistant_content: '看起来是卤肉饭配炸鸡腿。',
      assistant_created_at: at('2026-05-14T07:56:40.000Z'),
    },
    {
      session_id: 's-1',
      session_title: '午餐记录',
      session_started_at: at('2026-05-14T07:50:00.000Z'),
      session_updated_at: at('2026-05-14T07:57:00.000Z'),
      user_message_id: 'u-2',
      user_content: JSON.stringify([
        { type: 'image_url', image_url: { url: 'https://example.com/report.jpg' } },
      ]),
      user_created_at: at('2026-05-14T07:57:00.000Z'),
      assistant_message_id: 'a-2',
      assistant_content: '我看到了你发的图片。',
      assistant_created_at: at('2026-05-14T07:57:03.000Z'),
    },
  ]

  const results = buildChatHistorySearchResultsFromTurns(rows)

  assert.equal(results.length, 2)
  assert.equal(results[0].user, '[image]\n你觉得我今天中午吃的这些怎么样？')
  assert.equal(results[1].user, '[image]')
  assert.doesNotMatch(results[0].user, /example\.com/)
})

test('formatSearchChatHistoryOutput returns concise plain text without JSON metadata', () => {
  const { output, truncated } = formatSearchChatHistoryOutput([
    {
      sessionTitle: '昨日聊天',
      sessionStartedAt: '2026-05-13T01:00:00.000Z',
      sessionEndedAt: '2026-05-13T01:30:00.000Z',
      turnTime: '2026-05-13T01:10:00.000Z',
      user: '昨天我们说了啥',
      assistant: '最后一句是：我们明天继续看饮食记录。',
      truncated: false,
    },
  ])

  assert.equal(truncated, false)
  assert.match(output, /原始对话标题：昨日聊天/)
  assert.match(output, /原始对话时间：2026\/05\/13 09:10:00/)
  assert.match(output, /用户问题：\n昨天我们说了啥/)
  assert.match(output, /AI回复：\n最后一句是/)
  assert.doesNotMatch(output, /"success"/)
  assert.doesNotMatch(output, /"query"/)
  assert.doesNotMatch(output, /"results"/)
})

test('formatSearchChatHistoryOutput returns a short miss message and enforces total budget', () => {
  assert.equal(formatSearchChatHistoryOutput([]).output, '没有找到匹配的历史对话。')

  const { output, truncated } = formatSearchChatHistoryOutput([
    {
      sessionTitle: '长对话',
      sessionStartedAt: '2026-05-13T01:00:00.000Z',
      sessionEndedAt: '2026-05-13T01:30:00.000Z',
      turnTime: '2026-05-13T01:10:00.000Z',
      user: '用户'.repeat(100),
      assistant: '回复'.repeat(100),
      truncated: false,
    },
  ], 80)

  assert.equal(truncated, true)
  assert.ok(output.length > 0)
  assert.match(output, /已截断/)
})
