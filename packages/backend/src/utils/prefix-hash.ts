/**
 * Prefix Hash — 发给 LLM 的 (system + messages + tools) 字节级指纹
 *
 * 用于验证"多轮对话 LLM prefix 严格不变"这条铁律（见 CLAUDE.md）。
 * JSON.stringify 对 LLMMessage 的字段集合是确定性的：role/content/tool_call_id/tool_calls
 * 都是固定 key，内容里没有 Map/Set/Symbol 等不可序列化结构。
 */

import { createHash } from 'node:crypto'
import type { LLMMessage, ToolDefinition } from '../api/types.js'

export function hashLLMPayload(
  system: string,
  messages: LLMMessage[],
  tools?: Array<Pick<ToolDefinition, 'type' | 'function'>>,
): string {
  const payload = JSON.stringify({ system, messages, tools: tools ?? [] })
  return createHash('sha256').update(payload).digest('hex')
}
