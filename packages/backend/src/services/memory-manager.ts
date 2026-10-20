import type { Logger } from '../lib/logger.js'
import { getEnv } from '../env.js'
import { createMemoryEmbedding } from './embeddings.js'
import { getTodayMemory, getUserProfileMemory } from './memory.js'
import {
  isUserMemoryItemExpired,
  searchActiveUserMemoryItemsByEmbedding,
  type UserMemorySearchHit,
  type UserMemoryTemporalScope,
} from './memory-items.js'
import type { CurrentConcern } from '@health-agent/shared'

export interface MemoryContextSnapshot {
  profileMemory: string | null
  todayMemory: string | null
  relevantItems: UserMemorySearchHit[]
}

export class MemoryManager {
  constructor(private readonly logger: Logger) {}

  async loadContext(
    userId: string,
    opts: { query?: string | null } = {},
  ): Promise<MemoryContextSnapshot> {
    const [profileMemory, todayMemory, relevantItems] = await Promise.all([
      getUserProfileMemory(userId, this.logger),
      getTodayMemory(userId, this.logger),
      this.loadRelevantItemsWithTimeout(userId, opts.query),
    ])

    return {
      profileMemory,
      todayMemory,
      relevantItems: filterProfileCoveredRelevantItems(profileMemory, relevantItems),
    }
  }

  private async loadRelevantItemsWithTimeout(
    userId: string,
    query?: string | null,
  ): Promise<UserMemorySearchHit[]> {
    const env = getEnv()
    if (!env.MEMORY_RECALL_ENABLED) return []

    try {
      return await withTimeout(
        this.loadRelevantItems(userId, query),
        env.MEMORY_RECALL_TIMEOUT_MS,
        'relevant memory retrieval timed out',
      )
    } catch (err) {
      this.logger.child({ module: 'memory-manager' }).warn(
        { error: err instanceof Error ? err.message : String(err) },
        'relevant memory retrieval skipped',
      )
      return []
    }
  }

  private async loadRelevantItems(
    userId: string,
    query?: string | null,
  ): Promise<UserMemorySearchHit[]> {
    const trimmed = query?.trim() ?? ''
    if (!shouldPrefetchRelevantMemory(trimmed)) return []

    const log = this.logger.child({ module: 'memory-manager' })
    try {
      const embedding = await createMemoryEmbedding(trimmed, log)
      return await searchActiveUserMemoryItemsByEmbedding({
        userId,
        embeddingModel: embedding.embeddingModel,
        embedding: embedding.embedding,
        limit: 6,
        minScore: getEnv().MEMORY_RECALL_MIN_SCORE,
      })
    } catch (err) {
      log.warn(
        { error: err instanceof Error ? err.message : String(err) },
        'relevant memory retrieval failed (non-critical)',
      )
      return []
    }
  }
}

export function filterProfileCoveredRelevantItems(
  profileMemory: string | null,
  items: UserMemorySearchHit[],
): UserMemorySearchHit[] {
  if (!profileMemory?.trim()) return items
  return items.filter((item) => !profileMemory.includes(item.content.trim()))
}

export function filterAlreadyRenderedRelevantItems(
  items: UserMemorySearchHit[],
  priorContextText: string,
): UserMemorySearchHit[] {
  if (!priorContextText.trim()) return items
  return items.filter((item) => !priorContextText.includes(item.content))
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })

  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

export function renderRelevantMemoryReminder(
  items: UserMemorySearchHit[],
  _currentConcern?: CurrentConcern | null,
): string | null {
  if (items.length === 0) return null

  return renderRelevantMemoryContextBlock(items)
}

export function renderRelevantMemoryContextBlock(
  items: UserMemorySearchHit[],
  now: Date = new Date(),
): string | null {
  const visibleItems = items.filter((item) => !isUserMemoryItemExpired(item, now))
  if (visibleItems.length === 0) return null

  const body = [
    '## Relevant User Memory',
    ...visibleItems.map((item) => `- [${memoryContextLabel(item)}] ${sanitizeMemoryContextLine(item.content)}`),
  ].join('\n')

  return [
    '<memory-context>',
    '[System note: The following is recalled memory context, NOT new user input. Use only when relevant; do not quote it as if the user just said it.]',
    '',
    body,
    '</memory-context>',
  ].join('\n')
}

function sanitizeMemoryContextLine(text: string): string {
  return text
    .replace(/<\/?\s*memory-context\s*>/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function memoryContextLabel(item: UserMemorySearchHit): string {
  const parts = [memoryTypeLabel(item.memoryType)]
  const scope = memoryTemporalScope(item)
  const scopeLabel = temporalScopeLabel(scope)
  if (scopeLabel) parts.push(scopeLabel)

  const timeLabel = memoryTimeLabel(item, scope)
  if (timeLabel) parts.push(timeLabel)

  return parts.join(' | ')
}

function memoryTemporalScope(item: UserMemorySearchHit): UserMemoryTemporalScope {
  const raw = metadataString(item, 'temporalScope')
  if (
    raw === 'stable'
    || raw === 'current_state'
    || raw === 'episodic'
    || raw === 'scheduled'
    || raw === 'historical'
  ) {
    return raw
  }

  switch (item.memoryType) {
    case 'communication_preference':
    case 'caregiver_context':
    case 'life_context':
      return 'stable'
    case 'treatment_experience':
    case 'symptom_pattern':
    case 'emotional_pattern':
      return 'current_state'
    default:
      return 'historical'
  }
}

function temporalScopeLabel(scope: UserMemoryTemporalScope): string {
  switch (scope) {
    case 'stable':
      return '长期稳定'
    case 'current_state':
      return '当前状态'
    case 'episodic':
      return '单次记录'
    case 'scheduled':
      return '计划事项'
    case 'historical':
      return '历史信息'
  }
}

function memoryTimeLabel(item: UserMemorySearchHit, scope: UserMemoryTemporalScope): string | null {
  const eventDate = formatMemoryDate(metadataString(item, 'eventAt'))
  if (eventDate) return `发生: ${eventDate}`

  const confirmedDate = formatMemoryDate(
    metadataString(item, 'lastConfirmedAt')
    ?? metadataString(item, 'lastSeenAt')
    ?? item.updatedAt.toISOString(),
  )

  if (!confirmedDate) return null
  if (scope === 'current_state') return `最近确认: ${confirmedDate}`
  return `更新: ${confirmedDate}`
}

function metadataString(item: UserMemorySearchHit, key: string): string | null {
  const value = item.metadata?.[key]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function formatMemoryDate(value: string | null): string | null {
  if (!value) return null
  const time = Date.parse(value)
  if (!Number.isFinite(time)) return null
  return new Date(time).toISOString().slice(0, 10)
}

export function shouldPrefetchRelevantMemory(query: string): boolean {
  return query.trim().length > 0
}

function memoryTypeLabel(memoryType: string): string {
  switch (memoryType) {
    case 'communication_preference':
      return '沟通偏好'
    case 'caregiver_context':
      return '照护背景'
    case 'treatment_experience':
      return '治疗体验'
    case 'symptom_pattern':
      return '症状模式'
    case 'emotional_pattern':
      return '情绪模式'
    case 'life_context':
      return '生活背景'
    default:
      return '其他'
  }
}
