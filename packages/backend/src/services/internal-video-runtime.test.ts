import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { InternalVideoCatalogEntry } from '@health-agent/shared'
import { selectMatchingInternalVideos, type InternalVideoRuntimeSnapshot } from './internal-video-runtime.js'

function entry(id: string, overrides: Partial<InternalVideoCatalogEntry>): InternalVideoCatalogEntry {
  return {
    id,
    version: 'v1',
    title: '',
    description: '',
    sourceRef: '',
    durationSec: 90,
    videoKey: `internal-videos/${id}/v1/video.mp4`,
    posterKey: `internal-videos/${id}/v1/poster.jpg`,
    tags: {
      difficulty: ['简易版'],
      bodyParts: [],
      severity: [],
      triggerScenes: [],
      conditions: [],
      environments: [],
    },
    ...overrides,
  }
}

const warmup = entry('iv-seated-warmup-multi-joint', {
  title: '坐姿热身：全身多关节活动准备',
  tags: {
    difficulty: ['简易版'],
    bodyParts: ['全身多关节', '膝关节', '髋关节', '肩颈部'],
    severity: ['轻微不适', '晨僵但活动后缓解'],
    triggerScenes: ['晨起后关节僵硬', '起床困难', '久坐后站起疼'],
    conditions: ['可坐位', '无需器械'],
    environments: ['家里'],
  },
})

const legRaise = entry('iv-seated-leg-raise', {
  title: '坐姿抬腿：膝关节与髋关节激活',
  tags: {
    difficulty: ['简易版'],
    bodyParts: ['膝关节', '髋关节'],
    severity: ['轻微不适'],
    triggerScenes: ['久坐后站起疼'],
    conditions: ['可坐位'],
    environments: ['家里'],
  },
})

function snapshot(entries: InternalVideoCatalogEntry[]): InternalVideoRuntimeSnapshot {
  return { targetEnv: 'dev', entries, byId: new Map(entries.map((e) => [e.id, e])) }
}

test('relevant scene query matches internal videos', () => {
  const matched = selectMatchingInternalVideos(snapshot([warmup, legRaise]), '久坐后站起疼 膝关节', 3)
  const ids = matched.map((m) => m.id)
  assert.ok(ids.includes('iv-seated-warmup-multi-joint'))
  assert.ok(ids.includes('iv-seated-leg-raise'))
})

test('morning stiffness query prefers the multi-joint warmup', () => {
  const matched = selectMatchingInternalVideos(snapshot([legRaise, warmup]), '晨起后关节僵硬 起床困难', 3)
  assert.equal(matched[0]?.id, 'iv-seated-warmup-multi-joint')
})

test('irrelevant symptom yields no internal video match', () => {
  const matched = selectMatchingInternalVideos(snapshot([warmup, legRaise]), '恶心想吐 化疗后', 3)
  assert.equal(matched.length, 0)
})

test('limit caps the number of returned videos', () => {
  const matched = selectMatchingInternalVideos(snapshot([warmup, legRaise]), '久坐后站起疼', 1)
  assert.equal(matched.length, 1)
})
