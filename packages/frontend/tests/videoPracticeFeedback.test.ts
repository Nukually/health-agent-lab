import assert from 'node:assert/strict'
import test from 'node:test'
import {
  getMobilePracticeFeedbackDelayMs,
  shouldShowVideoPracticeFeedback,
} from '../src/components/chat/videoPracticeFeedback.js'

test('shows practice feedback for regular videos after inferred pause or completion', () => {
  assert.equal(shouldShowVideoPracticeFeedback({
    source: 'chat_inline',
    hasTodoContext: false,
    isTodoContextClosed: false,
    isAtEnd: false,
    feedbackState: 'paused',
  }), true)

  assert.equal(shouldShowVideoPracticeFeedback({
    source: 'materials',
    hasTodoContext: false,
    isTodoContextClosed: false,
    isAtEnd: true,
    feedbackState: 'completed',
  }), true)
})

test('keeps practice feedback hidden for regular videos before playback feedback is triggered', () => {
  assert.equal(shouldShowVideoPracticeFeedback({
    source: 'chat_inline',
    hasTodoContext: false,
    isTodoContextClosed: false,
    isAtEnd: false,
    feedbackState: 'hidden',
  }), false)
})

test('keeps shared-view practice feedback read-only and hidden', () => {
  assert.equal(shouldShowVideoPracticeFeedback({
    source: 'shared_view',
    hasTodoContext: false,
    isTodoContextClosed: false,
    isAtEnd: true,
    feedbackState: 'completed',
  }), false)
})

test('preserves todo feedback visibility rules', () => {
  assert.equal(shouldShowVideoPracticeFeedback({
    source: 'chat_inline',
    hasTodoContext: true,
    isTodoContextClosed: false,
    isAtEnd: false,
    feedbackState: 'hidden',
  }), false)

  assert.equal(shouldShowVideoPracticeFeedback({
    source: 'chat_inline',
    hasTodoContext: true,
    isTodoContextClosed: true,
    isAtEnd: false,
    feedbackState: 'hidden',
  }), true)
})

test('schedules mobile practice feedback at half of the video duration', () => {
  assert.equal(getMobilePracticeFeedbackDelayMs(162, 0), 81000)
  assert.equal(getMobilePracticeFeedbackDelayMs(162, 40), 41000)
})

test('shows mobile practice feedback immediately when playback is already past halfway', () => {
  assert.equal(getMobilePracticeFeedbackDelayMs(162, 81), 0)
  assert.equal(getMobilePracticeFeedbackDelayMs(162, 120), 0)
})

test('does not schedule mobile practice feedback without a known duration', () => {
  assert.equal(getMobilePracticeFeedbackDelayMs(0, 0), null)
  assert.equal(getMobilePracticeFeedbackDelayMs(Number.NaN, 0), null)
})
