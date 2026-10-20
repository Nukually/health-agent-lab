import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ProcessStep } from '../src/stores/slices/chat.js'

;(globalThis as typeof globalThis & { React?: typeof React }).React = React

const { default: ProcessIndicator } = await import('../src/components/chat/ProcessIndicator.js')
const source = readFileSync(
  fileURLToPath(new URL('../src/components/chat/ProcessIndicator.tsx', import.meta.url)),
  'utf8',
)

const streamingHtml = renderToStaticMarkup(
  <ProcessIndicator steps={[]} isStreaming answerStartedAt={null} />,
)

assert.equal(streamingHtml, '')

const streamingNarrationSteps: ProcessStep[] = [
  { type: 'text', content: '我先确认需要调用的资料。', timestamp: 1 },
  {
    type: 'tool_call',
    toolCallId: 'call-search',
    name: 'medical_literature_search',
    input: { query: '内分泌治疗 关节痛 缓解' },
    isActive: true,
    timestamp: 2,
  },
]

const streamingNarrationHtml = renderToStaticMarkup(
  <ProcessIndicator steps={streamingNarrationSteps} isStreaming answerStartedAt={null} />,
)

assert.match(streamingNarrationHtml, /role="button"/)
assert.match(streamingNarrationHtml, /我先确认需要调用的资料。/)
assert.match(streamingNarrationHtml, /医学资料检索中/)
assert.doesNotMatch(streamingNarrationHtml, /内分泌治疗 关节痛 缓解/)

const completedSteps: ProcessStep[] = [{
  type: 'tool_call',
  toolCallId: 'call-1',
  name: 'grade_medical_risk',
  input: { level: 'B0', category: '当前症状', analysis: '无红肿发热等急症信号。' },
  durationMs: 820,
  isActive: false,
  timestamp: 1,
}]

const completedHtml = renderToStaticMarkup(
  <ProcessIndicator steps={completedSteps} durationMs={1200} />,
)

assert.match(completedHtml, /风险分级 · 1.2s/)
assert.match(completedHtml, /role="button"/)
assert.doesNotMatch(completedHtml, /无红肿发热等急症信号/)
assert.match(source, /<BottomSheet/)

console.log('agent timeline tests passed')
