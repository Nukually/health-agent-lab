import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildEffectFollowupRoute,
  calculateEffectFollowupDueAt,
  getEffectFollowupDelayMs,
  nextEffectFollowupFailureStatus,
  sanitizeEffectFollowupQuestion,
  shouldScheduleEffectFollowup,
} from './intervention-effect-followup-policy.js'

test('legacy effect followup scheduler is disabled', () => {
  assert.equal(shouldScheduleEffectFollowup({
    event: 'follow_start',
    source: 'chat_inline',
    existingFollowStartedAt: null,
  }), false)
  assert.equal(shouldScheduleEffectFollowup({
    event: 'follow_start',
    source: 'chat_inline',
    existingFollowStartedAt: new Date('2026-05-09T08:00:00Z'),
  }), false)
  assert.equal(shouldScheduleEffectFollowup({
    event: 'follow_start',
    source: 'materials',
    existingFollowStartedAt: null,
  }), false)
  assert.equal(shouldScheduleEffectFollowup({
    event: 'progress',
    source: 'chat_inline',
    existingFollowStartedAt: null,
  }), false)
})

test('effect followup delay is short in local/dev and two hours in sit/prod', () => {
  assert.equal(getEffectFollowupDelayMs('local'), 10_000)
  assert.equal(getEffectFollowupDelayMs('dev'), 10_000)
  assert.equal(getEffectFollowupDelayMs('sit'), 2 * 60 * 60 * 1000)
  assert.equal(getEffectFollowupDelayMs('prod'), 2 * 60 * 60 * 1000)
})

test('effect followup due time follows deploy environment delay', () => {
  const now = new Date('2026-05-09T08:00:00Z')
  assert.equal(calculateEffectFollowupDueAt(now, 'local').toISOString(), '2026-05-09T08:00:10.000Z')
  assert.equal(calculateEffectFollowupDueAt(now, 'prod').toISOString(), '2026-05-09T10:00:00.000Z')
})

test('effect followup route points back to the original chat message', () => {
  assert.equal(
    buildEffectFollowupRoute(
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
    ),
    '/chat/11111111-1111-4111-8111-111111111111?focusMessageId=22222222-2222-4222-8222-222222222222',
  )
})

test('effect followup failures retry twice and fail on third attempt', () => {
  assert.equal(nextEffectFollowupFailureStatus(1), 'pending')
  assert.equal(nextEffectFollowupFailureStatus(2), 'pending')
  assert.equal(nextEffectFollowupFailureStatus(3), 'failed')
})

test('effect followup question sanitizer falls back for sensitive lock-screen content', () => {
  assert.equal(
    sanitizeEffectFollowupQuestion('练习后恶心有没有好一点？还会不舒服吗？'),
    '练习后恶心有没有好一点？还会不舒服吗？',
  )
  assert.equal(
    sanitizeEffectFollowupQuestion('化疗后练习有没有缓解？'),
    '练习后现在感觉有没有好一点？如果不适明显加重，请及时联系医生或就医。',
  )
})
