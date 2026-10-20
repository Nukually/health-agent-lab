import type { ContentBlock, LLMMessage } from '../api/types.js'

const SYSTEM_REMINDER_PREFIX_PATTERN = /^(<system-reminder>[\s\S]*?<\/system-reminder>)\s*/
const SYSTEM_REMINDER_CLOSE_PATTERN = /<\/system-reminder>\s*$/i

export function shouldAppendMemoryRecallEphemerally(memoryEnablePersist: boolean): boolean {
  return !memoryEnablePersist
}

export function shouldPersistMemoryRecallContext(memoryEnablePersist: boolean): boolean {
  return memoryEnablePersist
}

export function appendEphemeralContextsToLatestUser(
  messages: LLMMessage[],
  contexts: Array<string | null | undefined>,
): LLMMessage[] {
  const prefixBody = buildContextBody(contexts)
  if (!prefixBody) return messages

  let lastUserIdx = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      lastUserIdx = i
      break
    }
  }
  if (lastUserIdx < 0) return messages

  const original = messages[lastUserIdx]
  const result = [...messages]

  result[lastUserIdx] = {
    ...original,
    content: prependContextsToUserContent(original.content, contexts),
  }

  return result
}

export function prependContextsToUserContent(
  content: LLMMessage['content'],
  contexts: Array<string | null | undefined>,
): LLMMessage['content'] {
  const prefixBody = buildContextBody(contexts)
  if (!prefixBody) return content

  if (typeof content === 'string') {
    return prependContextToUserText(content, prefixBody)
  }

  if (Array.isArray(content)) {
    const blocks = [...content] as ContentBlock[]
    const firstTextIdx = blocks.findIndex((b) => b.type === 'text')
    if (firstTextIdx >= 0) {
      const textBlock = blocks[firstTextIdx] as { type: 'text'; text: string }
      blocks[firstTextIdx] = { type: 'text', text: prependContextToUserText(textBlock.text ?? '', prefixBody) }
    } else {
      blocks.unshift({ type: 'text', text: wrapContextInSystemReminder(prefixBody) })
    }
    return blocks
  }

  return content
}

function buildContextBody(contexts: Array<string | null | undefined>): string {
  return contexts
    .map((context) => context?.trim())
    .filter((context): context is string => !!context)
    .join('\n\n')
}

function prependContextToUserText(text: string, context: string): string {
  const systemReminder = text.match(SYSTEM_REMINDER_PREFIX_PATTERN)
  if (systemReminder) {
    const userText = text.slice(systemReminder[0].length)
    const reminderWithContext = appendContextToSystemReminder(systemReminder[1], context)
    return userText
      ? `${reminderWithContext}\n\n${userText}`
      : reminderWithContext
  }

  const reminderWithContext = wrapContextInSystemReminder(context)
  return text ? `${reminderWithContext}\n\n${text}` : reminderWithContext
}

function wrapContextInSystemReminder(context: string): string {
  return `<system-reminder>\n${context}\n</system-reminder>`
}

function appendContextToSystemReminder(systemReminder: string, context: string): string {
  const beforeClosingTag = systemReminder.replace(SYSTEM_REMINDER_CLOSE_PATTERN, '').trimEnd()
  const separator = /<system-reminder>\s*$/i.test(beforeClosingTag) ? '\n' : '\n\n'
  return `${beforeClosingTag}${separator}${context}\n</system-reminder>`
}
