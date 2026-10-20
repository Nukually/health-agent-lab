import assert from 'node:assert/strict'
import test from 'node:test'
import { parseMedicalRiskToolOutput } from '../src/types/intervention-material.js'

test('parseMedicalRiskToolOutput preserves todo context on video resources', () => {
  const parsed = parseMedicalRiskToolOutput({
    kind: 'medical_risk_resources',
    resources: [{
      id: 'todo-resource',
      kind: 'video_resource',
      title: '2分钟手指操视频',
      url: 'https://example.com/video',
      providerVideoId: 'BV123',
      publishedAt: null,
      durationSec: 120,
      thumbnailUrl: null,
      snippet: '短视频跟练',
      sourceQuery: '手指晨僵',
      todoContext: {
        planId: 'plan-1',
        todoId: 'todo-1',
        scheduledMessageId: 'schedule-1',
        feedback: null,
        isDone: false,
      },
    }],
  })

  assert.equal(parsed?.resources[0]?.kind, 'video_resource')
  assert.deepEqual(parsed?.resources[0]?.todoContext, {
    planId: 'plan-1',
    todoId: 'todo-1',
    scheduledMessageId: 'schedule-1',
    feedback: null,
    isDone: false,
  })
})
