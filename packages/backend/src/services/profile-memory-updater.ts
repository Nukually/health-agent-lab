import { llmCall } from '../lib/llm.js'
import { getEnv } from '../env.js'
import { invalidateSessionPrompt } from './prompt-cache.js'
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
import { syncLangfuseTextPrompt } from '../observability/langfuse.js'
import type { Logger } from '../lib/logger.js'
import type { UserMemoryItem, UserMemoryItemType } from './memory-items.js'

const PROFILE_UPDATE_MODEL = 'qwen3.5-flash'
const PROFILE_UPDATER_PROMPT_NAME = 'health-agent-lab-profile-memory-updater'
const PROFILE_CLEANUP_PROMPT_NAME = 'health-agent-lab-profile-memory-cleanup'
const NO_UPDATE_MARKER = '[skip update]'
const MEDICAL_FACT_PATTERNS = [
  /来曲唑|他莫昔芬|阿那曲唑|依西美坦|阿贝西利/,
  /化疗|放疗|靶向|内分泌治疗|免疫治疗|手术后|术后/,
  /治疗体验|用药时长|长期服药|治疗持续性/,
  /分型|分期|确诊|淋巴结|肿瘤标志物|病理|影像|复查结果/,
  /\b(?:HER2|ER|PR|Ki-?67)\b/i,
]

// Reviewer-managed USER.md refresh. These durable preference/background items
// are routed directly into USER.md and should not also be persisted as
// user_memory_items. Time-sensitive patterns stay in user_memory_items for
// semantic recall and lifecycle expiry.
const PROFILE_MEMORY_TYPES = new Set<UserMemoryItemType>([
  'communication_preference',
  'caregiver_context',
  'life_context',
])

export interface UserProfileMemoryRefreshInput {
  userId: string
  sourceSessionId?: string | null
  items: ProfileMemorySourceItem[]
  logger: Logger
}

export type ProfileMemorySourceItem = Pick<UserMemoryItem, 'memoryType' | 'content'>

export type UserProfileMemoryRefreshResult =
  | { kind: 'skipped_no_items' }
  | { kind: 'skipped_llm' }
  | { kind: 'skipped_unchanged' }
  | { kind: 'updated' }

export interface ProfileMemoryPatchAction {
  action: 'add' | 'replace' | 'remove'
  content?: string
  old_text?: string
}

export type ProfileMemoryPatchApplyResult =
  | {
    kind: 'updated'
    content: string
    entries: string[]
    appliedActions: number
    skippedActions: number
    errors: string[]
  }
  | {
    kind: 'skipped_unchanged'
    content: string
    entries: string[]
    appliedActions: number
    skippedActions: number
    errors: string[]
  }

export interface UserProfileMemoryCleanupInput {
  userId: string
  sourceSessionId?: string | null
  apply?: boolean
  logger: Logger
}

export type UserProfileMemoryCleanupResult =
  | { kind: 'skipped_no_profile' }
  | { kind: 'skipped_no_medical_facts' }
  | { kind: 'skipped_llm' }
  | { kind: 'skipped_unchanged' }
  | { kind: 'preview'; content: string }
  | { kind: 'updated'; content: string }

export function isProfileMemoryItemType(memoryType: string): memoryType is UserMemoryItemType {
  return PROFILE_MEMORY_TYPES.has(memoryType as UserMemoryItemType)
}

export function profileMemoryMayContainMedicalFacts(content: string): boolean {
  return MEDICAL_FACT_PATTERNS.some((pattern) => pattern.test(content))
}

export function stripMedicalFactLinesFromProfile(content: string): string | null {
  const cleaned = content
    .split(/\r?\n/)
    .filter((line) => !profileMemoryMayContainMedicalFacts(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  if (!cleaned || cleaned === content.trim()) return null
  return cleaned
}

export function scheduleUserProfileMemoryRefresh(input: UserProfileMemoryRefreshInput): void {
  if (!getEnv().MEMORY_PROFILE_REFRESH_ENABLED) return
  const items = input.items.filter((item) => isProfileMemoryItemType(item.memoryType))
  if (items.length === 0) return

  void updateUserProfileMemoryFromItems({ ...input, items }).catch((err) => {
    input.logger.child({ module: 'profile-memory-updater', userId: input.userId }).warn(
      { error: err instanceof Error ? err.message : String(err) },
      'user profile memory refresh failed (non-critical)',
    )
  })
}

export async function updateUserProfileMemoryFromItems(
  input: UserProfileMemoryRefreshInput,
): Promise<UserProfileMemoryRefreshResult> {
  const items = input.items.filter((item) => isProfileMemoryItemType(item.memoryType))
  if (items.length === 0) return { kind: 'skipped_no_items' }

  const log = input.logger.child({ module: 'profile-memory-updater', userId: input.userId })
  const existingProfile = await getUserProfileMemory(input.userId, log)
  const systemPrompt = await resolveProfileUpdaterSystemPrompt(log)
  const response = await llmCall({
    model: PROFILE_UPDATE_MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: buildUserPrompt({
          existingProfile,
          items,
        }),
      },
    ],
    max_tokens: 1600,
    temperature: 0.2,
    enable_thinking: false,
  }, log)

  const actions = normalizeProfileMemoryPatch(response.choices[0]?.message?.content ?? '')
  if (!actions?.length) {
    log.debug({ itemCount: items.length }, 'profile memory updater skipped')
    return { kind: 'skipped_llm' }
  }

  const patch = applyProfileMemoryPatch(existingProfile, actions)
  if (patch.kind !== 'updated') {
    log.debug(
      {
        actionCount: actions.length,
        skippedActions: patch.skippedActions,
        errors: patch.errors,
      },
      'profile memory updater patch produced no changes',
    )
    return { kind: 'skipped_unchanged' }
  }

  const scanned = scanMemoryContentForStorage(patch.content)
  if (!scanned.ok) {
    log.warn({ reasons: scanned.reasons }, 'profile memory updater output rejected')
    return { kind: 'skipped_llm' }
  }

  await upsertUserMdMemory(input.userId, patch.content, log)
  // Do not invalidate the active chat session here. The current session already
  // carries the preference in visible history/tool results; rebuilding its prompt
  // would insert USER PROFILE as a new system message and break the KV cache
  // prefix mid-conversation. Fresh sessions will pick up the updated profile.
  log.info(
    {
      itemCount: items.length,
      appliedActions: patch.appliedActions,
      skippedActions: patch.skippedActions,
    },
    'user profile memory refreshed from memory items',
  )
  return { kind: 'updated' }
}

export async function cleanupUserProfileMemory(
  input: UserProfileMemoryCleanupInput,
): Promise<UserProfileMemoryCleanupResult> {
  const log = input.logger.child({ module: 'profile-memory-cleanup', userId: input.userId })
  const existingProfile = await getUserProfileMemory(input.userId, log)
  const trimmedExisting = existingProfile?.trim()
  if (!trimmedExisting) return { kind: 'skipped_no_profile' }
  if (!profileMemoryMayContainMedicalFacts(trimmedExisting)) {
    return { kind: 'skipped_no_medical_facts' }
  }

  const systemPrompt = await resolveProfileCleanupSystemPrompt(log)
  const response = await llmCall({
    model: PROFILE_UPDATE_MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: `当前 Profile：\n${trimmedExisting}`,
      },
    ],
    max_tokens: 1600,
    temperature: 0.1,
    enable_thinking: false,
  }, log)

  let normalized = normalizeProfileMemoryOutput(response.choices[0]?.message?.content ?? '')
  if (normalized === null) return { kind: 'skipped_llm' }
  normalized = sanitizeProfileMemoryForStorage(normalized)
  if (normalized === null) return { kind: 'skipped_llm' }
  if (normalized === trimmedExisting) return { kind: 'skipped_unchanged' }

  const scanned = scanMemoryContentForStorage(normalized)
  if (!scanned.ok) {
    log.warn({ reasons: scanned.reasons }, 'profile memory cleanup output rejected')
    return { kind: 'skipped_llm' }
  }

  if (input.apply === false) return { kind: 'preview', content: normalized }

  await upsertUserMdMemory(input.userId, normalized, log)
  if (input.sourceSessionId) {
    await invalidateSessionPrompt(input.sourceSessionId, log).catch(() => {})
  }
  log.info('user profile memory cleaned')
  return { kind: 'updated', content: normalized }
}

export function normalizeProfileMemoryOutput(raw: string): string | null {
  const stripped = raw
    .trim()
    .replace(/^```(?:markdown|md)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()

  if (!stripped || stripped === NO_UPDATE_MARKER) return null
  if (stripped.length < 12) return null
  return stripped.length > 8000 ? stripped.slice(0, 8000).trim() : stripped
}

export function normalizeProfileMemoryPatch(raw: string): ProfileMemoryPatchAction[] | null {
  const stripped = stripModelOutputFence(raw)
  if (!stripped || stripped === NO_UPDATE_MARKER) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(stripped)
  } catch {
    return null
  }

  const rawActions = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { actions?: unknown }).actions)
      ? (parsed as { actions: unknown[] }).actions
      : parsed && typeof parsed === 'object' && 'action' in parsed
        ? [parsed]
        : []

  const actions: ProfileMemoryPatchAction[] = []
  for (const rawAction of rawActions) {
    const normalized = normalizePatchAction(rawAction)
    if (!normalized) continue
    actions.push(normalized)
    if (actions.length >= 6) break
  }

  return actions.length ? actions : null
}

export function applyProfileMemoryPatch(
  existingProfile: string | null,
  actions: ProfileMemoryPatchAction[],
): ProfileMemoryPatchApplyResult {
  let entries = splitUserMdEntries(existingProfile)
  let appliedActions = 0
  let skippedActions = 0
  const errors: string[] = []

  for (const action of actions) {
    const result = applyProfileMemoryAction(entries, action)
    if (!result.ok) {
      skippedActions++
      errors.push(result.error)
      continue
    }
    entries = result.entries
    if (result.changed) appliedActions++
  }

  const content = normalizeUserMd(entries.join(USER_MD_ENTRY_DELIMITER))
  const normalizedEntries = splitUserMdEntries(content)
  if (appliedActions === 0) {
    return {
      kind: 'skipped_unchanged',
      content,
      entries: normalizedEntries,
      appliedActions,
      skippedActions,
      errors,
    }
  }

  return {
    kind: 'updated',
    content,
    entries: normalizedEntries,
    appliedActions,
    skippedActions,
    errors,
  }
}

export function sanitizeProfileMemoryForStorage(content: string): string | null {
  const strippedMedicalFacts = stripMedicalFactLinesFromProfile(content) ?? content.trim()
  const cleaned = strippedMedicalFacts
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '§')
    .filter((line) => !userMdEntryLooksLikeTransientRecord(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  if (!cleaned || profileMemoryMayContainMedicalFacts(cleaned)) return null
  return cleaned
}

function stripModelOutputFence(raw: string): string {
  return raw
    .trim()
    .replace(/^```(?:json|markdown|md)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()
}

function normalizePatchAction(raw: unknown): ProfileMemoryPatchAction | null {
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  const actionValue = typeof record.action === 'string' ? record.action : typeof record.op === 'string' ? record.op : ''
  const action = normalizePatchActionName(actionValue)
  if (!action) return null

  const content = typeof record.content === 'string'
    ? normalizeProfileEntryContent(record.content)
    : undefined
  const oldTextRaw = record.old_text ?? record.oldText ?? record.match_text ?? record.matchText
  const oldText = typeof oldTextRaw === 'string' ? oldTextRaw.trim() : undefined

  if (action === 'add') {
    return content ? { action, content } : null
  }
  if (action === 'replace') {
    return oldText && content ? { action, old_text: oldText, content } : null
  }
  return oldText ? { action, old_text: oldText } : null
}

function normalizePatchActionName(action: string): ProfileMemoryPatchAction['action'] | null {
  const normalized = action.trim().toLowerCase().replace(/[\s_-]+/g, '_')
  if (normalized === 'add' || normalized === 'create' || normalized === 'append') return 'add'
  if (normalized === 'replace' || normalized === 'update' || normalized === 'merge') return 'replace'
  if (normalized === 'remove' || normalized === 'delete' || normalized === 'drop') return 'remove'
  return null
}

function applyProfileMemoryAction(
  entries: string[],
  action: ProfileMemoryPatchAction,
): { ok: true; entries: string[]; changed: boolean } | { ok: false; error: string } {
  if (action.action === 'add') {
    const content = normalizeProfileEntryContent(action.content)
    const rejected = validateProfileEntryContent(content)
    if (rejected) return { ok: false, error: rejected }
    if (entries.includes(content)) return { ok: true, entries, changed: false }
    return finalizeProfileEntries([...entries, content])
  }

  const oldText = action.old_text?.trim()
  if (!oldText) return { ok: false, error: "old_text is required for replace/remove actions." }

  const matches = entries
    .map((entry, idx) => ({ entry, idx }))
    .filter(({ entry }) => entry.includes(oldText))
  if (matches.length === 0) {
    return { ok: false, error: `No USER.md entry matched '${oldText}'.` }
  }

  const uniqueMatches = [...new Set(matches.map((match) => match.entry))]
  if (uniqueMatches.length > 1) {
    return {
      ok: false,
      error: `Multiple USER.md entries matched '${oldText}'. Use a more specific old_text.`,
    }
  }

  if (action.action === 'remove') {
    return finalizeProfileEntries(entries.filter((_, idx) => idx !== matches[0].idx))
  }

  const content = normalizeProfileEntryContent(action.content)
  const rejected = validateProfileEntryContent(content)
  if (rejected) return { ok: false, error: rejected }
  const next = [...entries]
  next[matches[0].idx] = content
  return finalizeProfileEntries(next)
}

function finalizeProfileEntries(entries: string[]): { ok: true; entries: string[]; changed: boolean } | { ok: false; error: string } {
  const normalized = normalizeUserMd(entries.join(USER_MD_ENTRY_DELIMITER))
  if (normalized.length > USER_MD_CHAR_LIMIT) {
    return {
      ok: false,
      error: `USER.md would exceed ${USER_MD_CHAR_LIMIT.toLocaleString('en-US')} chars; replace or remove existing entries first.`,
    }
  }
  return { ok: true, entries: splitUserMdEntries(normalized), changed: true }
}

function validateProfileEntryContent(content: string): string | null {
  if (!content) return 'content cannot be empty.'

  const scanned = scanMemoryContentForStorage(content)
  if (!scanned.ok) return scanned.message

  if (userMdEntryLooksLikeTransientRecord(content)) {
    return 'Single-use records such as meals, sleep logs, symptoms, diaries, or check-ins must not be saved to USER.md.'
  }

  if (profileMemoryMayContainMedicalFacts(content)) {
    return 'Medical facts, medication names, treatment phase, report values, and treatment decisions must not be saved to USER.md.'
  }

  return null
}

function normalizeProfileEntryContent(content: string | undefined): string {
  return String(content ?? '')
    .trim()
    .replace(/^\s*[-*]\s+/, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

async function resolveProfileUpdaterSystemPrompt(logger: Logger): Promise<string> {
  const prompt = buildSystemPrompt()
  await syncLangfuseTextPrompt({
    name: PROFILE_UPDATER_PROMPT_NAME,
    prompt,
    logger,
    source: 'profile-memory-updater-system-prompt',
    tags: ['memory', 'profile-updater'],
    commitMessagePrefix: `sync ${PROFILE_UPDATER_PROMPT_NAME}`,
  }).catch((err) => {
    logger.debug(
      { err, promptName: PROFILE_UPDATER_PROMPT_NAME },
      'profile memory updater prompt Langfuse sync skipped',
    )
  })
  return prompt
}

async function resolveProfileCleanupSystemPrompt(logger: Logger): Promise<string> {
  const prompt = buildCleanupSystemPrompt()
  await syncLangfuseTextPrompt({
    name: PROFILE_CLEANUP_PROMPT_NAME,
    prompt,
    logger,
    source: 'profile-memory-cleanup-system-prompt',
    tags: ['memory', 'profile-cleanup'],
    commitMessagePrefix: `sync ${PROFILE_CLEANUP_PROMPT_NAME}`,
  }).catch((err) => {
    logger.debug(
      { err, promptName: PROFILE_CLEANUP_PROMPT_NAME },
      'profile memory cleanup prompt Langfuse sync skipped',
    )
  })
  return prompt
}

function buildSystemPrompt(): string {
  return `你是乳腺健康 USER.md 生命周期整理助手。USER.md 是 Cx Agent 的用户长期记忆，用于让助手理解用户的长期服务偏好和生活背景，不是病历事实源。

你会收到当前 USER.md 条目和新产生的长期记忆条目。请像 Hermes memory reviewer 一样输出 entry-level patch，而不是整段重写或一直累加。

必须遵守：
- 只合并服务偏好、照护/家庭/生活背景、情绪沟通模式等长期服务背景
- 不要写入分型、分期、检查数值、治疗阶段、具体用药、用药方案、治疗决策等病历事实
- 不要写建议、诊断、风险判断
- 不要重复已有内容；如果新信息补充、修正或反转已有条目，用 replace 合并成一条更准确的 entry
- 如果已有条目已经过时、被用户反转、或会和新条目冲突，用 remove 或 replace 清理旧条目
- replace/remove 的 old_text 必须是当前 USER.md 某条 entry 中短且唯一的原文片段，方便后端定位
- 若新条目不足以让 USER.md 发生实质变化，只输出 ${NO_UPDATE_MARKER}

输出规则：
- 要么只输出 ${NO_UPDATE_MARKER}
- 要么只输出 JSON，不要代码块、不要解释前后缀：
{"actions":[{"action":"add","content":"用户希望被称呼为“飞飞”。"},{"action":"replace","old_text":"喜欢吃西瓜","content":"用户喜欢吃西瓜和喝牛奶。"},{"action":"remove","old_text":"回答要非常详细"}]}

action 只能是 add、replace、remove。需要合并或更新时用 replace，不要输出 merge/update。`
}

function buildCleanupSystemPrompt(): string {
  return `你是乳腺健康长期 Profile 清洗助手。Profile 是 Cx Agent 的用户长期记忆，只用于让助手理解用户的长期服务偏好、生活背景和沟通模式，不是病历事实源。

任务：
- 清洗当前 Profile 中已经混入的病历事实
- 保留仍然有用的服务偏好、照护/家庭/生活背景、情绪沟通模式
- 不新增当前 Profile 没有的信息

必须删除或改写为非病历事实：
- 分型、分期、检查数值、治疗阶段、具体用药、用药方案、治疗决策
- 具体日期的一次性饮食、睡眠、通勤、症状、运动、打卡或日记记录
- “正在服用某药”“处于某治疗阶段”“术后第几个月”等当前医学事实
- 任何可能被后续回答当作权威病历依据的内容
- 不要保留或改写出这些词：来曲唑、他莫昔芬、阿那曲唑、依西美坦、阿贝西利、化疗、放疗、靶向、内分泌治疗、术后、治疗阶段、用药时长
- 如果这些内容背后表达的是情绪或沟通偏好，只能抽象成“对医疗安排、身体不适或不确定表述容易担忧”

可以保留：
- 用户希望如何被称呼
- 用户偏好的回答结构、语气、长短
- 用户对某些表达的焦虑触发点
- 用户希望如何组织医患沟通问题

输出规则：
- 若无需清洗，只输出 ${NO_UPDATE_MARKER}
- 否则输出完整 Profile Markdown，不要代码块，不要解释前后缀`
}

function buildUserPrompt(input: {
  existingProfile: string | null
  items: ProfileMemorySourceItem[]
}): string {
  const itemLines = input.items
    .map((item, idx) => `${idx + 1}. [${item.memoryType}] ${item.content}`)
    .join('\n')

  return `当前 USER.md 条目：
${input.existingProfile?.trim() || '无'}

新增长期记忆条目：
${itemLines}`
}
