import type { CommunicationCardPromptSummary } from '../../../services/communication-card.js'

const UPDATE_TIME_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

export interface CommunicationCardsContextResult {
  text: string
  /** c-* 短 ID → UUID 映射；executor 用它把 LLM 传入的 c-1/c-2 还原为 UUID */
  cardIdMap: Map<string, string>
}

function formatShanghaiMinute(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso

  const parts = Object.fromEntries(
    UPDATE_TIME_FMT.formatToParts(date).map((part) => [part.type, part.value]),
  )
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim() || '未命名'
}

function updaterLabel(updater: 'ai' | 'user'): string {
  return updater === 'user' ? '用户' : 'AI'
}

function renderCardPreviewLine(
  card: CommunicationCardPromptSummary['cards'][number],
  index: number,
): string {
  const shortId = `c-${index + 1}`
  return `  ${index + 1}. [${shortId}] 《${oneLine(card.title)}》｜更新时间：${formatShanghaiMinute(card.updatedAt)}｜最终更新人：${updaterLabel(card.finalUpdatedBy)}`
}

export function communicationCardsContext(
  summary?: CommunicationCardPromptSummary | null,
): CommunicationCardsContextResult {
  const total = summary?.totalCount ?? 0
  const cards = summary?.cards ?? []
  const cardIdMap = new Map<string, string>()
  const lines = [
    '## 已保存医患沟通卡片',
    `- 总数：${total} 张。`,
  ]

  if (!cards.length) {
    lines.push('- 当前暂无已保存卡片。')
    return { text: lines.join('\n'), cardIdMap }
  }

  cards.forEach((card, index) => {
    const shortId = `c-${index + 1}`
    cardIdMap.set(shortId, card.id)
  })

  lines.push('- 编号按更新时间倒序生成；新会话通过 saved_content 的 list/read 读取原文，c-* 编号仅用于历史上下文兼容。')
  lines.push(`- 卡片编号范围：c-1 到 c-${cards.length} 都有效；若用户询问未预览的中间编号，新会话应先调用 saved_content list。`)

  if (cards.length <= 6) {
    lines.push(`- 全部 ${cards.length} 张（列标题、更新时间、最终更新人）：`)
    cards.forEach((card, index) => {
      lines.push(renderCardPreviewLine(card, index))
    })
  } else {
    lines.push('- 预览：最近更新的 5 张 + 最早更新的 1 张（中间省略，仍可按编号读取）：')
    cards.slice(0, 5).forEach((card, index) => {
      lines.push(renderCardPreviewLine(card, index))
    })
    lines.push(`  ... 中间 ${cards.length - 6} 张省略（c-6 到 c-${cards.length - 1} 仍可读取）`)
    lines.push(renderCardPreviewLine(cards[cards.length - 1], cards.length - 1))
  }
  lines.push('- 最终更新人说明：若当前卡片有任一字段由用户手动修改，记为“用户”；否则记为“AI”。')

  return { text: lines.join('\n'), cardIdMap }
}
