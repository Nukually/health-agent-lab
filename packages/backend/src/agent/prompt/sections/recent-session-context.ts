import type { RecentSessionPromptSummary } from '../../../services/session.js'

function formatShanghaiDateTimeMinute(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function recentSessionContext(
  summary: RecentSessionPromptSummary | null | undefined,
): string {
  if (!summary?.sessions.length) return ''

  const stats = summary.stats
  const lines = summary.sessions.map((session, index) => {
    const title = session.title?.trim() || '未命名会话'
    const startedAt = formatShanghaiDateTimeMinute(session.startedAt)
    return `${index + 1}. ${title}｜交互轮次 ${session.userTurnCount}｜${startedAt}`
  })

  return `## 最近历史会话
以下仅是最近历史会话的元信息，不包含对话原文。用户引用过去具体内容时，优先用 search_chat_history 搜索原始轮次，不要凭标题或摘要猜。

近期会话概览：今日已进行了${stats.todayCount}个session对话，昨日${stats.yesterdayCount}个session对话，本周一共${stats.thisWeekCount}个session对话。

${lines.join('\n')}`
}
