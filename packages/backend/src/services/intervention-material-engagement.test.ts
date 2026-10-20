import assert from 'node:assert/strict'
import test from 'node:test'
import { parseInterventionMaterialToolOutput } from '@health-agent/shared'
import { buildInterventionEngagementReminderLine } from './intervention-material-engagement.js'

test('renders no-click intervention reminder when follow has not started', () => {
  const line = buildInterventionEngagementReminderLine({
    materialCode: '1-1',
    followStartedAt: null,
    totalFollowSec: 0,
  })

  assert.equal(line, '- 干预方案 1-1：用户未点击跟练卡片。')
})

test('renders saved intervention reminder when follow has not started', () => {
  const line = buildInterventionEngagementReminderLine({
    materialCode: '1-1',
    savedAt: new Date('2026-04-25T09:00:00Z'),
    followStartedAt: null,
    totalFollowSec: 0,
  })

  assert.equal(line, '- 干预方案 1-1：用户已保存到我的跟练卡，但尚未开始跟练。')
})

test('renders clicked intervention reminder with followed seconds', () => {
  const line = buildInterventionEngagementReminderLine({
    materialCode: '1-1',
    followStartedAt: new Date('2026-04-25T10:00:00Z'),
    totalFollowSec: 42,
  })

  assert.equal(line, '- 干预方案 1-1：用户点击了卡片跟练，并跟练了 42s。')
})

test('intervention tool output keeps client progress snapshot', () => {
  const parsed = parseInterventionMaterialToolOutput({
    kind: 'intervention_material',
    code: '1-1',
    materialId: 'material-1',
    version: 'v1',
    sideEffect: '恶心',
    scene: '呕吐后',
    actionName: '坐位恢复',
    overview: {
      totalDurationSec: 80,
      prepareItems: [],
      precheckQuestion: '',
      feedbackQuestion: '',
      effectiveRule: '',
      fallbackAction: '',
      redFlags: [],
      safetyNote: '',
    },
    stepsMeta: [
      { stepIndex: 1, durationSec: 20, displayText: '坐稳' },
      { stepIndex: 2, durationSec: 20, displayText: '小口喝水' },
    ],
    stableAssetKeys: {
      overviewImageKey: 'overview.png',
      stepImageKeys: ['1.png', '2.png'],
      stepAudioKeys: ['1.mp3', '2.mp3'],
    },
    currentSignedUrls: {
      overviewImageUrl: 'https://example.com/overview.png',
      stepImageUrls: ['https://example.com/1.png', 'https://example.com/2.png'],
      stepAudioUrls: ['https://example.com/1.mp3', 'https://example.com/2.mp3'],
    },
    progress: {
      savedAt: null,
      viewedAt: '2026-05-09T06:00:00.000Z',
      followStartedAt: '2026-05-09T06:01:00.000Z',
      followCompletedAt: null,
      totalFollowSec: 20,
      completedStepCount: 1,
      totalStepCount: 2,
      lastStepIndex: 2,
    },
  })

  assert.equal(parsed?.progress?.totalFollowSec, 20)
  assert.equal(parsed?.progress?.completedStepCount, 1)
})
