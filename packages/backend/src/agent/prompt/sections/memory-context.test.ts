import assert from 'node:assert/strict'
import test from 'node:test'
import { memoryContext, userProfileSystemContext } from './memory-context.js'

test('user profile context is rendered as a separate Cx long-term memory system block', () => {
  const prompt = userProfileSystemContext('用户喜欢先看行动清单。')

  assert.ok(prompt)
  assert.match(prompt, /USER PROFILE \(who the user is\)/)
  assert.match(prompt, /用户喜欢先看行动清单。/)
  assert.doesNotMatch(prompt, /<user-profile>/)
  assert.doesNotMatch(prompt, /<user_md>/)
  assert.doesNotMatch(prompt, /<\/user_md>/)
  assert.doesNotMatch(prompt, /仅作服务偏好与长期背景/)
  assert.doesNotMatch(prompt, /当前关注情况不是乳腺肿瘤相关诊疗/)
})

test('daily memory context does not include long-term profile memory', () => {
  const prompt = memoryContext('用户正在内分泌治疗。', null, 'breast_tumor_care')

  assert.equal(prompt, '')
})
