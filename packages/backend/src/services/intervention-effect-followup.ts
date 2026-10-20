import { and, asc, eq, lte } from 'drizzle-orm'
import type {
  InterventionMaterialToolOutput,
} from '@health-agent/shared'
import { getDb } from '../db/client.js'
import {
  chatSessions,
  interventionMaterialEngagements,
  users,
} from '../db/schema/index.js'
import { llmCall } from '../lib/llm.js'
import type { Logger } from '../lib/logger.js'
import { getModel } from '../state/process.js'
import type { ChatMessage } from '../state/session.js'
import { withCronLock } from '../cron/lock.js'
import { estimateTextTokens } from '../utils/tokens.js'
import { stripSystemReminderText } from '../utils/system-reminder.js'
import { findInterventionToolOutputInSession } from './intervention-material-engagement.js'
import {
  buildEffectFollowupRoute,
  nextEffectFollowupFailureStatus,
  sanitizeEffectFollowupQuestion,
} from './intervention-effect-followup-policy.js'
import { loadSessionMessages, saveMessage } from './message.js'
import { pushToUser } from './push.js'

const FOLLOWUP_BATCH_LIMIT = 20
const FOLLOWUP_LOCK_TTL_SECONDS = 55
const MAX_CONTEXT_CHARS = 6000
const MAX_MESSAGE_LINE_CHARS = 500

type EngagementRow = typeof interventionMaterialEngagements.$inferSelect

type TextBlock = { type: string; text?: string; image_url?: { url: string } }

function renderContent(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content

  const parts: string[] = []
  for (const block of content as TextBlock[]) {
    if (block.type === 'text' && block.text) {
      parts.push(block.text)
    } else if (block.type === 'image_url') {
      parts.push('[用户上传了图片]')
    }
  }
  return parts.join('\n')
}

function renderMessageLine(message: ChatMessage): string | null {
  if (message.role !== 'user' && message.role !== 'assistant') return null
  const role = message.role === 'user' ? '用户' : 'AI'
  const text = stripSystemReminderText(renderContent(message.content)).trim()
  if (!text) return null
  return `${role}：${text.slice(0, MAX_MESSAGE_LINE_CHARS)}`
}

function buildRecentConversationContext(messages: ChatMessage[]): string {
  const lines = messages
    .map(renderMessageLine)
    .filter((line): line is string => !!line)
    .slice(-16)

  let used = 0
  const kept: string[] = []
  for (const line of lines.reverse()) {
    if (used + line.length > MAX_CONTEXT_CHARS) break
    kept.push(line)
    used += line.length
  }
  kept.reverse()
  return kept.length ? kept.join('\n') : '暂无可用的近期对话。'
}

function buildMaterialContext(
  row: EngagementRow,
  detail: InterventionMaterialToolOutput | null,
): string {
  const progress = [
    `素材编号：${row.materialCode}`,
    `跟练时长：${Math.max(0, row.totalFollowSec)} 秒`,
    `完成步数：${Math.max(0, row.completedStepCount)}/${Math.max(0, row.totalStepCount)}`,
  ]

  if (!detail) return progress.join('\n')

  return [
    `素材编号：${detail.code}`,
    `干预名称：${detail.actionName}`,
    `副作用/场景：${detail.sideEffect} / ${detail.scene}`,
    `素材反馈问题：${detail.overview.feedbackQuestion}`,
    `效果判断规则：${detail.overview.effectiveRule}`,
    `兜底行动：${detail.overview.fallbackAction}`,
    ...progress.slice(1),
  ].join('\n')
}

function buildSystemPrompt(): string {
  return `你是Health Agent Lab的主动随访消息生成器，只负责生成一条发给用户的疗效问询消息。

输出要求：
- 只输出用户可见的中文问询消息，不要解释，不要加标题，不要使用 Markdown。
- 1 到 2 句，总长度不超过 70 个中文字符。
- 询问用户跟练后症状是否缓解、是否还有不舒服即可。
- 不要诊断，不要判断疗效，不要给具体用药、处方或治疗建议。
- 不要在锁屏通知里暴露敏感病情细节：不要提癌种、药名、检查结论、治疗阶段。
- 如果近期上下文出现明显加重、危险信号或需要就医的描述，只做温和安全提醒：如果不适明显加重，请及时联系医生或就医。`
}

function buildUserPrompt(params: {
  now: Date
  sessionSummary: string | null
  materialContext: string
  recentConversation: string
}): string {
  return [
    `当前时间：${params.now.toISOString()}`,
    params.sessionSummary ? `会话摘要：\n${params.sessionSummary}` : '会话摘要：暂无',
    `本次跟练信息：\n${params.materialContext}`,
    `近期对话：\n${params.recentConversation}`,
    '请生成一条现在推送给用户的跟练后症状缓解问询。',
  ].join('\n\n')
}

async function generateEffectFollowupQuestion(
  row: EngagementRow,
  logger: Logger,
): Promise<string> {
  const [session, messages, detail] = await Promise.all([
    getDb().query.chatSessions.findFirst({
      where: eq(chatSessions.id, row.sessionId),
      columns: { summary: true },
    }),
    loadSessionMessages(row.sessionId, logger),
    findInterventionToolOutputInSession(row.sessionId, row.toolCallId, logger),
  ])

  const response = await llmCall({
    model: getModel(),
    messages: [
      { role: 'system', content: buildSystemPrompt() },
      {
        role: 'user',
        content: buildUserPrompt({
          now: new Date(),
          sessionSummary: session?.summary ?? null,
          materialContext: buildMaterialContext(row, detail),
          recentConversation: buildRecentConversationContext(messages),
        }),
      },
    ],
    max_tokens: 120,
    temperature: 0.3,
    enable_thinking: false,
  }, logger)

  return sanitizeEffectFollowupQuestion(response.choices[0]?.message?.content)
}

async function claimPendingFollowup(row: EngagementRow, logger: Logger): Promise<EngagementRow | null> {
  const db = getDb()
  const [claimed] = await db.update(interventionMaterialEngagements)
    .set({ effectFollowupStatus: 'processing', updatedAt: new Date() })
    .where(and(
      eq(interventionMaterialEngagements.id, row.id),
      eq(interventionMaterialEngagements.effectFollowupStatus, 'pending'),
    ))
    .returning()

  if (!claimed) {
    logger.info({ engagementId: row.id }, 'effect followup skipped: already claimed')
    return null
  }
  return claimed
}

async function markFollowupFailed(row: EngagementRow, err: unknown, logger: Logger): Promise<void> {
  const db = getDb()
  const attemptCount = row.effectFollowupAttemptCount + 1
  const status = nextEffectFollowupFailureStatus(attemptCount)
  const message = err instanceof Error ? err.message : String(err)

  await db.update(interventionMaterialEngagements)
    .set({
      effectFollowupStatus: status,
      effectFollowupAttemptCount: attemptCount,
      effectFollowupLastError: message.slice(0, 1000),
      updatedAt: new Date(),
    })
    .where(eq(interventionMaterialEngagements.id, row.id))

  logger.warn({
    engagementId: row.id,
    status,
    attemptCount,
    error: message,
  }, 'intervention effect followup failed')
}

async function processOneEffectFollowup(row: EngagementRow, logger: Logger): Promise<'sent' | 'skipped' | 'failed'> {
  const log = logger.child({ engagementId: row.id, sessionId: row.sessionId })
  const claimed = await claimPendingFollowup(row, log)
  if (!claimed) return 'skipped'

  const user = await getDb().query.users.findFirst({
    where: eq(users.id, claimed.userId),
    columns: { status: true },
  })
  if (!user || user.status !== 'active') {
    await getDb().update(interventionMaterialEngagements)
      .set({
        effectFollowupStatus: 'failed',
        effectFollowupLastError: 'user_not_active',
        updatedAt: new Date(),
      })
      .where(eq(interventionMaterialEngagements.id, claimed.id))
    log.info({ userStatus: user?.status ?? null }, 'effect followup skipped: user not active')
    return 'skipped'
  }

  try {
    const content = await generateEffectFollowupQuestion(claimed, log)
    const messageId = await saveMessage(claimed.sessionId, {
      role: 'assistant',
      content,
      tokenCount: estimateTextTokens(content),
    }, log)
    const sentAt = new Date()

    await getDb().update(interventionMaterialEngagements)
      .set({
        effectFollowupStatus: 'sent',
        effectFollowupSentAt: sentAt,
        effectFollowupMessageId: messageId,
        effectFollowupLastError: null,
        reminderConsumedAt: sentAt,
        updatedAt: sentAt,
      })
      .where(eq(interventionMaterialEngagements.id, claimed.id))

    try {
      const pushResult = await pushToUser(claimed.userId, {
        title: 'Health Agent Lab',
        alert: content,
        route: buildEffectFollowupRoute(claimed.sessionId, messageId),
        type: 'intervention_effect_followup',
        entityType: 'intervention_material_engagement',
        entityId: claimed.id,
        dedupeKey: `intervention_effect_followup:${claimed.id}`,
      }, log)

      log.info({ messageId, pushStatus: pushResult.status, pushReason: pushResult.reason }, 'effect followup sent')
    } catch (pushErr: any) {
      log.warn({ messageId, error: pushErr?.message ?? String(pushErr) }, 'effect followup push failed after message persisted')
    }
    return 'sent'
  } catch (err) {
    await markFollowupFailed(claimed, err, log)
    return 'failed'
  }
}

async function processDueEffectFollowups(now: Date, logger: Logger): Promise<{
  scanned: number
  sent: number
  skipped: number
  failed: number
}> {
  const rows = await getDb().query.interventionMaterialEngagements.findMany({
    where: and(
      eq(interventionMaterialEngagements.effectFollowupStatus, 'pending'),
      lte(interventionMaterialEngagements.effectFollowupDueAt, now),
    ),
    orderBy: asc(interventionMaterialEngagements.effectFollowupDueAt),
    limit: FOLLOWUP_BATCH_LIMIT,
  })

  const stats = { scanned: rows.length, sent: 0, skipped: 0, failed: 0 }
  for (const row of rows) {
    const result = await processOneEffectFollowup(row, logger)
    stats[result]++
  }
  return stats
}

export async function runDueInterventionEffectFollowups(logger: Logger): Promise<void> {
  const now = new Date()
  await withCronLock('intervention-effect-followup', 'due', FOLLOWUP_LOCK_TTL_SECONDS, logger, async () => {
    const stats = await processDueEffectFollowups(now, logger.child({ module: 'intervention-effect-followup' }))
    if (stats.scanned > 0) {
      logger.info(stats, 'intervention effect followup cron completed')
    }
  })
}
