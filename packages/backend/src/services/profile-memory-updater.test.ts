import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyProfileMemoryPatch,
  isProfileMemoryItemType,
  profileMemoryMayContainMedicalFacts,
  normalizeProfileMemoryPatch,
  normalizeProfileMemoryOutput,
  sanitizeProfileMemoryForStorage,
  stripMedicalFactLinesFromProfile,
} from './profile-memory-updater.js'

test('reviewer routes durable preference/background items into USER.md profile refresh', () => {
  assert.equal(isProfileMemoryItemType('communication_preference'), true)
  assert.equal(isProfileMemoryItemType('caregiver_context'), true)
  assert.equal(isProfileMemoryItemType('life_context'), true)
  assert.equal(isProfileMemoryItemType('emotional_pattern'), false)
  assert.equal(isProfileMemoryItemType('treatment_experience'), false)
  assert.equal(isProfileMemoryItemType('symptom_pattern'), false)
  assert.equal(isProfileMemoryItemType('other'), false)
})

test('normalizeProfileMemoryOutput handles skip marker and markdown fences', () => {
  assert.equal(normalizeProfileMemoryOutput('[skip update]'), null)
  assert.equal(
    normalizeProfileMemoryOutput('```markdown\n## 沟通偏好\n- 用户希望先给结论。\n```'),
    '## 沟通偏好\n- 用户希望先给结论。',
  )
})

test('normalizeProfileMemoryPatch parses add replace remove actions from reviewer output', () => {
  const actions = normalizeProfileMemoryPatch(`\`\`\`json
{
  "actions": [
    {"action": "add", "content": "用户喜欢吃西瓜。"},
    {"action": "merge", "old_text": "喜欢吃西瓜", "content": "用户喜欢吃西瓜和喝牛奶。"},
    {"action": "delete", "old_text": "回答要非常详细"}
  ]
}
\`\`\``)

  assert.deepEqual(actions, [
    { action: 'add', content: '用户喜欢吃西瓜。' },
    { action: 'replace', old_text: '喜欢吃西瓜', content: '用户喜欢吃西瓜和喝牛奶。' },
    { action: 'remove', old_text: '回答要非常详细' },
  ])
  assert.equal(normalizeProfileMemoryPatch('[skip update]'), null)
})

test('applyProfileMemoryPatch updates USER.md entries without accumulating stale preferences', () => {
  const result = applyProfileMemoryPatch(`用户喜欢吃西瓜。
§
用户回答要非常详细。`, [
    { action: 'replace', old_text: '喜欢吃西瓜', content: '用户喜欢吃西瓜和喝牛奶。' },
    { action: 'remove', old_text: '回答要非常详细' },
    { action: 'add', content: '用户希望被称呼为“飞飞”。' },
  ])

  assert.equal(result.kind, 'updated')
  assert.equal(result.appliedActions, 3)
  assert.deepEqual(result.entries, [
    '用户喜欢吃西瓜和喝牛奶。',
    '用户希望被称呼为“飞飞”。',
  ])
  assert.equal(result.content, '用户喜欢吃西瓜和喝牛奶。\n§\n用户希望被称呼为“飞飞”。')
})

test('applyProfileMemoryPatch skips invalid actions and keeps safe valid ones', () => {
  const result = applyProfileMemoryPatch('用户希望回答先给结论。', [
    { action: 'add', content: '用户正在服用来曲唑。' },
    { action: 'remove', old_text: '不存在的旧偏好' },
    { action: 'add', content: '用户喜欢喝牛奶。' },
  ])

  assert.equal(result.kind, 'updated')
  assert.equal(result.appliedActions, 1)
  assert.equal(result.skippedActions, 2)
  assert.deepEqual(result.entries, [
    '用户希望回答先给结论。',
    '用户喜欢喝牛奶。',
  ])
  assert.ok(result.errors.some((error) => error.includes('Medical facts')))
})

test('profileMemoryMayContainMedicalFacts detects medical facts that should not live in long-term memory', () => {
  assert.equal(profileMemoryMayContainMedicalFacts('用户希望被称呼为“晴晴”。'), false)
  assert.equal(profileMemoryMayContainMedicalFacts('用户正在服用来曲唑，处于内分泌治疗阶段。'), true)
  assert.equal(profileMemoryMayContainMedicalFacts('用户处于术后第6个月。'), true)
  assert.equal(profileMemoryMayContainMedicalFacts('用户处于乳腺癌术后复查阶段。'), true)
  assert.equal(profileMemoryMayContainMedicalFacts('用户对用药时长高度关注。'), true)
})

test('stripMedicalFactLinesFromProfile removes medical fact lines and keeps service preferences', () => {
  const cleaned = stripMedicalFactLinesFromProfile(`# 用户长期服务 Profile

## 偏好
- 用户希望被称呼为“晴晴”。
- 用户正在服用来曲唑，处于内分泌治疗阶段。`)

  assert.equal(cleaned, `# 用户长期服务 Profile

## 偏好
- 用户希望被称呼为“晴晴”。`)
})

test('sanitizeProfileMemoryForStorage removes medical fact lines and empty delimiters before storage', () => {
  const cleaned = sanitizeProfileMemoryForStorage(`用户希望被称呼为“安安”。
§
§
目前处于乳腺癌术后复查阶段。
§
2026-05-22 午餐：糖醋排骨、西兰花、一碗米饭。
§
用户希望回答先给简短行动清单。`)

  assert.equal(cleaned, `用户希望被称呼为“安安”。
用户希望回答先给简短行动清单。`)
})
