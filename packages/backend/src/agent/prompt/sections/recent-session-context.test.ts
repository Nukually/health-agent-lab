import assert from 'node:assert/strict'
import test from 'node:test'
import { recentSessionContext } from './recent-session-context.js'

test('recentSessionContext renders recent session metadata only', () => {
  const prompt = recentSessionContext({
    stats: {
      todayCount: 3,
      yesterdayCount: 5,
      thisWeekCount: 13,
    },
    sessions: [
      {
        id: 's-1',
        title: '饮食记录',
        userTurnCount: 3,
        startedAt: '2026-05-12T01:00:00.000Z',
      },
    ],
  })

  assert.match(prompt, /最近历史会话/)
  assert.match(prompt, /今日已进行了3个session对话，昨日5个session对话，本周一共13个session对话/)
  assert.match(prompt, /饮食记录｜交互轮次 3/)
  assert.match(prompt, /2026\/05\/12 09:00/)
  assert.doesNotMatch(prompt, /09:00:00/)
  assert.doesNotMatch(prompt, /11:00/)
  assert.match(prompt, /search_chat_history/)
  assert.doesNotMatch(prompt, /用户提问/)
  assert.doesNotMatch(prompt, /AI 回复/)
})

test('recentSessionContext returns empty string without sessions', () => {
  assert.equal(recentSessionContext({ stats: { todayCount: 0, yesterdayCount: 0, thisWeekCount: 0 }, sessions: [] }), '')
  assert.equal(recentSessionContext(null), '')
})
