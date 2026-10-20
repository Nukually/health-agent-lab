import { llmCall } from '../lib/llm.js'
import { getEnv } from '../env.js'
import {
  archiveUserMemoryItems,
  createUserMemoryItem,
  ensureUserMemoryItemEmbedding,
  listActiveUserMemoryItems,
  searchActiveUserMemoryItemsByEmbedding,
  updateUserMemoryItem,
  upsertUserMemoryEmbedding,
  type UserMemoryItem,
  type UserMemoryItemType,
  type UserMemoryTemporalScope,
} from './memory-items.js'
import { createMemoryEmbedding, type MemoryEmbeddingResult } from './embeddings.js'
import {
  isProfileMemoryItemType,
  scheduleUserProfileMemoryRefresh,
  type ProfileMemorySourceItem,
} from './profile-memory-updater.js'
import { syncLangfuseTextPrompt } from '../observability/langfuse.js'
import type { Logger } from '../lib/logger.js'

const REVIEW_MODEL = 'qwen3.5-flash'
const REVIEWER_VERSION = 1
const MAX_REVIEW_INPUT_CHARS = 1800
const MAX_ASSISTANT_CONTEXT_CHARS = 1600
const MAX_COMPACTION_REVIEW_CHARS = 6000
const MEMORY_REVIEWER_PROMPT_NAME = 'health-agent-lab-memory-reviewer'
const MEMORY_LIFECYCLE_PROMPT_NAME = 'health-agent-lab-memory-lifecycle-reviewer'

const ALLOWED_MEMORY_TYPES = [
  'communication_preference',
  'caregiver_context',
  'treatment_experience',
  'symptom_pattern',
  'emotional_pattern',
  'life_context',
  'other',
] as const satisfies readonly UserMemoryItemType[]

const allowedMemoryTypeSet = new Set<UserMemoryItemType>(ALLOWED_MEMORY_TYPES)
const BROAD_LIFECYCLE_MEMORY_TYPES = new Set<UserMemoryItemType>([
  'communication_preference',
  'caregiver_context',
  'treatment_experience',
  'symptom_pattern',
  'emotional_pattern',
  'life_context',
])

export interface NormalizedMemoryReviewItem {
  memoryType: UserMemoryItemType
  content: string
  importance: number
  confidence: number
  temporalScope?: UserMemoryTemporalScope
  eventAt?: string
  expiresAt?: string
}

export interface MemoryLifecycleDecision {
  action: 'skip' | 'touch' | 'merge' | 'update' | 'replace' | 'create'
  targetId?: string
  content?: string
  replaceIds: string[]
}

export type MemoryCandidateStorageTarget = 'profile' | 'memory_item'

export interface MemoryReviewTurnInput {
  userId: string
  sessionId: string
  userMessageId: string | null
  assistantMessageId: string | null
  userMessageContent: string
  assistantMessageContent: string
  imageCount?: number
  logger: Logger
}

export interface MemoryReviewCompactionMessage {
  role: 'user' | 'assistant'
  content: string
  dbId?: string
}

export interface MemoryReviewCompactionInput {
  userId: string
  sessionId: string
  reason: 'proactive' | 'reactive'
  messages: MemoryReviewCompactionMessage[]
  logger: Logger
}

export function scheduleMemoryReviewForTurn(input: MemoryReviewTurnInput): void {
  if (!getEnv().MEMORY_REVIEW_ENABLED) return
  if (!input.userMessageId || !input.assistantMessageId) return
  if (!input.userMessageContent.trim()) return

  void reviewTurnMemory(input).catch((err) => {
    input.logger.child({ module: 'memory-reviewer', sessionId: input.sessionId }).warn(
      { error: err instanceof Error ? err.message : String(err) },
      'memory review failed (non-critical)',
    )
  })
}

export function scheduleMemoryReviewForCompaction(input: MemoryReviewCompactionInput): void {
  if (!getEnv().MEMORY_REVIEW_ENABLED) return
  if (!input.messages.some((message) => message.role === 'user' && message.content.trim())) return

  void reviewCompactionMemory(input).catch((err) => {
    input.logger.child({ module: 'memory-reviewer', sessionId: input.sessionId, reason: input.reason }).warn(
      { error: err instanceof Error ? err.message : String(err) },
      'compaction memory review failed (non-critical)',
    )
  })
}

export async function reviewTurnMemory(input: MemoryReviewTurnInput): Promise<void> {
  const log = input.logger.child({ module: 'memory-reviewer', sessionId: input.sessionId })
  const existingItems = await listActiveUserMemoryItems(input.userId, { limit: 20 })
  const systemPrompt = await resolveMemoryReviewerSystemPrompt(log)

  const response = await llmCall({
    model: REVIEW_MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: buildReviewerUserPrompt({
          userMessageContent: input.userMessageContent,
          assistantMessageContent: input.assistantMessageContent,
          imageCount: input.imageCount ?? 0,
          existingItems: existingItems.map((item) => ({
            memoryType: item.memoryType,
            content: item.content,
          })),
        }),
      },
    ],
    max_tokens: 800,
    temperature: 0.2,
    enable_thinking: false,
  }, log)

  const raw = response.choices[0]?.message?.content
  if (!raw) {
    log.warn('memory review returned empty content')
    return
  }

  const candidates = normalizeMemoryReviewItems(raw)
  if (candidates.length === 0) {
    log.debug('memory review produced no new candidates')
    return
  }

  const result = await persistMemoryCandidates({
    userId: input.userId,
    sessionId: input.sessionId,
    source: 'reviewer',
    sourceMessageId: input.userMessageId,
    assistantMessageId: input.assistantMessageId,
    candidates,
    existingItems,
    logger: log,
    metadata: { reviewOrigin: 'post_turn' },
  })
  const { profileRefreshItems, ...counts } = result
  // reviewer-managed USER.md refresh: durable preferences/background are first
  // persisted as memory items, then summarized into the frozen profile source.
  scheduleUserProfileMemoryRefresh({
    userId: input.userId,
    sourceSessionId: input.sessionId,
    items: profileRefreshItems,
    logger: log,
  })

  log.info(
    { candidateCount: candidates.length, ...counts, profileRefreshItemCount: profileRefreshItems.length },
    'memory review completed',
  )
}

export async function reviewCompactionMemory(input: MemoryReviewCompactionInput): Promise<void> {
  const log = input.logger.child({ module: 'memory-reviewer', sessionId: input.sessionId, reason: input.reason })
  const messages = input.messages
    .map((message) => ({ ...message, content: message.content.trim() }))
    .filter((message) => message.content)
  if (!messages.some((message) => message.role === 'user')) return

  const existingItems = await listActiveUserMemoryItems(input.userId, { limit: 20 })
  const systemPrompt = await resolveMemoryReviewerSystemPrompt(log)

  const response = await llmCall({
    model: REVIEW_MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: buildCompactionReviewerUserPrompt({
          messages,
          existingItems: existingItems.map((item) => ({
            memoryType: item.memoryType,
            content: item.content,
          })),
        }),
      },
    ],
    max_tokens: 800,
    temperature: 0.2,
    enable_thinking: false,
  }, log)

  const raw = response.choices[0]?.message?.content
  if (!raw) {
    log.warn('compaction memory review returned empty content')
    return
  }

  const candidates = normalizeMemoryReviewItems(raw)
  if (candidates.length === 0) {
    log.debug('compaction memory review produced no new candidates')
    return
  }

  const sourceMessageId = messages.find((message) => message.role === 'user' && message.dbId)?.dbId ?? null
  const result = await persistMemoryCandidates({
    userId: input.userId,
    sessionId: input.sessionId,
    source: 'compaction_reviewer',
    sourceMessageId,
    assistantMessageId: null,
    candidates,
    existingItems,
    logger: log,
    metadata: {
      reviewOrigin: 'compaction',
      compactionReason: input.reason,
      compactedMessageCount: messages.length,
    },
  })
  const { profileRefreshItems, ...counts } = result
  // reviewer-managed USER.md refresh after compaction catches durable facts
  // even when the main agent never had a visible memory tool.
  scheduleUserProfileMemoryRefresh({
    userId: input.userId,
    sourceSessionId: input.sessionId,
    items: profileRefreshItems,
    logger: log,
  })

  log.info(
    { candidateCount: candidates.length, ...counts, profileRefreshItemCount: profileRefreshItems.length },
    'compaction memory review completed',
  )
}

async function persistMemoryCandidates(input: {
  userId: string
  sessionId: string
  source: string
  sourceMessageId: string | null
  assistantMessageId: string | null
  candidates: NormalizedMemoryReviewItem[]
  existingItems: UserMemoryItem[]
  logger: Logger
  metadata?: Record<string, unknown>
}): Promise<{
  created: number
  updated: number
  touched: number
  replaced: number
  profileRouted: number
  skippedSimilar: number
  profileRefreshItems: ProfileMemorySourceItem[]
}> {
  const activeItems = [...input.existingItems]
  const existingContent = new Set(activeItems.map(memoryContentKey))
  let created = 0
  let updated = 0
  let touched = 0
  let replaced = 0
  let profileRouted = 0
  let skippedSimilar = 0
  const profileRefreshItems: ProfileMemorySourceItem[] = []
  const collectProfileRefreshItem = (item: ProfileMemorySourceItem) => {
    profileRefreshItems.push({
      memoryType: item.memoryType,
      content: item.content,
    })
  }
  for (let item of input.candidates) {
    if (memoryCandidateStorageTarget(item.memoryType) === 'profile') {
      collectProfileRefreshItem(item)
      profileRouted++
      continue
    }

    const exactExistingItem = activeItems.find((existing) =>
      existing.memoryType === item.memoryType && existing.content.trim() === item.content,
    )
    if (exactExistingItem) {
      const touchedItem = await touchMemoryItem({
        userId: input.userId,
        item: exactExistingItem,
        candidate: item,
        metadata: input.metadata,
        assistantMessageId: input.assistantMessageId,
        logger: input.logger,
      })
      if (touchedItem) {
        replaceActiveItem(activeItems, touchedItem)
        touched++
      }
      continue
    }

    let candidateEmbedding: MemoryEmbeddingResult | null = null
    let sameTypeSimilarItems: UserMemoryItem[] = []
    let lifecycleItems: UserMemoryItem[] = []
    try {
      candidateEmbedding = await createMemoryEmbedding(item.content, input.logger)
      const similarItems = await searchActiveUserMemoryItemsByEmbedding({
        userId: input.userId,
        embeddingModel: candidateEmbedding.embeddingModel,
        embedding: candidateEmbedding.embedding,
        limit: 3,
        minScore: getEnv().MEMORY_DUPLICATE_MIN_SCORE,
      })
      sameTypeSimilarItems = similarItems.filter((existing) => existing.memoryType === item.memoryType)
    } catch (err) {
      input.logger.warn(
        { error: err instanceof Error ? err.message : String(err) },
        'memory candidate similarity check failed (non-critical)',
      )
    }

    lifecycleItems = selectMemoryLifecycleCandidates({
      candidateMemoryType: item.memoryType,
      existingItems: activeItems,
      similarItems: sameTypeSimilarItems,
    })
    if (lifecycleItems.length > 0) {
      const decision = await resolveMemoryLifecycle({
        candidate: item,
        existingItems: lifecycleItems,
        logger: input.logger,
      }).catch((err) => {
        input.logger.warn(
          { error: err instanceof Error ? err.message : String(err) },
          'memory lifecycle review failed; skipping candidate to avoid duplicate active memory',
        )
        return { action: 'skip', replaceIds: [] } satisfies MemoryLifecycleDecision
      })

      if (decision.action === 'skip') {
        skippedSimilar++
        continue
      }

      if (decision.action === 'touch') {
        const target = findLifecycleTarget(lifecycleItems, decision.targetId)
        if (target) {
          const touchedItem = await touchMemoryItem({
            userId: input.userId,
            item: target,
            candidate: item,
            metadata: input.metadata,
            assistantMessageId: input.assistantMessageId,
            logger: input.logger,
          })
          if (touchedItem) {
            replaceActiveItem(activeItems, touchedItem)
            touched++
          }
        } else {
          skippedSimilar++
        }
        continue
      }

      if (decision.action === 'merge' || decision.action === 'update') {
        const target = findLifecycleTarget(lifecycleItems, decision.targetId)
        const nextContent = decision.content?.trim()
        if (target && nextContent) {
          const updatedItem = await updateMemoryItemContent({
            userId: input.userId,
            item: target,
            candidate: item,
            content: nextContent,
            lifecycle: decision.action,
            metadata: input.metadata,
            assistantMessageId: input.assistantMessageId,
            logger: input.logger,
          })
          if (updatedItem) {
            replaceActiveItem(activeItems, updatedItem)
            existingContent.add(memoryContentKey(updatedItem))
            updated++
          }
        } else {
          skippedSimilar++
        }
        continue
      }

      if (decision.action === 'replace') {
        await archiveUserMemoryItems({
          userId: input.userId,
          memoryItemIds: decision.replaceIds,
          reason: 'superseded_by_reviewer_candidate',
          metadata: {
            reviewerVersion: REVIEWER_VERSION,
            replacementContent: decision.content ?? item.content,
          },
        }, input.logger)
        replaced += decision.replaceIds.length
        removeActiveItems(activeItems, decision.replaceIds)
        if (decision.content) {
          item = { ...item, content: decision.content }
          candidateEmbedding = null
        }
      }
    }

    if (existingContent.has(memoryContentKey(item))) {
      skippedSimilar++
      continue
    }

    try {
      const createdItem = await createUserMemoryItem({
        userId: input.userId,
        memoryType: item.memoryType,
        content: item.content,
        source: input.source,
        sourceSessionId: input.sessionId,
        sourceMessageId: input.sourceMessageId,
        importance: item.importance,
        confidence: item.confidence,
        metadata: {
          ...(input.assistantMessageId ? { assistantMessageId: input.assistantMessageId } : {}),
          reviewerVersion: REVIEWER_VERSION,
          lifecycle: 'created',
          ...buildMemoryTemporalMetadata(item),
          ...input.metadata,
        },
      }, input.logger)

      try {
        if (candidateEmbedding) {
          await upsertUserMemoryEmbedding({
            userId: input.userId,
            memoryItemId: createdItem.id,
            embeddingModel: candidateEmbedding.embeddingModel,
            embedding: candidateEmbedding.embedding,
            contentHash: candidateEmbedding.contentHash,
          })
        } else {
          await ensureUserMemoryItemEmbedding(createdItem, input.logger)
        }
      } catch (err) {
        input.logger.warn(
          {
            memoryItemId: createdItem.id,
            error: err instanceof Error ? err.message : String(err),
          },
          'memory embedding creation failed (non-critical)',
        )
      }
      existingContent.add(memoryContentKey(createdItem))
      activeItems.push(createdItem)
      created++
    } catch (err) {
      input.logger.warn(
        {
          memoryType: item.memoryType,
          error: err instanceof Error ? err.message : String(err),
        },
        'memory candidate rejected',
      )
    }
  }

  return { created, updated, touched, replaced, profileRouted, skippedSimilar, profileRefreshItems }
}

export function memoryCandidateStorageTarget(memoryType: UserMemoryItemType): MemoryCandidateStorageTarget {
  return isProfileMemoryItemType(memoryType) ? 'profile' : 'memory_item'
}

function memoryContentKey(item: Pick<UserMemoryItem, 'memoryType' | 'content'>): string {
  return `${item.memoryType}:${item.content.trim()}`
}

function replaceActiveItem(items: UserMemoryItem[], next: UserMemoryItem): void {
  const idx = items.findIndex((item) => item.id === next.id)
  if (idx >= 0) items[idx] = next
}

function removeActiveItems(items: UserMemoryItem[], ids: string[]): void {
  const removeIds = new Set(ids)
  for (let idx = items.length - 1; idx >= 0; idx--) {
    if (removeIds.has(items[idx].id)) items.splice(idx, 1)
  }
}

function findLifecycleTarget<T extends Pick<UserMemoryItem, 'id'>>(
  items: T[],
  targetId?: string,
): T | null {
  if (!targetId) return null
  return items.find((item) => item.id === targetId) ?? null
}

async function touchMemoryItem(input: {
  userId: string
  item: UserMemoryItem
  candidate: NormalizedMemoryReviewItem
  metadata?: Record<string, unknown>
  assistantMessageId: string | null
  logger: Logger
}): Promise<UserMemoryItem | null> {
  try {
    return await updateUserMemoryItem({
      userId: input.userId,
      memoryItemId: input.item.id,
      content: input.item.content,
      importance: Math.max(input.item.importance, input.candidate.importance),
      confidence: Math.max(input.item.confidence, input.candidate.confidence),
      metadata: {
        ...(input.assistantMessageId ? { assistantMessageId: input.assistantMessageId } : {}),
        reviewerVersion: REVIEWER_VERSION,
        lifecycle: 'touched',
        lastSeenAt: new Date().toISOString(),
        lastCandidateContent: input.candidate.content,
        ...buildMemoryTemporalMetadata(input.candidate, input.item),
        ...input.metadata,
      },
    }, input.logger)
  } catch (err) {
    input.logger.warn(
      {
        memoryItemId: input.item.id,
        error: err instanceof Error ? err.message : String(err),
      },
      'memory item touch failed',
    )
    return null
  }
}

async function updateMemoryItemContent(input: {
  userId: string
  item: UserMemoryItem
  candidate: NormalizedMemoryReviewItem
  content: string
  lifecycle: 'merge' | 'update'
  metadata?: Record<string, unknown>
  assistantMessageId: string | null
  logger: Logger
}): Promise<UserMemoryItem | null> {
  try {
    const updatedItem = await updateUserMemoryItem({
      userId: input.userId,
      memoryItemId: input.item.id,
      content: input.content,
      importance: Math.max(input.item.importance, input.candidate.importance),
      confidence: Math.max(input.item.confidence, input.candidate.confidence),
      metadata: {
        ...(input.assistantMessageId ? { assistantMessageId: input.assistantMessageId } : {}),
        reviewerVersion: REVIEWER_VERSION,
        lifecycle: input.lifecycle,
        previousContent: input.item.content,
        candidateContent: input.candidate.content,
        ...buildMemoryTemporalMetadata(input.candidate, input.item),
        ...input.metadata,
      },
    }, input.logger)
    if (!updatedItem) return null

    try {
      const embedding = await createMemoryEmbedding(updatedItem.content, input.logger)
      await upsertUserMemoryEmbedding({
        userId: input.userId,
        memoryItemId: updatedItem.id,
        embeddingModel: embedding.embeddingModel,
        embedding: embedding.embedding,
        contentHash: embedding.contentHash,
      })
    } catch (err) {
      input.logger.warn(
        {
          memoryItemId: updatedItem.id,
          error: err instanceof Error ? err.message : String(err),
        },
        'updated memory embedding refresh failed (non-critical)',
      )
    }

    return updatedItem
  } catch (err) {
    input.logger.warn(
      {
        memoryItemId: input.item.id,
        error: err instanceof Error ? err.message : String(err),
      },
      'memory item lifecycle update failed',
    )
    return null
  }
}

export function selectMemoryLifecycleCandidates<T extends Pick<UserMemoryItem, 'id' | 'memoryType'>>(input: {
  candidateMemoryType: UserMemoryItemType
  existingItems: T[]
  similarItems: T[]
}): T[] {
  const candidates = BROAD_LIFECYCLE_MEMORY_TYPES.has(input.candidateMemoryType)
    ? input.existingItems.filter((item) => item.memoryType === input.candidateMemoryType)
    : input.similarItems.filter((item) => item.memoryType === input.candidateMemoryType)

  const seen = new Set<string>()
  return candidates.filter((item) => {
    if (seen.has(item.id)) return false
    seen.add(item.id)
    return true
  })
}

async function resolveMemoryLifecycle(input: {
  candidate: NormalizedMemoryReviewItem
  existingItems: UserMemoryItem[]
  logger: Logger
}): Promise<MemoryLifecycleDecision> {
  const systemPrompt = await resolveMemoryLifecycleSystemPrompt(input.logger)
  const response = await llmCall({
    model: REVIEW_MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: buildLifecycleUserPrompt(input.candidate, input.existingItems),
      },
    ],
    max_tokens: 360,
    temperature: 0.1,
    enable_thinking: false,
  }, input.logger)

  return normalizeMemoryLifecycleDecision(
    response.choices[0]?.message?.content ?? '',
    input.existingItems.map((item) => item.id),
  )
}

async function resolveMemoryReviewerSystemPrompt(logger: Logger): Promise<string> {
  const prompt = buildReviewerSystemPrompt()
  await syncMemoryPrompt({
    name: MEMORY_REVIEWER_PROMPT_NAME,
    prompt,
    logger,
    source: 'memory-reviewer-system-prompt',
  })
  return prompt
}

async function resolveMemoryLifecycleSystemPrompt(logger: Logger): Promise<string> {
  const prompt = buildLifecycleSystemPrompt()
  await syncMemoryPrompt({
    name: MEMORY_LIFECYCLE_PROMPT_NAME,
    prompt,
    logger,
    source: 'memory-lifecycle-reviewer-system-prompt',
  })
  return prompt
}

async function syncMemoryPrompt(input: {
  name: string
  prompt: string
  logger: Logger
  source: string
}): Promise<void> {
  await syncLangfuseTextPrompt({
    name: input.name,
    prompt: input.prompt,
    logger: input.logger,
    source: input.source,
    tags: ['memory', 'reviewer'],
    commitMessagePrefix: `sync ${input.name}`,
  }).catch((err) => {
    input.logger.debug(
      { err, promptName: input.name },
      'memory prompt Langfuse sync skipped',
    )
  })
}

export function normalizeMemoryLifecycleDecision(
  raw: string,
  allowedIds: string[],
): MemoryLifecycleDecision {
  const parsed = parseReviewJson(raw)
  const action = parsed && typeof (parsed as Record<string, unknown>).action === 'string'
    ? (parsed as Record<string, string>).action
    : 'skip'

  const allowed = new Set(allowedIds)
  const targetIdRaw = (parsed as { targetId?: unknown } | null)?.targetId
  const targetId = typeof targetIdRaw === 'string' && allowed.has(targetIdRaw) ? targetIdRaw : undefined
  const contentRaw = (parsed as { content?: unknown } | null)?.content
  const content = typeof contentRaw === 'string'
    ? normalizeLifecycleContent(contentRaw)
    : undefined
  const replaceIdsRaw = (parsed as { replaceIds?: unknown[] } | null)?.replaceIds
  const replaceIds = Array.isArray(replaceIdsRaw)
    ? replaceIdsRaw.filter((id): id is string => typeof id === 'string' && allowed.has(id))
    : []

  if (action === 'touch') {
    return targetId ? { action: 'touch', targetId, replaceIds: [] } : { action: 'skip', replaceIds: [] }
  }

  if (action === 'merge' || action === 'update') {
    return targetId && content
      ? { action, targetId, content, replaceIds: [] }
      : { action: 'skip', replaceIds: [] }
  }

  if (action === 'replace') {
    if (replaceIds.length === 0) return { action: 'skip', replaceIds: [] }
    return content ? { action: 'replace', content, replaceIds } : { action: 'replace', replaceIds }
  }

  if (action === 'create') return { action: 'create', replaceIds: [] }

  return { action: 'skip', replaceIds: [] }
}

export function normalizeMemoryReviewItems(raw: string): NormalizedMemoryReviewItem[] {
  const parsed = parseReviewJson(raw)
  const items = Array.isArray(parsed?.items) ? parsed.items : []
  const result: NormalizedMemoryReviewItem[] = []
  const seen = new Set<string>()

  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const memoryType = record.memoryType ?? record.type
    if (!isAllowedMemoryType(memoryType)) continue

    const content = typeof record.content === 'string'
      ? record.content.trim().replace(/\s+/g, ' ')
      : ''
    if (content.length < 6) continue

    const normalized: NormalizedMemoryReviewItem = {
      memoryType,
      content: content.length > 300 ? content.slice(0, 300).trim() : content,
      importance: clampScore(record.importance, 1, 5, 2),
      confidence: clampScore(record.confidence, 1, 100, 70),
    }
    const temporalScope = normalizeTemporalScope(record.temporalScope)
    if (temporalScope) normalized.temporalScope = temporalScope
    const eventAt = normalizeIsoInstant(record.eventAt)
    if (eventAt) normalized.eventAt = eventAt
    const expiresAt = normalizeIsoInstant(record.expiresAt)
    if (expiresAt) normalized.expiresAt = expiresAt

    const key = `${normalized.memoryType}:${normalized.content}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(normalized)
    if (result.length >= 3) break
  }

  return result
}

function normalizeLifecycleContent(raw: string): string | undefined {
  const content = raw.trim().replace(/\s+/g, ' ')
  if (content.length < 6) return undefined
  return content.length > 300 ? content.slice(0, 300).trim() : content
}

function buildMemoryTemporalMetadata(
  candidate: NormalizedMemoryReviewItem,
  existing?: UserMemoryItem,
): Record<string, unknown> {
  const now = new Date()
  const nowIso = now.toISOString()
  const temporalScope = candidate.temporalScope ?? memoryDefaultTemporalScope(candidate.memoryType)
  const expiresAt = candidate.expiresAt ?? memoryDefaultExpiresAt(candidate.memoryType, temporalScope, now)

  return {
    temporalScope,
    observedAt: metadataString(existing, 'observedAt') ?? nowIso,
    lastConfirmedAt: nowIso,
    ...(candidate.eventAt ? { eventAt: candidate.eventAt } : {}),
    ...(expiresAt ? { expiresAt } : {}),
  }
}

function memoryDefaultTemporalScope(memoryType: UserMemoryItemType): UserMemoryTemporalScope {
  switch (memoryType) {
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

function memoryDefaultExpiresAt(
  memoryType: UserMemoryItemType,
  temporalScope: UserMemoryTemporalScope,
  now: Date,
): string | undefined {
  if (temporalScope !== 'current_state') return undefined

  const days = (() => {
    switch (memoryType) {
      case 'symptom_pattern':
        return 30
      case 'emotional_pattern':
        return 60
      case 'treatment_experience':
        return 90
      default:
        return 30
    }
  })()

  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString()
}

function metadataString(item: UserMemoryItem | undefined, key: string): string | null {
  const value = item?.metadata?.[key]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function normalizeTemporalScope(value: unknown): UserMemoryTemporalScope | undefined {
  return value === 'stable'
    || value === 'current_state'
    || value === 'episodic'
    || value === 'scheduled'
    || value === 'historical'
    ? value
    : undefined
}

function normalizeIsoInstant(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  const time = Date.parse(value)
  if (!Number.isFinite(time)) return undefined
  return new Date(time).toISOString()
}

export function buildReviewerSystemPrompt(): string {
  return `你是乳腺癌患者陪伴产品的长期记忆 reviewer。你不回答用户，只判断这一轮对话里是否有未来多轮服务仍然有帮助的信息。

可以记录：
- 用户希望助手如何表达、解释、组织信息
- 用户纠正助手的表达、语气、格式、回复长短或信息组织方式；这类“以后别这样/太啰嗦/先给结论”等反馈是第一优先级长期记忆信号
- 照护者、家庭角色、生活工作背景
- 用户稳定的饮食/生活偏好、喜欢或不喜欢的事物、常用称呼等长期服务背景
- 治疗过程中的长期体验、生活影响、复诊沟通习惯
- 多次出现或明显持续的症状/情绪/困扰模式

不要记录：
- 分型、分期、检查数值、用药方案、治疗决策等病历事实；这些以病历档案为准
- 单次普通医学问答、助手建议、工具输出、没有长期价值的闲聊
- 临时任务状态、完成记录、一次性 TODO、工具调用过程或本轮执行结果
- 单次饮食、症状、睡眠、日记、天气、备忘等打卡记录；除非已经形成多次出现的模式
- 需要用户确认的猜测，或从图片内容推断出的医学事实

只输出 JSON，不要代码块，不要解释：
{"items":[{"memoryType":"communication_preference","content":"...","importance":2,"confidence":80,"temporalScope":"stable"}]}

memoryType 只能是：communication_preference、caregiver_context、treatment_experience、symptom_pattern、emotional_pattern、life_context、other。
存储边界：communication_preference、caregiver_context、life_context 会进入 USER.md，不进入 user_memory_items；symptom_pattern、treatment_experience、emotional_pattern、other 会进入 user_memory_items 做语义召回。稳定情绪支持偏好请归 communication_preference；阶段性焦虑、情绪困扰模式才归 emotional_pattern。
temporalScope 可选，只能是：stable、current_state、episodic、scheduled、historical。沟通偏好/生活背景通常用 stable；症状/治疗体验当前仍可能影响服务时用 current_state；明确一次性历史事件用 historical，但能不存就不存。
如用户明确给出事件发生时间，可输出 eventAt（ISO 时间）；如该记忆预计会过期，可输出 expiresAt（ISO 时间）。不要把“今天/最近/下周”等相对时间直接写进 content。
没有值得新增的记忆时输出 {"items":[]}
最多输出 3 条。content 写成陈述事实，不要写成“以后必须...”这类指令句，也不要写成医疗建议。`
}

function buildLifecycleSystemPrompt(): string {
  return `你是长期记忆生命周期 reviewer。你只判断一个新候选记忆如何融入已有 active 记忆，目标是让长期记忆自进化，而不是不断累加重复碎片。

规则：
- 已有记忆已经覆盖新候选，输出 skip
- 新候选只是再次印证已有记忆，输出 touch，并指定 targetId
- 新候选补充了已有记忆，输出 merge，并给出合并后的 content
- 新候选修正了已有记忆但旧记忆仍可原地演化，输出 update，并给出更新后的 content
- 新候选与旧记忆冲突，旧记忆继续保留会误导后续回答时，输出 replace，并指定 replaceIds
- 新候选是同类型但独立的新长期背景，输出 create
- 不要因为措辞不同就 replace 或 create
- symptom_pattern / treatment_experience 中同一药物、同一症状、同一复诊主题的增量细节，优先 merge 或 update，不要拆成多条碎片
- 如果新候选说明旧的当前状态已经缓解、取消、反转或过期，优先 update/replace，不要继续保留会误导后续回答的旧状态
- 不处理病历事实，不做医学判断

只输出 JSON：
{"action":"skip","replaceIds":[]}
{"action":"touch","targetId":"旧记忆id"}
{"action":"merge","targetId":"旧记忆id","content":"合并后的记忆"}
{"action":"update","targetId":"旧记忆id","content":"更新后的记忆"}
{"action":"replace","replaceIds":["旧记忆id"],"content":"新的当前记忆"}
{"action":"create","replaceIds":[]}`
}

function buildLifecycleUserPrompt(
  candidate: NormalizedMemoryReviewItem,
  existingItems: UserMemoryItem[],
): string {
  const existing = existingItems
    .map((item, idx) => `${idx + 1}. id=${item.id}\n内容：${item.content}`)
    .join('\n\n')

  return `新候选记忆：
类型：${candidate.memoryType}
内容：${candidate.content}

已有同类型相似记忆：
${existing}`
}

function buildReviewerUserPrompt(input: {
  userMessageContent: string
  assistantMessageContent: string
  imageCount: number
  existingItems: Array<{ memoryType: string; content: string }>
}): string {
  const existing = input.existingItems.length
    ? input.existingItems
      .map((item, idx) => `${idx + 1}. [${item.memoryType}] ${truncate(item.content, 160)}`)
      .join('\n')
    : '无'

  return `用户最新消息：
${truncate(input.userMessageContent, MAX_REVIEW_INPUT_CHARS)}

当前时间：${new Date().toISOString()}

用户本轮上传图片数：${input.imageCount}

助手本轮回答摘要上下文：
${truncate(input.assistantMessageContent, MAX_ASSISTANT_CONTEXT_CHARS)}

已有长期记忆（如果新信息已被覆盖，请不要重复写入）：
${existing}`
}

export function buildCompactionReviewerUserPrompt(input: {
  messages: MemoryReviewCompactionMessage[]
  existingItems: Array<{ memoryType: string; content: string }>
}): string {
  const conversation = truncate(
    input.messages
      .map((message) => {
        const role = message.role === 'user' ? '用户' : '助手'
        return `【${role}】${message.content}`
      })
      .join('\n\n'),
    MAX_COMPACTION_REVIEW_CHARS,
  )
  const existing = input.existingItems.length
    ? input.existingItems
      .map((item, idx) => `${idx + 1}. [${item.memoryType}] ${truncate(item.content, 160)}`)
      .join('\n')
    : '无'

  return `以下对话即将被压缩出主上下文。请只从这些历史对话中提取未来多轮服务仍然有帮助、但压缩摘要可能损失细节的长期记忆。

当前时间：${new Date().toISOString()}

即将压缩的历史对话：
${conversation}

已有长期记忆（如果新信息已被覆盖，请不要重复写入）：
${existing}`
}

function parseReviewJson(raw: string): { items?: unknown[] } | null {
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()

  try {
    return JSON.parse(stripped) as { items?: unknown[] }
  } catch {
    const start = stripped.indexOf('{')
    const end = stripped.lastIndexOf('}')
    if (start < 0 || end <= start) return null
    try {
      return JSON.parse(stripped.slice(start, end + 1)) as { items?: unknown[] }
    } catch {
      return null
    }
  }
}

function isAllowedMemoryType(value: unknown): value is UserMemoryItemType {
  return typeof value === 'string' && allowedMemoryTypeSet.has(value as UserMemoryItemType)
}

function clampScore(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.round(value)))
}

function truncate(text: string, maxChars: number): string {
  const trimmed = text.trim()
  if (trimmed.length <= maxChars) return trimmed
  return `${trimmed.slice(0, maxChars)}...`
}
