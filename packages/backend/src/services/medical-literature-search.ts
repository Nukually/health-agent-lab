import type {
  MedicalLiteratureChunk,
  MedicalLiteratureSearchOutput,
  MedicalLiteratureSource,
} from '@health-agent/shared'
import { llmCall } from '../lib/llm.js'
import type { Logger } from '../lib/logger.js'

const RERANK_MODEL = 'qwen3.5-flash'
const RERANK_ATTEMPTS = 2
const RAG_TIMEOUT_MS = 10_000
const MAX_SELECTED_SOURCES = 5
const MAX_RERANK_SOURCES = 20
const MAX_RERANK_CHUNKS_PER_SOURCE = 3
const MAX_RERANK_CHUNK_CHARS = 900
export const MEDICAL_LITERATURE_MIN_SCORE = 0.65

const RERANK_SYSTEM_PROMPT = `你是乳腺癌医学知识库的相关性审核器。
任务：从候选医学资料中选出“能直接回答 query 的高度相关资料”。

高度相关必须同时满足：
1. 资料主题实体与 query 对齐，药名、疾病、治疗场景不能只是不相关同词或拼写噪声。
2. 资料内容能支持回答中的一个具体事实，不只是作者、利益冲突、泛泛背景、无关癌种或无关研究。
3. 药品说明书中 basic_info/safety/special_pop 可用于“是什么/成分/禁忌/不良反应/特殊人群”等问题。
4. 对乳腺癌用户安全有直接意义的指南、共识、RCT、Meta、药品说明书优先。

只输出 JSON 数组，元素为候选资料 id，最多 5 个。
如果没有高度相关资料，输出 []。
不要解释，不要 Markdown。`

export interface RawRagHit {
  rank?: unknown
  score?: unknown
  vec_score?: unknown
  content?: unknown
  title?: unknown
  doi?: unknown
  journal?: unknown
  pub_year?: unknown
  impact_factor?: unknown
  jcr_quartile?: unknown
  cas_quartile?: unknown
  article_class?: unknown
  section_name?: unknown
  chunk_type?: unknown
}

interface RawRagResponse {
  code?: unknown
  msg?: unknown
  data?: {
    selected_hits?: {
      evidence?: RawRagHit[]
    }
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
}

function optionalText(value: unknown): string | undefined {
  const normalized = text(value)
  return normalized || undefined
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function trimForRerank(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxChars) return normalized
  return `${normalized.slice(0, Math.max(0, maxChars - 1))}…`
}

function resolveRagQueryUrl(): string | null {
  const configured = process.env.MEDICAL_RAG_QUERY_URL?.trim()
  if (!configured) return null
  try {
    const url = new URL(configured)
    if (!url.pathname || url.pathname === '/') {
      url.pathname = '/query'
    }
    return url.toString()
  } catch {
    return null
  }
}

export function normalizeMedicalLiteratureHit(
  raw: RawRagHit,
  fallbackRank: number,
): MedicalLiteratureChunk | null {
  const content = text(raw.content)
  if (!content) return null

  const rank = numberOrNull(raw.rank)
  const score = numberOrNull(raw.score) ?? numberOrNull(raw.vec_score)
  const pubYear = numberOrNull(raw.pub_year)
  return {
    sourceRank: rank && rank > 0 ? Math.trunc(rank) : fallbackRank,
    score,
    title: text(raw.title) || '未命名文献',
    content,
    doi: optionalText(raw.doi),
    journal: optionalText(raw.journal),
    pubYear,
    articleClass: optionalText(raw.article_class),
    sectionName: optionalText(raw.section_name),
    chunkType: optionalText(raw.chunk_type),
  }
}

export function filterMedicalLiteratureChunksByScore(
  chunks: MedicalLiteratureChunk[],
): MedicalLiteratureChunk[] {
  return chunks.filter(
    (chunk) => chunk.score != null && chunk.score >= MEDICAL_LITERATURE_MIN_SCORE,
  )
}

function articleGroupKey(chunk: MedicalLiteratureChunk): string {
  if (chunk.doi) return `doi:${chunk.doi.toLowerCase()}`
  return [
    'title',
    chunk.title.toLowerCase(),
    chunk.pubYear ?? '',
    chunk.journal?.toLowerCase() ?? '',
    chunk.articleClass?.toLowerCase() ?? '',
  ].join('|')
}

function maxScore(chunks: MedicalLiteratureChunk[]): number | null {
  let score: number | null = null
  for (const chunk of chunks) {
    if (chunk.score == null) continue
    score = score == null ? chunk.score : Math.max(score, chunk.score)
  }
  return score
}

export function buildMedicalLiteratureSources(
  chunks: MedicalLiteratureChunk[],
  batchIndex: number,
): MedicalLiteratureSource[] {
  const groups = new Map<string, MedicalLiteratureChunk[]>()
  for (const chunk of chunks) {
    const key = articleGroupKey(chunk)
    const group = groups.get(key)
    if (group) group.push(chunk)
    else groups.set(key, [chunk])
  }

  return Array.from(groups.values()).map((group, index) => {
    const first = group[0]
    const sortedChunks = [...group].sort((a, b) => a.sourceRank - b.sourceRank)
    return {
      id: `d-${Math.max(1, Math.floor(batchIndex))}-${index + 1}`,
      title: first.title,
      doi: first.doi,
      journal: first.journal,
      pubYear: first.pubYear,
      articleClass: first.articleClass,
      score: maxScore(sortedChunks),
      chunks: sortedChunks,
    }
  })
}

async function fetchRagEvidence(query: string, logger: Logger): Promise<MedicalLiteratureChunk[]> {
  const queryUrl = resolveRagQueryUrl()
  if (!queryUrl) return []
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), RAG_TIMEOUT_MS)
  const startedAt = performance.now()
  try {
    const response = await fetch(queryUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_intents: ['regular_query'],
        query,
      }),
      signal: controller.signal,
    })

    if (!response.ok) {
      logger.warn({
        status: response.status,
        durationMs: Math.round(performance.now() - startedAt),
      }, 'medical literature rag request failed')
      return []
    }

    const json = await response.json() as RawRagResponse
    const evidence = json.data?.selected_hits?.evidence ?? []
    const chunks = evidence
      .map((hit, index) => normalizeMedicalLiteratureHit(hit, index + 1))
      .filter((hit): hit is MedicalLiteratureChunk => hit !== null)
    logger.info({
      durationMs: Math.round(performance.now() - startedAt),
      candidateCount: chunks.length,
    }, 'medical literature rag returned candidates')
    return chunks
  } catch (err: any) {
    logger.warn({
      durationMs: Math.round(performance.now() - startedAt),
      error: err?.name === 'AbortError' ? 'AbortError' : err?.message ?? String(err),
    }, 'medical literature rag request error')
    return []
  } finally {
    clearTimeout(timeout)
  }
}

function describeSourceForRerank(source: MedicalLiteratureSource): string {
  const meta = [
    source.articleClass,
    source.journal,
    source.pubYear != null ? String(source.pubYear) : '',
    source.doi ? `DOI: ${source.doi}` : '',
    source.score != null ? `score: ${source.score}` : '',
  ].filter(Boolean).join(' | ')

  const chunkText = source.chunks
    .slice(0, MAX_RERANK_CHUNKS_PER_SOURCE)
    .map((chunk) => {
      const chunkMeta = [
        `rank ${chunk.sourceRank}`,
        chunk.sectionName,
        chunk.chunkType,
      ].filter(Boolean).join(' | ')
      return `### ${chunkMeta}\n${trimForRerank(chunk.content, MAX_RERANK_CHUNK_CHARS)}`
    })
    .join('\n')

  return [
    `## ${source.id}`,
    `title: ${source.title}`,
    meta ? `meta: ${meta}` : null,
    chunkText,
  ].filter(Boolean).join('\n')
}

function buildRerankUserPrompt(query: string, sources: MedicalLiteratureSource[]): string {
  const candidates = sources
    .slice(0, MAX_RERANK_SOURCES)
    .map(describeSourceForRerank)
    .join('\n\n---\n\n')

  return `query:
${query}

候选医学资料:
${candidates}`
}

export function parseMedicalLiteratureIdArray(
  raw: string,
  validIds: Set<string>,
): string[] | null {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')
  const collect = (values: unknown[]): string[] => {
    const ids: string[] = []
    for (const value of values) {
      const id = typeof value === 'string' ? value.trim().toLowerCase() : ''
      if (!validIds.has(id) || ids.includes(id)) continue
      ids.push(id)
      if (ids.length >= MAX_SELECTED_SOURCES) break
    }
    return ids
  }

  try {
    const parsed = JSON.parse(trimmed)
    if (!Array.isArray(parsed)) return null
    return collect(parsed)
  } catch {
    const matches = [...trimmed.matchAll(/\bd-\d+-\d+\b/gi)].map((match) => match[0])
    return matches.length > 0 ? collect(matches) : null
  }
}

function renumberSelectedSources(sources: MedicalLiteratureSource[]): MedicalLiteratureSource[] {
  return sources.map((source, index) => ({
    ...source,
    id: String(index + 1),
  }))
}

async function rerankRelevantSources(
  query: string,
  sources: MedicalLiteratureSource[],
  logger: Logger,
): Promise<string[]> {
  if (sources.length === 0) return []

  const validIds = new Set(sources.map((source) => source.id))
  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: RERANK_SYSTEM_PROMPT },
    { role: 'user', content: buildRerankUserPrompt(query, sources) },
  ]

  for (let attempt = 1; attempt <= RERANK_ATTEMPTS; attempt++) {
    try {
      const response = await llmCall({
        model: RERANK_MODEL,
        messages,
        max_tokens: 200,
        temperature: 0.1,
        enable_thinking: false,
      }, logger)

      const content = response.choices[0]?.message?.content ?? ''
      const ids = parseMedicalLiteratureIdArray(content, validIds)
      if (ids) return ids

      logger.warn({ attempt }, 'medical literature reranker returned invalid JSON')
      messages.push(
        { role: 'assistant', content },
        { role: 'user', content: '上一轮输出不是合法 JSON 数组。请只输出一个 JSON 数组，例如 ["d-1-1","d-1-3"] 或 []。' },
      )
    } catch (err: any) {
      logger.warn({
        attempt,
        error: err?.message ?? String(err),
      }, 'medical literature reranker failed')
      return []
    }
  }

  return []
}

export function formatMedicalLiteratureToolOutput(output: MedicalLiteratureSearchOutput): string {
  const citationLabels = output.selectedSources
    .map((source) => `[${source.id}]`)
    .join('、')

  const lines = [
    '[medical_literature_search_result]',
    `医学知识库 query：${output.query}`,
    output.selectedCount > 0
      ? `找到 ${output.selectedCount} 篇相关文献。若最终回答使用或引用这些文献原文支持的事实或含义，必须在对应句子句末使用文献编号 ${citationLabels}；同一句综合多个文献时并列标注对应编号。引用不要求逐字照搬原文，可以用用户易懂的话转述原文含义；但不要给原文无法支持、与原文含义不一致或过度外推的表述加引用。`
      : '没有找到相关文献。不要输出医学知识库引用编号，也不要编造资料结论。',
  ]

  if (output.selectedSources.length === 0) {
    return lines.join('\n')
  }

  const sourceBlocks = output.selectedSources.map((source) => {
    const meta = [
      source.articleClass,
      source.journal,
      source.pubYear != null ? String(source.pubYear) : '',
      source.doi ? `DOI: ${source.doi}` : '',
    ].filter(Boolean).join(' | ')
    const chunks = source.chunks.map((chunk, index) => {
      const chunkMeta = [
        `片段 ${index + 1}`,
        `原始 rank ${chunk.sourceRank}`,
        chunk.sectionName,
        chunk.chunkType,
      ].filter(Boolean).join(' | ')
      return `### ${chunkMeta}\n${chunk.content}`
    }).join('\n\n')

    return `## [${source.id}] ${source.title}
${meta}

${chunks}`
  })

  return `${lines.join('\n')}\n\n${sourceBlocks.join('\n\n---\n\n')}`
}

export async function searchMedicalLiterature(
  query: string,
  logger: Logger,
  batchIndex: number,
): Promise<{
  llmOutput: string
  displayOutput: MedicalLiteratureSearchOutput
}> {
  const normalizedQuery = query.replace(/\s+/g, ' ').trim()
  const rawChunks = await fetchRagEvidence(normalizedQuery, logger)
  const chunks = filterMedicalLiteratureChunksByScore(rawChunks)
  const sources = buildMedicalLiteratureSources(chunks, batchIndex)
  logger.info({
    scoreThreshold: MEDICAL_LITERATURE_MIN_SCORE,
    rawCandidateCount: rawChunks.length,
    scoreQualifiedCount: chunks.length,
    sourceCount: sources.length,
  }, 'medical literature score filter applied')
  const selectedIds = sources.length > 0
    ? await rerankRelevantSources(normalizedQuery, sources, logger)
    : []
  const sourceById = new Map(sources.map((source) => [source.id, source]))
  const selectedSources = selectedIds
    .map((id) => sourceById.get(id))
    .filter((source): source is MedicalLiteratureSource => source !== undefined)
  const numberedSelectedSources = renumberSelectedSources(selectedSources)

  const displayOutput: MedicalLiteratureSearchOutput = {
    kind: 'medical_literature_search',
    query: normalizedQuery,
    citationStyle: 'numeric',
    searchedCount: rawChunks.length,
    scoreThreshold: MEDICAL_LITERATURE_MIN_SCORE,
    scoreQualifiedCount: chunks.length,
    candidateCount: sources.length,
    selectedCount: numberedSelectedSources.length,
    allSources: sources,
    selectedSources: numberedSelectedSources,
  }

  return {
    llmOutput: formatMedicalLiteratureToolOutput(displayOutput),
    displayOutput,
  }
}
