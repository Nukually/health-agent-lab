/**
 * Memory Service — 动态个性化记忆 CRUD
 *
 * - 天级记忆：每用户每天一行记录，追加式写入
 * - Hermes-style USER.md：长期偏好/身份画像，作为第二条 system prompt 注入
 * - legacy Profile content：夜间合并产物，仅保留给历史兼容，不派生 USER.md
 */

import { eq, and, sql, asc, gt } from 'drizzle-orm'
import { getDb } from '../db/client.js'
import { fetchBase64 } from '../lib/oss.js'
import {
  userDailyMemories,
  userProfilesMemory,
  messages,
  chatSessions,
  medicalRecords,
  medicalDocuments,
  users,
} from '../db/schema/index.js'
import { stripSystemReminderText } from '../utils/system-reminder.js'
import { hasSyntheticHiddenUserMarker } from '../utils/repeated-user-message.js'
import {
  getUntrustedUserControlMarkerReasons,
  type UnsafeUserContentReason,
} from '../utils/untrusted-user-content.js'
import type { Logger } from '../lib/logger.js'
import { getModelImageBlocksForMessages } from './image-asset.js'

/** 当日用户原始 prompt 字符上限（~3000 tokens，按 4 字符/token 估算） */
const USER_PROMPTS_CHAR_LIMIT = 12_000
const MAX_DAILY_USER_IMAGES = 12
export const USER_MD_ENTRY_DELIMITER = '\n§\n'
export const USER_MD_CHAR_LIMIT = 1375
const DATA_IMAGE_URL_PATTERN = /^data:image\/[a-z0-9.+-]+;base64,/i

export interface DailyUserImageInput {
  source: 'chat_message' | 'medical_document'
  url: string
  label: string
  createdAt: Date
}

const MEMORY_REJECTION_MESSAGES: Record<UnsafeUserContentReason, string> = {
  internal_control_marker: '包含内部控制标签或系统合成标记',
  invisible_control_char: '包含不可见控制字符',
  xml_like_tag: '包含类似 XML/HTML 的控制标签',
  json_instruction_field: '包含疑似 JSON 指令字段',
  prompt_keyword: '包含提示词/系统提示相关内容',
  prompt_injection_phrase: '包含高风险提示注入短语',
}

export class MemoryContentRejectedError extends Error {
  readonly reasons: UnsafeUserContentReason[]

  constructor(reasons: UnsafeUserContentReason[]) {
    super(`memory content rejected: ${reasons.join(', ')}`)
    this.name = 'MemoryContentRejectedError'
    this.reasons = reasons
  }
}

export function scanMemoryContentForStorage(content: string): {
  ok: true
} | {
  ok: false
  reasons: UnsafeUserContentReason[]
  message: string
} {
  const trimmed = content.trim()
  if (!trimmed) {
    return {
      ok: false,
      reasons: [],
      message: '记忆内容为空',
    }
  }

  const reasons = getUntrustedUserControlMarkerReasons(trimmed)
  if (reasons.length === 0) return { ok: true }

  return {
    ok: false,
    reasons,
    message: [...new Set(reasons.map((reason) => MEMORY_REJECTION_MESSAGES[reason]))].join('；'),
  }
}

export function normalizeUserMd(raw: string | null | undefined): string {
  const entries = splitUserMdEntries(raw)
  return entries.join(USER_MD_ENTRY_DELIMITER)
}

export function sanitizeUserMdForPrompt(raw: string | null | undefined): string {
  const entries = splitUserMdEntries(raw)
    .map(sanitizeUserMdEntryForPrompt)
    .filter((entry): entry is string => Boolean(entry))
  return entries.join(USER_MD_ENTRY_DELIMITER)
}

function sanitizeUserMdEntryForPrompt(entry: string): string | null {
  const lineCleaned = entry
    .split(/\r?\n/)
    .filter((line) => !userMdEntryLooksLikeTransientRecord(line))
    .join('\n')
    .trim()
  if (!lineCleaned || userMdEntryLooksLikeTransientRecord(lineCleaned)) return null
  return lineCleaned
}

export function splitUserMdEntries(raw: string | null | undefined): string[] {
  const text = String(raw ?? '').trim()
  if (!text) return []

  const entries: string[] = []
  let current: string[] = []
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '§') {
      const entry = current.join('\n').trim()
      if (entry) entries.push(entry)
      current = []
      continue
    }
    current.push(line)
  }

  const tail = current.join('\n').trim()
  if (tail) entries.push(tail)

  return [...new Set(entries)]
}

export function userMdEntryLooksLikeTransientRecord(content: string): boolean {
  const text = content.trim()
  const hasAbsoluteDate = /\b\d{4}-\d{2}-\d{2}\b/.test(text)
  const hasRecordKeyword =
    /早餐|午餐|晚餐|加餐|吃了|喝了|睡眠|入睡|起床|醒来|通勤|路线|出发|到达|运动|步数|症状|疼痛|记录|打卡|日记|备忘/.test(text)
  if (hasAbsoluteDate && hasRecordKeyword) return true

  return /^(?:今天|昨天|前天|今晚|昨晚|今早|明天).*(?:早餐|午餐|晚餐|加餐|吃了|喝了|睡眠|入睡|起床|醒来|通勤|出发|到达|运动|步数|症状|疼痛|记录|打卡|日记|备忘)/.test(text)
}

export function profileMarkdownToUserMd(content: string | null | undefined): string {
  void content
  // Hermes USER.md is a separate curated store. Generated legacy profile
  // markdown must never be flattened into it, otherwise daily records leak
  // into the second system prompt.
  return ''
}

export function renderUserMdPromptBlock(userMd: string | null | undefined): string | null {
  const normalized = sanitizeUserMdForPrompt(userMd)
  if (!normalized) return null

  const current = normalized.length
  const pct = Math.min(100, Math.floor((current / USER_MD_CHAR_LIMIT) * 100))
  const separator = '═'.repeat(46)

  return [
    separator,
    `USER PROFILE (who the user is) [${pct}% — ${current.toLocaleString('en-US')}/${USER_MD_CHAR_LIMIT.toLocaleString('en-US')} chars]`,
    separator,
    normalized,
  ].join('\n')
}

function assertMemoryContentSafeForStorage(content: string): void {
  const scanned = scanMemoryContentForStorage(content)
  if (!scanned.ok) throw new MemoryContentRejectedError(scanned.reasons)
}

// ─── 天级记忆 ────────────────────────────────────────────────────────────────

/** 追加一条天级记忆（原子操作，首次自动创建当天记录） */
export async function appendDailyMemory(
  userId: string,
  entry: string,
  logger: Logger,
): Promise<{ date: string; isNew: boolean }> {
  const normalizedEntry = String(entry ?? '').trim()
  assertMemoryContentSafeForStorage(normalizedEntry)

  const db = getDb()
  const now = new Date()
  const dateStr = now.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' })
  const timeStr = now.toLocaleTimeString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
  const line = `[${timeStr}] ${normalizedEntry}\n`

  const existing = await db.query.userDailyMemories.findFirst({
    where: and(
      eq(userDailyMemories.userId, userId),
      eq(userDailyMemories.memoryDate, dateStr),
    ),
    columns: { id: true },
  })

  if (existing) {
    await db
      .update(userDailyMemories)
      .set({
        content: sql`${userDailyMemories.content} || ${line}`,
        updatedAt: now,
      })
      .where(eq(userDailyMemories.id, existing.id))

    logger.info({ userId, date: dateStr }, 'daily memory appended')
    return { date: dateStr, isNew: false }
  }

  await db.insert(userDailyMemories).values({
    userId,
    memoryDate: dateStr,
    content: line,
  })

  logger.info({ userId, date: dateStr }, 'daily memory created')
  return { date: dateStr, isNew: true }
}

/** 读取今天的记忆（用于 prompt 注入） */
export async function getTodayMemory(
  userId: string,
  logger: Logger,
): Promise<string | null> {
  const dateStr = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' })
  return getDailyMemoryForDate(userId, dateStr, logger)
}

/** 读取指定日期的天级记忆（夜间 cron 用，dateStr 为 Asia/Shanghai 的 YYYY-MM-DD） */
export async function getDailyMemoryForDate(
  userId: string,
  dateStr: string,
  logger: Logger,
): Promise<string | null> {
  const db = getDb()

  const row = await db.query.userDailyMemories.findFirst({
    where: and(
      eq(userDailyMemories.userId, userId),
      eq(userDailyMemories.memoryDate, dateStr),
    ),
    columns: { content: true },
  })

  return row?.content || null
}

/** 按日期批量查询（夜间 cron 用） */
export async function getDailyMemoriesByDate(
  dateStr: string,
  logger: Logger,
): Promise<Array<{ userId: string; content: string }>> {
  const db = getDb()

  const rows = await db.query.userDailyMemories.findMany({
    where: eq(userDailyMemories.memoryDate, dateStr),
    columns: { userId: true, content: true },
  })

  logger.info({ date: dateStr, count: rows.length }, 'daily memories queried by date')
  return rows
}

/**
 * 取指定日期（Asia/Shanghai）活跃用户 ID 并集：
 * - 当日发过 user message
 * - 当日 daily memory 有更新
 * - medical_records 当日有 update
 * - medical_documents 当日有 upload/update
 * - users 个人信息当日有 update
 *
 * 夜间 consolidation 用，覆盖长期 Profile 入场信号中任一来源的候选集
 */
export async function getActiveUserIdsForDate(
  dateStr: string,
  logger: Logger,
): Promise<string[]> {
  const db = getDb()

  // 直接在 SQL 里做 UNION，单次往返
  const rows = await db.execute<{ user_id: string }>(sql`
    SELECT DISTINCT s.user_id
    FROM ${messages} m
    JOIN ${chatSessions} s ON m.session_id = s.id
    WHERE m.role = 'user'
      AND (m.created_at AT TIME ZONE 'Asia/Shanghai')::date = ${dateStr}::date
    UNION
    SELECT user_id
    FROM ${userDailyMemories}
    WHERE memory_date = ${dateStr}::date
    UNION
    SELECT user_id
    FROM ${medicalRecords}
    WHERE (updated_at AT TIME ZONE 'Asia/Shanghai')::date = ${dateStr}::date
    UNION
    SELECT user_id
    FROM ${medicalDocuments}
    WHERE (uploaded_at AT TIME ZONE 'Asia/Shanghai')::date = ${dateStr}::date
       OR (updated_at AT TIME ZONE 'Asia/Shanghai')::date = ${dateStr}::date
    UNION
    SELECT id AS user_id
    FROM ${users}
    WHERE (updated_at AT TIME ZONE 'Asia/Shanghai')::date = ${dateStr}::date
  `)

  const userIds = (rows as unknown as Array<{ user_id: string }>).map((r) => r.user_id)
  logger.info({ date: dateStr, count: userIds.length }, 'active users queried for consolidation')
  return userIds
}

/**
 * 取某用户在指定日期（Asia/Shanghai）的 role=user 消息 content，
 * 按 createdAt 升序拼接。超出 USER_PROMPTS_CHAR_LIMIT 时保留最新段。
 *
 * 可选 since：仅返回 createdAt > since 的消息（用于变更检测时只看"新"的）。
 */
export async function getUserPromptsForDate(
  userId: string,
  dateStr: string,
  logger: Logger,
  since?: Date,
): Promise<string> {
  const db = getDb()

  const rows = await db
    .select({ content: messages.content, createdAt: messages.createdAt })
    .from(messages)
    .innerJoin(chatSessions, eq(messages.sessionId, chatSessions.id))
    .where(
      and(
        eq(chatSessions.userId, userId),
        eq(messages.role, 'user'),
        sql`(${messages.createdAt} AT TIME ZONE 'Asia/Shanghai')::date = ${dateStr}::date`,
        since ? gt(messages.createdAt, since) : undefined,
      ),
    )
    .orderBy(asc(messages.createdAt))

  if (rows.length === 0) return ''

  const cleanedRows = rows
    .map((row) => cleanUserPromptContent(row.content))
    .filter((content): content is string => !!content)

  if (cleanedRows.length === 0) return ''

  // 从最新往最早倒着塞，超出上限截断，保留最新段。
  // 注意：必须在去掉 system-reminder / 工具附件后再计入上限，否则病历图片 base64
  // 会把真实用户消息挤掉，导致 Profile/结构化抽取只看到当天最后几条。
  let total = 0
  const kept: string[] = []
  for (let i = cleanedRows.length - 1; i >= 0; i--) {
    const line = cleanedRows[i]
    if (total + line.length + 1 > USER_PROMPTS_CHAR_LIMIT) break
    kept.unshift(line)
    total += line.length + 1
  }

  logger.info(
    {
      userId,
      date: dateStr,
      totalRows: rows.length,
      cleanedRows: cleanedRows.length,
      keptRows: kept.length,
      chars: total,
    },
    'user prompts assembled for consolidation',
  )
  return kept.join('\n---\n')
}

/**
 * 取某用户在指定日期（Asia/Shanghai）的真实用户上传图片：
 * - 聊天消息里的 image_url（排除 saved_content 合成 user 消息）
 * - 当日上传/更新的 medical_documents 原图（转为模型可读的 base64 data URL）
 *
 * 若超过上限，保留最新图片；结构化抽取和长期 Profile 共用同一份图片输入。
 */
export async function getUserImagesForDate(
  userId: string,
  dateStr: string,
  logger: Logger,
): Promise<DailyUserImageInput[]> {
  const [chatImages, documentImages] = await Promise.all([
    getChatMessageImagesForDate(userId, dateStr, logger),
    getMedicalDocumentImagesForDate(userId, dateStr, logger),
  ])

  const deduped = dedupeImageInputs([...chatImages, ...documentImages])
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())

  if (deduped.length <= MAX_DAILY_USER_IMAGES) {
    logger.info(
      { userId, date: dateStr, imageCount: deduped.length },
      'user images assembled for profile tasks',
    )
    return deduped
  }

  const kept = deduped.slice(-MAX_DAILY_USER_IMAGES)
  logger.warn(
    {
      userId,
      date: dateStr,
      imageCount: deduped.length,
      keptImageCount: kept.length,
    },
    'user images truncated to latest inputs for profile tasks',
  )
  return kept
}

async function getChatMessageImagesForDate(
  userId: string,
  dateStr: string,
  logger: Logger,
): Promise<DailyUserImageInput[]> {
  const db = getDb()
  const rows = await db
    .select({
      id: messages.id,
      content: messages.content,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .innerJoin(chatSessions, eq(messages.sessionId, chatSessions.id))
    .where(
      and(
        eq(chatSessions.userId, userId),
        eq(messages.role, 'user'),
        sql`(${messages.createdAt} AT TIME ZONE 'Asia/Shanghai')::date = ${dateStr}::date`,
      ),
    )
    .orderBy(asc(messages.createdAt))

  let attachedBlocksByMessageId = new Map<string, Array<{ type: 'image_url'; image_url: { url: string } }>>()
  try {
    attachedBlocksByMessageId = await getModelImageBlocksForMessages(rows.map((row) => row.id))
  } catch (err) {
    logger.warn(
      { userId, date: dateStr, error: err instanceof Error ? err.message : String(err) },
      'chat message image attachments unavailable for profile tasks',
    )
  }

  return rows.flatMap((row) => {
    const attachedUrls = (attachedBlocksByMessageId.get(row.id) ?? [])
      .map((block) => block.image_url.url)
      .filter((url) => DATA_IMAGE_URL_PATTERN.test(url))
    if (attachedUrls.length > 0) {
      return attachedUrls.map((url, idx) => ({
        source: 'chat_message' as const,
        url,
        label: `聊天上传图片（${toShanghaiTime(row.createdAt)}，同条消息第 ${idx + 1} 张）`,
        createdAt: row.createdAt,
      }))
    }

    const urls = extractRealUserImageUrls(row.content)
    const supportedUrls = urls.filter((url) => DATA_IMAGE_URL_PATTERN.test(url))
    if (urls.length > supportedUrls.length) {
      logger.warn(
        {
          userId,
          date: dateStr,
          messageId: row.id,
          skippedImageCount: urls.length - supportedUrls.length,
        },
        'chat message images without model data URL skipped for profile tasks',
      )
    }
    return supportedUrls.map((url, idx) => ({
      source: 'chat_message' as const,
      url,
      label: `聊天上传图片（${toShanghaiTime(row.createdAt)}，同条消息第 ${idx + 1} 张）`,
      createdAt: row.createdAt,
    }))
  })
}

async function getMedicalDocumentImagesForDate(
  userId: string,
  dateStr: string,
  logger: Logger,
): Promise<DailyUserImageInput[]> {
  const db = getDb()
  const rows = await db
    .select({
      id: medicalDocuments.id,
      title: medicalDocuments.title,
      documentDate: medicalDocuments.documentDate,
      documentType: medicalDocuments.documentType,
      hospital: medicalDocuments.hospital,
      imageUrls: medicalDocuments.imageUrls,
      base64Urls: medicalDocuments.base64Urls,
      uploadedAt: medicalDocuments.uploadedAt,
      updatedAt: medicalDocuments.updatedAt,
      createdAt: medicalDocuments.createdAt,
    })
    .from(medicalDocuments)
    .where(
      and(
        eq(medicalDocuments.userId, userId),
        sql`(
          (${medicalDocuments.uploadedAt} AT TIME ZONE 'Asia/Shanghai')::date = ${dateStr}::date
          OR (${medicalDocuments.updatedAt} AT TIME ZONE 'Asia/Shanghai')::date = ${dateStr}::date
        )`,
      ),
    )
    .orderBy(asc(medicalDocuments.uploadedAt), asc(medicalDocuments.createdAt))

  const result: DailyUserImageInput[] = []
  for (const row of rows) {
    const imageUrls = parseJsonArray(row.imageUrls)
    const base64Urls = parseJsonArray(row.base64Urls)
    const meta = [
      row.title || '未命名病历图片',
      row.documentDate ? `文档日期 ${formatDateOnly(row.documentDate)}` : null,
      row.documentType ? `类型 ${row.documentType}` : null,
      row.hospital ? `医院 ${row.hospital}` : null,
      `上传 ${toShanghaiTime(row.uploadedAt)}`,
    ].filter(Boolean).join('，')

    for (let idx = 0; idx < imageUrls.length; idx++) {
      const base64Key = base64Urls[idx]
      if (!base64Key) {
        logger.warn(
          { userId, date: dateStr, docId: row.id, imageIndex: idx + 1 },
          'medical document image has no base64 companion; skipping for profile tasks',
        )
        continue
      }

      const dataUrl = await buildDataImageUrlFromBase64Key(base64Key, imageUrls[idx], logger, {
        userId,
        date: dateStr,
        docId: row.id,
        imageIndex: idx + 1,
      })
      if (!dataUrl) continue

      result.push({
        source: 'medical_document' as const,
        url: dataUrl,
        label: `病历/用药资料图片（${meta}，第 ${idx + 1} 页，docId=${row.id}）`,
        createdAt: row.uploadedAt,
      })
    }
  }
  return result
}

async function buildDataImageUrlFromBase64Key(
  base64Key: string,
  imageKey: string,
  logger: Logger,
  meta: { userId: string; date: string; docId: string; imageIndex: number },
): Promise<string | null> {
  try {
    const raw = (await fetchBase64(base64Key)).trim()
    if (!raw) return null
    if (DATA_IMAGE_URL_PATTERN.test(raw)) return raw
    return `data:${inferImageMimeType(base64Key, imageKey)};base64,${raw}`
  } catch (err) {
    logger.warn(
      { ...meta, error: err instanceof Error ? err.message : String(err) },
      'medical document image base64 companion unavailable; skipping for profile tasks',
    )
    return null
  }
}

function inferImageMimeType(...keys: string[]): string {
  const joined = keys.join(' ').toLowerCase()
  if (joined.includes('.png')) return 'image/png'
  if (joined.includes('.webp')) return 'image/webp'
  if (joined.includes('.gif')) return 'image/gif'
  return 'image/jpeg'
}

export function extractRealUserImageUrls(content: string): string[] {
  if (!content.startsWith('[')) return []

  try {
    const parsed = JSON.parse(content)
    if (!Array.isArray(parsed)) return []

    const textPart = parsed.find((part: any) => part?.type === 'text')
    const text = typeof textPart?.text === 'string' ? textPart.text : ''
    if (hasSyntheticHiddenUserMarker(text)) return []

    return parsed
      .filter((part: any) => part?.type === 'image_url')
      .map((part: any) => part?.image_url?.url)
      .filter((url: unknown): url is string => typeof url === 'string' && url.trim().length > 0)
  } catch {
    return []
  }
}

function dedupeImageInputs(images: DailyUserImageInput[]): DailyUserImageInput[] {
  const seen = new Set<string>()
  const out: DailyUserImageInput[] = []

  for (const image of images) {
    if (seen.has(image.url)) continue
    seen.add(image.url)
    out.push(image)
  }

  return out
}

function parseJsonArray(raw: string | null): string[] {
  if (!raw) return []
  try {
    const value = JSON.parse(raw)
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : []
  } catch {
    return []
  }
}

function toShanghaiTime(value: Date): string {
  return value.toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
  })
}

function formatDateOnly(value: unknown): string {
  if (value instanceof Date) {
    return value.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' })
  }
  return String(value).slice(0, 10)
}

/** 从 DB 原始 message.content 中提取“真实用户文本”，排除系统合成工具附件。 */
export function cleanUserPromptContent(content: string): string | null {
  let text = content

  if (content.startsWith('[')) {
    try {
      const parsed = JSON.parse(content)
      if (Array.isArray(parsed)) {
        const textPart = parsed.find((part: any) => part?.type === 'text')
        text = typeof textPart?.text === 'string' ? textPart.text : ''
      }
    } catch {
      // keep raw text fallback
    }
  }

  if (hasSyntheticHiddenUserMarker(text)) return null

  const cleaned = stripSystemReminderText(text).trim()
  return cleaned || null
}

/** 读取长期 Profile 的完整行（含 updatedAt，用于变更检测） */
export async function getUserProfileMemoryRow(
  userId: string,
  logger: Logger,
): Promise<{ id: string; content: string; userMd: string; version: number; updatedAt: Date } | null> {
  const db = getDb()

  const row = await db.query.userProfilesMemory.findFirst({
    where: eq(userProfilesMemory.userId, userId),
    columns: { id: true, content: true, userMd: true, version: true, updatedAt: true },
  })

  return row ?? null
}

// ─── 长期 Profile ───────────────────────────────────────────────────────────

/** 读取 Hermes-style USER.md 条目（用于第二条 system prompt 注入） */
export async function getUserProfileMemory(
  userId: string,
  logger: Logger,
): Promise<string | null> {
  const db = getDb()

  const row = await db.query.userProfilesMemory.findFirst({
    where: eq(userProfilesMemory.userId, userId),
    columns: { userMd: true },
  })

  const userMd = sanitizeUserMdForPrompt(row?.userMd)
  return userMd || null
}

/** 写入/更新长期 Profile（夜间合并用） */
export async function upsertUserProfileMemory(
  userId: string,
  content: string,
  logger: Logger,
): Promise<{ id: string; version: number; created: boolean }> {
  const db = getDb()

  const existing = await db.query.userProfilesMemory.findFirst({
    where: eq(userProfilesMemory.userId, userId),
    columns: { id: true, version: true },
  })

  if (existing) {
    await db
      .update(userProfilesMemory)
      .set({ content, version: existing.version + 1, updatedAt: new Date() })
      .where(eq(userProfilesMemory.id, existing.id))

    logger.info({ userId, version: existing.version + 1 }, 'user profile memory updated')
    return { id: existing.id, version: existing.version + 1, created: false }
  } else {
    const [row] = await db
      .insert(userProfilesMemory)
      .values({ userId, content })
      .returning({ id: userProfilesMemory.id })

    logger.info({ userId, version: 1 }, 'user profile memory created')
    return { id: row?.id ?? '', version: 1, created: true }
  }
}

/** 写入/更新 Cx Agent 用户长期记忆（memory 工具专用，不改 legacy content） */
export async function upsertUserMdMemory(
  userId: string,
  userMd: string,
  logger: Logger,
): Promise<{ id: string; version: number; created: boolean }> {
  const db = getDb()
  const normalized = sanitizeUserMdForPrompt(userMd)

  const existing = await db.query.userProfilesMemory.findFirst({
    where: eq(userProfilesMemory.userId, userId),
    columns: { id: true, version: true },
  })

  if (existing) {
    await db
      .update(userProfilesMemory)
      .set({ userMd: normalized, version: existing.version + 1, updatedAt: new Date() })
      .where(eq(userProfilesMemory.id, existing.id))

    logger.info({ userId, version: existing.version + 1 }, 'user md memory updated')
    return { id: existing.id, version: existing.version + 1, created: false }
  }

  const [row] = await db
    .insert(userProfilesMemory)
    .values({ userId, userMd: normalized })
    .returning({ id: userProfilesMemory.id })
  logger.info({ userId, version: 1 }, 'user md memory created')
  return { id: row?.id ?? '', version: 1, created: true }
}
