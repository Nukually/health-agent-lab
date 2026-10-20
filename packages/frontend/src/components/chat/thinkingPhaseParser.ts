import { normalizeThinkingPhaseName, replaceToolNameAliases } from '@health-agent/shared'

export interface ThinkingTimelineItem {
  phase: string
  title: string
  content: string
  isActive: boolean
}

const PHASE_MARKER_RE = /<phase\s+name="([^"\s>]+)">|<\|([^|<>\n]+)\|>/g
const PERSISTED_THINKING_PART_SEPARATOR_RE = /\n{2,}---\n{2,}/g
const DEFAULT_THINKING_TITLE = '方案规划'
const THINKING_CONTROL_TAG_RE = /<\/?think(?:ing)?>/g
const THINKING_CLOSE_TAG_RE = /<\/think(?:ing)?>/
const LEADING_THINKING_PROTOCOL_RE = /^\s*(?:<think(?:ing)?>\s*)?(?:<phase\s+name="[^"\s>]+">|<\|[^|<>\n]+\|>)/
const THINKING_PROTOCOL_MARKER_RE = /<phase\s+name="[^"\s>]+">|<\|[^|<>\n]+\|>/
const MAX_LEADING_THINKING_PREFIX_CHARS = 240

function stripPhaseProtocolText(raw: string): string {
  return raw
    .replace(/<phase\s+name="[^"]+">/g, '')
    .replace(/<\/phase>/g, '')
    .replace(/<\|[^|<>\n]+\|>/g, '')
    .replace(/<\|[^|<>\n]*(?:\|?)$/g, '')
}

export function stripThinkingControlTags(raw: string): string {
  const tagIdx = raw.indexOf('<final_answer>')
  if (tagIdx >= 0) return raw.slice(0, tagIdx).trimEnd()
  return raw.replace(/<\/?final_answer>/g, '').replace(/<\/?response>/g, '').trimEnd()
}

export function cleanThinkingContent(raw: string): string {
  const cleaned = stripPhaseProtocolText(stripThinkingControlTags(raw)
    .replace(THINKING_CONTROL_TAG_RE, '')
  )
    .trim()
  return replaceToolNameAliases(cleaned)
}

export function looksLikeThinkingProtocol(raw: string): boolean {
  return LEADING_THINKING_PROTOCOL_RE.test(stripThinkingControlTags(raw))
}

export function extractLeadingThinkingProtocol(raw: string): string | null {
  const split = splitLeadingThinkingProtocol(raw)
  return split ? stripThinkingControlTags(raw) : null
}

export function splitThinkingClose(raw: string): { thinking: string; answer: string; closed: boolean } {
  const close = THINKING_CLOSE_TAG_RE.exec(raw)
  if (close?.index == null) return { thinking: raw, answer: '', closed: false }
  return {
    thinking: raw.slice(0, close.index),
    answer: raw.slice(close.index + close[0].length),
    closed: true,
  }
}

export function splitLeadingThinkingProtocol(
  raw: string,
): { thinking: string; answer: string; closed: boolean } | null {
  const content = stripThinkingControlTags(raw)
  const directMatch = looksLikeThinkingProtocol(content)

  const marker = THINKING_PROTOCOL_MARKER_RE.exec(content)
  if (marker?.index == null && !directMatch) return null

  if (!directMatch && marker?.index != null) {
    const prefix = content.slice(0, marker.index)
    if (prefix.trim().length > MAX_LEADING_THINKING_PREFIX_CHARS) return null
  }

  return splitThinkingClose(content)
}

export function splitPersistedThinkingParts(raw: string): string[] {
  return raw
    .split(PERSISTED_THINKING_PART_SEPARATOR_RE)
    .map((part) => part.trim())
    .filter(Boolean)
}

export function displayPhaseTitle(rawName: string): string {
  const normalized = normalizeThinkingPhaseName(rawName)
  if (!normalized) return DEFAULT_THINKING_TITLE
  return /[\u3400-\u9fff]/.test(normalized) ? normalized : DEFAULT_THINKING_TITLE
}

export function displayPhasePill(rawName: string): string | null {
  const normalized = normalizeThinkingPhaseName(rawName)
  if (!normalized) return null
  return /[\u3400-\u9fff]/.test(normalized) ? `${normalized}中...` : null
}

export function parseThinkingTimeline(raw: string, streaming = false): ThinkingTimelineItem[] {
  const content = stripThinkingControlTags(raw).replace(THINKING_CONTROL_TAG_RE, '')
  PHASE_MARKER_RE.lastIndex = 0
  const openMatches = [...content.matchAll(PHASE_MARKER_RE)]
  if (openMatches.length === 0) return []

  const items: ThinkingTimelineItem[] = []

  for (let i = 0; i < openMatches.length; i++) {
    const match = openMatches[i]
    const name = match[1] ?? match[2]
    const isLegacyXmlPhase = !!match[1]
    const start = match.index
    if (start == null || !name) continue

    const contentStart = start + match[0].length
    const nextStart = openMatches[i + 1]?.index ?? content.length
    const closeIndex = isLegacyXmlPhase ? content.indexOf('</phase>', contentStart) : -1
    const hasOwnClose = closeIndex >= 0 && closeIndex < nextStart
    const contentEnd = hasOwnClose ? closeIndex : nextStart
    const inner = stripPhaseProtocolText(content.slice(contentStart, contentEnd)).trim()

    items.push({
      phase: normalizeThinkingPhaseName(name),
      title: displayPhaseTitle(name),
      content: replaceToolNameAliases(inner),
      isActive: streaming && (isLegacyXmlPhase ? !hasOwnClose : i === openMatches.length - 1),
    })
  }

  return items
}

export function makeThinkingSummary(content: string): string {
  const phases = parseThinkingTimeline(content)
  if (phases.length > 0) return phases.map((phase) => phase.title).join(' · ')

  return DEFAULT_THINKING_TITLE
}

/**
 * 提取 thinking content 中最后一个阶段 marker。
 * 已知历史英文 phase 会先归一化到中文；未知英文 phase 不直接外显给用户。
 */
export function extractActivePhase(content: string): string | null {
  if (!content) return null
  let match: RegExpExecArray | null
  let lastName: string | null = null
  PHASE_MARKER_RE.lastIndex = 0
  while ((match = PHASE_MARKER_RE.exec(content)) !== null) {
    lastName = match[1] ?? match[2] ?? null
  }
  return lastName
}
