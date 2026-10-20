import type { ChatMessage } from '../state/session.js'
import { stripSystemReminderText } from './system-reminder.js'

/**
 * 与 saved_content 合成 user 消息 marker 保持一致。
 * 该类消息由系统自动插入，不能参与“用户是否连续发送相同消息”的判断。
 */
export const SYNTHETIC_TOOL_ATTACHMENT_MARKER = '[tool-attachment:saved_content]'
export const LEGACY_SYNTHETIC_TOOL_ATTACHMENT_MARKER = '[tool-attachment:read_medical_documents]'
export const SYNTHETIC_SCHEDULED_TODO_TRIGGER_MARKER = '[scheduled-todo:trigger]'

export function hasSyntheticToolAttachmentMarker(text: string): boolean {
  return text.includes(SYNTHETIC_TOOL_ATTACHMENT_MARKER) ||
    text.includes(LEGACY_SYNTHETIC_TOOL_ATTACHMENT_MARKER)
}

export function hasSyntheticScheduledTodoTriggerMarker(text: string): boolean {
  return text.includes(SYNTHETIC_SCHEDULED_TODO_TRIGGER_MARKER)
}

export function hasSyntheticHiddenUserMarker(text: string): boolean {
  return hasSyntheticToolAttachmentMarker(text) || hasSyntheticScheduledTodoTriggerMarker(text)
}

interface RealUserMessageSignature {
  text: string
  imageUrls: string[]
  serialized: string
}

export function extractMessageTextContent(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content
  return (content.find((b: any) => b?.type === 'text') as any)?.text ?? ''
}

function extractImageUrls(content: ChatMessage['content']): string[] {
  if (typeof content === 'string') return []
  return content
    .map((b: any) => b?.image_url?.url)
    .filter((url): url is string => typeof url === 'string' && url.length > 0)
}

export function isSyntheticToolAttachmentUserMessage(message: ChatMessage): boolean {
  if (message.role !== 'user') return false
  return hasSyntheticToolAttachmentMarker(extractMessageTextContent(message.content))
}

function getRealUserMessageSignature(message: ChatMessage): RealUserMessageSignature | null {
  if (message.role !== 'user') return null
  if (hasSyntheticHiddenUserMarker(extractMessageTextContent(message.content))) return null

  const text = stripSystemReminderText(extractMessageTextContent(message.content)).trim()
  const imageUrls = extractImageUrls(message.content)
  if (!text && imageUrls.length === 0) return null

  return {
    text,
    imageUrls,
    serialized: JSON.stringify({ text, imageUrls }),
  }
}

export function findLatestRealUserMessageIndex(
  messages: ChatMessage[],
  beforeExclusive = messages.length,
): number {
  for (let i = Math.min(beforeExclusive, messages.length) - 1; i >= 0; i--) {
    if (getRealUserMessageSignature(messages[i])) return i
  }
  return -1
}

export function areLatestTwoRealUserMessagesIdentical(messages: ChatMessage[]): boolean {
  const latestIdx = findLatestRealUserMessageIndex(messages)
  if (latestIdx < 0) return false

  const previousIdx = findLatestRealUserMessageIndex(messages, latestIdx)
  if (previousIdx < 0) return false

  const latest = getRealUserMessageSignature(messages[latestIdx])
  const previous = getRealUserMessageSignature(messages[previousIdx])
  return !!latest && !!previous && latest.serialized === previous.serialized
}

export function countRealUserMessages(messages: ChatMessage[]): number {
  return messages.reduce((count, message) => (
    getRealUserMessageSignature(message) ? count + 1 : count
  ), 0)
}

export function extractLatestRealUserMessageText(messages: ChatMessage[]): string {
  const idx = findLatestRealUserMessageIndex(messages)
  if (idx < 0) return ''
  return getRealUserMessageSignature(messages[idx])?.text ?? ''
}
