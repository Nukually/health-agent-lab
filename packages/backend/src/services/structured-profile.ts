/**
 * 个性化结构化档案抽取 —— 每晚基于用户当日原始消息/上传图片生成一份**数值/布尔**档案
 *
 * 核心诉求：
 * - 只记录可量化的数值（体重/血压/疼痛分/用药剂量/睡眠时长…）和可观测的布尔（是否恶心/是否服药）
 * - **不**记录流水账、原话、偏好、性格描述（这些由 cron/consolidation 的画像合并任务负责）
 * - 字段因人而异，不预设全局 schema；前一天的字段作为次日 schema 约束（允许加，不删）
 * - 当日未提及的历史字段置 null
 * - 今日文字和图片都没有可记录的数值/布尔事实 → LLM 输出 [nothing_to_record] 字面量，跳过 upsert
 * - JSON 解析失败最多重试 3 次，失败则不写库
 * - 固定走 backup 通道（Moonshot Kimi），不占用 primary
 */

import { and, desc, eq, gte, sql } from 'drizzle-orm'
import { getDb } from '../db/client.js'
import { userDailyStructuredProfiles } from '../db/schema/index.js'
import { getModel, getBackupModel } from '../state/process.js'
import { llmCall } from '../lib/llm.js'
import {
  getUserPromptsForDate,
  getUserImagesForDate,
  type DailyUserImageInput,
} from './memory.js'
import { stripSystemReminderText } from '../utils/system-reminder.js'
import type { Logger } from '../lib/logger.js'
import { redactSensitiveLogText } from '../utils/log-redaction.js'

const MAX_JSON_RETRIES = 3
const SCHEMA_FIELD_WARN_THRESHOLD = 40
const NO_RECORD_MARKER = '[nothing_to_record]'

export interface StructuredProfileSnapshot {
  profileDate: string
  fields: Record<string, unknown>
  schemaFields: string[]
}

type StructuredProfileContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export type ExtractResult =
  | { kind: 'skipped_no_input' }
  | { kind: 'skipped_no_signal'; inputTokens?: number; outputTokens?: number }
  | { kind: 'updated'; attempts: number; inputTokens?: number; outputTokens?: number }
  | { kind: 'failed'; attempts: number; lastError: string }

/** 读最近一份快照（不限日期），作为次日抽取的 schema 约束基线 */
export async function getLatestStructuredProfile(
  userId: string,
): Promise<StructuredProfileSnapshot | null> {
  const db = getDb()
  const row = await db.query.userDailyStructuredProfiles.findFirst({
    where: eq(userDailyStructuredProfiles.userId, userId),
    orderBy: desc(userDailyStructuredProfiles.profileDate),
    columns: { profileDate: true, fields: true, schemaFields: true },
  })
  if (!row) return null
  return {
    profileDate: row.profileDate as unknown as string,
    fields: (row.fields ?? {}) as Record<string, unknown>,
    schemaFields: row.schemaFields ?? [],
  }
}

/** 取用户近 N 天的快照，升序（老→新）返回，给 prompt trend section 用 */
export async function getRecentStructuredProfiles(
  userId: string,
  days: number,
): Promise<StructuredProfileSnapshot[]> {
  const db = getDb()
  const since = new Date()
  since.setDate(since.getDate() - (days - 1))
  const sinceDateStr = since.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' })

  const rows = await db
    .select({
      profileDate: userDailyStructuredProfiles.profileDate,
      fields: userDailyStructuredProfiles.fields,
      schemaFields: userDailyStructuredProfiles.schemaFields,
    })
    .from(userDailyStructuredProfiles)
    .where(
      and(
        eq(userDailyStructuredProfiles.userId, userId),
        gte(userDailyStructuredProfiles.profileDate, sinceDateStr),
      ),
    )
    .orderBy(userDailyStructuredProfiles.profileDate)

  return rows.map((r) => ({
    profileDate: r.profileDate as unknown as string,
    fields: (r.fields ?? {}) as Record<string, unknown>,
    schemaFields: r.schemaFields ?? [],
  }))
}

/** upsert 一天的快照，冲突时按 user_id+profile_date 更新 */
export async function upsertDailyStructuredProfile(params: {
  userId: string
  profileDate: string
  fields: Record<string, unknown>
  schemaFields: string[]
  modelUsed: string
  attempts: number
  logger: Logger
}): Promise<void> {
  const db = getDb()
  await db
    .insert(userDailyStructuredProfiles)
    .values({
      userId: params.userId,
      profileDate: params.profileDate,
      fields: params.fields,
      schemaFields: params.schemaFields,
      modelUsed: params.modelUsed,
      attempts: params.attempts,
    })
    .onConflictDoUpdate({
      target: [userDailyStructuredProfiles.userId, userDailyStructuredProfiles.profileDate],
      set: {
        fields: params.fields,
        schemaFields: params.schemaFields,
        modelUsed: params.modelUsed,
        attempts: params.attempts,
        updatedAt: sql`now()`,
      },
    })
  params.logger.info(
    {
      userId: params.userId,
      profileDate: params.profileDate,
      fieldCount: params.schemaFields.length,
      attempts: params.attempts,
    },
    'structured profile upserted',
  )
}

/** 核心：单用户单日抽取 */
export async function extractDailyStructuredProfile(
  userId: string,
  dateStr: string,
  logger: Logger,
): Promise<ExtractResult> {
  // 1. 输入：当日全部 user messages 文本 + 用户上传/病历上传图片
  const [rawPrompts, imageInputs] = await Promise.all([
    getUserPromptsForDate(userId, dateStr, logger),
    getUserImagesForDate(userId, dateStr, logger),
  ])
  const userPrompts = rawPrompts ? stripSystemReminderText(rawPrompts) : ''
  if (!userPrompts.trim() && imageInputs.length === 0) {
    return { kind: 'skipped_no_input' }
  }

  // 2. 基线：最近一份快照的字段集
  const latest = await getLatestStructuredProfile(userId)
  const prevFields = latest?.fields ?? {}
  const prevSchemaFields = latest?.schemaFields ?? []

  // 3. 构造 prompts
  const systemPrompt = buildExtractionSystemPrompt()
  const userPromptContent = buildExtractionUserContent({
    dateStr,
    prevFields,
    userPrompts,
    imageInputs,
  })

  const messages: Array<{ role: 'system' | 'user'; content: string | StructuredProfileContentBlock[] }> = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPromptContent },
  ]

  // 4. LLM 抽取：先识别 [nothing_to_record] 字面量短路；否则按 JSON 解析（最多重试 3 次）
  // 注意：不开启 response_format=json_object，否则 A 分支的 marker 会被强制裹成 JSON。
  let attempts = 0
  let lastError = ''
  let parsed: Record<string, unknown> | null = null
  let tokensIn: number | undefined
  let tokensOut: number | undefined

  while (attempts < MAX_JSON_RETRIES) {
    attempts++
    try {
      const response = await llmCall(
        {
          model: getModel(),
          messages,
          max_tokens: 2000,
          temperature: 0.2,
          // 结构化抽取无需 thinking：完全按 schema + 输出规则回答即可，
          // 关掉后能省 1-2k thinking token、降首字延时，且避免 thinking 把 max_tokens 吃光导致 JSON 截断。
          // lib/llm.ts 会把它翻译成 Moonshot 的 thinking:{type:'disabled'} 并自动把 temperature 钳到 0.6。
          enable_thinking: false,
        },
        logger,
        { forceBackup: true },
      )
      tokensIn = response.usage?.prompt_tokens
      tokensOut = response.usage?.completion_tokens
      const content = response.choices[0]?.message?.content ?? ''
      const trimmed = content.trim()

      if (trimmed === NO_RECORD_MARKER) {
        logger.info(
          { userId, attempt: attempts, inputTokens: tokensIn, outputTokens: tokensOut },
          'llm judged no numeric/boolean signal today, skip',
        )
        return { kind: 'skipped_no_signal', inputTokens: tokensIn, outputTokens: tokensOut }
      }

      try {
        const obj = JSON.parse(trimmed)
        if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
          parsed = obj as Record<string, unknown>
          break
        }
        lastError = 'response is not a JSON object'
      } catch (err: any) {
        lastError = `JSON.parse failed: ${err.message}`
      }

      logger.warn(
        { userId, attempt: attempts, lastError, contentPreview: content.slice(0, 200) },
        'structured profile extract JSON invalid, retrying',
      )
      messages.push({
        role: 'user',
        content: `上次输出解析失败：${lastError}。请严格按 system 规则输出：要么 JSON 对象，要么单独一行 ${NO_RECORD_MARKER}，不要任何其他字符。`,
      })
    } catch (err: any) {
      lastError = `LLM call failed: ${err.message}`
      logger.error(
        { userId, attempt: attempts, error: redactSensitiveLogText(err.message) },
        'LLM call errored during extract',
      )
    }
  }

  if (!parsed) {
    return { kind: 'failed', attempts, lastError }
  }

  // 5. 合并 schema：历史字段必须保留（缺失则置 null）；新字段合并进并集
  // 新字段若 sanitize 后为 null 且原值不是 null（即被违规类型挡掉），不计入 schemaFields，
  // 避免 LLM 偶尔输出 string 字段时往表里塞一列永远为 null 的脏字段。
  const merged: Record<string, unknown> = {}
  const mergedSchemaSet = new Set<string>(prevSchemaFields)

  for (const key of prevSchemaFields) {
    merged[key] = key in parsed ? sanitizeValue(parsed[key]) : null
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (!isValidFieldKey(key)) continue
    if (mergedSchemaSet.has(key)) continue // 已是历史字段，上一段已处理
    const cleaned = sanitizeValue(value)
    if (cleaned === null && value !== null) continue // 违规类型被剥成 null，不污染 schema
    mergedSchemaSet.add(key)
    merged[key] = cleaned
  }

  const mergedSchemaFields = Array.from(mergedSchemaSet)
  if (mergedSchemaFields.length > SCHEMA_FIELD_WARN_THRESHOLD) {
    logger.warn(
      { userId, fieldCount: mergedSchemaFields.length },
      'structured profile schema growing large',
    )
  }

  await upsertDailyStructuredProfile({
    userId,
    profileDate: dateStr,
    fields: merged,
    schemaFields: mergedSchemaFields,
    modelUsed: getBackupModel(),
    attempts,
    logger,
  })

  return { kind: 'updated', attempts, inputTokens: tokensIn, outputTokens: tokensOut }
}

// ─── Prompt 构造 ───────────────────────────────────────────────────────────────

function buildExtractionSystemPrompt(): string {
  return `你是乳腺癌患者治疗管理**数值化**档案抽取助手。任务：从今日用户原始消息与用户上传图片中抽取**可量化的数值与可观测的布尔事实**。
本任务**不**负责记录偏好、性格、流水账、原话引用、文本类描述 —— 这些由另一个画像合并任务负责，与本任务严格分工。

图片处理规则：
- 用户上传图片视为用户提供的信息，图片可能是病历/检查报告/检验单/处方/用药盒/药品说明书/当前症状照片。
- 必须阅读图片中清晰可见的文字、数值、勾选项和药品名称；图片里的客观事实与用户文字同等重要。
- 只能抽取图片中明确可见的信息，不要根据图片模糊区域、常识或药盒外观猜测剂量/诊断/风险。
- 图片中的日期、医院、标题等文本元数据不要作为字段值；只有相对时长、周期数、检验数值、症状是否出现、是否正在/曾经使用某药等可量化/布尔事实可入表。

输出规则（二选一，严格遵守）：

A. 若今日文字和图片中**没有任何可量化的数值或可观测的布尔事实** —— 包括但不限于：用户只在闲聊、问问题、咨询用药、表达情绪、抱怨、转述他人观点、请求生成卡片，且图片也没有清晰可读的医疗/用药事实 —— 则**整条响应只输出一行字面量**，不要任何其他字符：
${NO_RECORD_MARKER}

B. 否则输出一个 JSON 对象，遵守以下硬性约束：

字段值类型（只允许这三种）：
- number：如 60.5, 120, 2
- boolean：true / false（不要写 1/0 或 "true"）
- null：表示历史 schema 字段今日未提及

明确禁止：字符串、数组、嵌套对象、日期字符串、自由文本。任何字段值是 string 一律视为违规。

字段命名（snake_case，名称需自带语义/单位）：
- 数值类：在名称中体现单位 —— weight_kg / blood_pressure_systolic_mmhg / pain_score_0_10 / medication_dose_mg / sleep_hours / exercise_min / heart_rate_bpm / medication_frequency_per_day
- 布尔类：用 symptom_xxx / medication_xxx / activity_xxx 前缀 —— symptom_nausea / symptom_vomiting / medication_tamoxifen / activity_exercise_today

**字段复用第一原则**（重要）：

1. 必须保留所有历史字段（见下方 Schema 约束）；今日未提及的历史字段值置 null。

2. **优先从历史 schema 里找匹配字段复用，禁止改名**。今日的事实如果能用现有字段表达，**必须沿用原名**，哪怕你觉得换个写法更顺眼。常见反例（**严禁**这样做）：
   - 历史已有 \`medication_goserelin_missed\`，今日还是漏打 → 直接 \`medication_goserelin_missed: true\`，**不要**新建 \`medication_goserelin_missed_dose\`
   - 历史已有 \`symptom_morning_finger_stiffness\`，今日还是晨僵 → 复用，**不要**写成 \`symptom_finger_stiffness_morning\`（仅 token 顺序不同视为同一字段）
   - 历史已有 \`medication_letrozole_duration_months\`，今日继续吃 → 更新该字段的数值，**不要**新建 \`medication_letrozole_months\`
   - 历史已有 \`symptom_hand_fist_discomfort\`，今日还是握拳不适 → 复用，**不要**写 \`symptom_fist_discomfort\` / \`symptom_hand_discomfort_fist\` 等变体

3. 只有当今日出现的事实**无法用任何现有字段表达**时，才能新增字段。新增前先反问："历史 schema 里真的没有任何字段能承载这个事实吗？" 不确定时一律倾向复用。

4. 允许新增的字段必须同时满足：
- 可重复观测（明天后天都可能再出现）
- 跨日有趋势意义（数值能画曲线，bool 能统计频次）
- 治疗管理相关
- 命名遵守前文 snake_case 规范

绝对禁止新增的字段类型：
- 任何字符串字段（record_date / user_message / inquiry_type / 任何文本字段）
- 一次性事件描述（"今天去了外滩"、"本周计划爬山"）
- 偏好/性格/性情判断（preference_xxx / mood_text / communication_style）
- 诊断/建议/风险类（risk_level / should_see_doctor / suggestion）
- 把用户原话直接当字段值

**反"无聊数据"硬约束**（违反任意一条 = 字段必须丢弃）：

R1. 用户行为型动词一律不抽。以下后缀/语义都不是医疗事实，是"用户讨论了什么"：
   - \`*_inquiry\` / \`*_inquired\` / \`*_asked\` / \`*_mentioned\`
   - \`*_considered\` / \`*_discussed\` / \`*_planned\` / \`*_intends_to_*\`
   - 反例：\`medication_ibuprofen_inquiry: true\`（用户问了布洛芬）→ 丢
   - 反例：\`medication_tamoxifen_considered: true\`（讨论过他莫昔芬）→ 丢
   只抽客观状态："正在吃 / 已停 / 持续 N 月 / 出现症状"。
   例外说明：如果用户上传的处方/药盒/用药清单图片明确显示某药正在使用，可抽 \`medication_xxx: true\`；这不是"用户问了药"，而是图片中的客观用药事实。

R2. 字段名复合度 ≤ 4 个语义段。超过即说明字段过度场景化、不可重复观测：
   - OK：\`medication_letrozole_duration_months\`（4 段：medication / letrozole / duration / months）
   - OK：\`symptom_morning_finger_stiffness\`（4 段）
   - 丢：\`chemotherapy_cycles_5_6_impact_daily_activities\`（7 段，把单次对话情景字段化）
   - 丢：\`symptom_morning_finger_stiffness_severity_index_finger\`（>4 段）
   超长字段名 = 强行相关数据，宁可不抽。

R3. 严禁用 boolean 表达"程度 / 部位 / 严重度 / 频次"：
   - 丢：\`symptom_X_severity_index_finger: true\` —— "严重度"为 true 等于没信息
   - 丢：\`symptom_X_left: true\` + \`symptom_X_right: true\` —— 部位拆 boolean
   - 替换方案：要么用 0-10 数值字段（\`pain_score_0_10\`），要么只保留一个总开关 boolean（\`symptom_joint_pain: true\`），细化部位/程度交给非结构化画像
   - 频次同理：用 \`*_per_day\` / \`*_per_week\` 数值字段，不要 \`*_frequent: true\`

R4. 不抽日期字段，不论拆几段。日期归非结构化画像负责：
   - 丢：\`surgery_date_year / surgery_date_month / surgery_date_day\` —— 用 number 拆日期是绕过"禁字符串"的反模式
   - 丢：\`medication_neratinib_start_year/month/day\`
   - 唯一允许的"时间类数值"：相对时长（\`*_duration_months\` / \`*_cycles_completed\` / \`*_total_fractions\`），它们有趋势意义

R5. 包含/层级关系去重——同一事实只保留最宽那个字段：
   - 历史已有 \`symptom_joint_discomfort\`，今日是握拳不适 → 直接复用前者，**不要**同时再写 \`symptom_hand_finger_joint_discomfort\`
   - 通用规则：若两个 boolean 字段中一个是另一个的细化（部位/程度/触发条件），只保留更宽那个
   - 细化粒度需要时，必须落到 number（数值）或独立的客观枚举字段，不能也是 boolean

关键约束：
- 走 A 时整条响应必须**精确等于** "${NO_RECORD_MARKER}"，前后不得有任何字符、空行、解释、代码块围栏
- 不要把 A 和 B 混合输出
- 走 B 时不能输出代码块围栏；输出必须能被 JSON.parse 直接解析
- 用户没主动陈述的事实，不要从历史快照里"补"出值；保留 null 即可`
}

function buildExtractionUserContent(params: {
  dateStr: string
  prevFields: Record<string, unknown>
  userPrompts: string
  imageInputs: DailyUserImageInput[]
}): string | StructuredProfileContentBlock[] {
  const text = buildExtractionUserPrompt(params)
  if (params.imageInputs.length === 0) return text

  const blocks: StructuredProfileContentBlock[] = [{ type: 'text', text }]
  params.imageInputs.forEach((image, idx) => {
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

function buildExtractionUserPrompt(params: {
  dateStr: string
  prevFields: Record<string, unknown>
  userPrompts: string
  imageInputs: DailyUserImageInput[]
}): string {
  const schemaBlock = Object.keys(params.prevFields).length
    ? JSON.stringify(params.prevFields, null, 2)
    : '（首日，无历史 schema 约束）'
  const userPromptsBlock = params.userPrompts.trim() || '（今日无可用文本消息；请结合随附图片判断是否有可记录事实。）'
  const imageBlock = params.imageInputs.length
    ? params.imageInputs
      .map((image, idx) => `- 图片 ${idx + 1}: ${image.label}`)
      .join('\n')
    : '（今日没有随附图片。）'
  return `今日日期：${params.dateStr}

## Schema 约束（你的字段复用字典 —— 优先从这里挑名字，禁止给同一概念起新名；历史字段必须保留，今日未提及则值为 null）
${schemaBlock}

## 今日用户原始消息（文本）
${userPromptsBlock}

## 今日用户上传图片
${imageBlock}

随附图片会作为本条 user message 的 image_url blocks 追加在下方，请逐张阅读。若图片是病历、检验单、处方、药盒或当前用药，请把清晰可见的客观事实纳入同一次抽取；结构化输出仍只能使用 number/boolean/null。

请按 system 规则输出：要么单独一行 ${NO_RECORD_MARKER}，要么一个合法 JSON 对象（值仅 number/boolean/null）。`
}

// ─── 字段清洗 ─────────────────────────────────────────────────────────────────

const FIELD_KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/

function isValidFieldKey(key: string): boolean {
  return FIELD_KEY_PATTERN.test(key)
}

/**
 * 只放行 number / boolean / null。
 * 字符串、数组、嵌套对象一律返回 null —— LLM 偶尔违规也不会污染表。
 * 注：number 里 NaN / Infinity 也丢弃，避免后续 JSON 序列化炸。
 */
function sanitizeValue(v: unknown): number | boolean | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  return null
}
