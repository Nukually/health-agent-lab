import test from 'node:test'
import assert from 'node:assert/strict'
import type { ToolCallRecord } from '@health-agent/shared'
import {
  countAssistantToolReplayMessages,
  groupToolCallsForReplay,
} from './tool-call-replay.js'

function toolCall(name: string, assistantStepIndex?: number): ToolCallRecord {
  return {
    toolCallId: `call_${name}`,
    name,
    input: {},
    rawArguments: '{}',
    assistantToolCallContent: '',
    assistantStepIndex,
    llmOutput: `${name}_output`,
    output: `${name}_output`,
  }
}

test('tool replay keeps parallel tool calls in the same assistant step', () => {
  const calls = [
    toolCall('medical_report_consultation_board', 0),
    toolCall('grade_medical_risk', 0),
  ]

  const groups = groupToolCallsForReplay(calls)

  assert.equal(groups.length, 1)
  assert.deepEqual(groups[0].map((item) => item.toolCall.name), [
    'medical_report_consultation_board',
    'grade_medical_risk',
  ])
  assert.equal(countAssistantToolReplayMessages(calls, true), 4)
})

test('tool replay restores sequential assistant tool-call steps', () => {
  const calls = [
    toolCall('medical_report_consultation_board', 0),
    toolCall('grade_medical_risk', 1),
  ]

  const groups = groupToolCallsForReplay(calls)

  assert.equal(groups.length, 2)
  assert.deepEqual(groups.map((group) => group.map((item) => item.toolCall.name)), [
    ['medical_report_consultation_board'],
    ['grade_medical_risk'],
  ])
  assert.equal(countAssistantToolReplayMessages(calls, true), 5)
})

test('legacy tool records without step indexes keep the old single assistant group', () => {
  const calls = [
    toolCall('medical_report_consultation_board'),
    toolCall('grade_medical_risk'),
  ]

  const groups = groupToolCallsForReplay(calls)

  assert.equal(groups.length, 1)
  assert.equal(countAssistantToolReplayMessages(calls, true), 4)
})
