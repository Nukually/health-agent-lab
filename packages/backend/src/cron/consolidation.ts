/**
 * 夜间长期 Profile 合并 — 从当日用户活动生成/更新服务背景
 *
 * 输入：昨日 Profile + 最新病历快照 + 当日用户原始 prompt/上传图片 + 当日天级记忆
 *
 * 执行分两层短路：
 * 1. 外层：对比用户消息 / 天级记忆 / 病历 / 个人信息与上次 Profile 的 updatedAt，都未变 → 跳过
 * 2. 内层：LLM 自判信号不足以更新 Profile 时返回字面量 NO_UPDATE → 跳过 upsert
 *
 * 队列处理：逐用户执行，每用户间隔 2s 防止并发过大
 */

import { getModel } from '../state/process.js'
import { llmCall } from '../lib/llm.js'
import {
  getActiveUserIdsForDate,
  getDailyMemoryForDate,
  getUserImagesForDate,
  getUserPromptsForDate,
  getUserProfileMemoryRow,
  upsertUserProfileMemory,
  type DailyUserImageInput,
} from '../services/memory.js'
import { getFullProfile } from '../services/user.js'
import type { Logger } from '../lib/logger.js'
import { redactSensitiveLogText } from '../utils/log-redaction.js'
import { withCronLock } from './lock.js'

const BATCH_DELAY_MS = 2_000
const LOCK_TTL_SECONDS = 2 * 60 * 60
const NO_UPDATE_MARKER = '[skip update]'
const EPOCH = new Date(0)

type ConsolidationContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

/** 当日（Asia/Shanghai）日期字符串，YYYY-MM-DD */
function shanghaiDateStr(date: Date): string {
  return date.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' })
}

export async function runNightlyConsolidation(logger: Logger): Promise<void> {
  // 凌晨 3 点执行，合并"昨天"的活动
  const yesterday = new Date()
  yesterday.setDate(yesterday.getDate() - 1)
  const dateStr = shanghaiDateStr(yesterday)

  await withCronLock('consolidation', dateStr, LOCK_TTL_SECONDS, logger, async () => {
    await runNightlyConsolidationForDate(dateStr, logger)
  })
}

async function runNightlyConsolidationForDate(
  dateStr: string,
  logger: Logger,
): Promise<void> {
  const userIds = await getActiveUserIdsForDate(dateStr, logger)

  if (userIds.length === 0) {
    logger.info({ date: dateStr }, 'no active users to consolidate')
    return
  }

  logger.info({ date: dateStr, userCount: userIds.length }, 'starting nightly consolidation')

  const stats = {
    skippedExternal: 0,
    skippedByLLM: 0,
    updated: 0,
    errors: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
  }

  for (const userId of userIds) {
    try {
      const result = await consolidateOneUser(userId, dateStr, logger)
      if (result.kind === 'skipped_external') stats.skippedExternal++
      else if (result.kind === 'skipped_llm') stats.skippedByLLM++
      else if (result.kind === 'updated') stats.updated++
      stats.totalInputTokens += result.inputTokens ?? 0
      stats.totalOutputTokens += result.outputTokens ?? 0
    } catch (err: any) {
      stats.errors++
      logger.error({ userId, error: redactSensitiveLogText(err.message) }, 'consolidation failed for user')
    }

    // Queue delay between users（无论是否 skip）
    await new Promise((r) => setTimeout(r, BATCH_DELAY_MS))
  }

  logger.info(
    { date: dateStr, totalUsers: userIds.length, ...stats },
    'nightly consolidation completed',
  )
}

type ConsolidateResult =
  | { kind: 'skipped_external'; inputTokens?: number; outputTokens?: number }
  | { kind: 'skipped_llm'; inputTokens?: number; outputTokens?: number }
  | { kind: 'updated'; inputTokens?: number; outputTokens?: number }

/**
 * 合并单个用户长期 Profile。导出供手动测试脚本调用。
 */
export async function consolidateOneUser(
  userId: string,
  dateStr: string,
  logger: Logger,
): Promise<ConsolidateResult> {
  // 1. 读上次 Profile 时间 T_last（无则 epoch，全部信号都算"新"）
  const existing = await getUserProfileMemoryRow(userId, logger)
  const tLast = existing?.updatedAt ?? EPOCH
  const existingProfile = existing?.userMd?.trim() || existing?.content?.trim() || null

  // 2. 外层变更检测：用户消息 / 天级记忆 / 病历 / 个人信息
  const [userPromptsNew, dailyMemory, fullProfile, userImages] = await Promise.all([
    getUserPromptsForDate(userId, dateStr, logger, tLast),
    getDailyMemoryForDate(userId, dateStr, logger),
    getFullProfile(userId, logger),
    getUserImagesForDate(userId, dateStr, logger),
  ])
  const medicalRecord = fullProfile.medical
  const { updatedAt: _userUpdatedAt, ...userInfoForPrompt } = fullProfile.user

  const medicalUpdated = medicalRecord ? medicalRecord.updatedAt > tLast : false
  const userUpdated = fullProfile.user.updatedAt ? fullProfile.user.updatedAt > tLast : false
  const imageUpdated = userImages.some((image) => image.createdAt > tLast)
  const dailyMemoryUpdated =
    !!dailyMemory && (await isDailyMemoryNewerThan(userId, dateStr, tLast))

  if (!userPromptsNew && !dailyMemoryUpdated && !medicalUpdated && !userUpdated && !imageUpdated) {
    logger.info({ userId, tLast }, 'no signal changed, skip consolidation (external)')
    return { kind: 'skipped_external' }
  }

  // 3. 装 prompt（用全量当日 user prompts/images 给 LLM，不是 "新"那部分；变更检测只决定是否入场）
  const fullUserPrompts = await getUserPromptsForDate(userId, dateStr, logger)

  const { content: response, inputTokens, outputTokens } = await callConsolidationLLM({
    dateStr,
    existingProfile,
    userInfo: userInfoForPrompt,
    userPrompts: fullUserPrompts,
    userImages,
    dailyMemory: dailyMemory || null,
    medicalRecord: medicalRecord?.profileData ?? null,
    logger,
  })

  // 4. 内层短路
  const trimmed = response.trim()
  if (trimmed === NO_UPDATE_MARKER) {
    logger.info({ userId, inputTokens, outputTokens }, 'llm judged no update, skip')
    return { kind: 'skipped_llm', inputTokens, outputTokens }
  }

  const profileContent = trimmed
  if (!profileContent) throw new Error('LLM returned empty profile content for consolidation')

  // 5. 写入画像。首页推荐问题由独立 Agent 按需生成；consolidation 只维护长期画像。
  await upsertUserProfileMemory(userId, profileContent, logger)
  logger.info(
    { userId, inputTokens, outputTokens },
    'user profile consolidated',
  )

  return { kind: 'updated', inputTokens, outputTokens }
}

/** 指定日期的天级记忆 updatedAt 是否晚于 T_last */
async function isDailyMemoryNewerThan(
  userId: string,
  dateStr: string,
  tLast: Date,
): Promise<boolean> {
  const { getDb } = await import('../db/client.js')
  const { userDailyMemories } = await import('../db/schema/index.js')
  const { and, eq } = await import('drizzle-orm')
  const db = getDb()
  const row = await db.query.userDailyMemories.findFirst({
    where: and(
      eq(userDailyMemories.userId, userId),
      eq(userDailyMemories.memoryDate, dateStr),
    ),
    columns: { updatedAt: true },
  })
  return !!row && row.updatedAt > tLast
}

// ─── LLM ─────────────────────────────────────────────────────────────────────

async function callConsolidationLLM(params: {
  dateStr: string
  existingProfile: string | null
  userInfo: unknown
  userPrompts: string
  userImages: DailyUserImageInput[]
  dailyMemory: string | null
  medicalRecord: unknown
  logger: Logger
}): Promise<{ content: string; inputTokens?: number; outputTokens?: number }> {
  const model = getModel()

  const response = await llmCall(
    {
      model,
      messages: [
        { role: 'system', content: buildSystemPrompt() },
        { role: 'user', content: buildUserContent(params) },
      ],
      max_tokens: 4000,
      temperature: 0.3,
    },
    params.logger,
    { forceBackup: true },
  )

  const content = response.choices[0]?.message?.content
  if (!content) {
    throw new Error('LLM returned empty response for consolidation')
  }

  return {
    content,
    inputTokens: response.usage?.prompt_tokens,
    outputTokens: response.usage?.completion_tokens,
  }
}

function buildSystemPrompt(): string {
  return `你是乳腺健康长期 Profile 整理助手。Profile 用于让助手理解用户的服务偏好与长期背景，不是病历事实源。只记录事实性观察，不做诊断、不做建议、不做风险提示。

输入可能同时包含文字和用户上传图片。图片可能是病历/检查报告/检验单/处方/用药盒/药品说明书/当前症状照片；图片中清晰可见的信息只能作为判断用户长期关注点、体验和沟通偏好的信号。不要把图片中的分型、分期、数值、用药、治疗阶段写成 Profile 的权威医学事实；这些事实以病历档案为准。只能记录图片中明确可见的信息，不要根据模糊区域、常识或药盒外观推断诊断、疗效或风险。

输出规则（二选一，严格遵守）：
A. 若今日信号不足以让 Profile 发生"实质性"变化 —— 包括但不限于：用户只说了问候语/无关话题、无新事实、今日内容可被昨日 Profile 完全覆盖 —— 则**只输出一行字面量**，不要重新复述昨日 Profile：
[skip update]

B. 否则输出完整的 Profile Markdown，不带任何解释性前后缀、不带代码块围栏。

首页推荐问题约束：
- 不要生成首页推荐问题。
- 不要输出 <recommended_question_candidates> 或任何类似候选块。
- 首页推荐问题由独立推荐 Agent 处理；本任务只整理 Profile，不输出候选问题。

关键约束：
- 输出 A 时整条响应必须精确等于 "[skip update]"（含中括号），前后不得有任何其他字符、空行、标点或解释
- 禁止"虽然没有新变化，但为了完整性我仍输出一遍 Profile"这类行为 —— 无变化直接走 A，有变化才走 B
- 不要把 B 的 Profile 和 A 的标记同时输出`
}

function buildUserContent(params: {
  dateStr: string
  existingProfile: string | null
  userInfo: unknown
  userPrompts: string
  userImages: DailyUserImageInput[]
  dailyMemory: string | null
  medicalRecord: unknown
}): string | ConsolidationContentBlock[] {
  const text = buildUserPrompt(params)
  if (params.userImages.length === 0) return text

  const blocks: ConsolidationContentBlock[] = [{ type: 'text', text }]
  params.userImages.forEach((image, idx) => {
    blocks.push({
      type: 'text',
      text: `\n\n[图片 ${idx + 1}] ${image.label}`,
    })
    blocks.push({
      type: 'image_url',
      image_url: { url: image.url },
    })
  })
  return blocks
}

function buildUserPrompt(params: {
  dateStr: string
  existingProfile: string | null
  userInfo: unknown
  userPrompts: string
  userImages: DailyUserImageInput[]
  dailyMemory: string | null
  medicalRecord: unknown
}): string {
  const parts: string[] = []

  parts.push(`今日日期：${params.dateStr}`)

  if (params.existingProfile) {
    parts.push(`\n## 昨日 Profile\n${params.existingProfile}`)
  } else {
    parts.push(
      `\n## Profile 状态：首次生成\n本用户尚无历史 Profile。请根据下方信号必须输出完整 Profile（走 B 分支），禁止输出 [skip update]。`,
    )
  }

  parts.push(
    `\n## 最新个人信息\n${
      params.userInfo ? JSON.stringify(params.userInfo, null, 2) : '（无）'
    }`,
  )

  parts.push(
    `\n## 最新病历快照\n${
      params.medicalRecord ? JSON.stringify(params.medicalRecord, null, 2) : '（无）'
    }`,
  )

  parts.push(
    `\n## 今日用户原始提问\n${params.userPrompts || '（无）'}`,
  )

  parts.push(
    `\n## 今日用户上传图片\n${
      params.userImages.length
        ? params.userImages.map((image, idx) => `- 图片 ${idx + 1}: ${image.label}`).join('\n')
        : '（无）'
    }\n\n随附图片会作为本条 user message 的 image_url blocks 追加在下方。请把图片中清晰可见的信息用于判断用户长期关注点、体验和沟通偏好；不要把病历、检查、处方、药盒/说明书里的医学事实原样写进 Profile。`,
  )

  parts.push(
    `\n## 今日天级记忆摘录\n${params.dailyMemory ?? '（无）'}`,
  )

  parts.push(`
---

请按以下维度生成/更新长期 Profile。严格遵守规则：
1. 只写观察到的事实；禁止出现"建议""需注意""应当""风险信号""⚠"等判断/告诫性词汇
2. 时间一律用 YYYY-MM-DD 绝对日期；禁止"近期""明天""昨天""今日""本周"等相对表述
3. 空维度/空字段直接省略整行，不要写"暂无数据"也不要保留空表格行
4. 保留昨日 Profile 中仍成立的长期背景；今日有新事实与昨日冲突时，以今日为准
5. 若昨日 Profile 与【最新个人信息】或【最新病历快照】冲突，以最新个人信息/病历快照为准；不要把旧 Profile 里的结构化字段继续写成当前事实
6. 病历分型、治疗阶段、用药、检查数值等医学事实以病历档案为准；本任务只保留服务时长期有用的偏好、体验、情绪模式、生活影响和照护背景
7. 输出纯 Markdown，使用二级/三级标题，不要代码块围栏

### 沟通偏好
- 信息详细度偏好
- 称呼与语气偏好
- 敏感话题

### 治疗体验与生活影响
- 长期困扰的副作用或症状体验
- 作息、饮食、运动、工作生活影响

### 情绪与复查模式
- 整体情绪状态
- 焦虑触发点与反复关注的问题

### 家属与照护
- 家庭支持情况
- 病友交流情况

### AI 观察
- 对话模式
- 关注重点
- 需要避免的表达方式`)

  return parts.join('\n')
}
