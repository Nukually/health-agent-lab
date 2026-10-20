import type {
  InternalVideoCatalog,
  InternalVideoCatalogEntry,
  MedicalRiskInternalVideoResource,
} from '@health-agent/shared'
import { getEnv } from '../env.js'
import { getDb } from '../db/client.js'
import { internalVideos } from '../db/schema/index.js'
import { fetchBufferFromBucket, signUrlForBucket } from '../lib/oss.js'
import type { Logger } from '../lib/logger.js'
import { assertInterventionBucketName, resolveInterventionBucketEnv } from './intervention-material.js'

const CATALOG_KEY = 'internal-videos/catalog/index.json'
const CACHE_TTL_MS = 30_000

export interface InternalVideoRuntimeSnapshot {
  targetEnv: 'dev' | 'sit' | 'prod'
  entries: InternalVideoCatalogEntry[]
  byId: Map<string, InternalVideoCatalogEntry>
}

interface CacheEntry {
  expiresAt: number
  snapshot: InternalVideoRuntimeSnapshot
}

const cache = new Map<'dev' | 'sit' | 'prod', CacheEntry>()

function emptySnapshot(targetEnv: 'dev' | 'sit' | 'prod'): InternalVideoRuntimeSnapshot {
  return { targetEnv, entries: [], byId: new Map() }
}

function normalizeMatchText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\s｜|:：,，.。!！?？()（）【】\[\]《》"“”'’‘\-_/]/g, '')
}

function isValidEntry(entry: unknown): entry is InternalVideoCatalogEntry {
  if (!entry || typeof entry !== 'object') return false
  const raw = entry as Record<string, unknown>
  return typeof raw.id === 'string'
    && typeof raw.version === 'string'
    && typeof raw.title === 'string'
    && typeof raw.videoKey === 'string'
    && typeof raw.posterKey === 'string'
    && typeof raw.durationSec === 'number'
    && !!raw.tags && typeof raw.tags === 'object'
}

async function upsertCatalogToDb(
  entries: InternalVideoCatalogEntry[],
  logger: Logger,
): Promise<void> {
  if (entries.length === 0) return
  try {
    const db = getDb()
    for (const entry of entries) {
      await db
        .insert(internalVideos)
        .values({
          videoId: entry.id,
          version: entry.version,
          title: entry.title,
          description: entry.description ?? '',
          sourceRef: entry.sourceRef ?? '',
          tags: entry.tags,
          durationSec: entry.durationSec,
          videoKey: entry.videoKey,
          posterKey: entry.posterKey,
          status: 'published',
        })
        .onConflictDoUpdate({
          target: internalVideos.videoId,
          set: {
            version: entry.version,
            title: entry.title,
            description: entry.description ?? '',
            sourceRef: entry.sourceRef ?? '',
            tags: entry.tags,
            durationSec: entry.durationSec,
            videoKey: entry.videoKey,
            posterKey: entry.posterKey,
            status: 'published',
            updatedAt: new Date(),
          },
        })
    }
  } catch (err: any) {
    // DB 镜像失败不应影响内容供给（OSS catalog 才是源）
    logger.warn({ error: err?.message ?? String(err) }, 'failed to mirror internal video catalog to db')
  }
}

export function invalidateInternalVideoRuntimeCache(): void {
  cache.clear()
}

export async function getInternalVideoRuntimeCatalog(
  logger: Logger,
): Promise<InternalVideoRuntimeSnapshot> {
  const targetEnv = resolveInterventionBucketEnv(getEnv().DEPLOY_ENV)
  const now = Date.now()
  const cached = cache.get(targetEnv)
  if (cached && cached.expiresAt > now) return cached.snapshot

  let snapshot: InternalVideoRuntimeSnapshot
  try {
    const bucket = assertInterventionBucketName(targetEnv)
    const buffer = await fetchBufferFromBucket(bucket, CATALOG_KEY)
    const parsed = JSON.parse(buffer.toString('utf-8')) as InternalVideoCatalog
    const entries = Array.isArray(parsed.videos) ? parsed.videos.filter(isValidEntry) : []
    snapshot = {
      targetEnv,
      entries,
      byId: new Map(entries.map((entry) => [entry.id, entry])),
    }
    await upsertCatalogToDb(entries, logger)
  } catch (err: any) {
    snapshot = emptySnapshot(targetEnv)
    logger.warn({
      targetEnv,
      error: err?.message ?? String(err),
    }, 'failed to load internal video catalog, fallback to empty snapshot')
  }

  cache.set(targetEnv, { expiresAt: now + CACHE_TTL_MS, snapshot })
  logger.info({
    targetEnv,
    internalVideoCount: snapshot.entries.length,
  }, 'internal video runtime catalog prepared')
  return snapshot
}

function scoreInternalVideoEntry(entry: InternalVideoCatalogEntry, queryText: string): number {
  const query = normalizeMatchText(queryText)
  if (!query) return 0
  const tags = entry.tags
  let score = 0

  const accumulate = (values: string[] | undefined, weight: number) => {
    for (const value of values ?? []) {
      const normalized = normalizeMatchText(value)
      if (normalized && query.includes(normalized)) score += weight
    }
  }

  accumulate(tags.triggerScenes, 30)
  accumulate(tags.bodyParts, 25)
  accumulate(tags.severity, 15)
  accumulate(tags.conditions, 8)
  accumulate(tags.environments, 5)
  if (query.includes(normalizeMatchText(entry.title))) score += 20

  return score
}

/** 关键词匹配内部视频，按相关度降序返回 top N（仅 score>0） */
export function selectMatchingInternalVideos(
  snapshot: InternalVideoRuntimeSnapshot,
  queryText: string,
  limit: number,
): InternalVideoCatalogEntry[] {
  return snapshot.entries
    .map((entry) => ({ entry, score: scoreInternalVideoEntry(entry, queryText) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id))
    .slice(0, limit)
    .map((item) => item.entry)
}

/** 由 catalog 条目构造可引用资源，签出 video/poster 临时 URL */
export function toMedicalRiskInternalVideoResource(
  id: string,
  entry: InternalVideoCatalogEntry,
  targetEnv: 'dev' | 'sit' | 'prod',
): MedicalRiskInternalVideoResource {
  const bucket = assertInterventionBucketName(targetEnv)
  return {
    id,
    kind: 'internal_video',
    title: entry.title,
    videoId: entry.id,
    version: entry.version,
    description: entry.description ?? '',
    durationSec: entry.durationSec,
    videoKey: entry.videoKey,
    posterKey: entry.posterKey,
    videoUrl: signUrlForBucket(bucket, entry.videoKey),
    posterUrl: signUrlForBucket(bucket, entry.posterKey),
    tags: entry.tags,
    sourceRef: entry.sourceRef ?? '',
  }
}
