import assert from 'node:assert/strict'
import test from 'node:test'
import { savedInterventionMaterialsContext } from './saved-intervention-material-context.js'
import type { SavedInterventionMaterialPromptSummary } from '../../../services/intervention-material-engagement.js'
import type { InterventionRuntimeCatalogSnapshot } from '../../../services/intervention-material-runtime.js'

const catalog: InterventionRuntimeCatalogSnapshot = {
  targetEnv: 'sit',
  version: 'test',
  groups: [
    {
      sideEffect: '恶心呕吐',
      items: [
        {
          code: '2-2',
          materialId: 'mat-2-2',
          version: 'v1',
          sideEffect: '恶心呕吐',
          scene: '餐后不适',
          actionName: '餐后缓解跟练',
        },
      ],
    },
  ],
  codeMap: new Map([
    ['2-2', {
      code: '2-2',
      materialId: 'mat-2-2',
      version: 'v1',
      sideEffect: '恶心呕吐',
      scene: '餐后不适',
      actionName: '餐后缓解跟练',
    }],
  ]),
}

test('saved intervention material context renders saved and follow status', () => {
  const summary: SavedInterventionMaterialPromptSummary = {
    totalCount: 1,
    items: [
      {
        materialCode: '2-2',
        materialId: 'mat-2-2',
        materialVersion: 'v1',
        savedAt: '2026-04-25T02:00:00.000Z',
        followStartedAt: '2026-04-25T03:00:00.000Z',
        lastFollowedAt: '2026-04-25T03:08:00.000Z',
        followCompletedAt: null,
        totalFollowSec: 125,
        completedStepCount: 2,
        totalStepCount: 4,
      },
    ],
  }

  const text = savedInterventionMaterialsContext(summary, catalog)

  assert.match(text, /同一干预方案 code 只应保存一张跟练卡/)
  assert.match(text, /\[2-2\] 《餐后缓解跟练》｜恶心呕吐 \/ 餐后不适/)
  assert.match(text, /最近跟练：2026-04-25 11:08/)
  assert.match(text, /进度：2\/4/)
})

test('saved intervention material context renders empty state', () => {
  const text = savedInterventionMaterialsContext(null, catalog)

  assert.match(text, /总数：0 张/)
  assert.match(text, /当前暂无已保存跟练卡/)
})
