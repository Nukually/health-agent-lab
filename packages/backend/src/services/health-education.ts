import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import type {
  HealthEducationStatsRecord,
  HealthEducationDoctor,
  HealthEducationItemWithStats,
  HealthEducationReaction,
} from '@health-agent/shared'
import { getDb } from '../db/client.js'
import { healthEducationInteractions, healthEducationViews } from '../db/schema/index.js'
import { getEnv } from '../env.js'
import type { Logger } from '../lib/logger.js'

interface DxDoctor {
  doctor_id?: string | null
  name?: string | null
  title?: string | null
  hospital?: string | null
  department?: string | null
  avatar_url?: string | null
}

interface DxContentSection {
  illustration_url?: string | null
}

interface DxPosterContent {
  title?: string | null
  subtitle?: string | null
  body_markdown?: string | null
  rendered_image_url?: string | null
  sections?: DxContentSection[]
  footer?: string | null
}

interface DxContentItem {
  poster_id: number
  task_id?: string | null
  version?: number | null
  published_at?: string | null
  title?: string | null
  drug?: string | null
  content_format?: string | null
  task_type?: string | null
  cover_image_url?: string | null
  preview_text?: string | null
  tags?: string[]
  content?: DxPosterContent | Record<string, unknown> | null
  body_text?: string | null
  body_markdown?: string | null
  doctor?: DxDoctor | null
}

interface DxListResponse {
  items?: DxContentItem[]
  next_cursor?: number | null
}

interface HealthEducationStats extends HealthEducationStatsRecord {
  userReaction: HealthEducationReaction | null
  isFavorited: boolean
}

export interface HealthEducationPage {
  items: HealthEducationItemWithStats[]
  nextCursor: number | null
}

function getDoctorServerConfig() {
  const env = getEnv()
  if (!env.DOCTOR_SERVER_BASE_URL || !env.DOCTOR_SERVER_TOKEN) {
    const err = new Error('医生端内容服务未配置') as Error & { status?: number }
    err.status = 503
    throw err
  }
  return {
    baseUrl: env.DOCTOR_SERVER_BASE_URL.replace(/\/$/, ''),
    token: env.DOCTOR_SERVER_TOKEN,
  }
}

function toAbsoluteDoctorUrl(value: string | null | undefined, baseUrl: string): string | null {
  if (!value) return null
  const trimmed = value.trim()
  if (!trimmed) return null
  if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith('data:')) return trimmed
  if (trimmed.startsWith('/')) return `${baseUrl}${trimmed}`
  return trimmed
}

function normalizeDate(value: string | null | undefined): string {
  if (!value) return new Date().toISOString()
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toISOString()
}

function normalizeDoctor(input: DxDoctor | null | undefined): HealthEducationDoctor {
  return {
    id: input?.doctor_id?.trim() || '',
    name: input?.name?.trim() || '医生',
    avatarUrl: input?.avatar_url?.trim() || null,
    department: input?.department?.trim() || null,
    title: input?.title?.trim() || null,
    hospital: input?.hospital?.trim() || null,
  }
}

function collectImageUrls(item: DxContentItem, baseUrl: string): string[] {
  const content = item.content as DxPosterContent | null | undefined
  const urls = [
    toAbsoluteDoctorUrl(item.cover_image_url, baseUrl),
    toAbsoluteDoctorUrl(content?.rendered_image_url, baseUrl),
    ...(content?.sections ?? [])
      .map((section) => toAbsoluteDoctorUrl(section.illustration_url, baseUrl)),
  ].filter((url): url is string => Boolean(url))
  return urls.filter((url, index) => urls.indexOf(url) === index)
}

function getDxContentText(item: DxContentItem): string {
  const content = item.content as DxPosterContent | null | undefined
  return item.body_markdown?.trim() ||
    item.body_text?.trim() ||
    content?.body_markdown?.trim() ||
    item.preview_text?.trim() ||
    ''
}

function fallbackStats(): HealthEducationStats {
  return {
    itemId: '',
    likeCount: 0,
    dislikeCount: 0,
    favoriteCount: 0,
    pvCount: 0,
    uvCount: 0,
    userReaction: null,
    isFavorited: false,
  }
}

function fallbackStatsForItem(itemId: string): HealthEducationStats {
  return {
    ...fallbackStats(),
    itemId,
  }
}

export async function getHealthEducationStatsForItemIds(
  itemIds: string[],
  userId?: string | null,
): Promise<Map<string, HealthEducationStats>> {
  const uniqueIds = [...new Set(itemIds)].filter(Boolean)
  const stats = new Map<string, HealthEducationStats>()
  for (const id of uniqueIds) stats.set(id, fallbackStatsForItem(id))
  if (uniqueIds.length === 0) return stats

  const db = getDb()
  const interactionRows = await db
    .select({
      itemId: healthEducationInteractions.itemId,
      userId: healthEducationInteractions.userId,
      reaction: healthEducationInteractions.reaction,
      isFavorited: healthEducationInteractions.isFavorited,
    })
    .from(healthEducationInteractions)
    .where(inArray(healthEducationInteractions.itemId, uniqueIds))

  for (const row of interactionRows) {
    const itemStats = stats.get(row.itemId)
    if (!itemStats) continue
    if (row.reaction === 'like') itemStats.likeCount += 1
    if (row.reaction === 'dislike') itemStats.dislikeCount += 1
    if (row.isFavorited) itemStats.favoriteCount += 1
    if (userId && row.userId === userId) {
      itemStats.userReaction = row.reaction
      itemStats.isFavorited = row.isFavorited
    }
  }

  const viewRows = await db
    .select({
      itemId: healthEducationViews.itemId,
      pvCount: sql<number>`count(*)::int`,
      uvCount: sql<number>`count(distinct ${healthEducationViews.userId})::int`,
    })
    .from(healthEducationViews)
    .where(inArray(healthEducationViews.itemId, uniqueIds))
    .groupBy(healthEducationViews.itemId)

  for (const row of viewRows) {
    const itemStats = stats.get(row.itemId)
    if (!itemStats) continue
    itemStats.pvCount = Number(row.pvCount) || 0
    itemStats.uvCount = Number(row.uvCount) || 0
  }

  return stats
}

export function toHealthEducationStatsRecord(stats: HealthEducationStatsRecord): HealthEducationStatsRecord {
  return {
    itemId: stats.itemId,
    likeCount: stats.likeCount,
    dislikeCount: stats.dislikeCount,
    favoriteCount: stats.favoriteCount,
    pvCount: stats.pvCount,
    uvCount: stats.uvCount,
  }
}

function toVisibleStats(stats: HealthEducationStats) {
  return {
    likeCount: stats.likeCount,
    dislikeCount: stats.dislikeCount,
    favoriteCount: stats.favoriteCount,
    pvCount: stats.pvCount,
    uvCount: stats.uvCount,
    userReaction: stats.userReaction,
    isFavorited: stats.isFavorited,
  }
}

export function mapDxItem(item: DxContentItem, baseUrl: string, stats: HealthEducationStats): HealthEducationItemWithStats {
  const id = String(item.poster_id)
  const publishedAt = normalizeDate(item.published_at)
  const imageUrls = collectImageUrls(item, baseUrl)
  return {
    id,
    posterId: item.poster_id,
    status: 'published',
    title: item.title?.trim() || (item.content as DxPosterContent | null | undefined)?.title?.trim() || '未命名患教内容',
    summary: item.preview_text?.trim() || null,
    content: getDxContentText(item),
    imageUrls,
    coverUrl: imageUrls[0] ?? null,
    doctor: normalizeDoctor(item.doctor),
    publishedAt,
    updatedAt: publishedAt,
    tags: Array.isArray(item.tags) ? item.tags.filter((tag): tag is string => typeof tag === 'string') : [],
    drug: item.drug?.trim() || null,
    contentFormat: item.content_format?.trim() || null,
    taskType: item.task_type?.trim() || null,
    posterContent: item.content ?? null,
    isAvailable: true,
    ...toVisibleStats(stats),
  }
}

function unavailableItem(itemId: string, stats: HealthEducationStats): HealthEducationItemWithStats {
  const now = new Date().toISOString()
  return {
    id: itemId,
    status: 'offline',
    title: '内容已下架',
    summary: '内容已下架或暂时不可访问',
    content: '内容已下架',
    imageUrls: [],
    coverUrl: null,
    doctor: {
      id: '',
      name: '医生',
      avatarUrl: null,
      department: null,
      title: null,
      hospital: null,
    },
    publishedAt: now,
    updatedAt: now,
    tags: [],
    isAvailable: false,
    ...toVisibleStats(stats),
  }
}

async function requestDoctorServer(path: string, logger: Logger): Promise<Response> {
  const { baseUrl, token } = getDoctorServerConfig()
  const url = `${baseUrl}${path}`
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  }).catch((err) => {
    logger.warn({ err: err?.message ?? String(err), url }, 'doctor content request failed')
    return null
  })

  if (!res) {
    const err = new Error('医生端内容服务请求失败') as Error & { status?: number }
    err.status = 502
    throw err
  }
  return res
}

export async function listHealthEducationItems(params: {
  userId: string
  doctorId?: string | null
  doctorIds?: string[] | null
  limit: number
  cursor?: number | null
  logger: Logger
}): Promise<HealthEducationPage> {
  const doctorIds = params.doctorIds?.filter(Boolean) ?? (params.doctorId ? [params.doctorId] : [])
  const { baseUrl } = getDoctorServerConfig()

  async function fetchPage(doctorId: string | null): Promise<DxListResponse | null> {
    const query = new URLSearchParams()
    query.set('limit', String(params.limit))
    if (params.cursor != null && doctorIds.length <= 1) query.set('cursor', String(params.cursor))
    if (doctorId) query.set('doctor_id', doctorId)

    const res = await requestDoctorServer(`/api/cx-access/contents?${query.toString()}`, params.logger)
    if (!res.ok) {
      params.logger.warn({ status: res.status, doctorId }, 'doctor content list returned non-OK')
      const err = new Error('医生端内容加载失败') as Error & { status?: number }
      err.status = res.status === 401 || res.status === 403 ? 502 : res.status
      throw err
    }
    return await res.json().catch(() => null) as DxListResponse | null
  }

  const pages = doctorIds.length > 1
    ? await Promise.all(doctorIds.map((doctorId) => fetchPage(doctorId)))
    : [await fetchPage(doctorIds[0] ?? null)]

  const remoteItems = pages
    .flatMap((payload) => Array.isArray(payload?.items) ? payload.items : [])
    .sort((a, b) => new Date(b.published_at ?? 0).getTime() - new Date(a.published_at ?? 0).getTime())
    .slice(0, params.limit)
  const stats = await getHealthEducationStatsForItemIds(remoteItems.map((item) => String(item.poster_id)), params.userId)
  return {
    items: remoteItems.map((item) => mapDxItem(
      item,
      baseUrl,
      stats.get(String(item.poster_id)) ?? fallbackStatsForItem(String(item.poster_id)),
    )),
    nextCursor: doctorIds.length > 1 ? null : (typeof pages[0]?.next_cursor === 'number' ? pages[0].next_cursor : null),
  }
}

export async function getHealthEducationItem(params: {
  userId: string
  itemId: string
  logger: Logger
}): Promise<HealthEducationItemWithStats | null> {
  const { baseUrl } = getDoctorServerConfig()
  const res = await requestDoctorServer(`/api/cx-access/contents/${encodeURIComponent(params.itemId)}`, params.logger)
  if (res.status === 404) return null
  if (!res.ok) {
    params.logger.warn({ status: res.status, itemId: params.itemId }, 'doctor content detail returned non-OK')
    const err = new Error('医生端内容详情加载失败') as Error & { status?: number }
    err.status = res.status === 401 || res.status === 403 ? 502 : res.status
    throw err
  }

  const item = await res.json().catch(() => null) as DxContentItem | null
  if (!item || typeof item.poster_id !== 'number') {
    const err = new Error('医生端内容详情格式错误') as Error & { status?: number }
    err.status = 502
    throw err
  }

  const stats = await getHealthEducationStatsForItemIds([String(item.poster_id)], params.userId)
  return mapDxItem(item, baseUrl, stats.get(String(item.poster_id)) ?? fallbackStatsForItem(String(item.poster_id)))
}

export async function listDoctorHealthEducationItemIds(params: {
  doctorId: string
  limit: number
  cursor?: number | null
  logger: Logger
}): Promise<{ itemIds: string[]; nextCursor: number | null }> {
  const query = new URLSearchParams()
  query.set('limit', String(params.limit))
  query.set('doctor_id', params.doctorId)
  if (params.cursor != null) query.set('cursor', String(params.cursor))

  const res = await requestDoctorServer(`/api/cx-access/contents?${query.toString()}`, params.logger)
  if (!res.ok) {
    params.logger.warn({ status: res.status, doctorId: params.doctorId }, 'doctor content stats list returned non-OK')
    const err = new Error('医生端内容统计列表加载失败') as Error & { status?: number }
    err.status = res.status === 401 || res.status === 403 ? 502 : res.status
    throw err
  }

  const payload = await res.json().catch(() => null) as DxListResponse | null
  const remoteItems = Array.isArray(payload?.items) ? payload.items : []
  return {
    itemIds: remoteItems
      .filter((item) => typeof item.poster_id === 'number')
      .map((item) => String(item.poster_id)),
    nextCursor: typeof payload?.next_cursor === 'number' ? payload.next_cursor : null,
  }
}

export async function listSavedHealthEducationItems(params: {
  userId: string
  logger: Logger
}): Promise<HealthEducationItemWithStats[]> {
  const db = getDb()
  const interactions = await db.query.healthEducationInteractions.findMany({
    where: and(
      eq(healthEducationInteractions.userId, params.userId),
      eq(healthEducationInteractions.isFavorited, true),
    ),
    orderBy: desc(healthEducationInteractions.updatedAt),
  })
  const favoriteIds = interactions.map((interaction) => interaction.itemId)
  if (favoriteIds.length === 0) return []

  const stats = await getHealthEducationStatsForItemIds(favoriteIds, params.userId)
  const items = await Promise.all(favoriteIds.map(async (itemId) => {
    const item = await getHealthEducationItem({ userId: params.userId, itemId, logger: params.logger })
      .catch((err) => {
        params.logger.warn({ err: err?.message ?? String(err), itemId }, 'saved health education detail unavailable')
        return null
      })
    return item ?? unavailableItem(itemId, stats.get(itemId) ?? fallbackStatsForItem(itemId))
  }))

  return items
}

async function getCurrentInteraction(userId: string, itemId: string) {
  const db = getDb()
  return db.query.healthEducationInteractions.findFirst({
    where: and(
      eq(healthEducationInteractions.userId, userId),
      eq(healthEducationInteractions.itemId, itemId),
    ),
  })
}

export async function setHealthEducationReaction(params: {
  userId: string
  itemId: string
  reaction: HealthEducationReaction | null
  logger: Logger
}): Promise<HealthEducationItemWithStats | null> {
  const existingContent = await getHealthEducationItem({
    userId: params.userId,
    itemId: params.itemId,
    logger: params.logger,
  })
  if (!existingContent) return null

  const db = getDb()
  const now = new Date()
  const current = await getCurrentInteraction(params.userId, params.itemId)
  const nextReaction = current?.reaction === params.reaction ? null : params.reaction

  await db.insert(healthEducationInteractions).values({
    userId: params.userId,
    itemId: params.itemId,
    reaction: nextReaction,
    isFavorited: current?.isFavorited ?? false,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: [healthEducationInteractions.userId, healthEducationInteractions.itemId],
    set: {
      reaction: nextReaction,
      updatedAt: now,
    },
  })

  return getHealthEducationItem({ userId: params.userId, itemId: params.itemId, logger: params.logger })
}

export async function setHealthEducationFavorite(params: {
  userId: string
  itemId: string
  favorite: boolean
  logger: Logger
}): Promise<HealthEducationItemWithStats | null> {
  if (params.favorite) {
    const existingContent = await getHealthEducationItem({
      userId: params.userId,
      itemId: params.itemId,
      logger: params.logger,
    })
    if (!existingContent) return null
  }

  const db = getDb()
  const now = new Date()
  const current = await getCurrentInteraction(params.userId, params.itemId)

  await db.insert(healthEducationInteractions).values({
    userId: params.userId,
    itemId: params.itemId,
    reaction: current?.reaction ?? null,
    isFavorited: params.favorite,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: [healthEducationInteractions.userId, healthEducationInteractions.itemId],
    set: {
      isFavorited: params.favorite,
      updatedAt: now,
    },
  })

  const updated = await getHealthEducationItem({ userId: params.userId, itemId: params.itemId, logger: params.logger })
    .catch(() => null)
  if (updated) return updated

  return unavailableItem(params.itemId, {
    itemId: params.itemId,
    likeCount: 0,
    dislikeCount: 0,
    favoriteCount: params.favorite ? 1 : 0,
    pvCount: 0,
    uvCount: 0,
    userReaction: current?.reaction ?? null,
    isFavorited: params.favorite,
  })
}

export async function recordHealthEducationView(params: {
  userId: string
  itemId: string
  viewId: string
  source?: string | null
  logger: Logger
}): Promise<HealthEducationStatsRecord | null> {
  const existingContent = await getHealthEducationItem({
    userId: params.userId,
    itemId: params.itemId,
    logger: params.logger,
  })
  if (!existingContent) return null

  const db = getDb()
  await db.insert(healthEducationViews).values({
    userId: params.userId,
    itemId: params.itemId,
    viewId: params.viewId,
    source: params.source ?? null,
  }).onConflictDoNothing({
    target: [healthEducationViews.userId, healthEducationViews.viewId],
  })

  const stats = await getHealthEducationStatsForItemIds([params.itemId], params.userId)
  return toHealthEducationStatsRecord(stats.get(params.itemId) ?? fallbackStatsForItem(params.itemId))
}
