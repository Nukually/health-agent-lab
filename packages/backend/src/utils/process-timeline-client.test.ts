import assert from 'node:assert/strict'
import test from 'node:test'
import type { MedicalRiskToolOutput, ToolCallRecord } from '@health-agent/shared'
import { getProcessTimelineForClient, hydrateProcessTimelineToolOutputs } from './process-timeline-client.js'

test('preserves structured tool plan without requiring raw content', () => {
  const steps = getProcessTimelineForClient({
    processTimeline: [
      {
        type: 'tool_plan',
        content: '',
        toolName: 'grade_medical_risk',
        isActive: false,
        timestamp: 1,
      },
    ],
  })

  assert.deepEqual(steps, [
    {
      type: 'tool_plan',
      content: '',
      toolName: 'grade_medical_risk',
      isActive: false,
      timestamp: 1,
    },
  ])
})

test('preserves scheduleConfirmation terminal state on tool_call step', () => {
  const steps = getProcessTimelineForClient({
    processTimeline: [
      {
        type: 'tool_call',
        toolCallId: 'call-1',
        name: 'schedule',
        isActive: false,
        timestamp: 1,
        scheduleConfirmation: 'confirmed',
      },
    ],
  })

  assert.equal(steps?.length, 1)
  const step = steps?.[0]
  assert.equal(step?.type === 'tool_call' && step.scheduleConfirmation, 'confirmed')
})

test('drops invalid scheduleConfirmation value on re-parse', () => {
  const steps = getProcessTimelineForClient({
    processTimeline: [
      {
        type: 'tool_call',
        toolCallId: 'call-1',
        name: 'schedule',
        isActive: false,
        timestamp: 1,
        scheduleConfirmation: 'bogus',
      },
    ],
  })

  const step = steps?.[0]
  assert.equal(step?.type === 'tool_call' && step.scheduleConfirmation, undefined)
})

test('drops empty tool plan without structured tool name', () => {
  const steps = getProcessTimelineForClient({
    processTimeline: [
      {
        type: 'tool_plan',
        content: '',
        isActive: false,
        timestamp: 1,
      },
    ],
  })

  assert.equal(steps, undefined)
})

test('hydrates missing medical literature output from saved tool calls', () => {
  const literatureOutput: MedicalRiskToolOutput = {
    kind: 'medical_risk_resources',
    resources: [],
    literatureSearch: {
      kind: 'medical_literature_search',
      query: '乳腺结节 BI-RADS 分级',
      searchedCount: 14,
      candidateCount: 14,
      selectedCount: 1,
      allSources: [{
        id: '1',
        title: '中国乳腺癌随诊随访与健康管理指南(2022版)',
        articleClass: '指南',
        pubYear: 2022,
        chunks: [{ sourceRank: 1, title: '指南', content: 'BI-RADS 分级用于影像学评估。' }],
      }],
      selectedSources: [{
        id: '1',
        title: '中国乳腺癌随诊随访与健康管理指南(2022版)',
        articleClass: '指南',
        pubYear: 2022,
        chunks: [{ sourceRank: 1, title: '指南', content: 'BI-RADS 分级用于影像学评估。' }],
      }],
    },
  }
  const timeline = getProcessTimelineForClient({
    processTimeline: [{
      type: 'tool_call',
      toolCallId: 'call-1',
      name: 'medical_literature_search',
      input: { query: '乳腺结节 BI-RADS 分级' },
      durationMs: 5200,
      isActive: false,
      timestamp: 1,
    }],
  })
  const toolCalls: ToolCallRecord[] = [{
    toolCallId: 'call-1',
    name: 'medical_literature_search',
    input: { query: '乳腺结节 BI-RADS 分级' },
    output: literatureOutput,
    durationMs: 5200,
  }]

  const hydrated = hydrateProcessTimelineToolOutputs(timeline, toolCalls)

  assert.deepEqual(hydrated?.[0], {
    type: 'tool_call',
    toolCallId: 'call-1',
    name: 'medical_literature_search',
    input: { query: '乳腺结节 BI-RADS 分级' },
    output: literatureOutput,
    durationMs: 5200,
    isActive: false,
    timestamp: 1,
  })
})

test('does not hydrate null default tool outputs', () => {
  const timeline = getProcessTimelineForClient({
    processTimeline: [{
      type: 'tool_call',
      toolCallId: 'call-1',
      name: 'update_memory',
      isActive: false,
      timestamp: 1,
    }],
  })
  const toolCalls: ToolCallRecord[] = [{
    toolCallId: 'call-1',
    name: 'update_memory',
    input: null,
    output: null,
  }]

  const hydrated = hydrateProcessTimelineToolOutputs(timeline, toolCalls)

  assert.equal(hydrated, timeline)
})
