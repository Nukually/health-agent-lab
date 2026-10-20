import assert from 'node:assert/strict'
import test from 'node:test'
import type { ChatMessage } from '../../state/session.js'
import {
  buildUserVisitIntentReminder,
  detectVisitIntentMentions,
} from './user-visit-intent.js'

function user(content: ChatMessage['content']): ChatMessage {
  return { role: 'user', content }
}

test('builds visit intent reminder for hospital and follow-up plans', () => {
  const reminder = buildUserVisitIntentReminder([
    user('我明天准备去医院复诊，顺便问问医生这个报告。'),
  ])

  assert.ok(reminder)
  assert.match(reminder, /\[user-visit-intent-detected\]/)
  assert.match(reminder, /线下就医\/复诊\/见医生意图/)
  assert.match(reminder, /去医院/)
  assert.match(reminder, /复诊\/复查\/随访/)
  assert.match(reminder, /最终回答尾部主动询问/)
  assert.match(reminder, /generate_communication_card/)
})

test('detects seeing doctor and taking reports to doctor', () => {
  assert.deepEqual(
    detectVisitIntentMentions('下周去见医生，我想带病理报告给医生看。'),
    ['见医生', '带报告问医生'],
  )
})

test('detects scheduled exams and inpatient treatment intent', () => {
  assert.deepEqual(
    detectVisitIntentMentions('我后天要去做B超和抽血，月底可能还要住院。'),
    ['做检查/治疗', '入院/住院/日间治疗'],
  )
})

test('reads latest real user text from multimodal content', () => {
  const reminder = buildUserVisitIntentReminder([
    user([
      { type: 'text', text: '这个报告我明天拿去问医生' },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,abc' } },
    ]),
  ])

  assert.ok(reminder)
  assert.match(reminder, /带报告问医生/)
})

test('does not trigger for pure question about whether to seek care', () => {
  assert.deepEqual(detectVisitIntentMentions('我这个情况要不要去医院吗？'), [])
  assert.deepEqual(detectVisitIntentMentions('需不需要看医生？'), [])
  assert.deepEqual(detectVisitIntentMentions('需要复诊吗？'), [])
})

test('does not trigger for generic follow-up education without visit intent', () => {
  assert.deepEqual(detectVisitIntentMentions('复查一般都查什么？'), [])
})
