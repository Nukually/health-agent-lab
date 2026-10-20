import assert from 'node:assert/strict'
import test from 'node:test'
import { MAX_TOOL_ITERATIONS } from './loop.js'

test('agent loop allows up to 99 tool iterations', () => {
  assert.equal(MAX_TOOL_ITERATIONS, 99)
})
