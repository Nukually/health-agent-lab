/**
 * 历史压缩摘要 — 动态 section
 * 当对话被压缩时注入之前的摘要
 */
export function sessionSummary(summary: string | null): string {
  if (!summary) return ''

  return `## 历史对话摘要（之前的对话已被压缩为以下摘要）
${summary}`
}
