import assert from 'node:assert/strict'
import test from 'node:test'
import { communicationCardsContext } from './communication-card-context.js'
import type { CommunicationCardPromptSummary } from '../../../services/communication-card.js'

function summaryOf(count: number): CommunicationCardPromptSummary {
  return {
    totalCount: count,
    cards: Array.from({ length: count }, (_, index) => ({
      id: `card-${index + 1}`,
      title: `第${index + 1}张`,
      updatedAt: new Date(Date.UTC(2026, 3, 28, 3, 0, 0) - index * 60_000).toISOString(),
      finalUpdatedBy: index % 2 === 0 ? 'ai' : 'user',
    })),
  }
}

test('communication card context indexes every card but previews only first five and last one', () => {
  const result = communicationCardsContext(summaryOf(8))

  assert.equal(result.cardIdMap.get('c-1'), 'card-1')
  assert.equal(result.cardIdMap.get('c-6'), 'card-6')
  assert.equal(result.cardIdMap.get('c-8'), 'card-8')
  assert.match(result.text, /卡片编号范围：c-1 到 c-8 都有效/)
  assert.match(result.text, /最近更新的 5 张 \+ 最早更新的 1 张/)
  assert.match(result.text, /\[c-5\] 《第5张》/)
  assert.match(result.text, /中间 2 张省略（c-6 到 c-7 仍可读取）/)
  assert.match(result.text, /\[c-8\] 《第8张》/)
  assert.doesNotMatch(result.text, /\[c-6\] 《第6张》/)
})

test('communication card context keeps prompt short for one hundred cards while mapping all ids', () => {
  const result = communicationCardsContext(summaryOf(100))

  assert.equal(result.cardIdMap.size, 100)
  assert.equal(result.cardIdMap.get('c-50'), 'card-50')
  assert.equal(result.cardIdMap.get('c-100'), 'card-100')
  assert.match(result.text, /卡片编号范围：c-1 到 c-100 都有效/)
  assert.match(result.text, /中间 94 张省略（c-6 到 c-99 仍可读取）/)
  assert.match(result.text, /\[c-100\] 《第100张》/)
  assert.doesNotMatch(result.text, /\[c-50\] 《第50张》/)
})
