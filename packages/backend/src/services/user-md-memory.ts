import {
  getUserProfileMemory,
  normalizeUserMd,
  scanMemoryContentForStorage,
  splitUserMdEntries,
  upsertUserMdMemory,
  userMdEntryLooksLikeTransientRecord,
  USER_MD_CHAR_LIMIT,
  USER_MD_ENTRY_DELIMITER,
} from './memory.js'
import { profileMemoryMayContainMedicalFacts } from './profile-memory-updater.js'
import type { Logger } from '../lib/logger.js'

export type UserMdMemoryAction = 'add' | 'replace' | 'remove'

export interface UserMdMemoryToolInput {
  action?: UserMdMemoryAction
  content?: string
  old_text?: string
  oldText?: string
  brief?: string
}

export type UserMdMemoryToolResult =
  | {
    success: true
    message: string
    action: UserMdMemoryAction
    entries: string[]
    entry_count: number
    usage: string
    version?: number
  }
  | {
    success: false
    error: string
    matches?: string[]
    entries?: string[]
    usage?: string
  }

export function applyUserMdMemoryAction(
  existingUserMd: string | null,
  input: UserMdMemoryToolInput,
): UserMdMemoryToolResult {
  const action = input.action
  if (action !== 'add' && action !== 'replace' && action !== 'remove') {
    return { success: false, error: "action must be 'add', 'replace', or 'remove'." }
  }

  const entries = splitUserMdEntries(existingUserMd)
  if (action === 'add') return addEntry(entries, input.content)

  const oldText = String(input.old_text ?? input.oldText ?? '').trim()
  if (!oldText) return { success: false, error: "old_text is required for 'replace' and 'remove'." }

  const matches = entries
    .map((entry, idx) => ({ entry, idx }))
    .filter(({ entry }) => entry.includes(oldText))

  if (matches.length === 0) {
    return { success: false, error: `No long-term memory entry matched '${oldText}'.`, entries, usage: usageForEntries(entries) }
  }

  if (matches.length > 1) {
    const uniqueMatches = [...new Set(matches.map((match) => match.entry))]
    if (uniqueMatches.length > 1) {
      return {
        success: false,
        error: `Multiple long-term memory entries matched '${oldText}'. Use a more specific old_text.`,
        matches: uniqueMatches.map(previewEntry),
        entries,
        usage: usageForEntries(entries),
      }
    }
  }

  if (action === 'remove') {
    const next = entries.filter((_, idx) => idx !== matches[0].idx)
    return success('remove', 'Entry removed.', next)
  }

  const content = normalizeEntryContent(input.content)
  const rejected = validateEntryContent(content)
  if (rejected) return rejected

  const next = [...entries]
  next[matches[0].idx] = content
  return finalizeWithinBudget('replace', 'Entry replaced.', next)
}

export async function runUserMdMemoryTool(
  userId: string,
  input: UserMdMemoryToolInput,
  logger: Logger,
): Promise<UserMdMemoryToolResult> {
  const existingUserMd = await getUserProfileMemory(userId, logger)
  const result = applyUserMdMemoryAction(existingUserMd, input)
  if (!result.success) return result

  const write = await upsertUserMdMemory(
    userId,
    result.entries.join(USER_MD_ENTRY_DELIMITER),
    logger,
  )
  return { ...result, version: write.version }
}

function addEntry(entries: string[], rawContent: string | undefined): UserMdMemoryToolResult {
  const content = normalizeEntryContent(rawContent)
  const rejected = validateEntryContent(content)
  if (rejected) return rejected

  if (entries.includes(content)) {
    return success('add', 'Entry already exists (no duplicate added).', entries)
  }

  return finalizeWithinBudget('add', 'Entry added.', [...entries, content])
}

function validateEntryContent(content: string): UserMdMemoryToolResult | null {
  if (!content) return { success: false, error: 'content cannot be empty.' }

  const scanned = scanMemoryContentForStorage(content)
  if (!scanned.ok) return { success: false, error: scanned.message }

  if (userMdEntryLooksLikeTransientRecord(content)) {
    return {
      success: false,
      error: 'Single-use records such as meals, sleep logs, commute notes, symptoms, diaries, or check-ins must not be saved to USER.md.',
    }
  }

  if (profileMemoryMayContainMedicalFacts(content)) {
    return {
      success: false,
      error: 'Long-term memory only stores service preferences and background. Medical facts, medication names, treatment phase, report values, and treatment decisions must not be saved here.',
    }
  }

  return null
}

function finalizeWithinBudget(
  action: UserMdMemoryAction,
  message: string,
  entries: string[],
): UserMdMemoryToolResult {
  const normalized = normalizeUserMd(entries.join(USER_MD_ENTRY_DELIMITER))
  const current = normalized.length
  if (current > USER_MD_CHAR_LIMIT) {
    return {
      success: false,
      error: `Long-term memory would be ${current.toLocaleString('en-US')}/${USER_MD_CHAR_LIMIT.toLocaleString('en-US')} chars. Replace or remove existing entries first.`,
      entries: splitUserMdEntries(normalized),
      usage: usageForText(normalized),
    }
  }
  return success(action, message, splitUserMdEntries(normalized))
}

function success(
  action: UserMdMemoryAction,
  message: string,
  entries: string[],
): UserMdMemoryToolResult {
  return {
    success: true,
    message,
    action,
    entries,
    entry_count: entries.length,
    usage: usageForEntries(entries),
  }
}

function normalizeEntryContent(content: string | undefined): string {
  return String(content ?? '')
    .trim()
    .replace(/^\s*[-*]\s+/, '')
    .trim()
}

function usageForEntries(entries: string[]): string {
  return usageForText(entries.join(USER_MD_ENTRY_DELIMITER))
}

function usageForText(text: string): string {
  const current = text.length
  const pct = Math.min(100, Math.floor((current / USER_MD_CHAR_LIMIT) * 100))
  return `${pct}% — ${current.toLocaleString('en-US')}/${USER_MD_CHAR_LIMIT.toLocaleString('en-US')} chars`
}

function previewEntry(entry: string): string {
  return entry.length > 80 ? `${entry.slice(0, 80)}...` : entry
}
