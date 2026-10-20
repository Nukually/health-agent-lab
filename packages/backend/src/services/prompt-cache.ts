/**
 * Session-scoped prompt cache
 *
 * 设计目标：
 * - Redis 只做热缓存（TTL 3600s，贴近上游 KV cache 热窗口）
 * - chat_sessions.prompt_snapshot / prompt_snapshot_meta 做持久化冻结快照
 * - 除 compaction 外，会话内始终复用同一份 system prompt / 文档/沟通卡片短 ID 顺序 /
 *   干预资料库编号映射，避免编号漂移
 */

import { eq } from 'drizzle-orm'
import { getKV } from '../lib/redis.js'
import { getDb } from '../db/client.js'
import { chatSessions } from '../db/schema/index.js'
import type { Logger } from '../lib/logger.js'
import type {
  InterventionCatalogCodeEntry,
  InterventionCatalogGroup,
} from './intervention-material-runtime.js'
import type { LangfusePromptRef } from '../observability/langfuse.js'

const PREFIX = 'prompt:session:'
const TTL_SECONDS = 3600
const SNAPSHOT_TTL_MS = TTL_SECONDS * 1000
// v43: 恢复 thinking 隐藏渲染协议（thinkingProtocolSection 重新并入静态 prompt + 工具规划折叠）
const PROMPT_LAYOUT_VERSION = 43

interface StoredPromptSnapshotMeta {
  /** prompt 快照布局版本；v2 起 system 只存静态前缀，v3 起医学风险分级改为工具化，v4 起风险工具增加场景分类，v5 起分级定义并入工具 schema，v6 起移除 CTCAE 静态提示，v7 起不再要求答案分界标识，v8 起药物别名迁移到 pre_model_call hook，v9 起工具指南和干预资料库列表移出静态 prompt，v10 起风险工具使用六级分级，v11 起远程复核档暂按 C 处理，v12 起禁用元话术，v13 起移除远程复核档，v14 起改为贴着具体症状/报告压力的人话开头，v15 起 schedule 原子化为 action 工具，v16 起干预资源通过 grade_medical_risk + resource_ref 引用，v17 起干预资源编号改为会话级批次编号，v18 起保存内容摘要化并由 saved_content list/read 读取，v19 起低风险具体不适可触发视频/跟练资源，v20 起副作用分级和干预资源生成拆为 grade_medical_risk + 独立 generate_plan，v21 起 UI 入口说明迁移到产品指南工具，v22 起产品 UI 问答要求保留 Markdown 链接格式，v23 起产品指南工具改名为 read_product_guide 并覆盖移动端 App 下载指南，v24 起长期记忆拆到第二条 USER PROFILE system message，v25 起静态 prompt 恢复产品 UI 指南并保留远端记忆指导，v26 起加入 skill catalog 和副作用疗程 load_skill 流程，v27 起 skill catalog 仅保留触发条件并改为命中 skill 先加载，v28 起 side_effect 由 grade_medical_risk 自动返回副作用疗程 skill，v29 起移除静态 skill catalog 和 load_skill 工具，v30 起移除标签化推理协议，v31 起 side_effect+B0/B1/C 风险工具只返回副作用疗程 skill，v32 起加入 load_skill 单 skill 按需加载流程，v33 起 current_symptom+B0/B1/C 也返回症状疗程 skill 调度，v34 起收紧已加载 skill 的必需工具步骤，v35 起 skill metadata 覆盖 current_symptom 并强调先问康复分流信息，v36 起红旗存在时禁止症状疗程 skill 直接调 generate_plan，v37 起分流完成后标准出口为 generate_plan 后立即 ask_user_question 展示三方案，v38 起问卷完成后禁止额外用药/病因追问并强制进入三方案选择，v39 起已加载 skill 问卷回填后禁止重复风险分级，v40 起资源选择后自动创建跟练计划和提醒，v41 起资源候选选择后强制 todos 而非 generate_plan，v42 起 USER.md 不再由 legacy Profile content 自动派生（合并 main 记忆重构），v43 起恢复 thinking 隐藏渲染协议（thinkingProtocolSection 重新并入静态 prompt + 裸工具名折叠为工具规划） */
  layoutVersion?: number
  /** 快照创建时间（毫秒时间戳）；旧版缺失时视为过期 */
  createdAt?: number
  /** feature profile/signature used when the prompt was assembled */
  featureSignature?: string
  /** Stable system prompt base used for Langfuse Prompt Management. */
  promptManagementPrompt?: string
  docIds: string[]
  /** 兼容旧快照：缺失时按空数组处理 */
  cardIds?: string[]
  interventionCatalogGroups: InterventionCatalogGroup[]
  /** Langfuse Prompt Management 中对应的 system prompt 版本。 */
  langfusePrompt?: LangfusePromptRef | null
  /** system prompt 中可跨用户复用的静态前缀长度，用于百炼显式 Context Cache marker。 */
  staticPrefixLength?: number
  /** 用户相关动态上下文；只在新建/重建 prompt 快照的当前 user reminder 中注入一次 */
  dynamicPromptReminder?: string
  /** Cx Agent long-term memory second system message. */
  userProfileSystemPrompt?: string
}

interface StoredPromptSnapshotEntry {
  prompt: string
  meta: StoredPromptSnapshotMeta
}

export interface SessionPromptSnapshot {
  prompt: string
  promptManagementPrompt?: string
  createdAt: number
  docIds: string[]
  cardIds: string[]
  interventionCatalogGroups: InterventionCatalogGroup[]
  interventionCodeMap: Map<string, InterventionCatalogCodeEntry>
  featureSignature?: string
  langfusePrompt?: LangfusePromptRef | null
  staticPrefixLength?: number
  dynamicPromptReminder?: string
  userProfileSystemPrompt?: string | null
}

export interface SessionPromptSnapshotInput {
  prompt: string
  promptManagementPrompt?: string
  createdAt?: number
  featureSignature?: string
  docIds: string[]
  cardIds: string[]
  interventionCatalogGroups: InterventionCatalogGroup[]
  langfusePrompt?: LangfusePromptRef | null
  staticPrefixLength?: number
  dynamicPromptReminder?: string
  userProfileSystemPrompt?: string | null
}

export interface SessionPromptSnapshotLookup {
  snapshot: SessionPromptSnapshot | null
  /** DB/Redis 曾有快照但已超过热窗口或缺少 createdAt，被故意丢弃 */
  expired: boolean
  /** DB/Redis 曾有快照但 feature profile 已变化，被故意丢弃 */
  featureMismatch?: boolean
}

function keyOf(sessionId: string): string {
  return `${PREFIX}${sessionId}`
}

function isCatalogGroup(value: unknown): value is InterventionCatalogGroup {
  if (!value || typeof value !== 'object') return false
  const group = value as Record<string, unknown>
  return typeof group.sideEffect === 'string'
    && Array.isArray(group.items)
    && group.items.every((item) => {
      if (!item || typeof item !== 'object') return false
      const entry = item as Record<string, unknown>
      return typeof entry.code === 'string'
        && typeof entry.materialId === 'string'
        && typeof entry.version === 'string'
        && typeof entry.sideEffect === 'string'
        && typeof entry.scene === 'string'
        && typeof entry.actionName === 'string'
    })
}

function buildInterventionCodeMap(
  groups: InterventionCatalogGroup[],
): Map<string, InterventionCatalogCodeEntry> {
  const map = new Map<string, InterventionCatalogCodeEntry>()
  for (const group of groups) {
    for (const item of group.items) {
      map.set(item.code, item)
    }
  }
  return map
}

export function isPromptSnapshotMetaFresh(
  meta: { createdAt?: number } | null | undefined,
  now = Date.now(),
): boolean {
  return typeof meta?.createdAt === 'number' && now - meta.createdAt <= SNAPSHOT_TTL_MS
}

export function isPromptSnapshotFeatureSignatureCompatible(
  meta: { featureSignature?: string } | null | undefined,
  expectedFeatureSignature?: string,
): boolean {
  return expectedFeatureSignature === undefined ||
    meta?.featureSignature === expectedFeatureSignature
}

function normalizeSnapshot(
  entry: StoredPromptSnapshotEntry | null,
  now = Date.now(),
  expectedFeatureSignature?: string,
): SessionPromptSnapshotLookup {
  if (!entry || typeof entry.prompt !== 'string') return { snapshot: null, expired: false }
  if (entry.meta?.layoutVersion !== PROMPT_LAYOUT_VERSION) {
    return { snapshot: null, expired: true }
  }
  if (!isPromptSnapshotMetaFresh(entry.meta, now)) {
    return { snapshot: null, expired: true }
  }
  if (!isPromptSnapshotFeatureSignatureCompatible(entry.meta, expectedFeatureSignature)) {
    return { snapshot: null, expired: false, featureMismatch: true }
  }
  const createdAt = entry.meta.createdAt as number
  const docIds = Array.isArray(entry.meta?.docIds)
    ? entry.meta.docIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
    : []
  const cardIds = Array.isArray(entry.meta?.cardIds)
    ? entry.meta.cardIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
    : []
  const interventionCatalogGroups = Array.isArray(entry.meta?.interventionCatalogGroups)
    ? entry.meta.interventionCatalogGroups.filter(isCatalogGroup)
    : []

  if (
    !Array.isArray(entry.meta?.docIds)
    || !Array.isArray(entry.meta?.interventionCatalogGroups)
    || interventionCatalogGroups.length !== entry.meta.interventionCatalogGroups.length
  ) {
    return { snapshot: null, expired: false }
  }

  return {
    snapshot: {
      prompt: entry.prompt,
      promptManagementPrompt: typeof entry.meta.promptManagementPrompt === 'string'
        ? entry.meta.promptManagementPrompt
        : undefined,
      createdAt,
      docIds,
      cardIds,
      interventionCatalogGroups,
      interventionCodeMap: buildInterventionCodeMap(interventionCatalogGroups),
      featureSignature: entry.meta.featureSignature,
      langfusePrompt: entry.meta.langfusePrompt ?? null,
      staticPrefixLength: entry.meta.staticPrefixLength,
      dynamicPromptReminder: typeof entry.meta.dynamicPromptReminder === 'string'
        ? entry.meta.dynamicPromptReminder
        : '',
      userProfileSystemPrompt: typeof entry.meta.userProfileSystemPrompt === 'string'
        ? entry.meta.userProfileSystemPrompt
        : null,
    },
    expired: false,
  }
}

function parseRedisEntry(
  raw: string,
  expectedFeatureSignature?: string,
): SessionPromptSnapshotLookup {
  try {
    const parsed = JSON.parse(raw) as StoredPromptSnapshotEntry
    return normalizeSnapshot(parsed, Date.now(), expectedFeatureSignature)
  } catch {
    return { snapshot: null, expired: false }
  }
}

export function buildPromptDocIdMap(docIds: string[]): Map<string, string> {
  const map = new Map<string, string>()
  docIds.forEach((id, idx) => {
    if (typeof id === 'string' && id.length > 0) map.set(`d-${idx + 1}`, id)
  })
  return map
}

export function buildPromptCommunicationCardIdMap(cardIds: string[]): Map<string, string> {
  const map = new Map<string, string>()
  cardIds.forEach((id, idx) => {
    if (typeof id === 'string' && id.length > 0) map.set(`c-${idx + 1}`, id)
  })
  return map
}

async function readPromptSnapshotFromDb(
  sessionId: string,
  expectedFeatureSignature?: string,
): Promise<SessionPromptSnapshotLookup> {
  const db = getDb()
  const row = await db.query.chatSessions.findFirst({
    where: eq(chatSessions.id, sessionId),
    columns: {
      promptSnapshot: true,
      promptSnapshotMeta: true,
    },
  })

  if (!row?.promptSnapshot || !row.promptSnapshotMeta) {
    return { snapshot: null, expired: false }
  }

  return normalizeSnapshot({
    prompt: row.promptSnapshot,
    meta: row.promptSnapshotMeta as StoredPromptSnapshotMeta,
  }, Date.now(), expectedFeatureSignature)
}

async function writePromptSnapshotToDb(
  sessionId: string,
  snapshot: SessionPromptSnapshotInput,
): Promise<void> {
  const db = getDb()
  await db.update(chatSessions)
    .set({
      promptSnapshot: snapshot.prompt,
      promptSnapshotMeta: {
        layoutVersion: PROMPT_LAYOUT_VERSION,
        createdAt: snapshot.createdAt ?? Date.now(),
        featureSignature: snapshot.featureSignature,
        promptManagementPrompt: snapshot.promptManagementPrompt,
        docIds: snapshot.docIds,
        cardIds: snapshot.cardIds,
        interventionCatalogGroups: snapshot.interventionCatalogGroups,
        langfusePrompt: snapshot.langfusePrompt ?? null,
        staticPrefixLength: snapshot.staticPrefixLength,
        dynamicPromptReminder: snapshot.dynamicPromptReminder ?? '',
        userProfileSystemPrompt: snapshot.userProfileSystemPrompt ?? '',
      },
    })
    .where(eq(chatSessions.id, sessionId))
}

async function clearPromptSnapshotInDb(sessionId: string): Promise<void> {
  const db = getDb()
  await db.update(chatSessions)
    .set({
      promptSnapshot: null,
      promptSnapshotMeta: null,
    })
    .where(eq(chatSessions.id, sessionId))
}

async function writePromptSnapshotToRedis(
  sessionId: string,
  snapshot: SessionPromptSnapshotInput,
): Promise<void> {
  const payload: StoredPromptSnapshotEntry = {
    prompt: snapshot.prompt,
    meta: {
      layoutVersion: PROMPT_LAYOUT_VERSION,
      createdAt: snapshot.createdAt ?? Date.now(),
      featureSignature: snapshot.featureSignature,
      promptManagementPrompt: snapshot.promptManagementPrompt,
      docIds: snapshot.docIds,
      cardIds: snapshot.cardIds,
      interventionCatalogGroups: snapshot.interventionCatalogGroups,
      langfusePrompt: snapshot.langfusePrompt ?? null,
      staticPrefixLength: snapshot.staticPrefixLength,
      dynamicPromptReminder: snapshot.dynamicPromptReminder ?? '',
      userProfileSystemPrompt: snapshot.userProfileSystemPrompt ?? '',
    },
  }
  await getKV().set(keyOf(sessionId), JSON.stringify(payload), TTL_SECONDS)
}

export async function getSessionPromptSnapshotLookup(
  sessionId: string,
  logger: Logger,
  opts: { featureSignature?: string } = {},
): Promise<SessionPromptSnapshotLookup> {
  let expired = false
  let featureMismatch = false

  try {
    const raw = await getKV().get(keyOf(sessionId))
    if (raw) {
      const cached = parseRedisEntry(raw, opts.featureSignature)
      if (cached.snapshot) {
        logger.debug({ sessionId, promptLength: cached.snapshot.prompt.length }, 'prompt cache hit')
        return cached
      }
      expired = expired || cached.expired
      featureMismatch = featureMismatch || !!cached.featureMismatch
      if (cached.expired) {
        logger.info({ sessionId }, 'expired prompt cache entry ignored')
      } else if (cached.featureMismatch) {
        logger.info({ sessionId }, 'feature-mismatched prompt cache entry ignored')
      } else {
        logger.info({ sessionId }, 'legacy/invalid prompt cache entry ignored')
      }
    }
  } catch (err: any) {
    logger.warn({ sessionId, err: err.message }, 'prompt cache get failed')
  }

  try {
    const result = await readPromptSnapshotFromDb(sessionId, opts.featureSignature)
    expired = expired || result.expired
    featureMismatch = featureMismatch || !!result.featureMismatch
    const snapshot = result.snapshot
    if (!snapshot) return { snapshot: null, expired, featureMismatch }

    await writePromptSnapshotToRedis(sessionId, snapshot).catch(() => {})
    logger.debug(
      { sessionId, promptLength: snapshot.prompt.length },
      'prompt snapshot restored from DB',
    )
    return { snapshot, expired: false }
  } catch (err: any) {
    logger.warn({ sessionId, err: err.message }, 'prompt snapshot DB get failed')
    return { snapshot: null, expired, featureMismatch }
  }
}

export async function getSessionPromptSnapshot(
  sessionId: string,
  logger: Logger,
  opts: { featureSignature?: string } = {},
): Promise<SessionPromptSnapshot | null> {
  return (await getSessionPromptSnapshotLookup(sessionId, logger, opts)).snapshot
}

export async function setSessionPromptSnapshot(
  sessionId: string,
  snapshot: SessionPromptSnapshotInput,
  logger: Logger,
): Promise<void> {
  const snapshotWithCreatedAt: SessionPromptSnapshotInput = {
    ...snapshot,
    createdAt: snapshot.createdAt ?? Date.now(),
  }
  try {
    await writePromptSnapshotToDb(sessionId, snapshotWithCreatedAt)
    logger.debug({
      sessionId,
      promptLength: snapshotWithCreatedAt.prompt.length,
      docCount: snapshotWithCreatedAt.docIds.length,
      communicationCardCount: snapshotWithCreatedAt.cardIds.length,
      interventionGroupCount: snapshotWithCreatedAt.interventionCatalogGroups.length,
      featureSignature: snapshotWithCreatedAt.featureSignature,
    }, 'prompt snapshot persisted')
  } catch (err: any) {
    logger.warn({ sessionId, err: err.message }, 'prompt snapshot DB set failed')
    throw err
  }

  try {
    await writePromptSnapshotToRedis(sessionId, snapshotWithCreatedAt)
  } catch (err: any) {
    logger.warn({ sessionId, err: err.message }, 'prompt cache set failed')
  }
}

export async function invalidateSessionPrompt(
  sessionId: string,
  logger: Logger,
): Promise<void> {
  try {
    await clearPromptSnapshotInDb(sessionId)
    logger.info({ sessionId }, 'prompt snapshot invalidated')
  } catch (err: any) {
    logger.warn({ sessionId, err: err.message }, 'prompt snapshot DB del failed')
    throw err
  }

  try {
    await getKV().del(keyOf(sessionId))
  } catch (err: any) {
    logger.warn({ sessionId, err: err.message }, 'prompt cache del failed')
  }
}

export async function invalidateUserPromptSnapshots(
  userId: string,
  logger: Logger,
): Promise<string[]> {
  const db = getDb()
  const rows = await db
    .select({ id: chatSessions.id })
    .from(chatSessions)
    .where(eq(chatSessions.userId, userId))
  const sessionIds = rows.map((row) => row.id)

  if (sessionIds.length === 0) return []

  await db.update(chatSessions)
    .set({
      promptSnapshot: null,
      promptSnapshotMeta: null,
    })
    .where(eq(chatSessions.userId, userId))

  await Promise.all(
    sessionIds.map(async (sessionId) => {
      try {
        await getKV().del(keyOf(sessionId))
      } catch (err: any) {
        logger.warn({ sessionId, err: err.message }, 'prompt cache del failed')
      }
    }),
  )

  logger.info({ userId, sessionCount: sessionIds.length }, 'user prompt snapshots invalidated')
  return sessionIds
}
