import type { MedicalRiskVideoResource } from '@health-agent/shared'
import type { Logger } from '../lib/logger.js'

const DEFAULT_BAIDU_WEB_SEARCH_ENDPOINT = 'https://qianfan.baidubce.com/v2/ai_search/web_search'
export const VIDEO_RESOURCE_SITE = 'bilibili.com'
const CORE_QUERY_TOKEN_MARKERS = [
  '乳腺',
  '结节',
  '化疗',
  '放疗',
  '靶向',
  '内分泌',
  '术后',
  '治疗后',
  '恶心',
  '呕吐',
  '想吐',
  '反胃',
  '乏力',
  '疲劳',
  '失眠',
  '焦虑',
  '疼痛',
  '麻木',
  '水肿',
  '便秘',
  '腹泻',
  '食欲',
  '口干',
  '口腔',
]

interface BaiduWebSearchReference {
  id?: number
  type?: string
  title?: string
  url?: string
  date?: string
  content?: string
  snippet?: string
  image?: string
  video?: {
    duration?: string | number
    hover_pic?: string
    width?: string | number
    height?: string | number
    url?: string
  }
}

interface BaiduWebSearchResponse {
  references?: BaiduWebSearchReference[]
  code?: string
  message?: string
}

export interface VideoResourceSearchResult {
  title: string
  url: string
  providerVideoId: string | null
  publishedAt: string | null
  durationSec: number
  thumbnailUrl: string | null
  snippet: string
}

function trimText(value: unknown, max: number): string {
  return typeof value === 'string'
    ? value.replace(/[\u0004\u0005\s]+/g, ' ').trim().slice(0, max)
    : ''
}

function parseDurationSec(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.floor(value))
  if (typeof value !== 'string') return 0
  const trimmed = value.trim()
  if (!trimmed) return 0
  const numeric = Number(trimmed)
  if (Number.isFinite(numeric)) return Math.max(0, Math.floor(numeric))
  const parts = trimmed.split(':').map((part) => Number(part))
  if (parts.some((part) => !Number.isFinite(part))) return 0
  if (parts.length === 2) return Math.max(0, Math.floor(parts[0] * 60 + parts[1]))
  if (parts.length === 3) return Math.max(0, Math.floor(parts[0] * 3600 + parts[1] * 60 + parts[2]))
  return 0
}

export function extractProviderVideoId(url: string): string | null {
  return url.match(/BV[0-9A-Za-z]+/)?.[0] ?? null
}

function normalizeVideoResource(ref: BaiduWebSearchReference): VideoResourceSearchResult | null {
  const title = trimText(ref.title, 120)
  const url = trimText(ref.url, 500)
  if (!title || !/bilibili\.com\/video\//.test(url)) return null

  return {
    title,
    url,
    providerVideoId: extractProviderVideoId(url),
    publishedAt: trimText(ref.date, 40) || null,
    durationSec: parseDurationSec(ref.video?.duration),
    thumbnailUrl: trimText(ref.video?.hover_pic, 800) || trimText(ref.image, 800) || null,
    snippet: trimText(ref.content || ref.snippet, 240),
  }
}

export function buildVideoResourceSearchQueries(query: string): string[] {
  const normalized = query.replace(/\s+/g, ' ').trim()
  if (!normalized) return []

  const coreTokens = normalized
    .split(/[\s,，、;；|/]+/)
    .map((token) => token.trim())
    .filter((token) => token && CORE_QUERY_TOKEN_MARKERS.some((marker) => token.includes(marker)))
  const coreQuery = coreTokens.join(' ')
  return [...new Set([normalized, coreQuery].filter(Boolean))]
}

export async function searchVideoResources(
  query: string,
  logger: Logger,
  topK = 10,
): Promise<VideoResourceSearchResult[]> {
  const searchQuery = query.trim()
  if (!searchQuery) return []

  const apiKey = process.env.BAIDU_WEB_SEARCH_API_KEY?.trim()
  if (!apiKey) return []
  const endpoint = process.env.BAIDU_WEB_SEARCH_ENDPOINT?.trim() || DEFAULT_BAIDU_WEB_SEARCH_ENDPOINT

  const startedAt = performance.now()
  const queries = buildVideoResourceSearchQueries(searchQuery)
  const seen = new Set<string>()
  const results: VideoResourceSearchResult[] = []

  try {
    for (const candidateQuery of queries) {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'X-Appbuilder-Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messages: [{ role: 'user', content: `${candidateQuery} 动作跟练 视频` }],
          search_source: 'baidu_search_v2',
          resource_type_filter: [{ type: 'video', top_k: Math.min(Math.max(topK, 1), 10) }],
          search_filter: { match: { site: [VIDEO_RESOURCE_SITE] } },
          safe_search: true,
        }),
      })
      const data = await res.json().catch(() => ({})) as BaiduWebSearchResponse
      if (!res.ok) {
        logger.warn({
          status: res.status,
          durationMs: Math.round(performance.now() - startedAt),
          code: data.code,
        }, 'baidu web search failed')
        continue
      }

      for (const ref of data.references ?? []) {
        const video = normalizeVideoResource(ref)
        if (!video) continue
        const key = video.providerVideoId ?? video.url
        if (seen.has(key)) continue
        seen.add(key)
        results.push(video)
        if (results.length >= topK) break
      }
      if (results.length >= topK) break
    }

    logger.debug({
      durationMs: Math.round(performance.now() - startedAt),
      queryCount: queries.length,
      resultCount: results.length,
    }, 'baidu video resource search completed')
    return results
  } catch (err: any) {
    logger.warn({
      durationMs: Math.round(performance.now() - startedAt),
      error: err?.message ?? String(err),
    }, 'baidu video resource search error')
    return []
  }
}

export function toMedicalRiskVideoResource(
  id: string,
  video: VideoResourceSearchResult,
  sourceQuery: string,
): MedicalRiskVideoResource {
  return {
    id,
    kind: 'video_resource',
    title: video.title,
    url: video.url,
    providerVideoId: video.providerVideoId,
    publishedAt: video.publishedAt,
    durationSec: video.durationSec,
    thumbnailUrl: video.thumbnailUrl,
    snippet: video.snippet,
    sourceQuery,
  }
}
