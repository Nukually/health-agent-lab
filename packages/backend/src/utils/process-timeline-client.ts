import type { MessageProcessStep, ToolCallRecord } from '@health-agent/shared'

type RawProcessTimeline = {
  processTimeline?: unknown
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export function attachProcessTimelineToRawResponse(
  rawResponse: unknown,
  processTimeline: MessageProcessStep[],
): unknown {
  const base = rawResponse && typeof rawResponse === 'object' && !Array.isArray(rawResponse)
    ? rawResponse as Record<string, unknown>
    : {}
  return { ...base, processTimeline }
}

export function getProcessTimelineForClient(rawResponse: unknown): MessageProcessStep[] | undefined {
  const candidate = rawResponse && typeof rawResponse === 'object'
    ? (rawResponse as RawProcessTimeline).processTimeline
    : undefined
  if (!Array.isArray(candidate)) return undefined

  const steps: MessageProcessStep[] = []
  candidate.forEach((raw, index) => {
    if (!raw || typeof raw !== 'object') return
    const step = raw as Record<string, unknown>
    const timestamp = finiteNumber(step.timestamp) ?? index

    if (step.type === 'thinking') {
      const content = stringOrUndefined(step.content)
      if (!content) return
      steps.push({
        type: 'thinking',
        content,
        isActive: false,
        timestamp,
      })
      return
    }

    if (step.type === 'tool_plan') {
      const content = stringOrUndefined(step.content)
      const toolName = stringOrUndefined(step.toolName)
      if (!content && !toolName) return
      steps.push({
        type: 'tool_plan',
        content: content ?? '',
        toolName,
        isActive: false,
        timestamp,
      })
      return
    }

    if (step.type === 'tool_call') {
      const name = stringOrUndefined(step.name)
      if (!name) return
      const durationMs = finiteNumber(step.durationMs)
      const scheduleConfirmation =
        step.scheduleConfirmation === 'pending' ||
        step.scheduleConfirmation === 'confirmed' ||
        step.scheduleConfirmation === 'rejected'
          ? step.scheduleConfirmation
          : undefined
      const scheduledTaskId = stringOrUndefined(step.scheduledTaskId)
      steps.push({
        type: 'tool_call',
        toolCallId: stringOrUndefined(step.toolCallId),
        name,
        input: step.input,
        output: step.output,
        durationMs,
        isActive: false,
        timestamp,
        ...(scheduleConfirmation ? { scheduleConfirmation } : {}),
        ...(scheduledTaskId ? { scheduledTaskId } : {}),
      })
      return
    }

    if (step.type === 'text') {
      const content = stringOrUndefined(step.content)
      if (!content) return
      steps.push({
        type: 'text',
        content,
        timestamp,
      })
      return
    }

    if (step.type === 'protocol_recovery') {
      steps.push({
        type: 'protocol_recovery',
        reason: stringOrUndefined(step.reason) ?? 'unknown',
        retryAttempt: finiteNumber(step.retryAttempt),
        isActive: false,
        timestamp,
      })
      return
    }

    if (step.type === 'doc_view') {
      const titles = Array.isArray(step.titles)
        ? step.titles.map((title) => typeof title === 'string' ? title : null)
        : []
      const count = finiteNumber(step.count) ?? titles.length
      steps.push({
        type: 'doc_view',
        titles,
        count,
        isActive: false,
        timestamp,
      })
    }
  })

  return steps.length > 0 ? steps : undefined
}

export function hydrateProcessTimelineToolOutputs(
  processTimeline: MessageProcessStep[] | undefined,
  toolCalls: ToolCallRecord[] | null | undefined,
): MessageProcessStep[] | undefined {
  if (!processTimeline?.length || !toolCalls?.length) return processTimeline

  const toolCallsById = new Map<string, ToolCallRecord>()
  const toolCallsByName = new Map<string, ToolCallRecord[]>()
  for (const toolCall of toolCalls) {
    if (toolCall.toolCallId) toolCallsById.set(toolCall.toolCallId, toolCall)
    const sameName = toolCallsByName.get(toolCall.name) ?? []
    sameName.push(toolCall)
    toolCallsByName.set(toolCall.name, sameName)
  }

  const nextNameIndex = new Map<string, number>()
  let changed = false
  const hydrated = processTimeline.map((step) => {
    if (step.type !== 'tool_call' || (step.output !== undefined && step.output !== null)) {
      return step
    }

    const toolCall = step.toolCallId
      ? toolCallsById.get(step.toolCallId)
      : takeNextToolCallByName(step.name, toolCallsByName, nextNameIndex)
    if (!toolCall || toolCall.output == null) return step

    changed = true
    return {
      ...step,
      input: step.input ?? toolCall.input,
      output: toolCall.output,
      durationMs: step.durationMs ?? toolCall.durationMs,
    }
  })

  return changed ? hydrated : processTimeline
}

function takeNextToolCallByName(
  name: string,
  toolCallsByName: Map<string, ToolCallRecord[]>,
  nextNameIndex: Map<string, number>,
): ToolCallRecord | undefined {
  const calls = toolCallsByName.get(name)
  if (!calls?.length) return undefined
  const index = nextNameIndex.get(name) ?? 0
  nextNameIndex.set(name, index + 1)
  return calls[index]
}
