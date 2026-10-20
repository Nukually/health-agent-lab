import assert from 'node:assert/strict'
import test from 'node:test'
import { withDashScopeExplicitCacheControl } from './llm.js'

test('withDashScopeExplicitCacheControl marks only the latest user string content', () => {
  const params = {
    model: 'kimi-k2.6',
    messages: [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好呀' },
      { role: 'user', content: '88' },
    ],
  }

  const result = withDashScopeExplicitCacheControl(params)
  const messages = result.messages as Array<{ role: string; content: unknown }>

  assert.notEqual(result, params)
  assert.equal(messages[1].content, '你好')
  assert.deepEqual(messages[3].content, [
    {
      type: 'text',
      text: '88',
      cache_control: { type: 'ephemeral' },
    },
  ])
  assert.equal((params.messages[3] as { content: unknown }).content, '88')
})

test('withDashScopeExplicitCacheControl marks static system prompt and latest user content', () => {
  const params = {
    messages: [
      { role: 'system', content: 'STATIC_PREFIX' },
      {
        role: 'user',
        content: '<system-reminder>\n[session-context:dynamic-user-context]\nuser-specific dynamic context\n</system-reminder>\n\n你好',
      },
    ],
  }

  const result = withDashScopeExplicitCacheControl(params, {
    dashscopeSystemCachePrefixLength: 'STATIC_PREFIX'.length,
  })
  const messages = result.messages as Array<{ content: unknown }>

  assert.deepEqual(messages[0].content, [
    {
      type: 'text',
      text: 'STATIC_PREFIX',
      cache_control: { type: 'ephemeral' },
    },
  ])
  assert.deepEqual(messages[1].content, [
    {
      type: 'text',
      text: '<system-reminder>\n[session-context:dynamic-user-context]\nuser-specific dynamic context\n</system-reminder>\n\n你好',
      cache_control: { type: 'ephemeral' },
    },
  ])
  assert.equal((params.messages[0] as { content: unknown }).content, 'STATIC_PREFIX')
})

test('withDashScopeExplicitCacheControl leaves second system message dynamic', () => {
  const params = {
    messages: [
      { role: 'system', content: 'STATIC_PREFIX' },
      { role: 'system', content: 'USER PROFILE\nUSER.md' },
      { role: 'user', content: '你好' },
    ],
  }

  const result = withDashScopeExplicitCacheControl(params, {
    dashscopeSystemCachePrefixLength: 'STATIC_PREFIX'.length,
  })
  const messages = result.messages as Array<{ content: unknown }>

  assert.deepEqual(messages[0].content, [
    {
      type: 'text',
      text: 'STATIC_PREFIX',
      cache_control: { type: 'ephemeral' },
    },
  ])
  assert.equal(messages[1].content, 'USER PROFILE\nUSER.md')
  assert.deepEqual(messages[2].content, [
    {
      type: 'text',
      text: '你好',
      cache_control: { type: 'ephemeral' },
    },
  ])
})

test('withDashScopeExplicitCacheControl does not split a partially dynamic system prompt', () => {
  const params = {
    messages: [
      { role: 'system', content: 'STATIC_PREFIX\n\nuser-specific dynamic context' },
      { role: 'user', content: '你好' },
    ],
  }

  const result = withDashScopeExplicitCacheControl(params, {
    dashscopeSystemCachePrefixLength: 'STATIC_PREFIX'.length,
  })
  const messages = result.messages as Array<{ content: unknown }>

  assert.equal(messages[0].content, 'STATIC_PREFIX\n\nuser-specific dynamic context')
  assert.deepEqual(messages[1].content, [
    {
      type: 'text',
      text: '你好',
      cache_control: { type: 'ephemeral' },
    },
  ])
})

test('withDashScopeExplicitCacheControl marks the last text block in multimodal user content', () => {
  const params = {
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: 'data:image/png;base64,xxx' } },
          { type: 'text', text: '请看报告' },
        ],
      },
    ],
  }

  const result = withDashScopeExplicitCacheControl(params)
  const messages = result.messages as Array<{ content: unknown[] }>

  assert.deepEqual(messages[0].content[0], {
    type: 'image_url',
    image_url: { url: 'data:image/png;base64,xxx' },
  })
  assert.deepEqual(messages[0].content[1], {
    type: 'text',
    text: '请看报告',
    cache_control: { type: 'ephemeral' },
  })
})

test('withDashScopeExplicitCacheControl leaves payload unchanged when no user text exists', () => {
  const params = {
    messages: [
      { role: 'system', content: 'system prompt' },
      { role: 'assistant', content: 'hello' },
    ],
  }

  assert.equal(withDashScopeExplicitCacheControl(params), params)
})
