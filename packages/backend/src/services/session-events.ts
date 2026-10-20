/**
 * Session events (Redis) — 会话内增量事件日志
 *
 * 系统提示词在一个 session 内只在冷启动 / 压缩后重算；档案更新被同意/拒绝、
 * update_memory 追加、沟通卡片保存等"增量信息"通过本事件流记录，下一轮 LLM 调用时由
 * injectSystemReminder 读取并拼入 <system-reminder> 区块，既让模型感知变化，
 * 又不破坏 system prompt 的前缀稳定性。
 *
 * Key:  events:session:{sessionId}
 *       events:user_external:{userId}
 * Value: JSON 字符串，数组 append，TTL 3600s（与 prompt cache 对齐，贴近上游 KV cache 热窗口）
 */

import { getKV } from '../lib/redis.js'
import type { Logger } from '../lib/logger.js'

const SESSION_PREFIX = 'events:session:'
const USER_EXTERNAL_PREFIX = 'events:user_external:'
const TTL_SECONDS = 3600

export type SessionEventType =
  | 'profile_approved'
  | 'profile_rejected'
  | 'memory_added'
  | 'communication_card_generated'
  | 'communication_card_saved'
  | 'external_page_changed'
  | 'schedule_confirmed'
  | 'schedule_rejected'

/** schedule 确认卡对应的操作类型 */
export type ScheduleEventAction = 'add' | 'update' | 'delete'

export type ExternalPageChangePage = 'personal_info' | 'medical_records' | 'materials'
export type ExternalPageChangeAction =
  | 'profile_saved'
  | 'medical_profile_saved'
  | 'medical_document_uploaded'
  | 'medical_document_deleted'
  | 'medical_document_image_deleted'
  | 'communication_card_updated'
  | 'communication_card_deleted'
  | 'intervention_material_deleted'

export interface SessionEventFieldChange {
  field: string
  fieldLabel?: string
  fromValue?: string | null
  toValue?: string | null
}

export interface SessionEventDocumentRef {
  docId?: string | null
  title?: string | null
  documentDate?: string | null
  documentType?: string | null
  hospital?: string | null
  pageCount?: number | null
  imageIndex?: number | null
}

export interface SessionEventCardRef {
  cardId?: string | null
  title?: string | null
  cardDate?: string | null
}

export interface SessionEventInterventionMaterialRef {
  engagementId?: string | null
  materialId?: string | null
  materialCode?: string | null
  title?: string | null
  sideEffect?: string | null
  scene?: string | null
}

export interface CommunicationCardSavedChange {
  field: string
  fieldLabel?: string
  fromValue?: string | null
  toValue?: string | null
}

export interface SessionEvent {
  type: SessionEventType
  /** 毫秒时间戳 */
  ts: number
  /** profile_* 事件的结构化档案字段名 */
  field?: string
  /** profile_approved 成功落库后的最终值（可读展示用） */
  valueLabel?: string
  /** memory_added 的摘要，不保存全文避免 redis 过大 */
  memorySnippet?: string
  /** communication_card_saved 的标题 */
  cardTitle?: string
  /** communication_card_saved 的日期 */
  cardDate?: string
  /** @deprecated 旧版本曾用于保存字段变更；system reminder 现在只反馈用户是否点击保存 */
  cardChanges?: CommunicationCardSavedChange[]
  /** external_page_changed：用户离开对话后进入哪个页面 */
  page?: ExternalPageChangePage
  /** external_page_changed：在页面里做了什么动作 */
  action?: ExternalPageChangeAction
  /** external_page_changed：字段级变更 */
  fieldChanges?: SessionEventFieldChange[]
  /** external_page_changed：病历文档相关动作 */
  document?: SessionEventDocumentRef
  /** external_page_changed：我的收藏夹/沟通卡片相关动作 */
  card?: SessionEventCardRef
  /** external_page_changed：我的收藏夹/跟练卡相关动作 */
  interventionMaterial?: SessionEventInterventionMaterialRef
  /** schedule_confirmed / schedule_rejected：提醒操作类型 */
  scheduleAction?: ScheduleEventAction
  /** schedule_confirmed / schedule_rejected：提醒任务名（展示用） */
  scheduleTaskName?: string | null
}

export type ExternalPageChangedEvent = SessionEvent & { type: 'external_page_changed' }
export type ExternalPageChangedEventInput = Omit<ExternalPageChangedEvent, 'ts'>

export interface RenderEventsReminderOptions {
  /** 已冻结 prompt 中的病历短 ID 映射；外部新增病历会从末尾追加 d-*，不覆盖既有映射 */
  docIdMap?: Map<string, string>
  /** 已冻结 prompt 中的卡片短 ID 映射；外部新增卡片会从末尾追加 c-*，不覆盖既有映射 */
  communicationCardIdMap?: Map<string, string>
}

export interface RenderEventsReminderResult {
  text: string
  docIdMap: Map<string, string>
  communicationCardIdMap: Map<string, string>
}

const EVENT_TIME_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

const DOC_TYPE_LABELS: Record<string, string> = {
  outpatient: '门诊病历',
  pathology: '病理报告',
  imaging: '影像报告',
  discharge: '出院记录',
  lab: '检验报告',
  other: '其他',
}

function communicationCardEventKey(event: SessionEvent): string | null {
  const title = event.cardTitle?.trim()
  if (!title) return null
  return `${title}\u0000${event.cardDate ?? ''}`
}

function communicationCardGeneratedSubject(event: SessionEvent): string {
  return event.cardTitle ? `卡片“${event.cardTitle}”` : '一张沟通卡片'
}

function formatShanghaiMinute(ts: number): string {
  const date = new Date(ts)
  if (Number.isNaN(date.getTime())) return String(ts)
  const parts = Object.fromEntries(
    EVENT_TIME_FMT.formatToParts(date).map((part) => [part.type, part.value]),
  )
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`
}

function pageLabel(page: ExternalPageChangePage | undefined): string {
  switch (page) {
    case 'personal_info':
      return '个人信息'
    case 'medical_records':
      return '病历档案'
    case 'materials':
      return '我的收藏夹'
    default:
      return '外部页面'
  }
}

function displayValue(value: string | null | undefined): string {
  const normalized = typeof value === 'string' ? value.trim() : ''
  return normalized || '未填写'
}

function renderFieldChange(change: SessionEventFieldChange): string {
  const label = change.fieldLabel || change.field
  return `“${label}”从「${displayValue(change.fromValue)}」修改为「${displayValue(change.toValue)}」`
}

function nextShortId(map: Map<string, string>, prefix: 'd' | 'c'): string {
  let idx = map.size + 1
  while (map.has(`${prefix}-${idx}`)) idx++
  return `${prefix}-${idx}`
}

function findExistingShortId(map: Map<string, string>, id: string): string | null {
  for (const [shortId, mappedId] of map) {
    if (mappedId === id) return shortId
  }
  return null
}

function ensureShortId(
  map: Map<string, string>,
  id: string | null | undefined,
  prefix: 'd' | 'c',
): string | null {
  if (!id) return null
  const existing = findExistingShortId(map, id)
  if (existing) return existing
  const shortId = nextShortId(map, prefix)
  map.set(shortId, id)
  return shortId
}

function renderDocumentSubject(
  event: SessionEvent,
  docIdMap: Map<string, string>,
): string {
  const doc = event.document
  if (!doc) return '一份病历'

  const shouldExposeShortId = event.action === 'medical_document_uploaded'
  const shortId = shouldExposeShortId ? ensureShortId(docIdMap, doc.docId, 'd') : null
  const parts = [
    doc.title || '未命名病历',
    doc.documentDate ? `就诊/检查日期 ${doc.documentDate}` : null,
    doc.documentType ? DOC_TYPE_LABELS[doc.documentType] || doc.documentType : null,
    doc.hospital || null,
    typeof doc.pageCount === 'number' ? `${doc.pageCount}页` : null,
  ].filter(Boolean)
  return `${shortId ? `[${shortId}] ` : ''}${parts.join(' | ')}`
}

function renderCardSubject(
  event: SessionEvent,
  communicationCardIdMap: Map<string, string>,
): string {
  const card = event.card
  if (!card) return '一张沟通卡片'
  const shortId = ensureShortId(communicationCardIdMap, card.cardId, 'c')
  const parts = [
    card.title ? `《${card.title}》` : '未命名卡片',
    card.cardDate || null,
  ].filter(Boolean)
  return `${shortId ? `[${shortId}] ` : ''}${parts.join(' | ')}`
}

function renderInterventionMaterialSubject(event: SessionEvent): string {
  const material = event.interventionMaterial
  if (!material) return '一张跟练卡'
  const title = material.title ? `《${material.title}》` : '未命名跟练卡'
  const parts = [
    title,
    material.materialCode ? `编号 ${material.materialCode}` : null,
    material.sideEffect && material.scene ? `${material.sideEffect} · ${material.scene}` : null,
  ].filter(Boolean)
  return parts.join(' | ')
}

function renderExternalPageChanged(
  event: SessionEvent,
  opts: Required<RenderEventsReminderOptions>,
): string | null {
  const time = formatShanghaiMinute(event.ts)
  const page = pageLabel(event.page)
  const fieldChanges = event.fieldChanges ?? []

  switch (event.action) {
    case 'profile_saved':
    case 'medical_profile_saved': {
      if (!fieldChanges.length) return null
      const rendered = fieldChanges.map(renderFieldChange)
      const changeText = rendered.length === 1
        ? `将${rendered[0]}`
        : `修改了 ${rendered.length} 个字段：${rendered.join('；')}`
      return `- 用户在「${page}」${changeText}，保存时间：${time}。`
    }
    case 'medical_document_uploaded':
      return `- 用户在「${page}」上传了一份病历：${renderDocumentSubject(event, opts.docIdMap)}，保存时间：${time}。`
    case 'medical_document_deleted':
      return `- 用户在「${page}」删除了一份病历：${renderDocumentSubject(event, opts.docIdMap)}，删除时间：${time}。这份病历已不在健康档案中，不要再调用 saved_content 读取或当作已保存病历引用。`
    case 'medical_document_image_deleted': {
      const imageNumber = typeof event.document?.imageIndex === 'number' ? event.document.imageIndex + 1 : null
      const imageText = imageNumber ? `第 ${imageNumber} 张图片` : '其中一张图片'
      return `- 用户在「${page}」删除了病历 ${renderDocumentSubject(event, opts.docIdMap)} 的${imageText}，操作时间：${time}。被删除的图片已不在病历原图中；如果之后读取这份病历，只能基于剩余图片，不要再依据被删除图片作答。`
    }
    case 'communication_card_updated': {
      const cardSubject = renderCardSubject(event, opts.communicationCardIdMap)
      const changes = fieldChanges.map(renderFieldChange)
      const suffix = changes.length ? `，字段变更：${changes.join('；')}` : ''
      return `- 用户在「${page}」修改了沟通卡片 ${cardSubject}${suffix}，保存时间：${time}。`
    }
    case 'communication_card_deleted': {
      const cardSubject = renderCardSubject(event, opts.communicationCardIdMap)
      return `- 用户在「${page}」取消收藏了沟通卡片 ${cardSubject}，操作时间：${time}。这张卡片已不在我的收藏夹中，不要再读取或当作已保存卡片引用。`
    }
    case 'intervention_material_deleted':
      return `- 用户在「${page}」取消收藏了跟练卡 ${renderInterventionMaterialSubject(event)}，操作时间：${time}。这张跟练卡已不在我的收藏夹中，不要再当作已保存跟练卡引用。`
    default:
      return null
  }
}

function sessionKeyOf(sessionId: string): string {
  return `${SESSION_PREFIX}${sessionId}`
}

function userExternalKeyOf(userId: string): string {
  return `${USER_EXTERNAL_PREFIX}${userId}`
}

export async function getSessionEvents(
  sessionId: string,
  logger: Logger,
): Promise<SessionEvent[]> {
  try {
    const raw = await getKV().get(sessionKeyOf(sessionId))
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as SessionEvent[]) : []
  } catch (err: any) {
    logger.warn({ sessionId, err: err.message }, 'session events get failed')
    return []
  }
}

export async function appendSessionEvent(
  sessionId: string,
  event: Omit<SessionEvent, 'ts'>,
  logger: Logger,
): Promise<void> {
  try {
    const existing = await getSessionEvents(sessionId, logger)
    const next: SessionEvent = { ...event, ts: Date.now() }
    existing.push(next)
    // 避免失控增长：最多保留最近 50 条
    const trimmed = existing.slice(-50)
    await getKV().set(sessionKeyOf(sessionId), JSON.stringify(trimmed), TTL_SECONDS)
    logger.info({ sessionId, type: event.type, field: event.field }, 'session event appended')
  } catch (err: any) {
    logger.warn({ sessionId, err: err.message }, 'session events append failed')
  }
}

export async function clearSessionEvents(
  sessionId: string,
  logger: Logger,
): Promise<void> {
  try {
    await getKV().del(sessionKeyOf(sessionId))
    logger.info({ sessionId }, 'session events cleared')
  } catch (err: any) {
    logger.warn({ sessionId, err: err.message }, 'session events clear failed')
  }
}

export async function getUserExternalEvents(
  userId: string,
  logger: Logger,
): Promise<ExternalPageChangedEvent[]> {
  try {
    const raw = await getKV().get(userExternalKeyOf(userId))
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const cutoff = Date.now() - TTL_SECONDS * 1000
    return parsed.filter((event): event is ExternalPageChangedEvent => (
      event?.type === 'external_page_changed' && typeof event.ts === 'number'
      && event.ts >= cutoff
    ))
  } catch (err: any) {
    logger.warn({ userId, err: err.message }, 'user external events get failed')
    return []
  }
}

export async function appendUserExternalEvent(
  userId: string,
  event: ExternalPageChangedEventInput,
  logger: Logger,
): Promise<void> {
  try {
    const existing = await getUserExternalEvents(userId, logger)
    const next: ExternalPageChangedEvent = { ...event, ts: Date.now() }
    existing.push(next)
    const trimmed = existing.slice(-50)
    await getKV().set(userExternalKeyOf(userId), JSON.stringify(trimmed), TTL_SECONDS)
    logger.info({ userId, page: event.page, action: event.action }, 'user external event appended')
  } catch (err: any) {
    logger.warn({ userId, err: err.message }, 'user external events append failed')
  }
}

export async function clearUserExternalEvents(
  userId: string,
  logger: Logger,
): Promise<void> {
  try {
    await getKV().del(userExternalKeyOf(userId))
    logger.info({ userId }, 'user external events cleared')
  } catch (err: any) {
    logger.warn({ userId, err: err.message }, 'user external events clear failed')
  }
}

function externalEventKey(event: SessionEvent): string {
  if (event.type !== 'external_page_changed') {
    return `${event.type}\u0000${event.ts}\u0000${event.field ?? ''}\u0000${event.cardTitle ?? ''}\u0000${event.cardDate ?? ''}`
  }
  const changes = (event.fieldChanges ?? [])
    .map((change) => `${change.field}:${change.fromValue ?? ''}->${change.toValue ?? ''}`)
    .join('|')
  return [
    event.type,
    event.ts,
    event.page ?? '',
    event.action ?? '',
    changes,
    event.document?.docId ?? '',
    event.document?.title ?? '',
    event.document?.imageIndex ?? '',
    event.card?.cardId ?? '',
    event.interventionMaterial?.engagementId ?? '',
    event.interventionMaterial?.materialCode ?? '',
  ].join('\u0000')
}

export function mergeEventsForReminder(
  sessionEvents: SessionEvent[],
  userExternalEvents: SessionEvent[],
  promptCreatedAt?: number,
): SessionEvent[] {
  const seen = new Set<string>()
  const merged: SessionEvent[] = []

  for (const event of [...sessionEvents, ...userExternalEvents]) {
    if (
      event.type === 'external_page_changed'
      && typeof promptCreatedAt === 'number'
      && event.ts < promptCreatedAt
    ) {
      continue
    }
    const key = externalEventKey(event)
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(event)
  }

  return merged
}

/** 把 events 渲染为 <system-reminder> 内的摘要段；同时扩展外部新增 doc/card 的临时短 ID 映射 */
export function renderEventsReminderWithMaps(
  events: SessionEvent[],
  options: RenderEventsReminderOptions = {},
): RenderEventsReminderResult {
  const docIdMap = options.docIdMap ?? new Map<string, string>()
  const communicationCardIdMap = options.communicationCardIdMap ?? new Map<string, string>()

  if (!events.length) {
    return { text: '', docIdMap, communicationCardIdMap }
  }

  const approved = events.filter((e) => e.type === 'profile_approved')
  const rejected = events.filter((e) => e.type === 'profile_rejected')
  const scheduleConfirmed = events.filter((e) => e.type === 'schedule_confirmed')
  const scheduleRejected = events.filter((e) => e.type === 'schedule_rejected')
  const memories = events.filter((e) => e.type === 'memory_added')
  const generatedCards = events.filter((e) => e.type === 'communication_card_generated')
  const cards = events.filter((e) => e.type === 'communication_card_saved')
  const externalChanges = events.filter((e) => e.type === 'external_page_changed')

  const lines: string[] = externalChanges.length
    ? ['用户对话期间操作记录：']
    : ['本会话历史增量记录（仅作上下文；是否调用工具仍按本轮用户请求判断）：']

  if (approved.length) {
    const items = approved
      .map((e) => (e.field ? `${e.field}${e.valueLabel ? `=${e.valueLabel}` : ''}` : ''))
      .filter(Boolean)
      .join('、')
    if (items) lines.push(`- 用户已同意更新：${items}`)
  }

  if (rejected.length) {
    const items = rejected.map((e) => e.field).filter(Boolean).join('、')
    if (items) lines.push(`- 用户已拒绝更新（本会话内不要再尝试）：${items}`)
  }

  if (scheduleConfirmed.length) {
    for (const e of scheduleConfirmed) {
      lines.push(`- 用户已确认并执行提醒操作：${scheduleActionLabel(e.scheduleAction)}${e.scheduleTaskName ? `「${e.scheduleTaskName}」` : ''}。`)
    }
  }

  if (scheduleRejected.length) {
    for (const e of scheduleRejected) {
      lines.push(`- 用户拒绝了这次提醒操作（${scheduleActionLabel(e.scheduleAction)}${e.scheduleTaskName ? `「${e.scheduleTaskName}」` : ''}），请和用户确认后续步骤，不要声称已完成或已设置成功。`)
    }
  }

  if (memories.length) {
    const snippets = memories.map((e) => e.memorySnippet).filter(Boolean)
    if (snippets.length) lines.push(`- 已追加到今日记忆：${snippets.join('；')}`)
  }

  if (generatedCards.length || cards.length) {
    const savedKeys = new Set(cards.map(communicationCardEventKey).filter(Boolean))
    const renderedKeys = new Set<string>()

    for (const card of generatedCards.slice(-3)) {
      const key = communicationCardEventKey(card) ?? `${card.cardTitle ?? 'untitled'}\u0000${card.ts}`
      if (renderedKeys.has(key)) continue
      renderedKeys.add(key)

      const clickedSave = savedKeys.has(key)
      lines.push(`- 生成的${communicationCardGeneratedSubject(card)}用户${clickedSave ? '点击了保存' : '未点击保存'}。`)
    }

    for (const card of cards.slice(-3)) {
      const key = communicationCardEventKey(card) ?? `${card.cardTitle ?? 'untitled'}\u0000${card.ts}`
      if (renderedKeys.has(key)) continue
      renderedKeys.add(key)

      lines.push(`- 生成的${communicationCardGeneratedSubject(card)}用户点击了保存。`)
    }
  }

  if (externalChanges.length) {
    const rendered = externalChanges
      .map((event) => renderExternalPageChanged(event, { docIdMap, communicationCardIdMap }))
      .filter((line): line is string => Boolean(line))
    if (rendered.length) {
      lines.push('- 用户在本次对话session期间更新了个人信息、档案或我的收藏夹；后续回复优先以这些变更后的状态为准。已落库或删除的内容无需再次更新。')
      lines.push(...rendered.slice(-10))
    }
  }

  return { text: lines.join('\n'), docIdMap, communicationCardIdMap }
}

/** 把 events 渲染为 <system-reminder> 内的摘要段；无事件返回空串 */
export function renderEventsReminder(
  events: SessionEvent[],
  options: RenderEventsReminderOptions = {},
): string {
  return renderEventsReminderWithMaps(events, options).text
}

/** schedule 操作类型 → 中文标签 */
function scheduleActionLabel(action: ScheduleEventAction | undefined): string {
  switch (action) {
    case 'add':
      return '设置提醒'
    case 'update':
      return '修改提醒'
    case 'delete':
      return '删除提醒'
    default:
      return '提醒'
  }
}

/** 取本会话已拒绝的字段集合，供 executor 提前拦截 */
export function rejectedFieldsFromEvents(events: SessionEvent[]): Set<string> {
  const set = new Set<string>()
  for (const e of events) {
    if (e.type === 'profile_rejected' && e.field) set.add(e.field)
  }
  return set
}
