import type { CheckInSchemaRecord } from '@health-agent/shared'
import type { CheckInDraftCardPromptSummary } from '../../../services/check-in.js'

function oneLine(value: unknown, max = 120): string {
  if (value === null || value === undefined) return ''
  const text = typeof value === 'string'
    ? value
    : JSON.stringify(value)
  return text.replace(/\s+/g, ' ').trim().slice(0, max)
}

function fieldValueForPrompt(value: unknown): string {
  if (value && typeof value === 'object' && !Array.isArray(value) && 'value' in value) {
    return fieldValueForPrompt((value as { value?: unknown }).value)
  }
  if (Array.isArray(value)) return value.map((item) => oneLine(item, 40)).filter(Boolean).join('、') || '未填'
  return oneLine(value, 80) || '未填'
}

export function checkInDraftCardsContext(cards?: CheckInDraftCardPromptSummary[] | null): string | null {
  if (!cards?.length) return null

  const lines = [
    '### 当前会话未保存打卡卡片',
    '以下卡片尚未保存为正式记录,仅用于判断本轮用户是否在继续修改同一张卡片。',
    '若用户本轮是在修改、补充、替换或重做其中某张未保存卡片,调用打卡工具时必须生成合并后的完整新草稿,并把被替换卡片的 checkInCardId 传入 supersedesCheckInCardId。',
    '若用户是在新增另一条独立记录,不要传 supersedesCheckInCardId。若用户只是要求保存,不要调用打卡工具,请告知需要手动点击卡片里的“保存打卡”。',
  ]

  for (const [index, card] of cards.slice(0, 5).entries()) {
    const recordedAt = card.recordedAt ? card.recordedAt.slice(0, 10) : '未定'
    const fields = card.fields.slice(0, 8).map((field) => {
      const value = fieldValueForPrompt(card.values[field.key])
      return `${field.label}(${field.key})=${value}`
    }).join('；') || '无字段'
    const note = card.note ? `；备注=${oneLine(card.note, 80)}` : ''
    const images = card.attachmentCount > 0 ? `；图片=${card.attachmentCount}张` : ''
    lines.push(`- draft-${index + 1}｜checkInCardId=${card.id}｜分类=${card.categoryName}｜记录日期=${recordedAt}｜字段：${fields}${note}${images}`)
  }

  return lines.join('\n')
}

export function checkInSchemasContext(schemas?: CheckInSchemaRecord[] | null): string {
  const manualSaveBoundary = '用户只说“保存/帮我保存/保存这张/保存上面卡片”且语义是让 Agent 代点卡片保存时,不要调用打卡工具、不要新建重复卡片;你没有权限替用户保存,只能告知用户需要在卡片里核对后手动点击“保存打卡”。'
  if (!schemas?.length) {
    return [
      '### 用户打卡分类',
      `用户尚未创建可复用的打卡分类。若用户要记录新的行为/症状/图片观察/天气/日记/备忘/自定义事项，且本轮或追问后已有足够的分类和核心字段信息，优先调用 propose_check_in_record 生成可编辑待保存卡片草稿；工具未命中已有分类时会自动创建新分类，不要告诉用户“没有找到分类”。用户明确说“记录/记下/保存一下”某个已发生且可回看的事实时，不要只口头说已记下。卡片内容必须严格来自用户输入；用户明说且能映射到字段的内容要逐项填入，不要漏填；严重缺失信息时先追问。未来日期不可生成历史打卡，应转提醒/计划。你不能替用户自动保存，最终只引导用户在卡片里核对后点击保存。${manualSaveBoundary}`,
    ].join('\n')
  }

  const lines = [
    '### 用户打卡分类',
    `以下是用户已有的可复用打卡分类概览。用户继续记录同类内容或记录一个新类别时,先用 get_check_in_schema 读取最匹配分类的完整 schema;命中后调用 propose_check_in_record 必须传 categoryKey,避免把新内容挂到相似但错误的分类。未命中时 propose_check_in_record 会在工具内部创建新分类,不要告诉用户“没有找到分类”。用户明确说“记录/记下/保存一下”某个已发生且可回看的事实时，不要只口头说已记下。draftValues 只能来自用户明确输入；用户明说且能映射到字段的内容要逐项填入，不要漏填；用户本轮描述优先于 schema, schema 只是参考。严重缺失信息时先追问。未来日期不可生成历史打卡，应转提醒/计划。你不能替用户自动保存，最终只引导用户在卡片里核对后点击保存。用户也可以自己点击卡片保存。${manualSaveBoundary}`,
  ]
  for (const [index, schema] of schemas.slice(0, 12).entries()) {
    const description = schema.categoryDescription ? `｜描述：${oneLine(schema.categoryDescription, 120)}` : ''
    const aliases = schema.aliases.length ? `；别名：${schema.aliases.join('、')}` : ''
    const lastUsed = schema.lastUsedAt ? `；最近使用：${schema.lastUsedAt.slice(0, 10)}` : ''
    const mode = schema.displayMode === 'quantitative' ? '趋势图' : '日历'
    lines.push(`- ci-${index + 1}｜${schema.categoryName}｜categoryQuery="${schema.categoryName}"｜categoryKey="${schema.categoryKey}"｜展示：${mode}${description}${aliases}${lastUsed}`)
  }
  return lines.join('\n')
}
