import { randomUUID } from 'node:crypto'
import { and, desc, eq } from 'drizzle-orm'
import { CURRENT_CONCERN_LABELS, type AgentRecommendedQuestionsResponse } from '@health-agent/shared'
import { getDb } from '../db/client.js'
import { chatSessions, messages, userProfilesMemory, users } from '../db/schema/index.js'
import { llmCallPrimaryOnly } from '../lib/llm.js'
import type { Logger } from '../lib/logger.js'
import { getKV } from '../lib/redis.js'
import { stripSystemReminderText } from '../utils/system-reminder.js'
import { getEnv } from '../env.js'

export const RECOMMENDED_QUESTION_DATA_TTL_SECONDS = 5 * 60
export const RECOMMENDED_QUESTION_LOCK_TTL_SECONDS = 30
export const RECOMMENDED_QUESTION_MAX_GENERATION_ATTEMPTS = 3
const MAX_RECENT_QUESTION_COUNT = 100
const MAX_RECENT_QUESTION_CHARS = 200
const MAX_RECENT_QUESTION_TOTAL_CHARS = 10_000
const MAX_RECOMMENDED_QUESTION_CHARS = 15
const PRESSURE_INDUCING_TERMS = [
  '恶性',
  '癌',
  '复发',
  '转移',
  '扩散',
  '死亡',
  '严重',
  '痛苦',
  '焦虑',
  '恐惧',
  '危险',
  '急诊',
  '抢救',
] as const
const AGENT_ASKING_USER_TERMS = [
  '你',
  '您',
  '愿意',
  '说说',
  '告诉我',
  '感觉怎么样',
  '哪里不舒服',
  '哪里难受',
  '想聊聊',
  '可以聊',
  '需要我',
] as const

export interface RecommendedQuestionAgentContext {
  userProfile: {
    nickname: string | null
    birthday: string | null
    gender: string | null
    currentConcernLabel: string | null
  }
  longTermPreference: string | null
  recentUserQuestions: string[]
}

interface RecentQuestionSanitizeOptions {
  maxCount?: number
  maxQuestionChars?: number
  maxTotalChars?: number
}

interface CachedRecommendedQuestions {
  status: 'ready'
  source: 'agent'
  generatedAt: string | null
  questions: string[]
}

interface GeneratingRecommendedQuestions {
  status: 'generating'
  source: 'agent'
  generationId: string
  startedAt: string
}

type RecommendedQuestionCacheValue = CachedRecommendedQuestions | GeneratingRecommendedQuestions

export const RECOMMENDED_QUESTION_SYSTEM_PROMPT = `你是Health Agent Lab首页推荐问题生成 Agent。

你的任务是根据用户基本信息、用户长期偏好、用户近期提问，生成 3 个适合展示在首页的问题推荐。
这些推荐问题会在用户点击后，作为“用户发给演示助手 Agent 的提问”直接发送出去。

你必须严格遵守输出协议：

1. 最终输出只能是一个合法 JSON 对象。
2. 不要输出 Markdown。
3. 不要输出 \`\`\`json 代码块。
4. 不要输出任何解释、说明、寒暄、标题、前后缀。
5. 不要在 JSON 前后添加任何字符、空行或自然语言。
6. 如果你无法判断，也必须输出合法 JSON。
7. 输出不符合 JSON 会被系统直接判定为失败。

唯一允许的 JSON 格式是：
{
  "questions": [
    "问题1",
    "问题2",
    "问题3"
  ]
}

内容生成规则：
1. questions 必须正好包含 3 个字符串。
2. 每个字符串必须是中文问句，适合用户直接点击发送给演示助手。
3. 问题要温暖、温馨、轻柔，像是在陪用户慢慢梳理身体和生活状态。
4. 每个问题必须不超过 15 个字，尽量控制在 8-14 个字。
5. 优先结合用户近期关注点，生成“下一步自然想问”的问题。
6. 如果近期问题不足，则主要根据用户基本信息和当前关注情况生成通用但贴心的问题。
7. 不要重复用户近期已经问过的问题。
8. 不要出现“恶性、癌、复发、转移、扩散、死亡、严重、痛苦、焦虑、恐惧、危险、急诊、抢救”等容易增加用户压力的词。
9. 不要生成诊断判断、治疗选择、停药换药、剂量调整、是否手术、是否化疗、是否放疗等高风险决策问题。
10. 不要包含姓名、手机号、身份证号、住院号、门诊号、报告编号等隐私信息。
11. 问题应该偏向日常照护、症状记录、检查准备、生活调整、情绪安抚、复诊沟通。
12. 必须站在用户视角来写，像“我想问演示助手什么”。
13. 不要站在 Agent 视角反问用户；不要出现“你、您、愿意、说说、告诉我、感觉怎么样、哪里不舒服、需要我”等面向用户提问的表达。
14. 推荐写法示例：“乳房疼怎么缓解？”“复查前准备什么？”“报告指标怎么看？”“睡眠不好怎么调？”`

export function buildRecommendedQuestionUserPrompt(context: RecommendedQuestionAgentContext): string {
  return [
    '请基于以下用户信息生成首页推荐问题。',
    '这些问题是用户点击后要直接发给演示助手 Agent 的问题，请务必站在用户视角生成。',
    '不要生成 Agent 反问用户的句子，例如“今天感觉怎么样？”“哪里不舒服？”“愿意说说吗？”。',
    '',
    '输出必须是 JSON，格式如下：',
    '{',
    '  "questions": [',
    '    "问题1",',
    '    "问题2",',
    '    "问题3"',
    '  ]',
    '}',
    '',
    '## 用户基本信息',
    `昵称：${context.userProfile.nickname || '未填写'}`,
    `性别：${context.userProfile.gender || '未填写'}`,
    `生日：${context.userProfile.birthday || '未填写'}`,
    `当前关注情况：${context.userProfile.currentConcernLabel || '未填写'}`,
    '',
    '## 用户长期偏好',
    context.longTermPreference?.trim() || '暂无长期偏好',
    '',
    '## 用户近期问题',
    '说明：',
    '- 以下是用户最近最多 100 条提问，按时间从新到旧排列。',
    '- 如果问题很少或为空，请主要根据用户基本信息生成温暖、通用、低压力的问题。',
    '- 不要重复这些问题本身。',
    '',
    formatRecentQuestions(context.recentUserQuestions),
  ].join('\n')
}

export function parseRecommendedQuestionJson(content: string): string[] {
  const trimmed = stripJsonMarkdownFence(content)
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    throw new Error('recommended questions response must be a valid JSON object')
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    throw new Error('recommended questions response must be a valid JSON object')
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('recommended questions response must be a valid JSON object')
  }
  const questions = (parsed as { questions?: unknown }).questions
  if (!Array.isArray(questions) || questions.length !== 3) {
    throw new Error('recommended questions response must contain exactly 3 questions')
  }

  const normalized = questions.map((item) => {
    if (typeof item !== 'string') throw new Error('recommended questions must be string items')
    return ensureQuestionMark(item.replace(/\s+/g, '').trim())
  })

  if (normalized.some((item) => !item)) throw new Error('recommended questions must not be empty')
  if (new Set(normalized.map(normalizeQuestionForDedupe)).size !== normalized.length) {
    throw new Error('recommended questions must not be duplicated')
  }
  if (normalized.some((item) => countQuestionChars(item) > MAX_RECOMMENDED_QUESTION_CHARS)) {
    throw new Error('recommended questions must not exceed 15 chars')
  }
  if (normalized.some(containsPressureInducingTerm)) {
    throw new Error('recommended questions must not contain pressure-inducing wording')
  }
  if (normalized.some(containsAgentAskingUserWording)) {
    throw new Error('recommended questions must be user-to-agent questions')
  }
  return normalized
}

export function extractStoredUserQuestionText(content: string): string | null {
  let text = content
  if (content.trim().startsWith('[')) {
    try {
      const parsed = JSON.parse(content)
      if (Array.isArray(parsed)) {
        const textPart = parsed.find((part) => (
          part &&
          typeof part === 'object' &&
          (part as { type?: unknown }).type === 'text' &&
          typeof (part as { text?: unknown }).text === 'string'
        )) as { text: string } | undefined
        text = textPart?.text ?? ''
      }
    } catch {
      text = content
    }
  }

  const stripped = stripSystemReminderText(text)
    .replace(/\s+/g, ' ')
    .trim()
  if (!stripped || stripped.includes('[tool-attachment:')) return null
  return stripped
}

export function sanitizeRecentUserQuestions(
  rows: string[],
  options: RecentQuestionSanitizeOptions = {},
): string[] {
  const maxCount = options.maxCount ?? MAX_RECENT_QUESTION_COUNT
  const maxQuestionChars = options.maxQuestionChars ?? MAX_RECENT_QUESTION_CHARS
  const maxTotalChars = options.maxTotalChars ?? MAX_RECENT_QUESTION_TOTAL_CHARS
  const result: string[] = []
  const seen = new Set<string>()
  let totalChars = 0

  for (const row of rows) {
    if (result.length >= maxCount) break
    const extracted = extractStoredUserQuestionText(row)
    if (!extracted) continue
    const text = extracted.slice(0, maxQuestionChars)
    const dedupeKey = normalizeQuestionForDedupe(text)
    if (!dedupeKey || seen.has(dedupeKey)) continue
    const nextTotal = totalChars + text.length + (result.length > 0 ? 1 : 0)
    if (nextTotal > maxTotalChars) break
    seen.add(dedupeKey)
    result.push(text)
    totalChars = nextTotal
  }

  return result
}

export async function getAgentRecommendedQuestionsForUser(
  userId: string,
  logger: Logger,
): Promise<AgentRecommendedQuestionsResponse> {
  const dataKey = recommendedQuestionDataCacheKey(userId)
  const lockKey = recommendedQuestionLockKey(userId)
  const cacheState = await readRecommendedQuestionDataCacheState(userId)
  if (cacheState?.status === 'ready') return toAgentResponse(cacheState, true)

  const kv = getKV()
  const generationId = randomUUID()
  const generationStarted = await kv.setNX(lockKey, generationId, RECOMMENDED_QUESTION_LOCK_TTL_SECONDS)
  if (!generationStarted) {
    const latestState = await readRecommendedQuestionDataCacheState(userId)
    return latestState?.status === 'ready'
      ? toAgentResponse(latestState, true)
      : toGeneratingResponse(true)
  }

  void generateAndCacheRecommendedQuestions(userId, dataKey, lockKey, generationId, logger)
  return toGeneratingResponse(false)
}

function toAgentResponse(
  ready: CachedRecommendedQuestions,
  cached: boolean,
): AgentRecommendedQuestionsResponse {
  return {
    status: 'ready',
    source: 'agent',
    cached,
    generatedAt: ready.generatedAt,
    questions: ready.questions,
  }
}

function toGeneratingResponse(cached: boolean): AgentRecommendedQuestionsResponse {
  return {
    status: 'generating',
    source: 'agent',
    cached,
    generatedAt: null,
    questions: [],
  }
}

async function generateAndCacheRecommendedQuestions(
  userId: string,
  dataKey: string,
  lockKey: string,
  generationId: string,
  logger: Logger,
): Promise<void> {
  try {
    const context = await loadRecommendedQuestionAgentContext(userId)
    const questions = await retryRecommendedQuestionGeneration(
      () => callRecommendedQuestionAgent(context, logger),
      logger,
    )
    const response: CachedRecommendedQuestions = {
      status: 'ready',
      source: 'agent',
      generatedAt: new Date().toISOString(),
      questions,
    }

    await getKV().set(dataKey, JSON.stringify(response), RECOMMENDED_QUESTION_DATA_TTL_SECONDS)
  } catch (err) {
    logger.warn(
      { userId, error: err instanceof Error ? err.message : String(err) },
      'recommended question agent failed',
    )
  } finally {
    await getKV().delIfValue(lockKey, generationId)
  }
}

export async function clearRecommendedQuestionAgentCacheForUser(userId: string, logger?: Logger): Promise<void> {
  try {
    await Promise.all([
      getKV().del(recommendedQuestionDataCacheKey(userId)),
      getKV().del(recommendedQuestionLockKey(userId)),
    ])
  } catch (err) {
    logger?.warn(
      { userId, error: err instanceof Error ? err.message : String(err) },
      'recommended question agent cache clear failed',
    )
  }
}

async function loadRecommendedQuestionAgentContext(userId: string): Promise<RecommendedQuestionAgentContext> {
  const db = getDb()
  const [user, memoryRow, recentRows] = await Promise.all([
    db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { nickname: true, birthday: true, gender: true, currentConcern: true },
    }),
    db.query.userProfilesMemory.findFirst({
      where: eq(userProfilesMemory.userId, userId),
      columns: { userMd: true },
    }),
    db
      .select({ content: messages.content })
      .from(messages)
      .innerJoin(chatSessions, eq(messages.sessionId, chatSessions.id))
      .where(and(
        eq(chatSessions.userId, userId),
        eq(messages.role, 'user'),
      ))
      .orderBy(desc(messages.createdAt))
      .limit(MAX_RECENT_QUESTION_COUNT),
  ])

  const concern = user?.currentConcern ?? null
  return {
    userProfile: {
      nickname: user?.nickname ?? null,
      birthday: user?.birthday ? String(user.birthday) : null,
      gender: user?.gender ?? null,
      currentConcernLabel: concern ? CURRENT_CONCERN_LABELS[concern] : null,
    },
    longTermPreference: memoryRow?.userMd?.trim() || null,
    recentUserQuestions: sanitizeRecentUserQuestions(recentRows.map((row) => row.content)),
  }
}

async function callRecommendedQuestionAgent(
  context: RecommendedQuestionAgentContext,
  logger: Logger,
): Promise<string[]> {
  const log = logger.child({ module: 'recommended-question-agent' })
  const response = await llmCallPrimaryOnly({
    model: getEnv().RECOMMENDED_QUESTION_MODEL,
    messages: [
      { role: 'system', content: RECOMMENDED_QUESTION_SYSTEM_PROMPT },
      { role: 'user', content: buildRecommendedQuestionUserPrompt(context) },
    ],
    temperature: 1.0,
    max_tokens: 800,
    response_format: { type: 'json_object' },
    enable_thinking: false,
  }, log)

  const content = response.choices[0]?.message?.content
  if (!content) throw new Error('recommended question agent returned empty content')
  return parseRecommendedQuestionJson(content)
}

export async function retryRecommendedQuestionGeneration<T>(
  generate: () => Promise<T>,
  logger?: Logger,
): Promise<T> {
  let lastError: unknown
  for (let attempt = 1; attempt <= RECOMMENDED_QUESTION_MAX_GENERATION_ATTEMPTS; attempt += 1) {
    try {
      return await generate()
    } catch (err) {
      lastError = err
      if (attempt < RECOMMENDED_QUESTION_MAX_GENERATION_ATTEMPTS) {
        logger?.warn(
          { attempt, error: err instanceof Error ? err.message : String(err) },
          'recommended question generation attempt failed, retrying',
        )
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

async function readRecommendedQuestionDataCacheState(userId: string): Promise<RecommendedQuestionCacheValue | null> {
  const raw = await getKV().get(recommendedQuestionDataCacheKey(userId))
  return parseRecommendedQuestionCacheValue(raw)
}

export function parseRecommendedQuestionCacheValue(raw: string | null): RecommendedQuestionCacheValue | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (
      parsed?.status === 'generating' &&
      parsed.source === 'agent' &&
      typeof parsed.generationId === 'string' &&
      typeof parsed.startedAt === 'string'
    ) {
      return {
        status: 'generating',
        source: 'agent',
        generationId: parsed.generationId,
        startedAt: parsed.startedAt,
      }
    }
    if (
      parsed.status !== 'ready' ||
      parsed?.source !== 'agent' ||
      !Array.isArray(parsed.questions) ||
      parsed.questions.length !== 3 ||
      !parsed.questions.every((item): item is string => typeof item === 'string')
    ) {
      return null
    }
    return {
      status: 'ready',
      source: 'agent',
      generatedAt: typeof parsed.generatedAt === 'string' ? parsed.generatedAt : null,
      questions: parsed.questions,
    }
  } catch {
    return null
  }
}

function formatRecentQuestions(questions: string[]): string {
  if (questions.length === 0) return '暂无可参考的近期问题。'
  return questions.map((question, index) => `${index + 1}. ${question}`).join('\n')
}

function recommendedQuestionDataCacheKey(userId: string): string {
  return `home:recommended_questions:data:${userId}`
}

function recommendedQuestionLockKey(userId: string): string {
  return `home:recommended_questions:lock:${userId}`
}

function ensureQuestionMark(text: string): string {
  const trimmed = text.trim().replace(/[?？]+$/g, '')
  return trimmed ? `${trimmed}？` : ''
}

function stripJsonMarkdownFence(content: string): string {
  return content
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()
}

function normalizeQuestionForDedupe(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s，。！？!?,.；;：:“”"'‘’、（）()【】\[\]《》<>]/g, '')
}

function containsPressureInducingTerm(text: string): boolean {
  return PRESSURE_INDUCING_TERMS.some((term) => text.includes(term))
}

function containsAgentAskingUserWording(text: string): boolean {
  return AGENT_ASKING_USER_TERMS.some((term) => text.includes(term))
}

function countQuestionChars(text: string): number {
  return Array.from(
    text.replace(/[\s，。！？!?,.；;：:“”"'‘’、（）()【】\[\]《》<>]/g, ''),
  ).length
}
