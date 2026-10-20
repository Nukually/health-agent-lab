import test from 'node:test'
import assert from 'node:assert/strict'
import { ERROR_CODES } from '@health-agent/shared'
import { classifyLLMError } from './llm-errors.js'

test('classifies DashScope input length range 400 as context too long', () => {
  const err = Object.assign(
    new Error('400 <400> InternalError.Algo.InvalidParameter: Range of input length should be [1, 260096]'),
    { status: 400 },
  )

  assert.equal(classifyLLMError(err).code, ERROR_CODES.CONTEXT_TOO_LONG)
})
