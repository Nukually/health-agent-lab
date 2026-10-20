import assert from 'node:assert/strict'
import test from 'node:test'
import { deriveStatus, buildAssistantAnalysisContent } from './efficacy-records.js'

// deriveStatus 是状态机核心：把采纳/疗效/节律映射到 生效中(active)/未生效(stale)/结束(closed)。
// 废弃(discarded) 只由 cron 老化/超额触发，deriveStatus 不产出它。

test('deriveStatus: 拒绝一律结束', () => {
  assert.equal(deriveStatus('rejected', 'no_feedback', 'oneshot'), 'closed')
  assert.equal(deriveStatus('rejected', 'improved', 'periodic'), 'closed')
})

test('deriveStatus: 一次性方案有任何效果反馈即结束', () => {
  assert.equal(deriveStatus('adopted', 'improved', 'oneshot'), 'closed')
  assert.equal(deriveStatus('adopted', 'unchanged', 'oneshot'), 'closed')
  assert.equal(deriveStatus('adopted', 'worsened', 'oneshot'), 'closed')
  assert.equal(deriveStatus('partial', 'improved', 'oneshot'), 'closed')
})

test('deriveStatus: 一次性方案无反馈仍生效中', () => {
  assert.equal(deriveStatus('adopted', 'no_feedback', 'oneshot'), 'active')
  assert.equal(deriveStatus('partial', 'no_feedback', 'oneshot'), 'active')
})

test('deriveStatus: 未采纳=未生效(stale)，与节律/效果无关', () => {
  assert.equal(deriveStatus('unknown', 'no_feedback', 'oneshot'), 'stale')
  assert.equal(deriveStatus('unknown', 'no_feedback', 'periodic'), 'stale')
})

test('deriveStatus: 采纳的周期性方案始终生效中（含变差/无变化，需持续跟）', () => {
  assert.equal(deriveStatus('adopted', 'no_feedback', 'periodic'), 'active')
  assert.equal(deriveStatus('adopted', 'improved', 'periodic'), 'active')
  assert.equal(deriveStatus('adopted', 'unchanged', 'periodic'), 'active')
  assert.equal(deriveStatus('adopted', 'worsened', 'periodic'), 'active')
  assert.equal(deriveStatus('partial', 'worsened', 'periodic'), 'active')
})

// buildAssistantAnalysisContent 还原喂给疗效分析的 assistant 完整正文。
// 新前端交互下 content 列只剩收尾轮，AI 方案正文落在 rawResponse.processTimeline 的 text 节点，
// 必须还原回来，否则疗效抽取读不到 AI 方案。

test('buildAssistantAnalysisContent: 还原 timeline 中间叙述并拼上收尾正文', () => {
  const raw = {
    processTimeline: [
      { type: 'text', content: '根据你化疗后的恶心，我建议每天少量多餐 + 生姜茶。', timestamp: 1 },
      { type: 'tool_call', name: 'generate_plan', isActive: false, timestamp: 2 },
      { type: 'text', content: '我已为你整理了三个跟练方案供选择。', timestamp: 3 },
    ],
  }
  const result = buildAssistantAnalysisContent('以上就是推荐方案，记得坚持。', raw)
  assert.match(result, /少量多餐/)
  assert.match(result, /三个跟练方案/)
  assert.match(result, /以上就是推荐方案/)
})

test('buildAssistantAnalysisContent: 无 processTimeline 的旧消息回退 content 列', () => {
  assert.equal(buildAssistantAnalysisContent('纯文本回答', {}), '纯文本回答')
  assert.equal(buildAssistantAnalysisContent('纯文本回答', null), '纯文本回答')
})

test('buildAssistantAnalysisContent: 相邻重复正文去重', () => {
  const raw = {
    processTimeline: [
      { type: 'text', content: '重复内容', timestamp: 1 },
      { type: 'text', content: '重复内容', timestamp: 2 },
    ],
  }
  // content 列与最后一个 text 节点相同也去重，避免堆叠
  const result = buildAssistantAnalysisContent('重复内容', raw)
  assert.equal(result, '重复内容')
})
