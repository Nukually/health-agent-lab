import type { MessageImageAttachment, MessageRecord } from '@health-agent/shared'

const OPTIMISTIC_USER_MESSAGE_MATCH_WINDOW_MS = 2 * 60 * 1000

// 用 assetId 而非 images 比较：images 是每次现签的 OSS 签名 URL，
// 乐观消息与服务端回传消息的签名串必然不同；assetId 是稳定的 DB 主键。
function imageAttachmentsEqual(
  a?: MessageImageAttachment[],
  b?: MessageImageAttachment[],
): boolean {
  const left = a ?? []
  const right = b ?? []
  if (left.length !== right.length) return false
  return left.every((value, index) => value.assetId === right[index]?.assetId)
}

function messageTimesAreClose(a: string, b: string): boolean {
  const left = Date.parse(a)
  const right = Date.parse(b)
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false
  return Math.abs(left - right) <= OPTIMISTIC_USER_MESSAGE_MATCH_WINDOW_MS
}

function canReplaceOptimisticUserMessage(
  current: MessageRecord,
  latest: MessageRecord,
): boolean {
  return current.role === 'user'
    && latest.role === 'user'
    && !current.synthetic
    && current.content === latest.content
    && imageAttachmentsEqual(current.imageAttachments, latest.imageAttachments)
    && messageTimesAreClose(current.createdAt, latest.createdAt)
}

function normalizedText(value?: string | null): string {
  return (value ?? '').replace(/\s+/g, ' ').trim()
}

function normalizedThinking(value?: string | null): string {
  return normalizedText(value)
}

function textsAreSameOrExtended(current: string, latest: string): boolean {
  const currentText = normalizedText(current)
  const latestText = normalizedText(latest)
  if (currentText === latestText) return true
  if (!currentText || !latestText) return true

  // 用户点击「停止生成」后，本地会立即把已渲染的截断内容落成一条
  // optimistic interrupted assistant；后端可能又多持久化了极少量已在
  // 网络缓冲里的 token。这里允许前后缀关系，避免移动端 native 定时
  // revalidate 时把同一条中断回复再 append 一次。
  const shorter = currentText.length <= latestText.length ? currentText : latestText
  const longer = currentText.length <= latestText.length ? latestText : currentText
  return shorter.length >= 8 && longer.startsWith(shorter)
}

function thinkingIsSameOrExtended(current?: string | null, latest?: string | null): boolean {
  const currentThinking = normalizedThinking(current)
  const latestThinking = normalizedThinking(latest)
  if (currentThinking === latestThinking) return true
  if (!currentThinking || !latestThinking) return true
  return latestThinking.startsWith(currentThinking) || currentThinking.startsWith(latestThinking)
}

function normalizeMessageForComparison(message: MessageRecord) {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    images: message.images ?? [],
    thinking: message.thinking ?? null,
    toolCalls: message.toolCalls ?? null,
    processTimeline: message.processTimeline ?? null,
    processDurationMs: message.processDurationMs ?? null,
    outputTps: message.outputTps ?? null,
    createdAt: message.createdAt,
    errorCode: message.errorCode ?? null,
    retriedOnce: message.retriedOnce === true,
    interrupted: message.interrupted === true,
    synthetic: message.synthetic === true,
    syntheticDocs: message.syntheticDocs ?? [],
    syntheticCommunicationCards: message.syntheticCommunicationCards ?? [],
  }
}

function messageRecordsAreEquivalent(current: MessageRecord, latest: MessageRecord): boolean {
  return JSON.stringify(normalizeMessageForComparison(current)) === JSON.stringify(normalizeMessageForComparison(latest))
}

export function canReplaceInterruptedAssistantMessage(
  current: MessageRecord,
  latest: MessageRecord,
): boolean {
  return current.role === 'assistant'
    && latest.role === 'assistant'
    && current.interrupted === true
    && latest.interrupted === true
    && textsAreSameOrExtended(current.content, latest.content)
    && thinkingIsSameOrExtended(current.thinking, latest.thinking)
    && messageTimesAreClose(current.createdAt, latest.createdAt)
}

export function appendOrReplaceInterruptedAssistantMessage(
  messages: MessageRecord[],
  message: MessageRecord,
): MessageRecord[] {
  const last = messages[messages.length - 1]
  if (last && canReplaceInterruptedAssistantMessage(last, message)) {
    return [...messages.slice(0, -1), message]
  }
  return [...messages, message]
}

function findOptimisticUserMessageIndex(
  merged: MessageRecord[],
  latestMessage: MessageRecord,
  lowerBound: number,
  upperBound: number,
  usedIndexes: Set<number>,
): number {
  for (let index = upperBound - 1; index > lowerBound; index--) {
    if (usedIndexes.has(index)) continue
    if (canReplaceOptimisticUserMessage(merged[index], latestMessage)) {
      return index
    }
  }
  return -1
}

function findOptimisticInterruptedAssistantMessageIndex(
  merged: MessageRecord[],
  latestMessage: MessageRecord,
  lowerBound: number,
  upperBound: number,
  usedIndexes: Set<number>,
): number {
  for (let index = upperBound - 1; index > lowerBound; index--) {
    if (usedIndexes.has(index)) continue
    if (canReplaceInterruptedAssistantMessage(merged[index], latestMessage)) {
      return index
    }
  }
  return -1
}

export function mergeLatestSessionMessages(
  current: MessageRecord[],
  latest: MessageRecord[],
): MessageRecord[] {
  if (latest.length === 0) return current
  if (current.length === 0) return latest

  const latestById = new Map(latest.map((message) => [message.id, message]))
  const merged = current.map((message) => {
    const latestMessage = latestById.get(message.id)
    if (!latestMessage) return message
    return messageRecordsAreEquivalent(message, latestMessage) ? message : latestMessage
  })
  const existingIds = new Set(merged.map((message) => message.id))
  const replacedIndexes = new Set<number>()
  const appended: MessageRecord[] = []
  let didChange = merged.some((message, index) => message !== current[index])
  let previousKnownIndex = -1

  latest.forEach((message, latestIndex) => {
    if (existingIds.has(message.id)) {
      previousKnownIndex = merged.findIndex((currentMessage) => currentMessage.id === message.id)
      return
    }

    if (message.role === 'user') {
      const nextKnownMessage = latest
        .slice(latestIndex + 1)
        .find((candidate) => existingIds.has(candidate.id))
      const nextKnownIndex = nextKnownMessage
        ? merged.findIndex((currentMessage) => currentMessage.id === nextKnownMessage.id)
        : -1
      const upperBound = nextKnownIndex >= 0 ? nextKnownIndex : merged.length
      const matchIndex = findOptimisticUserMessageIndex(
        merged,
        message,
        previousKnownIndex,
        upperBound,
        replacedIndexes,
      )

      if (matchIndex >= 0) {
        merged[matchIndex] = message
        existingIds.add(message.id)
        replacedIndexes.add(matchIndex)
        previousKnownIndex = matchIndex
        didChange = true
        return
      }
    }

    if (message.role === 'assistant' && message.interrupted) {
      const nextKnownMessage = latest
        .slice(latestIndex + 1)
        .find((candidate) => existingIds.has(candidate.id))
      const nextKnownIndex = nextKnownMessage
        ? merged.findIndex((currentMessage) => currentMessage.id === nextKnownMessage.id)
        : -1
      const upperBound = nextKnownIndex >= 0 ? nextKnownIndex : merged.length
      const matchIndex = findOptimisticInterruptedAssistantMessageIndex(
        merged,
        message,
        previousKnownIndex,
        upperBound,
        replacedIndexes,
      )

      if (matchIndex >= 0) {
        merged[matchIndex] = message
        existingIds.add(message.id)
        replacedIndexes.add(matchIndex)
        previousKnownIndex = matchIndex
        didChange = true
        return
      }
    }

    appended.push(message)
    existingIds.add(message.id)
  })

  if (appended.length === 0) {
    return didChange ? merged : current
  }
  return [...merged, ...appended]
}
