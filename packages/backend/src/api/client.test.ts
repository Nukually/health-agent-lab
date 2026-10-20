import assert from 'node:assert/strict'
import test from 'node:test'
import {
  findFirstPreambleProtocolToken,
  longestPreambleProtocolPartialSuffix,
  normalizeLLMUsage,
  normalizeStreamStopReason,
} from './client.js'

test('keeps tool_calls when valid tool calls were streamed', () => {
  assert.equal(normalizeStreamStopReason('tool_calls', 1), 'tool_calls')
  assert.equal(normalizeStreamStopReason('stop', 1), 'tool_calls')
})

test('downgrades empty tool_calls finish to stop for protocol recovery', () => {
  assert.equal(normalizeStreamStopReason('tool_calls', 0), 'stop')
  assert.equal(normalizeStreamStopReason('function_call', 0), 'stop')
})

test('preserves non-tool stop reasons without tool calls', () => {
  assert.equal(normalizeStreamStopReason('stop', 0), 'stop')
  assert.equal(normalizeStreamStopReason('length', 0), 'length')
})

test('normalizeLLMUsage preserves OpenAI-compatible token details', () => {
  assert.deepEqual(
    normalizeLLMUsage({
      prompt_tokens: 123,
      completion_tokens: 7,
      total_tokens: 130,
      prompt_tokens_details: {
        cached_tokens: 96,
        audio_tokens: 0,
      },
      completion_tokens_details: {
        reasoning_tokens: 3,
      },
    }),
    {
      inputTokens: 123,
      outputTokens: 7,
      totalTokens: 130,
      promptTokensDetails: {
        cached_tokens: 96,
        audio_tokens: 0,
      },
      completionTokensDetails: {
        reasoning_tokens: 3,
      },
      cachedTokens: 96,
      cacheCreationInputTokens: 0,
    },
  )
})

test('detects orphan thinking phase marker as preamble protocol', () => {
  assert.deepEqual(
    findFirstPreambleProtocolToken('\n<|判断|>先规划。'),
    { kind: 'thinking-phase', index: 1, token: '<|判断|>' },
  )
  assert.deepEqual(
    findFirstPreambleProtocolToken('需要先识别问题。\n<|判断|>先规划。'),
    { kind: 'thinking-phase', index: 9, token: '<|判断|>' },
  )
  assert.deepEqual(
    findFirstPreambleProtocolToken('<think>先规划。</think>'),
    { kind: 'thinking-open', index: 0, token: '<think>' },
  )
  assert.equal(longestPreambleProtocolPartialSuffix('<|判'), 3)
  assert.equal(longestPreambleProtocolPartialSuffix('<|判断|'), '<|判断|'.length)
})
