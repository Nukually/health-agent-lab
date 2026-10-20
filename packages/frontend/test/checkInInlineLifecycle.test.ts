import assert from 'node:assert/strict'
import {
  setupCheckInAsyncLifecycle,
  shouldApplyCheckInCardInvalidation,
  shouldDeactivateCheckInDraftCard,
  shouldMuteCheckInReadOnlyCard,
} from '../src/components/chat/checkInInlineLifecycle.js'

const cancelledRef = { current: true }
const pollTimerRef = { current: 42 }
const clearedTimers: number[] = []

const cleanup = setupCheckInAsyncLifecycle(
  cancelledRef,
  pollTimerRef,
  (timerId) => clearedTimers.push(timerId),
)

assert.equal(cancelledRef.current, false)
cleanup()
assert.equal(cancelledRef.current, true)
assert.deepEqual(clearedTimers, [42])

pollTimerRef.current = null
const remountCleanup = setupCheckInAsyncLifecycle(
  cancelledRef,
  pollTimerRef,
  (timerId) => clearedTimers.push(timerId),
)

assert.equal(cancelledRef.current, false)
remountCleanup()
assert.equal(cancelledRef.current, true)
assert.deepEqual(clearedTimers, [42])

assert.equal(
  shouldDeactivateCheckInDraftCard({ supersededByNewerUserMessage: true, status: 'draft' }),
  false,
)
assert.equal(
  shouldDeactivateCheckInDraftCard({ supersededByNewerUserMessage: true, status: 'saved' }),
  false,
)
assert.equal(
  shouldDeactivateCheckInDraftCard({ supersededByNewerUserMessage: false, status: 'draft' }),
  false,
)
assert.equal(
  shouldMuteCheckInReadOnlyCard({
    hasSavedRecord: true,
    supersededByNewerUserMessage: false,
    status: 'saved',
  }),
  true,
)
assert.equal(
  shouldMuteCheckInReadOnlyCard({
    hasSavedRecord: false,
    supersededByNewerUserMessage: true,
    status: 'draft',
  }),
  false,
)
assert.equal(
  shouldMuteCheckInReadOnlyCard({
    hasSavedRecord: false,
    supersededByNewerUserMessage: false,
    status: 'invalidated',
  }),
  true,
)
assert.equal(
  shouldMuteCheckInReadOnlyCard({
    hasSavedRecord: false,
    supersededByNewerUserMessage: false,
    status: 'saved',
  }),
  true,
)
assert.equal(
  shouldMuteCheckInReadOnlyCard({
    hasSavedRecord: false,
    isSaveIntent: true,
    supersededByNewerUserMessage: false,
    status: 'draft',
  }),
  true,
)
assert.equal(
  shouldMuteCheckInReadOnlyCard({
    hasSavedRecord: false,
    isSaveIntent: false,
    supersededByNewerUserMessage: false,
    status: 'draft',
  }),
  false,
)
assert.equal(
  shouldApplyCheckInCardInvalidation({ status: 'draft' }),
  true,
)
assert.equal(
  shouldApplyCheckInCardInvalidation({ status: 'saved' }),
  false,
)
assert.equal(
  shouldApplyCheckInCardInvalidation({ status: 'invalidated' }),
  false,
)

console.log('check-in inline lifecycle tests passed')
