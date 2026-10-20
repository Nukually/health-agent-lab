import { randomUUID } from 'node:crypto'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import {
  isFeatureEnabled,
  type FeatureSnapshot,
  type InterventionFollowupIntentKind,
  type InterventionFollowupIntentStatus,
  type InterventionMaterialEngagementRecord,
  type InterventionMaterialToolOutput,
  type MedicalRiskVideoResource,
  type MessageRecord,
} from '@health-agent/shared'
import { getDb } from '../db/client.js'
import {
  chatSessions,
  interventionFollowupIntents,
  messages,
} from '../db/schema/index.js'
import type { Logger } from '../lib/logger.js'
import { estimateTextTokens } from '../utils/tokens.js'
import { stripSystemReminderText } from '../utils/system-reminder.js'
import { llmCall } from '../lib/llm.js'
import { getBackendFeatureSnapshot } from '../features.js'
import {
  cancelScheduledProactiveMessagesForEntity,
  listFutureScheduledTasks,
  renderFutureScheduledTasksForFollowupContext,
  type FutureScheduledTaskSummary,
} from './scheduled-proactive-message.js'

type IntentRow = typeof interventionFollowupIntents.$inferSelect
const FOLLOWUP_GENERATION_MODEL = 'qwen3.5-flash'
const FOLLOWUP_CONTEXT_MESSAGE_LIMIT = 8
const FOLLOWUP_CONTEXT_CONTENT_LIMIT = 600
const FOLLOWUP_RAW_RESPONSE_KIND = 'intervention_followup_question'
const SESSION_FOLLOWUP_SLOT_STATUSES: InterventionFollowupIntentStatus[] = [
  'pending',
  'generating',
  'sent',
  'consumed_by_user_message',
  'discarded',
]
const DAILY_EFFECT_FOLLOWUP_SLOT_STATUSES: InterventionFollowupIntentStatus[] = [
  'pending',
  'generating',
  'sent',
  'consumed_by_user_message',
]

type FollowupResourceKind = 'intervention_material' | 'video_resource'
type VideoResourceFollowupTrigger = 'playback_end' | 'mobile_play_30s' | 'mobile_play_half'

interface FollowupIntentMetadata {
  resourceKind: FollowupResourceKind
  followupTrigger?: VideoResourceFollowupTrigger
  engagementId: string
  materialCode: string
  materialId: string
  actionName: string
  sideEffect: string
  scene: string
  materialDurationSec: number
  totalFollowSec: number
  completedStepCount: number
  totalStepCount: number
}

function parseMetadata(raw: Record<string, unknown> | null | undefined): FollowupIntentMetadata {
  const resourceKind = raw?.resourceKind === 'video_resource' ? 'video_resource' : 'intervention_material'
  const followupTrigger = raw?.followupTrigger === 'mobile_play_half' || raw?.followupTrigger === 'mobile_play_30s'
    ? raw.followupTrigger
    : 'playback_end'
  return {
    resourceKind,
    followupTrigger,
    engagementId: typeof raw?.engagementId === 'string' ? raw.engagementId : '',
    materialCode: typeof raw?.materialCode === 'string' ? raw.materialCode : '',
    materialId: typeof raw?.materialId === 'string' ? raw.materialId : '',
    actionName: typeof raw?.actionName === 'string'
      ? raw.actionName
      : resourceKind === 'video_resource' ? '这个视频' : '这张跟练卡',
    sideEffect: typeof raw?.sideEffect === 'string' ? raw.sideEffect : '不适',
    scene: typeof raw?.scene === 'string' ? raw.scene : '',
    materialDurationSec: typeof raw?.materialDurationSec === 'number' ? raw.materialDurationSec : 0,
    totalFollowSec: typeof raw?.totalFollowSec === 'number' ? raw.totalFollowSec : 0,
    completedStepCount: typeof raw?.completedStepCount === 'number' ? raw.completedStepCount : 0,
    totalStepCount: typeof raw?.totalStepCount === 'number' ? raw.totalStepCount : 0,
  }
}

function resourceLabel(meta: FollowupIntentMetadata): string {
  return meta.resourceKind === 'video_resource' ? '这个视频' : '这张跟练卡'
}

function resourceTypeLabel(meta: FollowupIntentMetadata): string {
  return meta.resourceKind === 'video_resource' ? '视频' : '跟练卡'
}

function isMobileEstimatedVideoEffectCheck(meta: FollowupIntentMetadata): boolean {
  return meta.resourceKind === 'video_resource'
    && (meta.followupTrigger === 'mobile_play_half' || meta.followupTrigger === 'mobile_play_30s')
}

function effectQuestionTarget(meta: FollowupIntentMetadata): string {
  if (isMobileEstimatedVideoEffectCheck(meta)) {
    return '刚才跟着这个视频练了一段时间，对你现在的不适有没有帮助或缓解一些'
  }
  return meta.resourceKind === 'video_resource'
    ? '刚才跟着这个视频练了一会儿后有没有缓解一些'
    : `${meta.sideEffect}刚才跟练后有没有缓解一些`
}

function isFollowupQuestionRawResponse(raw: unknown): boolean {
  return !!raw
    && typeof raw === 'object'
    && !Array.isArray(raw)
    && (raw as { kind?: unknown }).kind === FOLLOWUP_RAW_RESPONSE_KIND
}

async function lockSessionFollowupSlot(tx: any, sessionId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${sessionId}, 0))`)
}

function formatShanghaiDate(date: Date): string {
  return date.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' })
}

async function lockDailyEffectFollowupSlot(tx: any, userId: string, dateStr: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`intervention-effect-followup:${userId}:${dateStr}`}, 0))`)
}

async function hasExistingDailyEffectFollowupQuestion(
  dbOrTx: any,
  userId: string,
  dateStr: string,
): Promise<boolean> {
  const rows = await dbOrTx.query.interventionFollowupIntents.findMany({
    where: and(
      eq(interventionFollowupIntents.userId, userId),
      eq(interventionFollowupIntents.kind, 'effect_question'),
      inArray(interventionFollowupIntents.status, DAILY_EFFECT_FOLLOWUP_SLOT_STATUSES),
      sql`(
        (${interventionFollowupIntents.createdAt} AT TIME ZONE 'Asia/Shanghai')::date = ${dateStr}::date
        OR (${interventionFollowupIntents.updatedAt} AT TIME ZONE 'Asia/Shanghai')::date = ${dateStr}::date
      )`,
    ),
    columns: { id: true },
    limit: 1,
  })
  return rows.length > 0
}

async function hasExistingSessionFollowupQuestion(
  dbOrTx: any,
  userId: string,
  sessionId: string,
  opts: { ignoreIntentId?: string } = {},
): Promise<boolean> {
  const intentRows = await dbOrTx.query.interventionFollowupIntents.findMany({
    where: and(
      eq(interventionFollowupIntents.userId, userId),
      eq(interventionFollowupIntents.sessionId, sessionId),
      inArray(interventionFollowupIntents.status, SESSION_FOLLOWUP_SLOT_STATUSES),
    ),
    columns: { id: true },
  })
  if (intentRows.some((row: { id: string }) => row.id !== opts.ignoreIntentId)) return true

  const messageRows = await dbOrTx.query.messages.findMany({
    where: and(
      eq(messages.sessionId, sessionId),
      eq(messages.role, 'assistant'),
    ),
    columns: { rawResponse: true },
    orderBy: desc(messages.createdAt),
  })
  return messageRows.some((row: { rawResponse: unknown }) => isFollowupQuestionRawResponse(row.rawResponse))
}

export function resolveInterventionFollowupIntentKind(params: {
  totalFollowSec: number
  materialDurationSec: number
}): InterventionFollowupIntentKind {
  const duration = Math.max(0, params.materialDurationSec)
  if (duration <= 0) return 'completion_reminder_offer'
  return params.totalFollowSec / duration >= 0.5
    ? 'effect_question'
    : 'completion_reminder_offer'
}

export function shouldCreateInterventionFollowupIntent(
  kind: InterventionFollowupIntentKind,
  features: FeatureSnapshot = getBackendFeatureSnapshot(),
): boolean {
  return kind !== 'completion_reminder_offer'
    || isFeatureEnabled(features, 'interventionCompletionReminderOffer')
}

export function shouldEnforceDailyEffectFollowupLimit(features: FeatureSnapshot): boolean {
  return features.profile === 'sit' || features.profile === 'prod'
}

function normalizeForTaskMatch(value: string): string {
  return value.toLowerCase().replace(/[\s｜|:：，。,.;；、（）()[\]【】"'“”‘’]/g, '')
}

function findLikelyExistingCompletionTask(
  tasks: FutureScheduledTaskSummary[],
  meta: FollowupIntentMetadata,
): FutureScheduledTaskSummary | null {
  if (meta.engagementId) {
    const sameEngagement = tasks.find((task) =>
      task.purpose === 'intervention_completion_reminder' &&
      task.entityType === 'intervention_material_engagement' &&
      task.entityId === meta.engagementId
    )
    if (sameEngagement) return sameEngagement
  }

  const candidates = [
    meta.materialCode,
    meta.actionName,
    meta.sideEffect,
  ].map(normalizeForTaskMatch).filter((item) => item.length >= 2)

  return tasks.find((task) => {
    const haystack = normalizeForTaskMatch(`${task.taskName}\n${task.message}`)
    const looksLikeCompletionReminder = /(跟练|练习|完成|回来)/.test(task.taskName + task.message)
    return looksLikeCompletionReminder && candidates.some((candidate) => haystack.includes(candidate))
  }) ?? null
}

function buildFallbackIntentAssistantMessage(
  kind: InterventionFollowupIntentKind,
  meta: FollowupIntentMetadata,
  futureTasks: FutureScheduledTaskSummary[] = [],
): string | null {
  if (kind === 'effect_question') {
    return `${effectQuestionTarget(meta)}？如果不适明显加重，请及时联系医生或就医。`
  }
  const existingTask = findLikelyExistingCompletionTask(futureTasks, meta)
  if (existingTask) {
    return null
  }
  return `看到${resourceLabel(meta)}你刚才只练了一部分，后面有空还想继续练完吗？需要我到时候提醒你吗？`
}

function compactStoredMessageContent(content: string): string {
  const stripped = stripSystemReminderText(content)
  if (!stripped.startsWith('[')) return stripped.trim().slice(0, FOLLOWUP_CONTEXT_CONTENT_LIMIT)
  try {
    const blocks = JSON.parse(stripped) as Array<{ type?: string; text?: string }>
    if (!Array.isArray(blocks)) return stripped.trim().slice(0, FOLLOWUP_CONTEXT_CONTENT_LIMIT)
    const text = blocks
      .map((block) => block.type === 'text' && typeof block.text === 'string' ? block.text : '[图片]')
      .join('\n')
    return text.trim().slice(0, FOLLOWUP_CONTEXT_CONTENT_LIMIT)
  } catch {
    return stripped.trim().slice(0, FOLLOWUP_CONTEXT_CONTENT_LIMIT)
  }
}

async function loadRecentConversationContext(sessionId: string): Promise<string> {
  const rows = await getDb().query.messages.findMany({
    where: eq(messages.sessionId, sessionId),
    orderBy: desc(messages.createdAt),
    limit: FOLLOWUP_CONTEXT_MESSAGE_LIMIT,
    columns: {
      role: true,
      content: true,
      createdAt: true,
    },
  })

  return rows.reverse()
    .map((row) => {
      const roleLabel = row.role === 'user' ? '用户' : 'AI'
      const content = compactStoredMessageContent(row.content)
      return content ? `${roleLabel}：${content}` : null
    })
    .filter((item): item is string => !!item)
    .join('\n')
}

function buildFollowupGenerationPrompt(params: {
  kind: InterventionFollowupIntentKind
  meta: FollowupIntentMetadata
  futureTasks: FutureScheduledTaskSummary[]
  conversationContext: string
}): string {
  const { kind, meta, futureTasks, conversationContext } = params
  const label = resourceLabel(meta)
  const typeLabel = resourceTypeLabel(meta)
  const contextLabel = meta.resourceKind === 'video_resource' ? '匹配问题' : '副作用'
  const progress = [
    `${typeLabel}：${meta.actionName}`,
    `${contextLabel}：${meta.sideEffect}`,
    `场景：${meta.scene || '未标注'}`,
    `编号：${meta.materialCode}`,
    `进度：已跟练 ${meta.totalFollowSec}s / 总时长 ${meta.materialDurationSec}s`,
  ].join('\n')
  const scheduledTaskEnabled = isFeatureEnabled(getBackendFeatureSnapshot(), 'agentScheduledTasks')
  const scheduledTasksContext = scheduledTaskEnabled
    ? renderFutureScheduledTasksForFollowupContext(futureTasks)
    : '当前环境未开放定时提醒能力。'
  const isMobileVideoEffectCheck = isMobileEstimatedVideoEffectCheck(meta)
  const task = kind === 'effect_question'
    ? isMobileVideoEffectCheck
      ? `生成一条将直接发送给用户的中文消息：用户在移动端点击播放跟练视频后，已到视频约一半时长；当前无法可靠读取 iframe 内部暂停/结束状态。请自然追问“${effectQuestionTarget(meta)}”。不要说“练完后”，不要提到后台判定、时长比例、定时任务、APP 推送或 iframe。若最近上下文里出现不适明显加重，只加一句及时联系医生或就医的安全提醒。`
      : `生成一条将直接发送给用户的中文消息：自然追问“${effectQuestionTarget(meta)}”。不要提到后台判定、时长比例、定时任务或 APP 推送。若最近上下文里出现不适明显加重，只加一句及时联系医生或就医的安全提醒。`
    : scheduledTaskEnabled
      ? `生成一条将直接发送给用户的中文消息：用户本次跟练少于一半，询问后面有空是否想继续练完，以及是否需要到时候提醒。必须参考已有定时任务；如果已经有当前${typeLabel}或同类完成提醒，必须只输出 [no_notification]，不要输出其他文字。不要直接承诺已经新建任务。`
      : `生成一条将直接发送给用户的中文消息：用户本次跟练少于一半，自然鼓励后面有空可以回到${label}继续练完。不要询问是否需要提醒，不要承诺设置提醒，不要提到定时任务或 APP 推送。`
  const examples = scheduledTaskEnabled
    ? [
        `- 好：看到${label}你刚才只练了一部分，后面有空还想继续练完吗？需要我到时候提醒你吗？`,
        `- 好：刚才${label}只完成了一部分，后面想继续练完的话，要不要我晚点提醒你回来？`,
        '- 差：现在先休息好吗？如果晚点想回来把剩下的做完，需要我提醒你吗？',
        '- 差：不要硬撑，等你舒服些再慢慢做。',
      ].join('\n')
    : [
        `- 好：看到${label}你刚才只练了一部分，后面有空可以回来把剩下的慢慢练完。`,
        `- 好：${label}还剩一部分，等你后面方便时，可以继续练。`,
        '- 差：需要我到时候提醒你吗？',
        '- 差：我晚点提醒你回来练完。',
      ].join('\n')

  return `你是Health Agent Lab的对话助手。请根据最近对话和跟练进度，写一条自然、简短、口语化的中文 assistant 消息。

要求：
- 只输出要发送给用户的一条消息，不要解释，不要 Markdown，不要 XML 标签。
- 如果本次任务要求输出 [no_notification]，就只输出该标识。
- 语气温和，不要制造压力。
- 不要建议用户“现在休息一下/不要硬撑/等舒服些再做”；这不是本任务要表达的重点。
- 不要编造对话里没有的信息。
- 80 字以内。

参考例子：
${examples}

最近对话：
${conversationContext || '（暂无可用上下文）'}

跟练信息：
${progress}

已有定时任务：
${scheduledTasksContext}

本次任务：
${task}`
}

function sanitizeGeneratedFollowupContent(
  raw: string | null | undefined,
  fallback: string | null,
): string | null {
  const text = raw
    ?.replace(/```[\s\S]*?```/g, '')
    .trim()
  if (!text) return fallback
  if (/\[no_notification\]/i.test(text)) return null
  if (text.length > 240) return text.slice(0, 240)
  return text
}

async function generateIntentAssistantMessage(params: {
  kind: InterventionFollowupIntentKind
  meta: FollowupIntentMetadata
  futureTasks: FutureScheduledTaskSummary[]
  sessionId: string
  logger: Logger
}): Promise<string | null> {
  const fallback = buildFallbackIntentAssistantMessage(params.kind, params.meta, params.futureTasks)
  try {
    const conversationContext = await loadRecentConversationContext(params.sessionId)
    const prompt = buildFollowupGenerationPrompt({
      kind: params.kind,
      meta: params.meta,
      futureTasks: params.futureTasks,
      conversationContext,
    })
    const response = await llmCall({
      model: FOLLOWUP_GENERATION_MODEL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 180,
      temperature: 0.4,
      enable_thinking: false,
    }, params.logger.child({ module: 'intervention-followup-intent-gen' }))
    return sanitizeGeneratedFollowupContent(
      response.choices?.[0]?.message?.content ?? null,
      fallback,
    )
  } catch (err: any) {
    params.logger.warn({ error: err?.message ?? String(err) }, 'intervention followup generation failed, using fallback')
    return fallback
  }
}

function buildIntentReminder(
  kind: InterventionFollowupIntentKind,
  meta: FollowupIntentMetadata,
  futureTasks: FutureScheduledTaskSummary[] = [],
): string {
  const label = resourceLabel(meta)
  const typeLabel = resourceTypeLabel(meta)
  const progress = `用户刚结束${typeLabel}跟练：${meta.actionName}（${meta.resourceKind === 'video_resource' ? '匹配问题' : '副作用'}：${meta.sideEffect}；场景：${meta.scene || '未标注'}；编号：${meta.materialCode}），已跟练 ${meta.totalFollowSec}s / 总时长 ${meta.materialDurationSec}s。`

  if (kind === 'effect_question') {
    if (isMobileEstimatedVideoEffectCheck(meta)) {
      return `[intervention-followup:effect_question]
用户刚才在移动端点击开始视频跟练：${meta.actionName}（匹配问题：${meta.sideEffect}；场景：${meta.scene || '未标注'}；编号：${meta.materialCode}）。移动端视频 iframe 无法稳定回传暂停/结束状态，因此这里做一次轻量效果追问。
本轮请先回应用户刚发送的真实消息，再自然追问：${effectQuestionTarget(meta)}。不要说“练完后”，不要提及系统提醒、后台判定、时长比例或 iframe；不要触发 APP 推送。`
    }
    return `[intervention-followup:effect_question]
${progress}
本轮请先回应用户刚发送的真实消息，再自然追问：${effectQuestionTarget(meta)}。不要提及系统提醒或后台判定；不要触发 APP 推送。`
  }

  if (!isFeatureEnabled(getBackendFeatureSnapshot(), 'agentScheduledTasks')) {
    return `[intervention-followup:completion_reminder_offer]
${progress}
用户本次跟练少于一半。本轮请先回应用户刚发送的真实消息，再自然鼓励她后面有空可以回到${label}继续练完。不要询问是否需要提醒，不要承诺设置提醒，不要调用或提及定时任务工具。`
  }

  return `[intervention-followup:completion_reminder_offer]
${progress}
${renderFutureScheduledTasksForFollowupContext(futureTasks)}
用户本次跟练少于一半。本轮请先回应用户刚发送的真实消息，再询问是否需要晚些提醒她回来完成${label}。
如果已有任务里已经有当前${typeLabel}或同类不适完成提醒，不要重复询问是否新建提醒；可以说明已有提醒，并询问是否要调整时间或取消。
如果用户明确说需要提醒、同意提醒，或给出具体提醒时间，请调用 schedule action=create 创建定时任务；传 task、message、time。message 写成未来到点后发给用户的提醒信息，简练、温暖、直接；不要复制上一轮询问用户是否需要提醒的句子。time 可传未来 ISO 8601 或 cron 重复规则。task 要有区分度，优先写成“完成${meta.sideEffect}跟练卡”或“完成${meta.actionName}跟练卡”，不要只写“提醒/跟练提醒”。若用户说不需要，就不要创建提醒。`
}

function toMessageRecord(messageId: string, content: string, createdAt: Date): MessageRecord {
  return {
    id: messageId,
    role: 'assistant',
    content,
    thinking: null,
    toolCalls: null,
    createdAt: createdAt.toISOString(),
  }
}

function buildFollowupRawResponse(
  kind: InterventionFollowupIntentKind,
  meta: FollowupIntentMetadata,
): Record<string, unknown> {
  return {
    kind: FOLLOWUP_RAW_RESPONSE_KIND,
    followupKind: kind,
    resourceKind: meta.resourceKind,
    followupTrigger: meta.followupTrigger ?? null,
    engagementId: meta.engagementId || null,
    resourceId: meta.materialId || null,
    resourceCode: meta.materialCode || null,
  }
}

async function insertFollowupAssistantMessage(
  tx: any,
  params: {
    sessionId: string
    messageId: string
    content: string
    kind: InterventionFollowupIntentKind
    meta: FollowupIntentMetadata
    createdAt: Date
  },
): Promise<void> {
  const tokenCount = estimateTextTokens(params.content)
  await tx.insert(messages).values({
    id: params.messageId,
    sessionId: params.sessionId,
    role: 'assistant',
    content: params.content,
    tokenCount,
    rawResponse: buildFollowupRawResponse(params.kind, params.meta),
    createdAt: params.createdAt,
  })

  const session = await tx.query.chatSessions.findFirst({
    where: eq(chatSessions.id, params.sessionId),
    columns: { messageCount: true, tokenCount: true },
  })
  if (session) {
    await tx.update(chatSessions).set({
      messageCount: session.messageCount + 1,
      tokenCount: session.tokenCount + tokenCount,
      updatedAt: params.createdAt,
    }).where(eq(chatSessions.id, params.sessionId))
  }
}

export async function createInterventionFollowupIntentForReturnOverview(
  params: {
    userId: string
    sessionId: string
    engagement: InterventionMaterialEngagementRecord
    snapshot: InterventionMaterialToolOutput
  },
  logger: Logger,
): Promise<IntentRow | null> {
  const kind = resolveInterventionFollowupIntentKind({
    totalFollowSec: params.engagement.totalFollowSec,
    materialDurationSec: params.engagement.materialDurationSec,
  })
  const features = getBackendFeatureSnapshot()
  if (!shouldCreateInterventionFollowupIntent(kind, features)) {
    logger.info({
      engagementId: params.engagement.id,
      kind,
    }, 'intervention followup intent skipped by feature gate')
    return null
  }

  const db = getDb()
  const dailyEffectLimitDate = kind === 'effect_question' && shouldEnforceDailyEffectFollowupLimit(features)
    ? formatShanghaiDate(new Date())
    : null
  const metadata: FollowupIntentMetadata = {
    resourceKind: 'intervention_material',
    engagementId: params.engagement.id,
    materialCode: params.engagement.materialCode,
    materialId: params.engagement.materialId,
    actionName: params.snapshot.actionName,
    sideEffect: params.snapshot.sideEffect,
    scene: params.snapshot.scene,
    materialDurationSec: params.engagement.materialDurationSec,
    totalFollowSec: params.engagement.totalFollowSec,
    completedStepCount: params.engagement.completedStepCount,
    totalStepCount: params.engagement.totalStepCount,
  }

  const now = new Date()
  const row = await db.transaction(async (tx) => {
    if (dailyEffectLimitDate) {
      await lockDailyEffectFollowupSlot(tx, params.userId, dailyEffectLimitDate)
    }
    await lockSessionFollowupSlot(tx, params.sessionId)
    if (dailyEffectLimitDate && await hasExistingDailyEffectFollowupQuestion(tx, params.userId, dailyEffectLimitDate)) {
      return null
    }
    if (await hasExistingSessionFollowupQuestion(tx, params.userId, params.sessionId)) {
      return null
    }
    const [created] = await tx.insert(interventionFollowupIntents).values({
      userId: params.userId,
      sessionId: params.sessionId,
      engagementId: params.engagement.id,
      kind,
      status: 'pending',
      metadata: metadata as unknown as Record<string, unknown>,
      createdAt: now,
      updatedAt: now,
    }).returning()
    return created
  })

  if (!row) return null

  if (kind === 'effect_question') {
    await cancelScheduledProactiveMessagesForEntity({
      userId: params.userId,
      entityType: 'intervention_material_engagement',
      entityId: params.engagement.id,
      purpose: 'intervention_completion_reminder',
    }, logger)
  }

  logger.info({
    intentId: row.id,
    engagementId: params.engagement.id,
    kind,
  }, 'intervention followup intent created')
  return row
}

export async function createVideoResourceFollowupIntent(
  params: {
    userId: string
    sessionId: string
    resource: MedicalRiskVideoResource
    totalFollowSec: number
    materialDurationSec?: number
    kind?: InterventionFollowupIntentKind
    followupTrigger?: VideoResourceFollowupTrigger
  },
  logger: Logger,
): Promise<IntentRow | null> {
  const materialDurationSec = Math.max(
    0,
    Math.floor(params.materialDurationSec ?? params.resource.durationSec ?? 0),
  )
  const totalFollowSec = Math.max(0, Math.floor(params.totalFollowSec))
  const kind = params.kind ?? 'effect_question'
  const features = getBackendFeatureSnapshot()
  if (!shouldCreateInterventionFollowupIntent(kind, features)) {
    logger.info({
      resourceId: params.resource.id,
      kind,
    }, 'video resource followup intent skipped by feature gate')
    return null
  }
  const dailyEffectLimitDate = kind === 'effect_question' && shouldEnforceDailyEffectFollowupLimit(features)
    ? formatShanghaiDate(new Date())
    : null
  const metadata: FollowupIntentMetadata = {
    resourceKind: 'video_resource',
    followupTrigger: params.followupTrigger ?? 'playback_end',
    engagementId: '',
    materialCode: params.resource.providerVideoId ?? params.resource.id,
    materialId: params.resource.id,
    actionName: params.resource.title || '这个视频',
    sideEffect: params.resource.sourceQuery || '当前不适',
    scene: '视频跟练',
    materialDurationSec,
    totalFollowSec,
    completedStepCount: 0,
    totalStepCount: 0,
  }
  const now = new Date()
  const row = await getDb().transaction(async (tx) => {
    if (dailyEffectLimitDate) {
      await lockDailyEffectFollowupSlot(tx, params.userId, dailyEffectLimitDate)
    }
    await lockSessionFollowupSlot(tx, params.sessionId)
    if (dailyEffectLimitDate && await hasExistingDailyEffectFollowupQuestion(tx, params.userId, dailyEffectLimitDate)) {
      return null
    }
    if (await hasExistingSessionFollowupQuestion(tx, params.userId, params.sessionId)) {
      return null
    }
    const [created] = await tx.insert(interventionFollowupIntents).values({
      userId: params.userId,
      sessionId: params.sessionId,
      engagementId: null,
      kind,
      status: 'pending',
      metadata: metadata as unknown as Record<string, unknown>,
      createdAt: now,
      updatedAt: now,
    }).returning()
    return created
  })

  if (!row) return null
  logger.info({
    intentId: row.id,
    resourceId: params.resource.id,
    kind,
  }, 'video resource followup intent created')
  return row
}

export async function findInterventionFollowupIntentForUser(
  params: {
    userId: string
    sessionId: string
    intentId: string
  },
): Promise<IntentRow | null> {
  const row = await getDb().query.interventionFollowupIntents.findFirst({
    where: and(
      eq(interventionFollowupIntents.id, params.intentId),
      eq(interventionFollowupIntents.userId, params.userId),
      eq(interventionFollowupIntents.sessionId, params.sessionId),
    ),
  })
  return row ?? null
}

async function claimIntent(intentId: string, logger: Logger): Promise<IntentRow | null> {
  const claimToken = randomUUID()
  const [claimed] = await getDb().update(interventionFollowupIntents)
    .set({ status: 'generating', claimToken, updatedAt: new Date() })
    .where(and(
      eq(interventionFollowupIntents.id, intentId),
      eq(interventionFollowupIntents.status, 'pending'),
    ))
    .returning()

  if (!claimed) {
    logger.info({ intentId }, 'intervention followup intent skipped: already claimed')
    return null
  }
  return claimed
}

export async function processInterventionFollowupIntent(
  intentId: string,
  logger: Logger,
): Promise<MessageRecord | null> {
  const claimed = await claimIntent(intentId, logger)
  if (!claimed || !claimed.claimToken) return null

  const claimToken = claimed.claimToken
  const meta = parseMetadata(claimed.metadata)
  const futureTasks = claimed.kind === 'completion_reminder_offer'
    ? await listFutureScheduledTasks(claimed.userId)
    : []
  const content = await generateIntentAssistantMessage({
    kind: claimed.kind,
    meta,
    futureTasks,
    sessionId: claimed.sessionId,
    logger,
  })

  if (!content) {
    const [discarded] = await getDb().update(interventionFollowupIntents)
      .set({
        status: 'discarded',
        updatedAt: new Date(),
      })
      .where(and(
        eq(interventionFollowupIntents.id, claimed.id),
        eq(interventionFollowupIntents.status, 'generating'),
        eq(interventionFollowupIntents.claimToken, claimToken),
      ))
      .returning()
    if (discarded) {
      logger.info({ intentId, kind: claimed.kind }, 'intervention followup suppressed by generator')
    }
    return null
  }

  const messageId = randomUUID()
  const createdAt = new Date()

  const sent = await getDb().transaction(async (tx) => {
    await lockSessionFollowupSlot(tx, claimed.sessionId)
    if (await hasExistingSessionFollowupQuestion(tx, claimed.userId, claimed.sessionId, { ignoreIntentId: claimed.id })) {
      const [discarded] = await tx.update(interventionFollowupIntents)
        .set({
          status: 'discarded',
          updatedAt: new Date(),
        })
        .where(and(
          eq(interventionFollowupIntents.id, claimed.id),
          eq(interventionFollowupIntents.status, 'generating'),
          eq(interventionFollowupIntents.claimToken, claimToken),
        ))
        .returning()
      return discarded ? 'duplicate' as const : 'lost' as const
    }

    await insertFollowupAssistantMessage(tx, {
      sessionId: claimed.sessionId,
      messageId,
      content,
      kind: claimed.kind,
      meta,
      createdAt,
    })

    const [updated] = await tx.update(interventionFollowupIntents)
      .set({
        status: 'sent',
        generatedMessageId: messageId,
        updatedAt: createdAt,
      })
      .where(and(
        eq(interventionFollowupIntents.id, claimed.id),
        eq(interventionFollowupIntents.status, 'generating'),
        eq(interventionFollowupIntents.claimToken, claimToken),
      ))
      .returning()

    if (!updated) throw new Error('intervention followup intent claim lost')
    return 'sent' as const
  }).catch(async (err: any) => {
    const [failed] = await getDb().update(interventionFollowupIntents)
      .set({
        status: 'failed',
        updatedAt: new Date(),
      })
      .where(and(
        eq(interventionFollowupIntents.id, claimed.id),
        eq(interventionFollowupIntents.status, 'generating'),
        eq(interventionFollowupIntents.claimToken, claimToken),
      ))
      .returning()

    if (failed) {
      logger.error({ err, intentId }, 'intervention followup message persist failed')
    } else {
      logger.info({ intentId }, 'intervention followup generated message discarded')
    }
    return 'failed' as const
  })

  if (sent !== 'sent') {
    if (sent === 'duplicate') {
      logger.info({ intentId, kind: claimed.kind }, 'intervention followup skipped: session already prompted')
    }
    return null
  }

  logger.info({ intentId, messageId, kind: claimed.kind }, 'intervention followup message sent')
  return toMessageRecord(messageId, content, createdAt)
}

export async function consumePendingInterventionFollowupIntents(
  userId: string,
  sessionId: string,
  logger: Logger,
): Promise<string[]> {
  const now = new Date()
  const rows = await getDb().update(interventionFollowupIntents)
    .set({
      status: 'consumed_by_user_message',
      consumedAt: now,
      claimToken: null,
      updatedAt: now,
    })
    .where(and(
      eq(interventionFollowupIntents.userId, userId),
      eq(interventionFollowupIntents.sessionId, sessionId),
      inArray(interventionFollowupIntents.status, ['pending', 'generating'] satisfies InterventionFollowupIntentStatus[]),
    ))
    .returning()

  if (rows.length === 0) return []

  logger.info({ sessionId, count: rows.length }, 'intervention followup intents consumed by user message')
  const futureTasks = rows.some((row) => row.kind === 'completion_reminder_offer')
    ? await listFutureScheduledTasks(userId)
    : []
  return rows.map((row) => buildIntentReminder(row.kind, parseMetadata(row.metadata), futureTasks))
}

export async function findLatestConsumedCompletionReminderIntent(
  userId: string,
  sessionId: string,
): Promise<{ intentId: string; engagementId: string | null; metadata: Record<string, unknown> | null } | null> {
  const row = await getDb().query.interventionFollowupIntents.findFirst({
    where: and(
      eq(interventionFollowupIntents.userId, userId),
      eq(interventionFollowupIntents.sessionId, sessionId),
      eq(interventionFollowupIntents.kind, 'completion_reminder_offer'),
      eq(interventionFollowupIntents.status, 'consumed_by_user_message'),
    ),
    orderBy: desc(interventionFollowupIntents.updatedAt),
  })
  if (!row) return null
  return {
    intentId: row.id,
    engagementId: row.engagementId,
    metadata: row.metadata ?? null,
  }
}

export async function markCompletionReminderIntentScheduled(intentId: string): Promise<void> {
  await getDb().update(interventionFollowupIntents)
    .set({ status: 'discarded', updatedAt: new Date() })
    .where(and(
      eq(interventionFollowupIntents.id, intentId),
      eq(interventionFollowupIntents.status, 'consumed_by_user_message'),
    ))
}
