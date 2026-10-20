import assert from 'node:assert/strict'
import test from 'node:test'
import type { CommunicationCardRecord } from '@health-agent/shared'
import { renderCommunicationCardMarkdown } from './communication-card.js'

function record(): CommunicationCardRecord {
  return {
    id: 'card-1',
    userId: 'user-1',
    title: '下周复诊沟通卡（腹泻与用药调整）',
    cardDate: '2026-05-15',
    templateVersion: 2,
    sourceSessionId: 'session-1',
    contentJson: {
      draft: {
        title: '下周复诊沟通卡（腹泻与用药调整）',
        cardDate: '2026-05-15',
        visitPurpose: '确认腹泻是否和当前用药有关。',
        currentSituation: '| 重点 | 情况 |\n| --- | --- |\n| 最近变化 | 腹泻增多 |',
        informationForDoctor: '- 近期检查报告\n- 当前用药清单',
        questionsForDoctor: '是否需要调整阿贝西利剂量？',
      },
      aiDraft: {
        title: '下周复诊沟通卡（腹泻与用药调整）',
        cardDate: '2026-05-15',
        visitPurpose: '确认腹泻是否和当前用药有关。',
      },
      fieldSources: {
        title: 'ai',
        cardDate: 'ai',
        visitPurpose: 'ai',
        currentSituation: 'ai',
        informationForDoctor: 'ai',
        questionsForDoctor: 'user',
      },
      sourceToolCallId: 'call-1',
    },
    createdAt: '2026-05-15T00:00:00.000Z',
    updatedAt: '2026-05-15T00:00:00.000Z',
  }
}

test('communication card markdown renders v2 headings and folds legacy questions', () => {
  const markdown = renderCommunicationCardMarkdown(record())

  assert.match(markdown, /## 就诊目标/)
  assert.match(markdown, /## 我的情况/)
  assert.match(markdown, /## 这次建议带上/)
  assert.match(markdown, /想问医生的问题：\n是否需要调整阿贝西利剂量？/)
  assert.doesNotMatch(markdown, /## 我的问题/)
})
