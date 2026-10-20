import {
  SYNTHETIC_TOOL_ATTACHMENT_MARKER,
  LEGACY_SYNTHETIC_TOOL_ATTACHMENT_MARKER,
  SYNTHETIC_SCHEDULED_TODO_TRIGGER_MARKER,
} from './repeated-user-message.js'

type UserContentBlock = { type: string; text?: string; image_url?: { url: string } }
type UserContent = string | UserContentBlock[]

const SYSTEM_REMINDER_TAG_NAME = 'system[\\s_-]*reminder'
const TOOL_ATTACHMENT_META_TAG_NAME = 'tool[\\s_-]*attachment[\\s_-]*meta'

const SYSTEM_REMINDER_BLOCK_PATTERN = new RegExp(
  `<\\s*${SYSTEM_REMINDER_TAG_NAME}\\b[^>]*>[\\s\\S]*?<\\s*\\/\\s*${SYSTEM_REMINDER_TAG_NAME}\\s*>\\s*`,
  'gi',
)
const SYSTEM_REMINDER_TAG_PATTERN = new RegExp(
  `<\\s*\\/?\\s*${SYSTEM_REMINDER_TAG_NAME}\\b[^>]*>`,
  'gi',
)
const TOOL_ATTACHMENT_META_BLOCK_PATTERN = new RegExp(
  `<\\s*${TOOL_ATTACHMENT_META_TAG_NAME}\\b[^>]*>[\\s\\S]*?<\\s*\\/\\s*${TOOL_ATTACHMENT_META_TAG_NAME}\\s*>\\s*`,
  'gi',
)
const TOOL_ATTACHMENT_META_TAG_PATTERN = new RegExp(
  `<\\s*\\/?\\s*${TOOL_ATTACHMENT_META_TAG_NAME}\\b[^>]*>`,
  'gi',
)
const XML_LIKE_BLOCK_PATTERN = /<\s*([A-Za-z][\w:-]{0,80})\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>\s*/gi
const XML_LIKE_TAG_PATTERN = /<\s*\/?\s*[A-Za-z][\w:-]{0,80}\b[^>]*\/?>/gi
const XML_LIKE_DETECT_PATTERN = /<\s*\/?\s*[A-Za-z][\w:-]{0,80}\b[^>]*\/?>/i
const JSON_FIELD_DETECT_PATTERN = /(^|[{\[,])\s*["'][^"'\n]{1,80}["']\s*:/m
const SUSPICIOUS_KEYWORD_PATTERN = /(提示词|\bprompt\b)/i
const INVISIBLE_CONTROL_CHARS_PATTERN = /[\u200B\u200C\u200D\u2060\uFEFF\u202A-\u202E]/g
const HIGH_CONFIDENCE_EN_INJECTION_PATTERNS = [
  /\bignore\s+(previous|all|above|prior)\s+instructions?\b/i,
  /\bdisregard\s+(your|all|any|previous|above|prior)\s+(instructions?|rules?|guidelines?)\b/i,
  /\bsystem\s+prompt\s+override\b/i,
  /\boverride\s+(the\s+)?system\s+(prompt|instructions?|rules?)\b/i,
  /\breveal\s+(your\s+)?(system\s+prompt|developer\s+instructions?)\b/i,
  /\b(show|display|tell\s+me)\s+(your\s+)?(system\s+prompt|developer\s+instructions?)\b/i,
]
const HIGH_CONFIDENCE_ZH_INJECTION_PATTERNS = [
  /系统提示词覆盖/,
  /忽略(系统规则|系统指令|开发者指令)/,
  /(泄露|展示|显示|告诉我)(你的|当前)?(系统提示词|开发者指令|系统规则|系统指令)/,
]
const TRUSTED_SYSTEM_REMINDER_PREFIX_PATTERN = /^<system-reminder>[\s\S]*?<\/system-reminder>\s*/i
const TRUSTED_REMINDER_SENTINEL_PATTERN = /(当前时间：|输出内容必须严格遵循内部输出协议|医疗安全要求|\[tool-attachment:|\[scheduled-todo:|\[protocol-correction:|\[conversation-pattern:|\[security:)/

export type UnsafeUserContentReason =
  | 'internal_control_marker'
  | 'invisible_control_char'
  | 'xml_like_tag'
  | 'json_instruction_field'
  | 'prompt_keyword'
  | 'prompt_injection_phrase'

function neutralizeInternalControlMarkersOnly(text: string): string {
  return text
    .replace(SYSTEM_REMINDER_BLOCK_PATTERN, '')
    .replace(SYSTEM_REMINDER_TAG_PATTERN, '')
    .replace(TOOL_ATTACHMENT_META_BLOCK_PATTERN, '')
    .replace(TOOL_ATTACHMENT_META_TAG_PATTERN, '')
    .replace(XML_LIKE_BLOCK_PATTERN, '')
    .replace(XML_LIKE_TAG_PATTERN, '')
    .replaceAll(SYNTHETIC_TOOL_ATTACHMENT_MARKER, '')
    .replaceAll(LEGACY_SYNTHETIC_TOOL_ATTACHMENT_MARKER, '')
    .replaceAll(SYNTHETIC_SCHEDULED_TODO_TRIGGER_MARKER, '')
}

/**
 * Strip internal control markers when they come from real user input.
 *
 * These strings are trusted only when the backend itself injects them after the
 * user message has been saved. If a user types them verbatim, they can otherwise
 * be mistaken for trusted system-reminder / synthetic attachment metadata by
 * prefix-stability guards and history reconstruction.
 *
 * We remove rather than escape these markers: they are internal protocol syntax,
 * not user-facing content, and preserving them in any visually similar form
 * increases prompt-injection surface area.
 */
export function neutralizeUntrustedUserText(text: string): string {
  return neutralizeInternalControlMarkersOnly(
    text.replace(INVISIBLE_CONTROL_CHARS_PATTERN, ''),
  )
}

function splitTrustedReminderPrefix(text: string): { prefix: string; rest: string } | null {
  const match = text.match(TRUSTED_SYSTEM_REMINDER_PREFIX_PATTERN)
  if (!match) return null
  const prefix = match[0]
  if (!TRUSTED_REMINDER_SENTINEL_PATTERN.test(prefix)) return null
  return { prefix, rest: text.slice(prefix.length) }
}

export function contentHasTrustedReminder(
  content: UserContent,
): boolean {
  if (typeof content === 'string') return splitTrustedReminderPrefix(content) !== null
  const firstText = content.find((block) => block.type === 'text')
  return typeof firstText?.text === 'string' && splitTrustedReminderPrefix(firstText.text) !== null
}

function neutralizeUntrustedUserTextPreservingTrustedReminder(text: string): string {
  const split = splitTrustedReminderPrefix(text)
  if (!split) return neutralizeUntrustedUserText(text)
  return split.prefix + neutralizeUntrustedUserText(split.rest)
}

function collectSuspiciousSyntaxReasons(text: string): UnsafeUserContentReason[] {
  const reasons = new Set<UnsafeUserContentReason>()
  if (INVISIBLE_CONTROL_CHARS_PATTERN.test(text)) reasons.add('invisible_control_char')
  INVISIBLE_CONTROL_CHARS_PATTERN.lastIndex = 0
  if (neutralizeInternalControlMarkersOnly(text) !== text) reasons.add('internal_control_marker')
  if (XML_LIKE_DETECT_PATTERN.test(text)) reasons.add('xml_like_tag')
  if (JSON_FIELD_DETECT_PATTERN.test(text)) reasons.add('json_instruction_field')
  if (SUSPICIOUS_KEYWORD_PATTERN.test(text)) reasons.add('prompt_keyword')
  if (
    HIGH_CONFIDENCE_EN_INJECTION_PATTERNS.some((pattern) => pattern.test(text)) ||
    HIGH_CONFIDENCE_ZH_INJECTION_PATTERNS.some((pattern) => pattern.test(text))
  ) {
    reasons.add('prompt_injection_phrase')
  }
  if (
    text.includes(SYNTHETIC_TOOL_ATTACHMENT_MARKER) ||
    text.includes(LEGACY_SYNTHETIC_TOOL_ATTACHMENT_MARKER) ||
    text.includes(SYNTHETIC_SCHEDULED_TODO_TRIGGER_MARKER)
  ) {
    reasons.add('internal_control_marker')
  }
  return [...reasons]
}

function suspiciousSyntaxReasonsInText(
  text: string,
  opts: { preserveTrustedReminder?: boolean },
): UnsafeUserContentReason[] {
  if (!opts.preserveTrustedReminder) return collectSuspiciousSyntaxReasons(text)
  const split = splitTrustedReminderPrefix(text)
  return collectSuspiciousSyntaxReasons(split ? split.rest : text)
}

export function neutralizeUntrustedUserContent<T extends UserContent>(content: T): T {
  if (typeof content === 'string') {
    return neutralizeUntrustedUserText(content) as T
  }

  let changed = false
  const next = content.map((block) => {
    if (block.type !== 'text' || typeof block.text !== 'string') return block
    const text = neutralizeUntrustedUserText(block.text)
    if (text === block.text) return block
    changed = true
    return { ...block, text }
  })

  return (changed ? next : content) as T
}

export function neutralizeUntrustedUserContentPreservingTrustedReminder<T extends UserContent>(
  content: T,
): T {
  if (typeof content === 'string') {
    return neutralizeUntrustedUserTextPreservingTrustedReminder(content) as T
  }

  let changed = false
  const next = content.map((block) => {
    if (block.type !== 'text' || typeof block.text !== 'string') return block
    const text = neutralizeUntrustedUserTextPreservingTrustedReminder(block.text)
    if (text === block.text) return block
    changed = true
    return { ...block, text }
  })

  return (changed ? next : content) as T
}

export function hasUntrustedUserControlMarkers(
  content: UserContent,
  opts: { preserveTrustedReminder?: boolean } = {},
): boolean {
  return getUntrustedUserControlMarkerReasons(content, opts).length > 0
}

export function getUntrustedUserControlMarkerReasons(
  content: UserContent,
  opts: { preserveTrustedReminder?: boolean } = {},
): UnsafeUserContentReason[] {
  const reasons = new Set<UnsafeUserContentReason>()
  const collect = (text: string) => {
    for (const reason of suspiciousSyntaxReasonsInText(text, opts)) reasons.add(reason)
  }

  if (typeof content === 'string') {
    collect(content)
  } else {
    for (const block of content) {
      if (block.type === 'text' && typeof block.text === 'string') collect(block.text)
    }
  }

  return [...reasons]
}
