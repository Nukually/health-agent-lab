/**
 * Token Estimation — 粗略估算 context window 使用量
 *
 * 策略：4 字符/token（同 Claude Code），每张图片 ~1600 tokens。
 * 有意偏保守（宁可高估不低估）。
 * 注意：messages.tokenCount 并不总是"这条消息自身的上下文占用"。
 * 特别是 assistant 行落库的 tokenCount 来自整轮 LLM usage（含整个输入上下文），
 * 不能直接拿来估算后续请求的 message tokens，否则会反复误判需要压缩。
 */

import type { ToolCallRecord } from '@health-agent/shared'
import type { ChatMessage } from '../state/session.js'

const CHARS_PER_TOKEN = 4
const TOKENS_PER_IMAGE = 1600

export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

/**
 * 估算单条消息的 token 数。
 * - assistant：按可回放给 LLM 的 content/tool_calls 重新估算，不能信任落库 tokenCount
 * - 其他 role：优先使用已知 tokenCount，否则按内容规则估算
 * 处理多模态内容（可能是 string 或 ContentBlock[]，也可能是 DB 中的 JSON 字符串）。
 */
export function estimateMessageTokens(message: ChatMessage): number {
  if (message.role === 'assistant') {
    return estimateAssistantMessageTokens(message)
  }

  if (message.tokenCount && message.tokenCount > 0) {
    return message.tokenCount
  }

  return estimateMessageContentTokens(message.content)
}

function estimateAssistantMessageTokens(message: ChatMessage): number {
  return estimateMessageContentTokens(message.content) + estimateAssistantToolCallsTokens(message.toolCalls)
}

function estimateAssistantToolCallsTokens(toolCalls: ChatMessage['toolCalls']): number {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    return 0
  }

  return toolCalls.reduce<number>((sum, toolCall) => sum + estimateSingleToolCallTokens(toolCall), 0)
}

function estimateSingleToolCallTokens(toolCall: unknown): number {
  if (!toolCall || typeof toolCall !== 'object') {
    return estimateTextTokens(String(toolCall ?? ''))
  }

  const nativeToolCall = toolCall as {
    id?: unknown
    type?: unknown
    function?: { name?: unknown; arguments?: unknown }
  }
  if (nativeToolCall.function && typeof nativeToolCall.function === 'object') {
    const name = typeof nativeToolCall.function.name === 'string' ? nativeToolCall.function.name : ''
    const args = typeof nativeToolCall.function.arguments === 'string'
      ? nativeToolCall.function.arguments
      : JSON.stringify(nativeToolCall.function.arguments ?? '')
    const id = typeof nativeToolCall.id === 'string' ? nativeToolCall.id : ''

    return estimateTextTokens(JSON.stringify({
      id,
      type: 'function',
      function: { name, arguments: args },
    }))
  }

  const record = toolCall as ToolCallRecord
  if (typeof record.name === 'string') {
    const args = typeof record.rawArguments === 'string'
      ? record.rawArguments
      : record.input == null
        ? ''
        : JSON.stringify(record.input)
    const id = typeof record.toolCallId === 'string' ? record.toolCallId : ''

    return estimateTextTokens(JSON.stringify({
      id,
      type: 'function',
      function: { name: record.name, arguments: args },
    }))
  }

  return estimateTextTokens(JSON.stringify(toolCall))
}

function estimateMessageContentTokens(content: ChatMessage['content']): number {
  const rawContent = content

  if (typeof rawContent === 'string') {
    // DB 中多模态消息以 JSON 字符串存储，如 [{"type":"text",...},{"type":"image_url",...}]
    if (rawContent.startsWith('[')) {
      try {
        const parsed = JSON.parse(rawContent)
        if (Array.isArray(parsed)) {
          return estimateContentBlocks(parsed)
        }
      } catch { /* fall through to plain text estimate */ }
    }
    return estimateTextTokens(rawContent)
  }

  if (Array.isArray(rawContent)) {
    return estimateContentBlocks(rawContent)
  }

  return 0
}

function estimateContentBlocks(
  blocks: Array<{ type: string; text?: string; image_url?: { url: string } }>,
): number {
  let tokens = 0
  for (const block of blocks) {
    if (block.type === 'text') {
      tokens += estimateTextTokens(block.text || '')
    } else if (block.type === 'image_url') {
      tokens += TOKENS_PER_IMAGE
    }
  }
  return tokens
}

export function estimateMessagesTokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0)
}

/**
 * 估算一次请求的完整 context 使用量：系统提示词 + 消息 + 输出预留。
 */
export function estimateSessionContext(
  systemPrompt: string,
  messages: ChatMessage[],
  maxOutputTokens = 8000,
): number {
  return estimateTextTokens(systemPrompt) + estimateMessagesTokens(messages) + maxOutputTokens
}
