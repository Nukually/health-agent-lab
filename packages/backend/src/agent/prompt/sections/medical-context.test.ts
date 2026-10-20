import assert from 'node:assert/strict'
import test from 'node:test'
import { currentConcernContext, medicalRecordContext } from './medical-context.js'

test('current concern context is framed as background rather than turn classification', () => {
  const prompt = currentConcernContext({ currentConcern: 'breast_tumor_care' })

  assert.match(prompt, /## 用户长期健康背景 \/ 当前关注情况/)
  assert.match(prompt, /当前关注情况：乳腺肿瘤相关诊疗/)
  assert.match(prompt, /这只是长期背景，不是本轮问题分类/)
  assert.match(prompt, /普通防晒、饮食、运动、睡眠等泛健康问题按问题本身回答/)
  assert.match(prompt, /不要自动转成乳腺癌或结节诊疗建议/)
})

test('current concern context prevents non-cancer concerns from being treated as breast cancer', () => {
  const prompt = currentConcernContext({ currentConcern: 'breast_nodule_followup' })

  assert.match(prompt, /当前关注情况：乳腺结节 \/ 结节随访/)
  assert.match(prompt, /当前关注情况不是乳腺肿瘤相关诊疗，不要预设用户是乳腺癌患者/)
  assert.match(prompt, /乳腺结节、等待结果、不确定或其他乳腺问题都不能自动等同于乳腺癌/)
})

test('medical record context is only used when the current turn is clearly relevant', () => {
  const prompt = medicalRecordContext({ currentConcern: 'breast_nodule_followup', gender: '女' }, null)

  assert.match(prompt, /## 病历档案（仅本轮明确相关时参考）/)
  assert.match(prompt, /只有当本轮问题明确涉及病历字段、乳腺症状、报告\/治疗\/用药\/复查时，才结合病历档案/)
  assert.match(prompt, /日常闲聊、普通防晒、饮食、运动、睡眠等泛健康问题不要主动引用或套用档案/)
  assert.match(prompt, /当前关注情况不是乳腺肿瘤相关诊疗，不要预设用户是乳腺癌患者/)
})
