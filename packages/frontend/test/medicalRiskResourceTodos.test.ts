import assert from 'node:assert/strict'
import test from 'node:test'

;(globalThis as typeof globalThis & { localStorage?: Storage }).localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
  clear: () => {},
  key: () => null,
  length: 0,
}

const { collectMedicalRiskResources } = await import('../src/components/chat/AssistantMessage.js')

test('collectMedicalRiskResources adds todo context from a created plan resource ref', () => {
  const resources = collectMedicalRiskResources([
    {
      name: 'generate_plan',
      toolCallId: 'generate-1',
      input: null,
      output: {
        kind: 'medical_risk_resources',
        resources: [{
          id: '1-2',
          kind: 'video_resource',
          title: '20分钟手指操,缓解关节晨僵',
          difficulty: 'simple',
          url: 'https://example.com/video',
          providerVideoId: 'BV123',
          publishedAt: null,
          durationSec: 76,
          thumbnailUrl: null,
          snippet: '握拳平掌、对指锻炼等基础动作。',
          sourceQuery: '晨僵 手指',
        }],
      },
    },
    {
      name: 'todos',
      toolCallId: 'todos-1',
      input: null,
      output: {
        kind: 'todos',
        action: 'create',
        message: '已创建跟练计划',
        plan: {
          id: 'plan-1',
          title: '手指晨僵 3天跟练',
          status: 'not_started',
          sourceType: 'video_resource',
          sourceId: null,
          resourceRefId: '1-2',
          courseDays: 3,
          targetSideEffect: '手指晨僵',
          todos: [
            {
              id: 'todo-1',
              date: '2026-06-02',
              time: '07:00',
              showPrompt: '早安，今天开始跟练。',
              prompt: '',
              status: 'pending',
              feedback: null,
            },
          ],
        },
      },
    },
  ])

  assert.deepEqual(resources.get('1-2')?.resource.todoContext, {
    planId: 'plan-1',
    todoId: 'todo-1',
    feedback: null,
    status: 'pending',
  })
})
