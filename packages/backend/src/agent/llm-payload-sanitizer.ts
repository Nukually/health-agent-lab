import type { LLMMessage } from '../api/types.js'

const VALID_ROLES = new Set(['user', 'assistant', 'system', 'tool'])
const MISSING_TOOL_RESULT_STUB = '[tool_result_unavailable: 上一次工具调用的结果缺失，请基于现有上下文继续；不要重复假设工具已经成功返回。]'

export interface LLMPayloadSanitizeStats {
  droppedInvalidRoleMessages: number
  removedOrphanToolResults: number
  insertedMissingToolResults: number
}

export interface LLMPayloadSanitizeResult {
  messages: LLMMessage[]
  changed: boolean
  stats: LLMPayloadSanitizeStats
}

function getToolCallIds(message: LLMMessage): string[] {
  if (message.role !== 'assistant' || !Array.isArray(message.tool_calls)) return []
  return message.tool_calls
    .map((tc) => tc?.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
}

export function sanitizeLLMPayloadMessages(messages: LLMMessage[]): LLMPayloadSanitizeResult {
  const stats: LLMPayloadSanitizeStats = {
    droppedInvalidRoleMessages: 0,
    removedOrphanToolResults: 0,
    insertedMissingToolResults: 0,
  }

  const roleFiltered = messages.filter((message) => {
    const keep = VALID_ROLES.has((message as { role?: unknown }).role as string)
    if (!keep) stats.droppedInvalidRoleMessages++
    return keep
  })

  const sanitized: LLMMessage[] = []
  for (let i = 0; i < roleFiltered.length; i++) {
    const message = roleFiltered[i]
    const toolCallIds = getToolCallIds(message)

    if (message.role === 'tool') {
      stats.removedOrphanToolResults++
      continue
    }

    sanitized.push(message)
    if (toolCallIds.length === 0) continue

    const expected = new Set(toolCallIds)
    const satisfied = new Set<string>()
    let j = i + 1
    while (j < roleFiltered.length && roleFiltered[j].role === 'tool') {
      const toolMessage = roleFiltered[j]
      const toolCallId = toolMessage.tool_call_id
      if (toolCallId && expected.has(toolCallId) && !satisfied.has(toolCallId)) {
        sanitized.push(toolMessage)
        satisfied.add(toolCallId)
      } else {
        stats.removedOrphanToolResults++
      }
      j++
    }
    i = j - 1

    for (const toolCallId of toolCallIds) {
      if (!satisfied.has(toolCallId)) {
        sanitized.push({
          role: 'tool',
          content: MISSING_TOOL_RESULT_STUB,
          tool_call_id: toolCallId,
        })
        stats.insertedMissingToolResults++
      }
    }
  }

  const changed =
    stats.droppedInvalidRoleMessages > 0 ||
    stats.removedOrphanToolResults > 0 ||
    stats.insertedMissingToolResults > 0

  return { messages: changed ? sanitized : messages, changed, stats }
}
