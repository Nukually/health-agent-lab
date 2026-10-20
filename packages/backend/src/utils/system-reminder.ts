/**
 * system-reminder 辅助工具
 *
 * 核心原则：多轮对话发给 LLM 的 prefix 只在 compaction 时才允许变化。
 * 为此 reminder 必须在 user 消息"首次发送给 LLM 时"固化进 content 并落库；
 * 下一轮加载该条 user 时，它已经带着自己首次注入的那一版 reminder，prefix 稳定。
 * 对外展示（UI / 分享 / 导出）统一 strip 掉 <system-reminder> 块。
 */

const REMINDER_PATTERN = /^<system-reminder>[\s\S]*?<\/system-reminder>\s*/

export function hasSystemReminder(text: string): boolean {
  return REMINDER_PATTERN.test(text)
}

export function stripSystemReminderText(text: string): string {
  return text.replace(REMINDER_PATTERN, '')
}

/**
 * 构造注入 reminder 后的 content（字符串或多模态数组）。
 * 已带 reminder 时原样返回，保证幂等、防重复组装。
 */
export function applyReminderToContent(
  content: string | Array<{ type: string; text?: string; image_url?: { url: string; detail?: string } }>,
  reminderBody: string,
): string | Array<{ type: string; text?: string; image_url?: { url: string; detail?: string } }> {
  if (!reminderBody) return content
  const wrapper = `<system-reminder>\n${reminderBody}\n</system-reminder>\n\n`
  if (typeof content === 'string') {
    return hasSystemReminder(content) ? content : wrapper + content
  }
  const blocks = [...content]
  const firstTextIdx = blocks.findIndex((b) => b.type === 'text')
  if (firstTextIdx >= 0) {
    const original = blocks[firstTextIdx].text ?? ''
    if (hasSystemReminder(original)) return content
    blocks[firstTextIdx] = { ...blocks[firstTextIdx], text: wrapper + original }
  } else {
    blocks.unshift({ type: 'text', text: wrapper })
  }
  return blocks
}

/** 判断内容已注入 reminder —— 兼容字符串与多模态 */
export function contentHasReminder(
  content: string | Array<{ type: string; text?: string }>,
): boolean {
  if (typeof content === 'string') return hasSystemReminder(content)
  const firstText = content.find((b) => b.type === 'text')
  return !!firstText?.text && hasSystemReminder(firstText.text)
}
