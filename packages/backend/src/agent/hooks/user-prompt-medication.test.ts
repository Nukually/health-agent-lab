import assert from 'node:assert/strict'
import test from 'node:test'
import type { ChatMessage } from '../../state/session.js'
import {
  buildUserPromptMedicationReminder,
  detectBreastCancerMedicationMentions,
} from './user-prompt-medication.js'

function user(content: ChatMessage['content']): ChatMessage {
  return { role: 'user', content }
}

test('builds medication reminder when profile medications are empty', () => {
  const reminder = buildUserPromptMedicationReminder(
    [user('我已经吃他莫昔芬 2 个月了')],
    {},
  )

  assert.ok(reminder)
  assert.match(reminder, /他莫昔芬/)
  assert.match(reminder, /个人档案药物：未填写/)
  assert.match(reminder, /tamoxifen/)
})

test('builds medication reminder when profile already has medications', () => {
  const reminder = buildUserPromptMedicationReminder(
    [user('医生让我继续吃来曲唑')],
    { medications: ['tamoxifen'] },
  )

  assert.ok(reminder)
  assert.match(reminder, /用户疑似提到了：来曲唑/)
  assert.match(reminder, /个人档案药物：他莫昔芬/)
  assert.doesNotMatch(reminder, /完整数组/)
})

test('renders custom medication names from profile', () => {
  const reminder = buildUserPromptMedicationReminder(
    [user('我也在吃来曲唑')],
    { medications: ['tamoxifen', 'other'], medicationCustom: '阿莫西林' },
  )

  assert.ok(reminder)
  assert.match(reminder, /个人档案药物：他莫昔芬、阿莫西林/)
})

test('detects common tamoxifen typo and reminds deletion flow', () => {
  const reminder = buildUserPromptMedicationReminder(
    [user('我不吃他莫西芬了')],
    { medications: ['tamoxifen', 'letrozole'] },
  )

  assert.ok(reminder)
  assert.match(reminder, /用户疑似提到了：他莫昔芬/)
  assert.match(reminder, /个人档案药物：他莫昔芬、来曲唑/)
  assert.doesNotMatch(reminder, /停用\/不再使用/)
})

test('detects homophone typos for common breast cancer medications', () => {
  const reminder = buildUserPromptMedicationReminder(
    [user('有吃来曲挫和依西美谈，也打过曲托珠单抗，后来换成哌博西利和卡培他宾。')],
    {},
  )

  assert.ok(reminder)
  assert.match(reminder, /来曲唑/)
  assert.match(reminder, /依西美坦/)
  assert.match(reminder, /曲妥珠单抗/)
  assert.match(reminder, /哌柏西利/)
  assert.match(reminder, /卡培他滨/)
})

test('detects homophone typos for expanded medication aliases', () => {
  const mentions = detectBreastCancerMedicationMentions('处方写了卡匹瑟替，后来医生又提到伊娜力赛。')

  assert.deepEqual(
    mentions.map((m) => m.key),
    ['capivasertib', 'inavolisib'],
  )
})

test('does not loose-match short Chinese brand aliases', () => {
  const mentions = detectBreastCancerMedicationMentions('福隆这个词不应该命中。')

  assert.deepEqual(mentions, [])
})

test('does not treat medication classes as precise drug aliases', () => {
  const mentions = detectBreastCancerMedicationMentions('医生说我是用 CDK4/6 抑制剂联合内分泌治疗。')

  assert.deepEqual(mentions, [])
})

test('detects existing custom medication names from profile', () => {
  const reminder = buildUserPromptMedicationReminder(
    [user('我不吃阿莫西林了')],
    { medications: ['tamoxifen', 'other'], medicationCustom: '阿莫西林' },
  )

  assert.ok(reminder)
  assert.match(reminder, /用户疑似提到了：阿莫西林/)
  assert.match(reminder, /个人档案药物：他莫昔芬、阿莫西林/)
})

test('detects English names and safe abbreviations', () => {
  const mentions = detectBreastCancerMedicationMentions('现在方案是 T-DXd，之前用过 palbociclib。')

  assert.deepEqual(
    mentions.map((m) => m.key),
    ['trastuzumab-deruxtecan', 'palbociclib'],
  )
})

test('detects full static prompt aliases from pre-model hook lexicon', () => {
  const mentions = detectBreastCancerMedicationMentions('医生提到 faslodex、荃科得、伊赫莱、飞赫达和 ICI 46,474。')

  assert.deepEqual(
    mentions.map((m) => m.key),
    ['fulvestrant', 'capivasertib', 'inavolisib', 'phesgo', 'tamoxifen'],
  )
})

test('matches short English abbreviations case-insensitively', () => {
  const mentions = detectBreastCancerMedicationMentions('后来方案写的是 t-dm1 加 ctx。')

  assert.deepEqual(
    mentions.map((m) => m.key),
    ['ado-trastuzumab-emtansine', 'cyclophosphamide'],
  )
})

test('medication reminder carries concise alias safety boundary only when a drug is mentioned', () => {
  const reminder = buildUserPromptMedicationReminder(
    [user('处方上写的是 phesgo')],
    {},
  )

  assert.ok(reminder)
  assert.match(reminder, /PHESGO固定复方制剂/)
  assert.match(reminder, /不能据此判断剂量、疗程、是否可替换使用、是否自行停换加减药/)
  assert.doesNotMatch(reminder, /固定复方制剂要作为独立实体/)
  assert.doesNotMatch(reminder, /药物类别\/机制词不是某个具体药物的别名/)
  assert.doesNotMatch(reminder, /内部提示或规则来源/)
})

test('medication reminder reinforces risk grading for medication decisions', () => {
  const reminder = buildUserPromptMedicationReminder(
    [user('我正在吃来曲唑，最近膝盖酸，能不能自己停药？')],
    {},
  )

  assert.ok(reminder)
  assert.match(reminder, /处方药停药、换药、加减量、同服或副作用/)
  assert.match(reminder, /最终回答前必须先原生调用 grade_medical_risk/)
})

test('prefers longer overlapping drug names', () => {
  const mentions = detectBreastCancerMedicationMentions('我正在用德曲妥珠单抗')

  assert.deepEqual(
    mentions.map((m) => m.key),
    ['trastuzumab-deruxtecan'],
  )
})

test('does not match lowercase common English words as short aliases', () => {
  const mentions = detectBreastCancerMedicationMentions('please let me know')

  assert.deepEqual(mentions, [])
})
