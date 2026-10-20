import assert from 'node:assert/strict'
import test from 'node:test'
import {
  detectDanglingReferences,
  stripDanglingReferences,
  REFERENCE_BINDINGS,
  type ReferenceBindingContext,
  type ToolResultLike,
} from './reference-binding.js'

function videoToolResult(ids: string[]): ToolResultLike {
  return {
    displayOutput: {
      kind: 'medical_risk_resources',
      resources: ids.map((id) => ({
        kind: 'video_resource',
        id,
        title: '爬山后拉伸',
        url: 'https://example.com/v',
        providerVideoId: null,
        publishedAt: null,
        durationSec: 120,
        thumbnailUrl: null,
        snippet: '',
        sourceQuery: '拉伸',
      })),
    },
  }
}

function ctx(toolResults: ToolResultLike[]): ReferenceBindingContext {
  return { toolResults }
}

test('引用编号有工具结果支撑时不报悬空', () => {
  const content = '<resource_ref id="1-2" />这个跟练卡可以试试。'
  const dangling = detectDanglingReferences(content, ctx([videoToolResult(['1-2'])]))
  assert.equal(dangling.length, 0)
})

test('正文引用了没有任何工具结果的编号时检出悬空引用', () => {
  const content = '<resource_ref id="1-2" />'
  const dangling = detectDanglingReferences(content, ctx([]))
  assert.equal(dangling.length, 1)
  assert.equal(dangling[0].binding.tagName, 'resource_ref')
  assert.deepEqual(dangling[0].invalidIds, ['1-2'])
})

test('工具结果以 JSON 字符串形式出现也能解析（content 回退）', () => {
  const content = '<resource_ref id="A-1" />'
  const jsonOutput = JSON.stringify({
    kind: 'medical_risk_resources',
    resources: [{
      kind: 'video_resource', id: 'A-1', title: 't', url: 'u',
      providerVideoId: null, publishedAt: null, durationSec: 1,
      thumbnailUrl: null, snippet: '', sourceQuery: '',
    }],
  })
  const dangling = detectDanglingReferences(content, ctx([{ content: jsonOutput }]))
  assert.equal(dangling.length, 0)
})

test('部分编号合法、部分臆造时只检出臆造的', () => {
  const content = '<resource_ref id="1-1" /> 和 <resource_ref id="9-9" />'
  const dangling = detectDanglingReferences(content, ctx([videoToolResult(['1-1'])]))
  assert.equal(dangling.length, 1)
  assert.deepEqual(dangling[0].invalidIds, ['9-9'])
})

test('正文不含引用标签时不报错', () => {
  const dangling = detectDanglingReferences('到家了吗？先喝点水。', ctx([]))
  assert.equal(dangling.length, 0)
})

test('剥离只移除悬空引用，保留合法引用与正文', () => {
  const content = '前缀 <resource_ref id="1-1" /> 中间 <resource_ref id="9-9" /> 后缀'
  const dangling = detectDanglingReferences(content, ctx([videoToolResult(['1-1'])]))
  const stripped = stripDanglingReferences(content, dangling)
  assert.match(stripped, /<resource_ref id="1-1" \/>/)
  assert.doesNotMatch(stripped, /9-9/)
  assert.match(stripped, /前缀/)
  assert.match(stripped, /后缀/)
})

test('每个 binding 都带恢复提示，供 system-reminder 指明该调什么工具', () => {
  for (const binding of REFERENCE_BINDINGS) {
    assert.ok(binding.recoveryHint.trim().length > 0, `${binding.tagName} 缺少 recoveryHint`)
  }
})

test('非干预资源结构的工具结果不会被当成合法来源', () => {
  const content = '<resource_ref id="1-2" />'
  const dangling = detectDanglingReferences(content, ctx([{ displayOutput: { kind: 'other' } }]))
  assert.equal(dangling.length, 1)
})
