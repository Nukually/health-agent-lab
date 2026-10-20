import type { ToolCallRecord } from '@health-agent/shared'

export interface IndexedToolCallRecord {
  toolCall: ToolCallRecord
  index: number
}

export function getAssistantStepIndex(toolCall: ToolCallRecord): number | null {
  const value = toolCall.assistantStepIndex
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null
}

export function groupToolCallsForReplay(toolCalls: ToolCallRecord[]): IndexedToolCallRecord[][] {
  const indexed = toolCalls.map((toolCall, index) => ({ toolCall, index }))
  if (!indexed.every((item) => getAssistantStepIndex(item.toolCall) !== null)) {
    return [indexed]
  }

  const groups = new Map<number, IndexedToolCallRecord[]>()
  for (const item of indexed) {
    const stepIndex = getAssistantStepIndex(item.toolCall)!
    const group = groups.get(stepIndex) ?? []
    group.push(item)
    groups.set(stepIndex, group)
  }

  return Array.from(groups.entries())
    .sort(([a], [b]) => a - b)
    .map(([, group]) => group)
}

export function countAssistantToolReplayMessages(
  toolCalls: unknown,
  hasFinalAssistant: boolean,
): number {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return 1
  const groups = groupToolCallsForReplay(toolCalls as ToolCallRecord[])
  return groups.length + toolCalls.length + (hasFinalAssistant ? 1 : 0)
}
