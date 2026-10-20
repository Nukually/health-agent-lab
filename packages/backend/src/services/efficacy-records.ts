import { and, asc, desc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm'
import { getDb } from '../db/client.js'
import { chatSessions, efficacySessionAnalysisState, interventionEfficacyRecords, messages } from '../db/schema/index.js'
import { cleanUserPromptContent, MemoryContentRejectedError, scanMemoryContentForStorage } from './memory.js'
import { getProcessTimelineForClient } from '../utils/process-timeline-client.js'
import type {
  EfficacyAdoptionStatus,
  EfficacyCadence,
  EfficacyEvidence,
  EfficacyOutcome,
  EfficacyStatus,
} from '@health-agent/shared'
import type { Logger } from '../lib/logger.js'

export type EfficacyRecord = typeof interventionEfficacyRecords.$inferSelect

const DAY_MS = 86_400_000
// 未生效（stale）满此天数无被重新提及（updatedAt 老化）→ 自动废弃 discarded。
const DISCARD_DAYS = 14
// 召回时 stale（未生效）最多保留最新 N 条，超出的老 stale 自动废弃。
const STALE_RECALL_LIMIT = 10

/** 状态变更审计的一条记录，追加到 metadata.statusHistory。 */
interface StatusTransition {
  from: EfficacyStatus
  to: EfficacyStatus
  sessionId: string | null // cron 老化无 session
  reason: string
  at: string // ISO
}

/**
 * 由采纳/疗效/节律派生生命周期状态（纯函数，不产出 discarded —— 废弃只由 cron 老化/超额触发）：
 * - rejected → closed（结束）
 * - oneshot 且有效果反馈 → closed（结束：一次性方案已闭环）
 * - unknown → stale（未生效：用户未明确表态采纳）
 * - 其余（adopted/partial）→ active（生效中：含周期性、采纳后反馈变差/无变化）
 */
export function deriveStatus(
  adoptionStatus: EfficacyAdoptionStatus,
  outcome: EfficacyOutcome,
  cadence: EfficacyCadence,
): Extract<EfficacyStatus, 'active' | 'stale' | 'closed'> {
  if (adoptionStatus === 'rejected') return 'closed'
  if (cadence === 'oneshot' && outcome !== 'no_feedback') return 'closed'
  if (adoptionStatus === 'unknown') return 'stale'
  return 'active'
}

/** 把一条状态变更追加到 statusHistory（SQL 端 jsonb 拼接由调用方负责，这里只构造对象）。 */
function buildTransition(
  from: EfficacyStatus,
  to: EfficacyStatus,
  sessionId: string | null,
  reason: string,
  now: Date,
): StatusTransition {
  return { from, to, sessionId, reason, at: now.toISOString() }
}

export interface CreateEfficacyRecordInput {
  userId: string
  problem: string
  finalPlan: string
  cadence: EfficacyCadence
  expectedEndAt?: Date | null
  adoptionStatus: EfficacyAdoptionStatus
  outcome: EfficacyOutcome
  evidence?: EfficacyEvidence
  confidence?: number
  sourceSessionId: string
  sourceMessageId?: string | null
  metadata?: Record<string, unknown>
}

export interface UpdateEfficacyRecordInput {
  userId: string
  recordId: string
  finalPlan?: string
  adoptionStatus?: EfficacyAdoptionStatus
  outcome?: EfficacyOutcome
  evidence?: EfficacyEvidence
  sourceSessionId: string
  sourceMessageId?: string | null
  metadata?: Record<string, unknown>
}

export async function createEfficacyRecord(
  input: CreateEfficacyRecordInput,
  logger: Logger,
): Promise<EfficacyRecord> {
  // problem / finalPlan 含 LLM 抽取的用户对话内容，写库前过注入安全扫描（复用 memory 的扫描器）。
  for (const text of [input.problem, input.finalPlan]) {
    const scanned = scanMemoryContentForStorage(text)
    if (!scanned.ok) throw new MemoryContentRejectedError(scanned.reasons)
  }

  const now = new Date()
  const status = deriveStatus(input.adoptionStatus, input.outcome, input.cadence)
  const [row] = await getDb().insert(interventionEfficacyRecords).values({
    userId: input.userId,
    problem: input.problem.trim(),
    finalPlan: input.finalPlan.trim(),
    cadence: input.cadence,
    expectedEndAt: input.expectedEndAt ?? null,
    adoptionStatus: input.adoptionStatus,
    outcome: input.outcome,
    status,
    evidence: input.evidence ?? {},
    confidence: input.confidence ?? 70,
    sourceSessionIds: [input.sourceSessionId],
    firstSourceMessageId: input.sourceMessageId ?? null,
    lastSourceMessageId: input.sourceMessageId ?? null,
    metadata: {
      reviewerVersion: 1,
      lifecycle: 'created',
      statusHistory: [buildTransition(status, status, input.sourceSessionId, 'created', now)],
      ...input.metadata,
    },
  }).returning()

  logger.info({ userId: input.userId, recordId: row.id, adoptionStatus: input.adoptionStatus }, 'efficacy record created')
  return row
}

/**
 * 更新已有 record。若 finalPlan/adoptionStatus/outcome 相对现状均无变化，降级为 touch（仅推进 updatedAt 与
 * sourceSessionIds），不视为有效内容更新，避免"又聊一次同问题但无新反馈"产生无意义 update。
 */
export async function updateEfficacyRecord(
  input: UpdateEfficacyRecordInput,
  current: EfficacyRecord,
  logger: Logger,
): Promise<{ row: EfficacyRecord | null; touched: boolean }> {
  const nextFinalPlan = input.finalPlan?.trim()
  const planChanged = !!nextFinalPlan && nextFinalPlan !== current.finalPlan
  const adoptionChanged = !!input.adoptionStatus && input.adoptionStatus !== current.adoptionStatus
  const outcomeChanged = !!input.outcome && input.outcome !== current.outcome
  const touched = !planChanged && !adoptionChanged && !outcomeChanged

  if (planChanged) {
    const scanned = scanMemoryContentForStorage(nextFinalPlan)
    if (!scanned.ok) throw new MemoryContentRejectedError(scanned.reasons)
  }

  const now = new Date()
  const nextAdoption = input.adoptionStatus ?? current.adoptionStatus
  const nextOutcome = input.outcome ?? current.outcome
  // 按最新采纳/疗效重算状态。点名池已排除 closed/discarded，故 current 必为 active/stale，可安全重派生。
  const nextStatus = deriveStatus(nextAdoption, nextOutcome, current.cadence)
  const statusChanged = nextStatus !== current.status

  const mergedMetadata = {
    reviewerVersion: 1,
    lifecycle: touched ? 'touched' : 'updated',
    ...(touched ? {} : { previousAdoptionStatus: current.adoptionStatus, previousOutcome: current.outcome }),
    ...input.metadata,
  }
  // statusHistory 是追加语义：用 jsonb_set 在已有数组尾部 append，不能整体覆盖。
  const transition = statusChanged
    ? buildTransition(current.status, nextStatus, input.sourceSessionId, touched ? 'touched' : 'updated', now)
    : null

  const [row] = await getDb()
    .update(interventionEfficacyRecords)
    .set({
      finalPlan: planChanged ? nextFinalPlan : undefined,
      adoptionStatus: adoptionChanged ? input.adoptionStatus : undefined,
      outcome: outcomeChanged ? input.outcome : undefined,
      status: nextStatus,
      evidence: input.evidence && !touched
        ? sql`${interventionEfficacyRecords.evidence} || ${JSON.stringify(input.evidence)}::jsonb`
        : undefined,
      lastSourceMessageId: input.sourceMessageId ?? undefined,
      sourceSessionIds: sql`(
        SELECT array_agg(DISTINCT e) FROM unnest(
          array_append(${interventionEfficacyRecords.sourceSessionIds}, ${input.sourceSessionId}::uuid)
        ) AS e
      )`,
      metadata: transition
        ? sql`jsonb_set(
            ${interventionEfficacyRecords.metadata} || ${JSON.stringify(mergedMetadata)}::jsonb,
            '{statusHistory}',
            COALESCE(${interventionEfficacyRecords.metadata} -> 'statusHistory', '[]'::jsonb) || ${JSON.stringify([transition])}::jsonb
          )`
        : sql`${interventionEfficacyRecords.metadata} || ${JSON.stringify(mergedMetadata)}::jsonb`,
      updatedAt: now,
    })
    .where(and(
      eq(interventionEfficacyRecords.id, input.recordId),
      eq(interventionEfficacyRecords.userId, input.userId),
    ))
    .returning()

  if (row) {
    logger.info({ userId: input.userId, recordId: row.id, touched }, touched ? 'efficacy record touched' : 'efficacy record updated')
  }
  return { row: row ?? null, touched }
}

/** 召回：生效中(active)+未生效(stale) 且未过期，按 updatedAt 倒序取 Top-N，用于抽取阶段上下文。 */
export async function listRecallableEfficacyRecords(
  userId: string,
  now: Date,
  opts: { limit?: number } = {},
): Promise<EfficacyRecord[]> {
  return getDb().query.interventionEfficacyRecords.findMany({
    where: and(
      eq(interventionEfficacyRecords.userId, userId),
      inArray(interventionEfficacyRecords.status, ['active', 'stale']),
      or(
        isNull(interventionEfficacyRecords.expectedEndAt),
        gt(interventionEfficacyRecords.expectedEndAt, now),
      ),
    ),
    orderBy: desc(interventionEfficacyRecords.updatedAt),
    limit: opts.limit ?? 12,
  })
}

export async function getEfficacyRecordById(userId: string, recordId: string): Promise<EfficacyRecord | null> {
  const [row] = await getDb()
    .select()
    .from(interventionEfficacyRecords)
    .where(and(eq(interventionEfficacyRecords.userId, userId), eq(interventionEfficacyRecords.id, recordId)))
    .limit(1)
  return row ?? null
}

/** 点名召回用：可召回（active+stale）record 的精简视图（problem 短文本，不含 finalPlan，省 token）。
 *  排除 closed/discarded 终态——废弃方案不再参与点名，用户再次提及只会新建。 */
export async function listNonClosedEfficacyProblems(
  userId: string,
): Promise<Array<{ id: string; problem: string; status: string }>> {
  const rows = await getDb()
    .select({ id: interventionEfficacyRecords.id, problem: interventionEfficacyRecords.problem, status: interventionEfficacyRecords.status })
    .from(interventionEfficacyRecords)
    .where(and(
      eq(interventionEfficacyRecords.userId, userId),
      inArray(interventionEfficacyRecords.status, ['active', 'stale']),
    ))
    .orderBy(desc(interventionEfficacyRecords.updatedAt))
  return rows
}

/** 把单条 record 置为新状态并追加一条 statusHistory（cron 触发，sessionId=null）。 */
async function transitionStatus(
  userId: string,
  recordId: string,
  from: EfficacyStatus,
  to: EfficacyStatus,
  reason: string,
  now: Date,
): Promise<void> {
  const transition = buildTransition(from, to, null, reason, now)
  await getDb().update(interventionEfficacyRecords)
    .set({
      status: to,
      metadata: sql`jsonb_set(
        ${interventionEfficacyRecords.metadata},
        '{statusHistory}',
        COALESCE(${interventionEfficacyRecords.metadata} -> 'statusHistory', '[]'::jsonb) || ${JSON.stringify([transition])}::jsonb
      )`,
      updatedAt: now,
    })
    .where(and(eq(interventionEfficacyRecords.userId, userId), eq(interventionEfficacyRecords.id, recordId)))
}

/**
 * 状态机推进：对该用户全部非终态 record 按"当前时间"重算 status（纯代码，不调 LLM），逐条记 statusHistory。
 * - rejected / 一次性方案已反馈 → closed（结束）
 * - periodic 且 expectedEndAt 已过 → closed（结束：疗程已过）
 * - 未生效(stale) 超 14 天未被重新提及 → discarded（废弃）
 * - 未生效(stale) 超出最新 STALE_RECALL_LIMIT 条 → discarded（废弃：召回保留上限外的老 stale）
 */
export async function advanceEfficacyStatuses(
  userId: string,
  now: Date,
  logger: Logger,
): Promise<void> {
  const nowMs = now.getTime()
  const records = await getDb()
    .select()
    .from(interventionEfficacyRecords)
    .where(and(
      eq(interventionEfficacyRecords.userId, userId),
      inArray(interventionEfficacyRecords.status, ['active', 'stale']),
    ))

  let closed = 0
  let discarded = 0
  // stale 按 updatedAt 倒序排名，超出 STALE_RECALL_LIMIT 的判为"超额老 stale"。
  const staleRank = new Map<string, number>()
  records
    .filter((r) => r.status === 'stale')
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
    .forEach((r, i) => staleRank.set(r.id, i))

  for (const r of records) {
    // 1) 闭环判定：rejected / 一次性已反馈 / periodic 疗程已过。
    const derived = deriveStatus(r.adoptionStatus, r.outcome, r.cadence)
    if (derived === 'closed') {
      await transitionStatus(userId, r.id, r.status, 'closed', 'lifecycle_closed', now)
      closed++
      continue
    }
    if (r.cadence === 'periodic' && r.expectedEndAt && r.expectedEndAt.getTime() < nowMs) {
      await transitionStatus(userId, r.id, r.status, 'closed', 'periodic_ended', now)
      closed++
      continue
    }
    // 2) 废弃判定：仅对未生效(stale)。
    if (r.status === 'stale') {
      const agedOut = nowMs - r.updatedAt.getTime() > DISCARD_DAYS * DAY_MS
      const overLimit = (staleRank.get(r.id) ?? 0) >= STALE_RECALL_LIMIT
      if (agedOut || overLimit) {
        await transitionStatus(userId, r.id, r.status, 'discarded', agedOut ? 'stale_aged_out' : 'stale_over_limit', now)
        discarded++
      }
    }
  }

  if (closed || discarded) {
    logger.debug({ userId, closed, discarded }, 'efficacy statuses advanced')
  }
}

// ----- session 扫描与增量消息 -----

export interface PendingEfficacySession {
  sessionId: string
  userId: string
  analyzedUpToCreatedAt: Date | null
}

/** 扫描"停止活跃 ≥N 小时 且 有未分析新消息"的 session。 */
export async function getActiveSessionsPendingEfficacyAnalysis(
  opts: { inactiveHours: number; limit: number },
): Promise<PendingEfficacySession[]> {
  const rows = await getDb().execute<{ session_id: string; user_id: string; analyzed_up_to_created_at: Date | null }>(sql`
    SELECT s.id AS session_id, s.user_id, st.analyzed_up_to_created_at
    FROM ${chatSessions} s
    LEFT JOIN ${efficacySessionAnalysisState} st ON st.session_id = s.id
    WHERE s.updated_at < (now() - make_interval(hours => ${opts.inactiveHours}))
      AND EXISTS (
        SELECT 1 FROM ${messages} m
        WHERE m.session_id = s.id
          AND m.role IN ('user', 'assistant')
          AND (st.analyzed_up_to_created_at IS NULL OR m.created_at > st.analyzed_up_to_created_at)
      )
    ORDER BY s.updated_at ASC
    LIMIT ${opts.limit}
  `)
  // db.execute() 走 postgres-js raw 路径，timestamptz 返回字符串而非 Date（Drizzle select 才会映射成 Date）。
  // 不转 Date 直接喂回 getIncrementalMessagesForAnalysis 的 gt(messages.createdAt, ...) 会触发 value.toISOString is not a function。
  return (rows as unknown as Array<{ session_id: string; user_id: string; analyzed_up_to_created_at: string | null }>)
    .map((r) => ({
      sessionId: r.session_id,
      userId: r.user_id,
      analyzedUpToCreatedAt: r.analyzed_up_to_created_at ? new Date(r.analyzed_up_to_created_at) : null,
    }))
}

export interface IncrementalMessage {
  role: 'user' | 'assistant'
  content: string
}

/**
 * 重建 assistant 这一轮喂给疗效分析的完整正文。
 *
 * 新前端交互下 messages.content 只存无工具调用的收尾轮正文，带工具调用轮的「中间叙述」
 * （含 AI 给出的干预方案正文）被挪进 rawResponse.processTimeline 的 text 节点。疗效分析要
 * 抽取 AI 方案，必须把中间叙述也还原回来：按时间线 text 节点 + content 列收尾正文顺序拼接，
 * 去掉相邻重复。无 processTimeline 的旧消息直接回退 content 列。
 */
export function buildAssistantAnalysisContent(content: string, rawResponse: unknown): string {
  const timeline = getProcessTimelineForClient(rawResponse)
  if (!timeline?.length) return content

  const parts: string[] = []
  for (const step of timeline) {
    if (step.type !== 'text') continue
    const text = step.content?.trim()
    if (text) parts.push(text)
  }
  const tail = content.trim()
  if (tail) parts.push(tail)

  const deduped: string[] = []
  for (const p of parts) {
    if (deduped[deduped.length - 1] === p) continue
    deduped.push(p)
  }
  return deduped.join('\n')
}

/** 取该 session 水位线之后的 user/assistant 消息（清洗 system-reminder/合成附件），并返回本批最大 createdAt。 */
export async function getIncrementalMessagesForAnalysis(
  sessionId: string,
  sinceCreatedAt: Date | null,
): Promise<{ messages: IncrementalMessage[]; maxCreatedAt: Date | null; lastUserMessageId: string | null }> {
  const where = sinceCreatedAt
    ? and(eq(messages.sessionId, sessionId), inArray(messages.role, ['user', 'assistant']), gt(messages.createdAt, sinceCreatedAt))
    : and(eq(messages.sessionId, sessionId), inArray(messages.role, ['user', 'assistant']))

  const rows = await getDb()
    .select({ id: messages.id, role: messages.role, content: messages.content, rawResponse: messages.rawResponse, createdAt: messages.createdAt })
    .from(messages)
    .where(where)
    .orderBy(asc(messages.createdAt))

  const cleaned: IncrementalMessage[] = []
  let maxCreatedAt: Date | null = null
  let lastUserMessageId: string | null = null
  for (const r of rows) {
    if (!maxCreatedAt || r.createdAt > maxCreatedAt) maxCreatedAt = r.createdAt
    // assistant 正文要从 processTimeline 还原中间叙述（含 AI 方案）；user 维持原清洗逻辑。
    const rawContent = r.role === 'assistant'
      ? buildAssistantAnalysisContent(r.content, r.rawResponse)
      : r.content
    const text = cleanUserPromptContent(rawContent)
    if (!text) continue
    // 去掉连续完全重复的消息（前端重发/SSE 重连会产出相邻同 role 同内容），避免破坏问答节奏、干扰角色判断。
    const prev = cleaned[cleaned.length - 1]
    if (prev && prev.role === r.role && prev.content === text) continue
    cleaned.push({ role: r.role as 'user' | 'assistant', content: text })
    if (r.role === 'user') lastUserMessageId = r.id
  }
  return { messages: cleaned, maxCreatedAt, lastUserMessageId }
}

// ----- 水位线状态 -----

export async function upsertEfficacyAnalysisStateOnSuccess(input: {
  sessionId: string
  userId: string
  analyzedUpToCreatedAt: Date
}): Promise<void> {
  await getDb().insert(efficacySessionAnalysisState).values({
    sessionId: input.sessionId,
    userId: input.userId,
    analyzedUpToCreatedAt: input.analyzedUpToCreatedAt,
    lastAnalyzedAt: new Date(),
    analysisCount: 1,
    lastError: null,
    failureCount: 0,
  }).onConflictDoUpdate({
    target: efficacySessionAnalysisState.sessionId,
    set: {
      analyzedUpToCreatedAt: input.analyzedUpToCreatedAt,
      lastAnalyzedAt: new Date(),
      analysisCount: sql`${efficacySessionAnalysisState.analysisCount} + 1`,
      lastError: null,
      failureCount: 0,
      updatedAt: new Date(),
    },
  })
}

export async function recordEfficacyAnalysisFailure(input: {
  sessionId: string
  userId: string
  error: string
}): Promise<void> {
  const truncated = input.error.slice(0, 1000)
  await getDb().insert(efficacySessionAnalysisState).values({
    sessionId: input.sessionId,
    userId: input.userId,
    lastError: truncated,
    failureCount: 1,
  }).onConflictDoUpdate({
    target: efficacySessionAnalysisState.sessionId,
    set: {
      lastError: truncated,
      failureCount: sql`${efficacySessionAnalysisState.failureCount} + 1`,
      updatedAt: new Date(),
    },
  })
}
