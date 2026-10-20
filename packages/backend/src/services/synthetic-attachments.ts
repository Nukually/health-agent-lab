import {
  SYNTHETIC_TOOL_ATTACHMENT_MARKER,
  hasSyntheticToolAttachmentMarker,
} from '../utils/repeated-user-message.js'

type ContentBlock = { type: string; text?: string; image_url?: { url: string } }

interface SyntheticDocMeta {
  docId: string | null
  shortId: string | null
  title: string | null
  imageCount: number
}

interface SyntheticCardMeta {
  cardId: string | null
  shortId: string | null
  title: string | null
}

export type PruneSyntheticMedicalDocumentAttachmentResult =
  | { changed: false }
  | {
      changed: true
      removeMessage: boolean
      content?: string
      removedImageCount: number
    }

const SYNTHETIC_META_PATTERN = /<tool-attachment-meta>([\s\S]*?)<\/tool-attachment-meta>/
const SYNTHETIC_META_CLOSE_TAG = '</tool-attachment-meta>'
const SYSTEM_REMINDER_CLOSE_TAG = '</system-reminder>'
const TOOL_ATTACHED_MEDICAL_IMAGE_READING_BOUNDARY = `病历原图解读边界：
- 涉及诊断时长、用药时长、治疗阶段、报告新旧、"最近/既往/术后多久"等时间判断时，必须和本轮上下文里的"当前时间(今天)"对比；不要使用模型内置日期，也不要只凭报告模板或上传时间推断。
- 图片里模糊、遮挡、反光、裁切不完整或手写体难以辨认的内容，要坦诚说明"这部分看不清/无法确认"，不要猜测、补全或把不确定内容说成事实；不影响回答的模糊内容可以省略。
- 若图片里有明显异常、少见或疑似录入错误的数字、单位、阳性/阴性或结论，必须按图片可见原文转述，并提醒用户和医生/报告出具方核对；不要擅自改成你认为正确或常见的值，也不要让回复与病历原文冲突。`

function parseContentBlocks(content: string): ContentBlock[] | null {
  if (!content.startsWith('[')) return null
  try {
    const parsed = JSON.parse(content)
    if (Array.isArray(parsed) && parsed.every((block) => block && typeof block === 'object' && 'type' in block)) {
      return parsed as ContentBlock[]
    }
  } catch { /* keep as text */ }
  return null
}

function normalizeImageCount(value: unknown): number {
  return Number.isFinite(value)
    ? Math.max(0, Math.floor(Number(value)))
    : 0
}

function parseMeta(text: string): { docs: SyntheticDocMeta[]; cards: SyntheticCardMeta[] } | null {
  const metaMatch = text.match(SYNTHETIC_META_PATTERN)
  if (!metaMatch) return null

  try {
    const parsed = JSON.parse(metaMatch[1]) as {
      docs?: unknown[]
      communicationCards?: unknown[]
    }
    const docs = Array.isArray(parsed.docs)
      ? parsed.docs.map((raw) => {
          const doc = raw as Record<string, unknown>
          return {
            docId: typeof doc.docId === 'string' ? doc.docId : null,
            shortId: typeof doc.shortId === 'string'
              ? doc.shortId
              : typeof doc.shortId === 'number'
                ? String(doc.shortId)
                : null,
            title: typeof doc.title === 'string' || doc.title === null ? doc.title : null,
            imageCount: normalizeImageCount(doc.imageCount),
          }
        })
      : []
    const cards = Array.isArray(parsed.communicationCards)
      ? parsed.communicationCards.map((raw) => {
          const card = raw as Record<string, unknown>
          return {
            cardId: typeof card.cardId === 'string' ? card.cardId : null,
            shortId: typeof card.shortId === 'string' ? card.shortId : null,
            title: typeof card.title === 'string' || card.title === null ? card.title : null,
          }
        })
      : []

    return { docs, cards }
  } catch {
    return null
  }
}

function extractQuestionTail(text: string): string {
  const metaEnd = text.indexOf(SYNTHETIC_META_CLOSE_TAG)
  if (metaEnd < 0) return '请结合这些资料回答用户上一条问题。'

  const afterMeta = text.slice(metaEnd + SYNTHETIC_META_CLOSE_TAG.length)
  const reminderEnd = afterMeta.lastIndexOf(SYSTEM_REMINDER_CLOSE_TAG)
  const tail = reminderEnd >= 0 ? afterMeta.slice(0, reminderEnd) : afterMeta
  return tail.trim() || '请结合这些资料回答用户上一条问题。'
}

function renderDocTitle(doc: SyntheticDocMeta): string {
  return `${doc.shortId ? `[${doc.shortId}] ` : ''}${doc.title ?? '未命名文档'}`
}

function renderCardTitle(card: SyntheticCardMeta): string {
  return `${card.shortId ? `[${card.shortId}] ` : ''}${card.title ?? '未命名卡片'}`
}

function buildReminderText(
  docs: SyntheticDocMeta[],
  cards: SyntheticCardMeta[],
  questionTail: string,
): string {
  const totalImageCount = docs.reduce((sum, doc) => sum + doc.imageCount, 0)
  const docTitles = docs.map(renderDocTitle).join('、')
  const cardTitles = cards.map(renderCardTitle).join('、')
  const sourceLines = [
    totalImageCount > 0
      ? `以下 ${totalImageCount} 张图片来自 saved_content 工具读取的病历原图（${docTitles}），由系统自动附加，不是用户主动发送的内容。请结合这些图片内容回答用户的问题。`
      : null,
    cards.length > 0
      ? `以下 ${cards.length} 张医患沟通卡片引用来自 saved_content 工具（${cardTitles}），卡片 markdown 原文已在上一条 tool_result 中返回；这里的引用仅用于前端展示可点击卡片。`
      : null,
  ].filter(Boolean).join('\n')
  const readingBoundary = totalImageCount > 0
    ? `\n${TOOL_ATTACHED_MEDICAL_IMAGE_READING_BOUNDARY}\n`
    : ''
  const attachmentMeta = JSON.stringify({
    docs: docs.map((doc) => ({
      docId: doc.docId,
      shortId: doc.shortId,
      title: doc.title,
      imageCount: doc.imageCount,
    })),
    communicationCards: cards.map((card) => ({
      cardId: card.cardId,
      shortId: card.shortId,
      title: card.title,
    })),
  })
  const reminderBody = `${SYNTHETIC_TOOL_ATTACHMENT_MARKER}\n${sourceLines}${readingBoundary}\n<tool-attachment-meta>${attachmentMeta}</tool-attachment-meta>\n\n${questionTail}`
  return `<system-reminder>\n${reminderBody}\n</system-reminder>`
}

export function pruneSyntheticMedicalDocumentAttachmentContent(
  content: string,
  opts: { docId: string; imageIndex?: number },
): PruneSyntheticMedicalDocumentAttachmentResult {
  if (!hasSyntheticToolAttachmentMarker(content)) return { changed: false }

  const blocks = parseContentBlocks(content)
  const textBlockIndex = blocks?.findIndex((block) => block.type === 'text' && typeof block.text === 'string') ?? -1
  const text = blocks
    ? textBlockIndex >= 0 ? blocks[textBlockIndex].text ?? '' : ''
    : content
  if (!hasSyntheticToolAttachmentMarker(text)) return { changed: false }

  const meta = parseMeta(text)
  if (!meta) return { changed: false }

  let cursor = 0
  let found = false
  let removedImageCount = 0
  const imageOrdinalsToRemove = new Set<number>()
  const nextDocs: SyntheticDocMeta[] = []

  for (const doc of meta.docs) {
    const imageCount = doc.imageCount
    if (doc.docId !== opts.docId) {
      nextDocs.push(doc)
      cursor += imageCount
      continue
    }

    found = true
    if (opts.imageIndex == null) {
      for (let offset = 0; offset < imageCount; offset++) {
        imageOrdinalsToRemove.add(cursor + offset)
      }
      removedImageCount += imageCount
      cursor += imageCount
      continue
    }

    if (opts.imageIndex < imageCount) {
      imageOrdinalsToRemove.add(cursor + opts.imageIndex)
      removedImageCount += 1
      const nextImageCount = imageCount - 1
      if (nextImageCount > 0) {
        nextDocs.push({ ...doc, imageCount: nextImageCount })
      }
    } else {
      nextDocs.push(doc)
    }
    cursor += imageCount
  }

  if (!found || (opts.imageIndex != null && removedImageCount === 0)) {
    return { changed: false }
  }

  if (nextDocs.length === 0 && meta.cards.length === 0) {
    return { changed: true, removeMessage: true, removedImageCount }
  }

  const nextText = buildReminderText(nextDocs, meta.cards, extractQuestionTail(text))
  if (!blocks) {
    return {
      changed: true,
      removeMessage: false,
      content: nextText,
      removedImageCount,
    }
  }

  let imageOrdinal = 0
  const nextBlocks = blocks.flatMap((block, index) => {
    if (index === textBlockIndex) return [{ ...block, text: nextText }]
    if (block.type !== 'image_url') return [block]

    const currentImageOrdinal = imageOrdinal
    imageOrdinal += 1
    return imageOrdinalsToRemove.has(currentImageOrdinal) ? [] : [block]
  })

  return {
    changed: true,
    removeMessage: false,
    content: JSON.stringify(nextBlocks),
    removedImageCount,
  }
}
