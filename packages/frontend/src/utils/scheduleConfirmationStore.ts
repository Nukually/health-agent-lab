/**
 * schedule 待确认卡片的 sessionStorage 旁路持久化
 *
 * pendingScheduleConfirmations 是纯内存态：用户在点确认前若导航离开聊天页（如点
 * [提醒](/scheduled-tasks) 跳走）再回来，会话加载 effect 会清空内存队列，而确认前
 * 后端不落库，卡片就此丢失。这里把未确认卡片快照存到 sessionStorage，返回同一会话时
 * 按 payload 自带的 messageId 还原；卡片自包含（confirmationId/toolCallId/pendingTask），
 * 还原后点确认仍可正常调 /scheduled-tasks/confirm 落库。
 *
 * 用 sessionStorage 而非 localStorage：待确认卡片是临时态，关闭标签页应自然清除，
 * 不应长期残留过期卡。
 */

import type { ScheduleConfirmationPayload } from '@health-agent/shared'

const STORAGE_KEY = 'cx-schedule-confirmations'

interface ScheduleConfirmationSnapshot {
  pending: ScheduleConfirmationPayload[]
  results: Record<string, 'confirmed' | 'rejected'>
}

const EMPTY_SNAPSHOT: ScheduleConfirmationSnapshot = { pending: [], results: {} }

export function readScheduleConfirmationSnapshot(): ScheduleConfirmationSnapshot {
  if (typeof window === 'undefined') return EMPTY_SNAPSHOT
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return EMPTY_SNAPSHOT
    const parsed = JSON.parse(raw) as Partial<ScheduleConfirmationSnapshot>
    return {
      pending: Array.isArray(parsed.pending) ? parsed.pending : [],
      results: parsed.results && typeof parsed.results === 'object' ? parsed.results : {},
    }
  } catch {
    return EMPTY_SNAPSHOT
  }
}

export function writeScheduleConfirmationSnapshot(snapshot: ScheduleConfirmationSnapshot) {
  if (typeof window === 'undefined') return
  try {
    if (snapshot.pending.length === 0 && Object.keys(snapshot.results).length === 0) {
      sessionStorage.removeItem(STORAGE_KEY)
      return
    }
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot))
  } catch {
    // sessionStorage 不可用（隐私模式/配额）时静默降级，仅丢失跨导航持久化能力
  }
}
