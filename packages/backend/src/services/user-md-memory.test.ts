import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyUserMdMemoryAction,
} from './user-md-memory.js'
import {
  renderUserMdPromptBlock,
  splitUserMdEntries,
  USER_MD_ENTRY_DELIMITER,
} from './memory.js'

const userMd = [
  '用户希望被称呼为“晴晴”，避免使用全名。',
  '用户希望回答先给简短行动清单，最后再补一句安慰。',
].join(USER_MD_ENTRY_DELIMITER)

test('renderUserMdPromptBlock uses Cx long-term memory profile header', () => {
  const block = renderUserMdPromptBlock(userMd)

  assert.ok(block)
  assert.match(block, /USER PROFILE \(who the user is\)/)
  assert.match(block, /§/)
  assert.doesNotMatch(block, /<user_md>/)
  assert.doesNotMatch(block, /<\/user_md>/)
})

test('splitUserMdEntries drops repeated empty delimiters', () => {
  assert.deepEqual(splitUserMdEntries('entry 1\n§\n§\n§\nentry 2'), ['entry 1', 'entry 2'])
})

test('applyUserMdMemoryAction adds one entry and avoids exact duplicates', () => {
  const added = applyUserMdMemoryAction(userMd, {
    action: 'add',
    content: '用户不喜欢太强硬的医患沟通语气，偏好“我想确认……”这类表达。',
  })

  assert.equal(added.success, true)
  if (added.success) assert.equal(added.entry_count, 3)

  const duplicate = applyUserMdMemoryAction(userMd, {
    action: 'add',
    content: '用户希望被称呼为“晴晴”，避免使用全名。',
  })

  assert.equal(duplicate.success, true)
  if (duplicate.success) {
    assert.equal(duplicate.message, 'Entry already exists (no duplicate added).')
    assert.equal(duplicate.entry_count, 2)
  }
})

test('applyUserMdMemoryAction replaces an entry by unique old_text', () => {
  const result = applyUserMdMemoryAction(userMd, {
    action: 'replace',
    old_text: '先给简短行动清单',
    content: '用户希望回答先给结论和行动清单，最后再补一句安慰。',
  })

  assert.equal(result.success, true)
  if (result.success) {
    assert.deepEqual(result.entries, [
      '用户希望被称呼为“晴晴”，避免使用全名。',
      '用户希望回答先给结论和行动清单，最后再补一句安慰。',
    ])
  }
})

test('applyUserMdMemoryAction removes an entry by unique old_text', () => {
  const result = applyUserMdMemoryAction(userMd, {
    action: 'remove',
    old_text: '避免使用全名',
  })

  assert.equal(result.success, true)
  if (result.success) {
    assert.deepEqual(result.entries, [
      '用户希望回答先给简短行动清单，最后再补一句安慰。',
    ])
  }
})

test('applyUserMdMemoryAction fails when old_text matches multiple entries', () => {
  const result = applyUserMdMemoryAction([
    '用户偏好简短回答。',
    '用户偏好简短行动清单。',
  ].join(USER_MD_ENTRY_DELIMITER), {
    action: 'remove',
    old_text: '用户偏好简短',
  })

  assert.equal(result.success, false)
  if (!result.success) {
    assert.match(result.error, /Multiple long-term memory entries matched/)
    assert.equal(result.matches?.length, 2)
  }
})

test('applyUserMdMemoryAction rejects medical facts', () => {
  const result = applyUserMdMemoryAction(userMd, {
    action: 'add',
    content: '用户正在服用来曲唑，处于术后内分泌治疗阶段。',
  })

  assert.equal(result.success, false)
  if (!result.success) assert.match(result.error, /Medical facts/)
})

test('applyUserMdMemoryAction rejects single-use check-in style records', () => {
  const result = applyUserMdMemoryAction(userMd, {
    action: 'add',
    content: '2026-05-22 午餐：糖醋排骨、西兰花、一碗米饭。',
  })

  assert.equal(result.success, false)
  if (!result.success) assert.match(result.error, /Single-use records/)
})
