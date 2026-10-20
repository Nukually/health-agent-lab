import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildLangfuseGenerationCreateEvent,
  buildLangfuseTraceContext,
  buildLangfuseUsageDetails,
  buildLangfuseConfig,
  maskLangfuseData,
  shouldCaptureRawLangfuseIO,
  summarizeForLangfuse,
} from './langfuse.js'

test('buildLangfuseConfig keeps tracing disabled by default', () => {
  const config = buildLangfuseConfig({})

  assert.equal(config.enabled, false)
  assert.equal(config.captureRawLLMIO, false)
  assert.equal(config.captureThinking, false)
  assert.equal(config.promptSyncEnabled, false)
  assert.equal(config.systemPromptName, 'health-agent-lab-system-prompt')
})

test('buildLangfuseConfig requires all credentials before enabling', () => {
  assert.equal(buildLangfuseConfig({ LANGFUSE_ENABLED: 'true' }).enabled, false)
  assert.equal(
    buildLangfuseConfig({
      LANGFUSE_ENABLED: 'true',
      LANGFUSE_PUBLIC_KEY: 'pk-test',
      LANGFUSE_SECRET_KEY: 'sk-test',
      LANGFUSE_BASE_URL: 'https://langfuse.example.com',
    }).enabled,
    true,
  )
})

test('buildLangfuseConfig reads prompt sync settings', () => {
  const config = buildLangfuseConfig({
    LANGFUSE_PROMPT_SYNC_ENABLED: 'true',
    LANGFUSE_SYSTEM_PROMPT_NAME: 'health-agent-lab-system-prompt-dev',
    LANGFUSE_PROMPT_LABEL: 'local',
  })

  assert.equal(config.promptSyncEnabled, true)
  assert.equal(config.systemPromptName, 'health-agent-lab-system-prompt-dev')
  assert.equal(config.promptLabel, 'local')
})

test('maskLangfuseData removes common sensitive payload fragments', () => {
  const masked = maskLangfuseData({
    data: JSON.stringify({
      phone: '13812345678',
      image: 'data:image/png;base64,' + 'a'.repeat(80),
      url: 'https://oss.example.com/report.png?Expires=123&Signature=secret&OSSAccessKeyId=key',
      bearer: 'Authorization: Bearer abc.def.ghi',
    }),
  })

  assert.match(masked, /138\*\*\*\*5678/)
  assert.doesNotMatch(masked, /13812345678/)
  assert.match(masked, /\[IMAGE_DATA_URL_REDACTED\]/)
  assert.doesNotMatch(masked, /Signature=secret/)
  assert.match(masked, /\[SIGNED_URL_QUERY_REDACTED\]/)
  assert.match(masked, /Bearer \[REDACTED\]/)
})

test('summarizeForLangfuse avoids raw values unless explicitly enabled', () => {
  const value = {
    messages: [
      { role: 'user', content: '我的手机号是13812345678' },
    ],
  }

  assert.deepEqual(summarizeForLangfuse(value, { captureRaw: false }), {
    kind: 'object',
    keys: ['messages'],
    jsonChars: JSON.stringify(value).length,
  })

  const raw = summarizeForLangfuse(value, { captureRaw: true })
  assert.equal(typeof raw, 'object')
  assert.equal(shouldCaptureRawLangfuseIO({ captureRawLLMIO: true }, 'llm'), true)
  assert.equal(shouldCaptureRawLangfuseIO({ captureRawLLMIO: false }, 'llm'), false)
})

test('buildLangfuseGenerationCreateEvent preserves structured input for ingestion', () => {
  const request = {
    model: 'kimi-k2.5',
    messages: [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: '用户问题' },
    ],
    max_tokens: 8000,
    temperature: 0.6,
  }

  const event = buildLangfuseGenerationCreateEvent({
    id: 'generation-1',
    traceId: 'trace-1',
    parentObservationId: 'agent-1',
    timestamp: new Date('2026-05-21T10:00:00.000Z'),
    name: 'llm.chat.completions',
    model: 'kimi-k2.5',
    modelParameters: { maxTokens: 8000, temperature: 0.6 },
    input: request,
    metadata: { requestId: 'req-1' },
    prompt: { name: 'health-agent-lab-system-prompt', version: 16, isFallback: false, promptHash: 'hash' },
    config: buildLangfuseConfig({ LANGFUSE_CAPTURE_RAW_LLM_IO: 'true', LANGFUSE_ENVIRONMENT: 'local' }),
  })

  assert.equal(event.type, 'generation-create')
  assert.deepEqual(event.body.input, request)
  assert.notEqual(typeof event.body.input, 'string')
  assert.equal(event.body.promptName, 'health-agent-lab-system-prompt')
  assert.equal(event.body.promptVersion, 16)
})

test('buildLangfuseTraceContext scopes Langfuse traces to request ids', () => {
  const first = buildLangfuseTraceContext({
    requestId: '37d8596b-9ba0-4f36-ad1f-f6af9e720c92',
  })
  const sameRequest = buildLangfuseTraceContext({
    requestId: '37d8596b-9ba0-4f36-ad1f-f6af9e720c92',
  })
  const nextTurn = buildLangfuseTraceContext({
    requestId: '7092e637-f4c2-48c5-98df-6117382221c5',
  })

  assert.equal(first.traceId, '37d8596b9ba04f36ad1ff6af9e720c92')
  assert.equal(first.traceId, sameRequest.traceId)
  assert.equal(first.parentSpanId, sameRequest.parentSpanId)
  assert.notEqual(first.traceId, nextTurn.traceId)
  assert.notEqual(first.parentSpanId, nextTurn.parentSpanId)
  assert.match(first.traceId, /^[0-9a-f]{32}$/)
  assert.match(first.parentSpanId, /^[0-9a-f]{16}$/)
})

test('buildLangfuseUsageDetails preserves cache and reasoning token breakdown', () => {
  assert.deepEqual(
    buildLangfuseUsageDetails({
      inputTokens: 123,
      outputTokens: 7,
      totalTokens: 130,
      promptTokensDetails: {
        cached_tokens: 96,
      },
      completionTokensDetails: {
        reasoning_tokens: 3,
      },
    }),
    {
      input: 27,
      cache_read_input_tokens: 96,
      output: 4,
      output_reasoning_tokens: 3,
      total: 130,
    },
  )
})
