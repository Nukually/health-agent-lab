/**
 * 记忆上下文 — 动态 section
 */

import type { CurrentConcern } from '@health-agent/shared'
import { renderUserMdPromptBlock } from '../../../services/memory.js'

export function memoryContext(
  profileMemory: string | null,
  todayMemory: string | null,
  _currentConcern?: CurrentConcern | null,
): string {
  const sections: string[] = []

  if (todayMemory?.trim()) {
    sections.push(`## 今日记忆（仅本轮明确相关时参考）\n- 仅作今天对话背景；医学事实以病历档案为准。\n${todayMemory.trim()}`)
  }

  return sections.join('\n\n')
}

export function userProfileSystemContext(
  profileMemory: string | null,
  stableUserContext?: string | null,
): string | null {
  const sections: string[] = []

  const profileBlock = renderUserMdPromptBlock(profileMemory)
  if (profileBlock) {
    sections.push(profileBlock)
  } else if (profileMemory?.trim()) {
    sections.push(profileMemory.trim())
  }

  if (stableUserContext?.trim()) {
    sections.push([
      '══════════════════════════════════════════════',
      'SESSION USER CONTEXT (stable user profile and health context)',
      '══════════════════════════════════════════════',
      stableUserContext.trim(),
    ].join('\n'))
  }

  return sections.length ? sections.join('\n\n') : null
}
