import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  buildReviewerSystemPrompt,
  buildCompactionReviewerUserPrompt,
  memoryCandidateStorageTarget,
  normalizeMemoryLifecycleDecision,
  normalizeMemoryReviewItems,
  selectMemoryLifecycleCandidates,
} from './memory-reviewer.js'

const sourcePath = join(dirname(fileURLToPath(import.meta.url)), 'memory-reviewer.ts')

test('memory reviewer schedules USER.md profile refresh for durable extracted items', () => {
  const source = readFileSync(sourcePath, 'utf8')

  assert.match(source, /scheduleUserProfileMemoryRefresh/)
  assert.match(source, /profileRefreshItems/)
  assert.match(source, /memoryCandidateStorageTarget\(item\.memoryType\) === 'profile'/)
})

test('memory reviewer routes stable preferences to USER.md and dynamic patterns to memory_items', () => {
  assert.equal(memoryCandidateStorageTarget('communication_preference'), 'profile')
  assert.equal(memoryCandidateStorageTarget('caregiver_context'), 'profile')
  assert.equal(memoryCandidateStorageTarget('life_context'), 'profile')
  assert.equal(memoryCandidateStorageTarget('symptom_pattern'), 'memory_item')
  assert.equal(memoryCandidateStorageTarget('treatment_experience'), 'memory_item')
  assert.equal(memoryCandidateStorageTarget('emotional_pattern'), 'memory_item')
  assert.equal(memoryCandidateStorageTarget('other'), 'memory_item')
})

test('normalizeMemoryReviewItems parses reviewer json', () => {
  const items = normalizeMemoryReviewItems(`{
    "items": [
      {
        "memoryType": "communication_preference",
        "content": "用户希望报告解释先给结论，再解释关键术语。",
        "importance": 3,
        "confidence": 86
      }
    ]
  }`)

  assert.deepEqual(items, [
    {
      memoryType: 'communication_preference',
      content: '用户希望报告解释先给结论，再解释关键术语。',
      importance: 3,
      confidence: 86,
    },
  ])
})

test('normalizeMemoryReviewItems keeps temporal fields when reviewer provides them', () => {
  const items = normalizeMemoryReviewItems(JSON.stringify({
    items: [
      {
        memoryType: 'symptom_pattern',
        content: '用户近期晚间容易出现恶心，需要复诊沟通时关注。',
        importance: 3,
        confidence: 82,
        temporalScope: 'current_state',
        eventAt: '2026-05-21T20:00:00.000Z',
        expiresAt: '2026-06-20T00:00:00.000Z',
      },
    ],
  }))

  assert.deepEqual(items, [
    {
      memoryType: 'symptom_pattern',
      content: '用户近期晚间容易出现恶心，需要复诊沟通时关注。',
      importance: 3,
      confidence: 82,
      temporalScope: 'current_state',
      eventAt: '2026-05-21T20:00:00.000Z',
      expiresAt: '2026-06-20T00:00:00.000Z',
    },
  ])
})

test('normalizeMemoryReviewItems strips code fences and clamps scores', () => {
  const items = normalizeMemoryReviewItems('```json\n{"items":[{"type":"life_context","content":"用户需要兼顾治疗和照顾上小学的孩子。","importance":99,"confidence":-1}]}\n```')

  assert.deepEqual(items, [
    {
      memoryType: 'life_context',
      content: '用户需要兼顾治疗和照顾上小学的孩子。',
      importance: 5,
      confidence: 1,
    },
  ])
})

test('normalizeMemoryReviewItems skips unknown or empty items', () => {
  const items = normalizeMemoryReviewItems(JSON.stringify({
    items: [
      { memoryType: 'medical_fact', content: '用户 HER2 阳性。' },
      { memoryType: 'emotional_pattern', content: '  ' },
      { memoryType: 'emotional_pattern', content: '用户复查前容易焦虑，希望先帮她拆解要问医生的问题。' },
    ],
  }))

  assert.deepEqual(items, [
    {
      memoryType: 'emotional_pattern',
      content: '用户复查前容易焦虑，希望先帮她拆解要问医生的问题。',
      importance: 2,
      confidence: 70,
    },
  ])
})

test('reviewer system prompt treats user corrections as long-term memory signals', () => {
  const prompt = buildReviewerSystemPrompt()

  assert.match(prompt, /用户纠正助手的表达、语气、格式、回复长短或信息组织方式/)
  assert.match(prompt, /第一优先级长期记忆信号/)
  assert.match(prompt, /临时任务状态、完成记录、一次性 TODO/)
  assert.match(prompt, /communication_preference、caregiver_context、life_context 会进入 USER\.md，不进入 user_memory_items/)
  assert.match(prompt, /阶段性焦虑、情绪困扰模式才归 emotional_pattern/)
  assert.match(prompt, /content 写成陈述事实/)
  assert.match(prompt, /不要写成.*指令句/)
})

test('normalizeMemoryLifecycleDecision only allows approved replacements', () => {
  assert.deepEqual(
    normalizeMemoryLifecycleDecision(
      '{"action":"replace","replaceIds":["old-1","unknown"]}',
      ['old-1'],
    ),
    { action: 'replace', replaceIds: ['old-1'] },
  )

  assert.deepEqual(
    normalizeMemoryLifecycleDecision(
      '{"action":"replace","replaceIds":["unknown"]}',
      ['old-1'],
    ),
    { action: 'skip', replaceIds: [] },
  )

  assert.deepEqual(
    normalizeMemoryLifecycleDecision('{"action":"skip","replaceIds":[]}', ['old-1']),
    { action: 'skip', replaceIds: [] },
  )
})

test('normalizeMemoryLifecycleDecision supports updating active memory instead of appending', () => {
  assert.deepEqual(
    normalizeMemoryLifecycleDecision(
      '{"action":"touch","targetId":"old-1"}',
      ['old-1'],
    ),
    { action: 'touch', targetId: 'old-1', replaceIds: [] },
  )

  assert.deepEqual(
    normalizeMemoryLifecycleDecision(
      '{"action":"merge","targetId":"old-1","content":"用户不喜欢说教或过度解释，希望获得简洁的情绪安慰。"}',
      ['old-1'],
    ),
    {
      action: 'merge',
      targetId: 'old-1',
      content: '用户不喜欢说教或过度解释，希望获得简洁的情绪安慰。',
      replaceIds: [],
    },
  )

  assert.deepEqual(
    normalizeMemoryLifecycleDecision(
      '{"action":"update","targetId":"old-1","content":"用户现在希望先给清单，再补充必要解释。"}',
      ['old-1'],
    ),
    {
      action: 'update',
      targetId: 'old-1',
      content: '用户现在希望先给清单，再补充必要解释。',
      replaceIds: [],
    },
  )
})

test('selectMemoryLifecycleCandidates reviews all active preferences for evolving memory types', () => {
  const existingItems = [
    { id: 'old-pref', memoryType: 'communication_preference' as const },
    { id: 'caregiver', memoryType: 'caregiver_context' as const },
    { id: 'new-pref', memoryType: 'communication_preference' as const },
  ]

  assert.deepEqual(
    selectMemoryLifecycleCandidates({
      candidateMemoryType: 'communication_preference',
      existingItems,
      similarItems: [],
    }).map((item) => item.id),
    ['old-pref', 'new-pref'],
  )
})

test('selectMemoryLifecycleCandidates reviews active symptom memories for lifecycle merge', () => {
  const existingItems = [
    { id: 'symptom-a', memoryType: 'symptom_pattern' as const },
    { id: 'symptom-b', memoryType: 'symptom_pattern' as const },
  ]

  assert.deepEqual(
    selectMemoryLifecycleCandidates({
      candidateMemoryType: 'symptom_pattern',
      existingItems,
      similarItems: [existingItems[1]],
    }).map((item) => item.id),
    ['symptom-a', 'symptom-b'],
  )
})

test('selectMemoryLifecycleCandidates reviews active treatment memories for lifecycle merge', () => {
  const existingItems = [
    { id: 'treatment-a', memoryType: 'treatment_experience' as const },
    { id: 'symptom-a', memoryType: 'symptom_pattern' as const },
    { id: 'treatment-b', memoryType: 'treatment_experience' as const },
  ]

  assert.deepEqual(
    selectMemoryLifecycleCandidates({
      candidateMemoryType: 'treatment_experience',
      existingItems,
      similarItems: [],
    }).map((item) => item.id),
    ['treatment-a', 'treatment-b'],
  )
})

test('buildCompactionReviewerUserPrompt frames compacted history as memory extraction input', () => {
  const prompt = buildCompactionReviewerUserPrompt({
    messages: [
      { role: 'user', content: '我复查前会很焦虑，希望你先帮我列要问医生的问题。', dbId: 'm-1' },
      { role: 'assistant', content: '可以，我会先帮你拆问题。' },
    ],
    existingItems: [
      { memoryType: 'communication_preference', content: '用户希望回答简短。' },
    ],
  })

  assert.match(prompt, /即将被压缩出主上下文/)
  assert.match(prompt, /复查前会很焦虑/)
  assert.match(prompt, /已有长期记忆/)
})
