import {
  COMMUNICATION_CARD_FIELDS,
  COMMUNICATION_CARD_FIELD_LABELS,
  COMMUNICATION_CARD_TEMPLATE_VERSION,
  type CommunicationCardContent,
  type CommunicationCardDraft,
  type CommunicationCardField,
  type CommunicationCardFieldSources,
  type CommunicationCardRecord,
  type CreateCommunicationCardRequest,
} from '@health-agent/shared'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { getDb } from '../db/client.js'
import { communicationCards } from '../db/schema/index.js'
import type { Logger } from '../lib/logger.js'

const TITLE_MAX_LEN = 80
const VISIT_PURPOSE_MAX_LEN = 500
const SECTION_MAX_LEN = 2000
const ARRAY_ITEM_MAX_LEN = 200
const ARRAY_MAX_ITEMS = 8

export type CommunicationCardFinalUpdater = 'ai' | 'user'

export interface CommunicationCardPromptSummaryItem {
  id: string
  title: string
  updatedAt: string
  finalUpdatedBy: CommunicationCardFinalUpdater
}

export interface CommunicationCardPromptSummary {
  totalCount: number
  /** 按更新时间倒序排列的全部已保存卡片元数据；prompt 只放摘要，原文仍需工具按 c-* 读取。 */
  cards: CommunicationCardPromptSummaryItem[]
}

function shanghaiDateStr(date: Date): string {
  return date.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' })
}

function isDateString(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
}

function trimString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeOptionalText(value: unknown, field: string): string {
  if (value == null) return ''
  if (typeof value !== 'string') throw new Error(`${field} 必须是字符串`)
  return value.trim()
}

function normalizeLegacyList(value: unknown, field: string): string[] {
  if (value == null) return []
  if (!Array.isArray(value)) throw new Error(`${field} 必须是字符串数组`)

  const result = value
    .map((item) => {
      if (typeof item !== 'string') throw new Error(`${field} 必须是字符串数组`)
      return item.trim()
    })
    .filter(Boolean)

  if (result.length > ARRAY_MAX_ITEMS) {
    throw new Error(`${field} 最多 ${ARRAY_MAX_ITEMS} 项`)
  }
  if (result.some((item) => item.length > ARRAY_ITEM_MAX_LEN)) {
    throw new Error(`${field} 单项不能超过 ${ARRAY_ITEM_MAX_LEN} 字`)
  }

  return result
}

function normalizeOptionalTextOrLegacyList(value: unknown, field: string): string {
  if (Array.isArray(value)) {
    return normalizeLegacyList(value, field).join('\n')
  }
  return normalizeOptionalText(value, field)
}

function buildLegacyInformationForDoctor(value: Record<string, unknown>): string {
  const recentChanges = normalizeLegacyList(value.recentChanges, 'recentChanges')
  const thingsToBring = normalizeLegacyList(value.thingsToBring, 'thingsToBring')
  const notes = normalizeOptionalText(value.notes, 'notes')

  const sections: string[] = []
  if (recentChanges.length > 0) {
    sections.push(recentChanges.map((item) => `- ${item}`).join('\n'))
  }
  if (thingsToBring.length > 0) {
    sections.push(`准备材料：\n${thingsToBring.map((item) => `- ${item}`).join('\n')}`)
  }
  if (notes) {
    sections.push(`其他补充：\n${notes}`)
  }

  return sections.join('\n\n')
}

function normalizeCurrentSituation(value: Record<string, unknown>): string {
  return (
    normalizeOptionalText(value.currentSituation, 'currentSituation') ||
    normalizeOptionalText(value.currentTreatment, 'currentTreatment')
  )
}

function normalizeInformationForDoctor(value: Record<string, unknown>): string {
  return (
    normalizeOptionalText(value.informationForDoctor, 'informationForDoctor') ||
    buildLegacyInformationForDoctor(value)
  )
}

function normalizeQuestionsForDoctor(value: Record<string, unknown>): string {
  return normalizeOptionalTextOrLegacyList(value.questionsForDoctor, 'questionsForDoctor')
}

function assertMaxLength(value: string, field: string, maxLen: number) {
  if (value.length > maxLen) {
    throw new Error(`${field} 不能超过 ${maxLen} 字`)
  }
}

function equalFieldValue(_field: CommunicationCardField, a: unknown, b: unknown): boolean {
  return String(a ?? '') === String(b ?? '')
}

function isFieldSourcesShape(value: unknown): value is CommunicationCardFieldSources {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return COMMUNICATION_CARD_FIELDS.every(
    (field) => record[field] === 'ai' || record[field] === 'user',
  )
}

function normalizeStoredContent(input: CommunicationCardContent): CommunicationCardContent {
  const draft = normalizeCommunicationCardDraft(input?.draft ?? {}, new Date(), {
    allowDefaultTitle: true,
  })
  const aiDraft = input?.aiDraft
    ? normalizeCommunicationCardDraft(input.aiDraft, new Date(), {
      allowDefaultTitle: true,
    })
    : draft
  const fieldSources = isFieldSourcesShape(input?.fieldSources)
    ? input.fieldSources
    : buildCommunicationCardFieldSources(draft, aiDraft)

  return {
    draft,
    aiDraft,
    fieldSources,
    sourceToolCallId: input?.sourceToolCallId ?? null,
  }
}

export function normalizeCommunicationCardDraft(
  input: unknown,
  now = new Date(),
  options?: { allowDefaultTitle?: boolean },
): CommunicationCardDraft {
  if (!input || typeof input !== 'object') {
    throw new Error('沟通卡片参数必须是对象')
  }

  const value = input as Record<string, unknown>
  const title = trimString(value.title)
  const cardDate = trimString(value.cardDate) || shanghaiDateStr(now)
  const visitPurpose = trimString(value.visitPurpose)
  const currentSituation = normalizeCurrentSituation(value)
  const informationForDoctor = normalizeInformationForDoctor(value)
  const questionsForDoctor = normalizeQuestionsForDoctor(value)

  if (!title) {
    if (options?.allowDefaultTitle) {
      value.title = '医患协同卡片'
    } else {
      throw new Error('title 不能为空，请为卡片生成一个具体标题')
    }
  }

  const normalizedTitle = trimString(value.title)

  if (normalizedTitle.length > TITLE_MAX_LEN) {
    throw new Error(`title 不能超过 ${TITLE_MAX_LEN} 字`)
  }
  if (!isDateString(cardDate)) {
    throw new Error('cardDate 必须是 YYYY-MM-DD')
  }
  if (!visitPurpose) {
    throw new Error('visitPurpose 不能为空')
  }
  assertMaxLength(visitPurpose, 'visitPurpose', VISIT_PURPOSE_MAX_LEN)
  assertMaxLength(currentSituation, 'currentSituation', SECTION_MAX_LEN)
  assertMaxLength(informationForDoctor, 'informationForDoctor', SECTION_MAX_LEN)
  assertMaxLength(questionsForDoctor, 'questionsForDoctor', SECTION_MAX_LEN)

  return {
    title: normalizedTitle,
    cardDate,
    visitPurpose,
    currentSituation: currentSituation || undefined,
    informationForDoctor: informationForDoctor || undefined,
    questionsForDoctor: questionsForDoctor || undefined,
  }
}

export function buildCommunicationCardFieldSources(
  draft: CommunicationCardDraft,
  originalDraft?: CommunicationCardDraft,
): CommunicationCardFieldSources {
  const result = {} as CommunicationCardFieldSources

  for (const field of COMMUNICATION_CARD_FIELDS) {
    const changed = originalDraft
      ? !equalFieldValue(field, draft[field], originalDraft[field])
      : true
    result[field] = changed ? 'user' : 'ai'
  }

  return result
}

function serialize(row: typeof communicationCards.$inferSelect): CommunicationCardRecord {
  const contentJson = normalizeStoredContent(row.contentJson)
  return {
    id: row.id,
    userId: row.userId,
    title: row.title,
    cardDate: row.cardDate,
    templateVersion: row.templateVersion,
    sourceSessionId: row.sourceSessionId,
    contentJson,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

function inferFinalUpdater(record: CommunicationCardRecord): CommunicationCardFinalUpdater {
  return Object.values(record.contentJson.fieldSources).some((source) => source === 'user')
    ? 'user'
    : 'ai'
}

function editorLabel(source: 'ai' | 'user' | undefined): string {
  return source === 'user' ? '用户' : 'AI'
}

function markdownValue(value: string | undefined): string {
  const normalized = value?.trim()
  return normalized || '未填写'
}

function mergeLegacyQuestionsIntoSituation(draft: CommunicationCardDraft): string | undefined {
  const parts = [draft.currentSituation?.trim()]
  const questions = draft.questionsForDoctor?.trim()
  if (questions) {
    parts.push(`想问医生的问题：\n${questions}`)
  }
  return parts.filter(Boolean).join('\n\n') || undefined
}

export function renderCommunicationCardMarkdown(record: CommunicationCardRecord): string {
  const { draft, fieldSources } = record.contentJson
  const hasLegacyQuestions = Boolean(draft.questionsForDoctor?.trim())
  const situationEditor =
    hasLegacyQuestions && fieldSources.questionsForDoctor === 'user'
      ? '用户'
      : editorLabel(fieldSources.currentSituation)

  return [
    `# ${draft.title}`,
    '',
    `- 标题最后编辑人：${editorLabel(fieldSources.title)}`,
    `- 卡片日期：${draft.cardDate}（最后编辑人：${editorLabel(fieldSources.cardDate)}）`,
    `- 保存更新时间：${record.updatedAt}`,
    '',
    `## ${COMMUNICATION_CARD_FIELD_LABELS.visitPurpose}（最后编辑人：${editorLabel(fieldSources.visitPurpose)}）`,
    markdownValue(draft.visitPurpose),
    '',
    `## ${COMMUNICATION_CARD_FIELD_LABELS.currentSituation}（最后编辑人：${situationEditor}）`,
    markdownValue(mergeLegacyQuestionsIntoSituation(draft)),
    '',
    `## ${COMMUNICATION_CARD_FIELD_LABELS.informationForDoctor}（最后编辑人：${editorLabel(fieldSources.informationForDoctor)}）`,
    markdownValue(draft.informationForDoctor),
  ].join('\n')
}

export async function createCommunicationCard(
  userId: string,
  payload: CreateCommunicationCardRequest,
  logger: Logger,
): Promise<CommunicationCardRecord> {
  const db = getDb()
  const draft = normalizeCommunicationCardDraft(payload.draft)
  const aiDraft = payload.originalDraft
    ? normalizeCommunicationCardDraft(payload.originalDraft)
    : draft
  const fieldSources = buildCommunicationCardFieldSources(draft, aiDraft)

  const contentJson: CommunicationCardContent = {
    draft,
    aiDraft,
    fieldSources,
    sourceToolCallId: payload.sourceToolCallId ?? null,
  }

  const [row] = await db
    .insert(communicationCards)
    .values({
      userId,
      title: draft.title,
      cardDate: draft.cardDate,
      templateVersion: COMMUNICATION_CARD_TEMPLATE_VERSION,
      sourceSessionId: payload.sourceSessionId ?? null,
      contentJson,
    })
    .returning()

  logger.info({ userId, cardId: row.id }, 'communication card created')
  return serialize(row)
}

export async function findCommunicationCardBySource(
  userId: string,
  sourceSessionId: string,
  sourceToolCallId: string,
  logger: Logger,
): Promise<CommunicationCardRecord | null> {
  const db = getDb()
  const [row] = await db
    .select()
    .from(communicationCards)
    .where(
      and(
        eq(communicationCards.userId, userId),
        eq(communicationCards.sourceSessionId, sourceSessionId),
        sql`${communicationCards.contentJson}->>'sourceToolCallId' = ${sourceToolCallId}`,
      ),
    )
    .orderBy(desc(communicationCards.createdAt))
    .limit(1)

  if (!row) return null
  logger.debug({ userId, sourceSessionId, sourceToolCallId, cardId: row.id }, 'communication card fetched by source')
  return serialize(row)
}

export async function findCommunicationCardBySessionMeta(
  userId: string,
  sourceSessionId: string,
  title: string,
  cardDate: string,
  logger: Logger,
): Promise<CommunicationCardRecord | null> {
  const db = getDb()
  const [row] = await db
    .select()
    .from(communicationCards)
    .where(
      and(
        eq(communicationCards.userId, userId),
        eq(communicationCards.sourceSessionId, sourceSessionId),
        eq(communicationCards.title, title),
        eq(communicationCards.cardDate, cardDate),
      ),
    )
    .orderBy(desc(communicationCards.createdAt))
    .limit(1)

  if (!row) return null
  logger.debug({ userId, sourceSessionId, title, cardDate, cardId: row.id }, 'communication card fetched by session meta')
  return serialize(row)
}

export async function listCommunicationCards(
  userId: string,
  logger: Logger,
): Promise<CommunicationCardRecord[]> {
  const db = getDb()
  const rows = await db
    .select()
    .from(communicationCards)
    .where(eq(communicationCards.userId, userId))
    .orderBy(desc(communicationCards.cardDate), desc(communicationCards.createdAt))

  logger.debug({ userId, count: rows.length }, 'listed communication cards')
  return rows.map(serialize)
}

export async function getCommunicationCardPromptSummary(
  userId: string,
  logger: Logger,
): Promise<CommunicationCardPromptSummary> {
  const db = getDb()
  const rows = await db
    .select()
    .from(communicationCards)
    .where(eq(communicationCards.userId, userId))
    .orderBy(desc(communicationCards.updatedAt))

  const cards = rows.map(serialize).map((record) => ({
    id: record.id,
    title: record.title,
    updatedAt: record.updatedAt,
    finalUpdatedBy: inferFinalUpdater(record),
  }))
  const totalCount = cards.length

  logger.debug({ userId, totalCount, indexedCount: cards.length }, 'communication card prompt summary loaded')
  return { totalCount, cards }
}

export async function getCommunicationCard(
  userId: string,
  cardId: string,
  logger: Logger,
): Promise<CommunicationCardRecord | null> {
  const db = getDb()
  const row = await db.query.communicationCards.findFirst({
    where: (t, { and, eq: e }) => and(e(t.id, cardId), e(t.userId, userId)),
  })

  if (!row) return null
  logger.debug({ userId, cardId }, 'communication card fetched')
  return serialize(row)
}

export async function getCommunicationCardsByIds(
  userId: string,
  ids: string[],
  logger: Logger,
): Promise<CommunicationCardRecord[]> {
  if (!ids.length) return []

  const db = getDb()
  const rows = await db
    .select()
    .from(communicationCards)
    .where(and(eq(communicationCards.userId, userId), inArray(communicationCards.id, ids)))

  const byId = new Map(rows.map((row) => [row.id, serialize(row)]))
  const matched = ids.map((id) => byId.get(id)).filter((card): card is CommunicationCardRecord => Boolean(card))

  logger.info({ requested: ids.length, found: matched.length }, 'fetched communication cards by IDs')
  return matched
}

export async function deleteCommunicationCard(
  userId: string,
  cardId: string,
  logger: Logger,
): Promise<CommunicationCardRecord | null> {
  const db = getDb()
  const [row] = await db
    .delete(communicationCards)
    .where(and(eq(communicationCards.id, cardId), eq(communicationCards.userId, userId)))
    .returning()

  if (!row) return null

  logger.info({ userId, cardId }, 'communication card deleted')
  return serialize(row)
}

export async function updateCommunicationCard(
  userId: string,
  cardId: string,
  nextDraftInput: unknown,
  logger: Logger,
): Promise<CommunicationCardRecord | null> {
  const db = getDb()
  const existing = await db.query.communicationCards.findFirst({
    where: (t, { and, eq: e }) => and(e(t.id, cardId), e(t.userId, userId)),
  })

  if (!existing) return null

  const existingContent = normalizeStoredContent(existing.contentJson)
  const draft = normalizeCommunicationCardDraft(nextDraftInput)
  const aiDraft = existingContent.aiDraft
  const fieldSources = buildCommunicationCardFieldSources(draft, aiDraft)

  const contentJson: CommunicationCardContent = {
    draft,
    aiDraft,
    fieldSources,
    sourceToolCallId: existingContent.sourceToolCallId ?? null,
  }

  const [row] = await db
    .update(communicationCards)
    .set({
      title: draft.title,
      cardDate: draft.cardDate,
      contentJson,
      updatedAt: new Date(),
    })
    .where(and(eq(communicationCards.id, cardId), eq(communicationCards.userId, userId)))
    .returning()

  logger.info({ userId, cardId }, 'communication card updated')
  return serialize(row)
}
