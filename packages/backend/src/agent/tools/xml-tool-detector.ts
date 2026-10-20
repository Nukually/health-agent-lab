export const XML_TOOL_CALL_VIOLATION_REASON = 'xml_tool_call_in_final_answer' as const

export interface XmlToolCallViolation {
  reason: typeof XML_TOOL_CALL_VIOLATION_REASON
  toolName: string
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export class XmlToolCallDetector {
  private readonly visibleToolNamePattern: RegExp | null
  private readonly bareParameterTagToolName: string | null
  private readonly maxBufferChars: number
  private buffer = ''

  constructor(toolNames: readonly string[], maxBufferChars = 512) {
    const names = [...new Set(toolNames)].filter(Boolean)
    this.maxBufferChars = maxBufferChars
    this.bareParameterTagToolName = names.includes('propose_check_in_record')
      ? 'propose_check_in_record'
      : names.includes('propose_check_in_draft')
        ? 'propose_check_in_draft'
        : null
    const alternatives = names.map(escapeRegExp).join('|')
    // Tool names are internal protocol tokens. In user-visible TEXT_DELTA,
    // any exact active tool name means the model hand-wrote a tool call or leaked internals.
    this.visibleToolNamePattern = names.length > 0
      ? new RegExp(`(?:^|[^A-Za-z0-9_.$-])(${alternatives})(?![A-Za-z0-9_-])`)
      : null
  }

  push(chunk: string): XmlToolCallViolation | null {
    if (!this.visibleToolNamePattern || !chunk) return null

    this.buffer += chunk
    const match = this.visibleToolNamePattern.exec(this.buffer)
    if (match?.[1]) {
      return {
        reason: XML_TOOL_CALL_VIOLATION_REASON,
        toolName: match[1],
      }
    }

    if (
      this.bareParameterTagToolName &&
      /<parameter\s+name=["'](?:categoryQuery|draftValues|recordedAt|sourceText|draftNote|draftTags)["']\s*>/i.test(this.buffer)
    ) {
      return {
        reason: XML_TOOL_CALL_VIOLATION_REASON,
        toolName: this.bareParameterTagToolName,
      }
    }

    if (this.buffer.length > this.maxBufferChars) {
      this.buffer = this.buffer.slice(-this.maxBufferChars)
    }
    return null
  }
}
