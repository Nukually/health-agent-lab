import { llmCall } from '../lib/llm.js'
import { getEnv } from '../env.js'
import {
  advanceEfficacyStatuses,
  createEfficacyRecord,
  getEfficacyRecordById,
  listNonClosedEfficacyProblems,
  listRecallableEfficacyRecords,
  updateEfficacyRecord,
  type EfficacyRecord,
} from './efficacy-records.js'
import { MemoryContentRejectedError } from './memory.js'
import type {
  EfficacyAdoptionStatus,
  EfficacyCadence,
  EfficacyEvidence,
  EfficacyOutcome,
} from '@health-agent/shared'
import type { Logger } from '../lib/logger.js'

const MAX_TRANSCRIPT_CHARS = 6000

function efficacyModel(): string {
  return getEnv().EFFICACY_ANALYSIS_MODEL
}

const ADOPTION_VALUES = new Set<EfficacyAdoptionStatus>(['adopted', 'rejected', 'partial', 'unknown'])
const OUTCOME_VALUES = new Set<EfficacyOutcome>(['improved', 'unchanged', 'worsened', 'no_feedback'])

export interface EfficacyCandidate {
  problem: string
  finalPlan: string
  cadence: EfficacyCadence
  expectedEndAt: string | null
  adoptionStatus: EfficacyAdoptionStatus
  outcome: EfficacyOutcome
  confidence: number
  evidence: EfficacyEvidence
}

export interface EfficacyAnalysisInput {
  userId: string
  sessionId: string
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
  lastUserMessageId: string | null
  now: Date
  logger: Logger
}

export interface EfficacyAnalysisResult {
  candidateCount: number
  created: number
  updated: number
  touched: number
  skipped: number
}

/**
 * 分析一段（增量）对话的干预方案疗效。三段 LLM：
 * 1) 抽取本片段的 problem→方案→采纳→疗效候选（含 cadence/expectedEndAt）
 * 2) 对每个候选做"点名召回"，在历史非 closed problem 列表里找可能同问题的 record
 * 3) lifecycle：在召回集合里决定 skip/create/update
 * 落库走 efficacy-records 的状态机与 touch 降级。
 */
export async function analyzeSessionEfficacy(input: EfficacyAnalysisInput): Promise<EfficacyAnalysisResult> {
  const log = input.logger.child({ module: 'efficacy-reviewer', sessionId: input.sessionId })
  const empty: EfficacyAnalysisResult = { candidateCount: 0, created: 0, updated: 0, touched: 0, skipped: 0 }
  if (input.messages.length === 0) return empty

  // 先推进状态机，再取近期可召回 record 作抽取上下文。
  await advanceEfficacyStatuses(input.userId, input.now, log)
  const recentRecords = await listRecallableEfficacyRecords(input.userId, input.now)

  const transcript = formatTranscript(input.messages)
  // 患者本人发言合集：采纳/疗效原话必须落在这里面，否则视为模型误抄 AI 的话（见 quoteIsGrounded）。
  const userText = input.messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n')

  const extractRaw = await llmCall({
    model: efficacyModel(),
    messages: [
      { role: 'system', content: buildExtractorSystemPrompt() },
      { role: 'user', content: buildExtractorUserPrompt({ transcript, existingRecords: recentRecords, now: input.now }) },
    ],
    max_tokens: 1000,
    temperature: 0.2,
    enable_thinking: false,
  }, log)

  const candidates = normalizeEfficacyItems(extractRaw.choices[0]?.message?.content ?? '', userText)
  if (candidates.length === 0) {
    log.debug('efficacy analysis produced no candidates')
    return empty
  }

  const result: EfficacyAnalysisResult = { candidateCount: candidates.length, created: 0, updated: 0, touched: 0, skipped: 0 }
  // 内存维护本次已知的非 closed record（id→record），供点名召回/lifecycle 使用。
  const known = new Map<string, EfficacyRecord>(recentRecords.map((r) => [r.id, r]))

  for (const cand of candidates) {
    try {
      const recalled = await resolveRecalledRecords(input.userId, cand, recentRecords, known, log)
      const decision = recalled.length === 0
        ? { action: 'create' as const }
        : await resolveLifecycle(cand, recalled, userText, log)

      if (decision.action === 'update' && decision.targetId) {
        const target = known.get(decision.targetId)
        if (!target) { result.skipped++; continue }
        // 二次审核：推进的采纳/疗效非默认值时，过 deepseek 复核，reject 则撤销该推进。
        const verdict = await verifyEfficacyTransition({
          problem: target.problem,
          finalPlan: decision.finalPlan ?? target.finalPlan,
          adoptionStatus: decision.adoptionStatus ?? 'unknown',
          outcome: decision.outcome ?? 'no_feedback',
          adoptionQuote: decision.evidence?.adoptionQuote ?? '',
          outcomeQuote: decision.evidence?.outcomeQuote ?? '',
        }, transcript, log)
        const updAdoption = verdict.adoptionApprove ? decision.adoptionStatus : undefined
        const updOutcome = verdict.outcomeApprove ? decision.outcome : undefined
        const updEvidence = decision.evidence ? {
          planQuote: decision.evidence.planQuote,
          adoptionQuote: verdict.adoptionApprove ? decision.evidence.adoptionQuote : undefined,
          outcomeQuote: verdict.outcomeApprove ? decision.evidence.outcomeQuote : undefined,
        } : undefined
        const { row, touched } = await updateEfficacyRecord({
          userId: input.userId,
          recordId: decision.targetId,
          finalPlan: decision.finalPlan,
          adoptionStatus: updAdoption,
          outcome: updOutcome,
          evidence: updEvidence,
          sourceSessionId: input.sessionId,
          sourceMessageId: input.lastUserMessageId,
        }, target, log)
        if (row) {
          known.set(row.id, row)
          if (touched) result.touched++
          else result.updated++
        } else {
          result.skipped++
        }
      } else if (decision.action === 'create') {
        // 二次审核：create 首次即带非默认采纳/疗效时，过 deepseek 复核，reject 则降级回默认态。
        const verdict = await verifyEfficacyTransition({
          problem: cand.problem,
          finalPlan: cand.finalPlan,
          adoptionStatus: cand.adoptionStatus,
          outcome: cand.outcome,
          adoptionQuote: cand.evidence.adoptionQuote ?? '',
          outcomeQuote: cand.evidence.outcomeQuote ?? '',
        }, transcript, log)
        const createAdoption = verdict.adoptionApprove ? cand.adoptionStatus : 'unknown'
        const createOutcome = verdict.outcomeApprove ? cand.outcome : 'no_feedback'
        const row = await createEfficacyRecord({
          userId: input.userId,
          problem: cand.problem,
          finalPlan: cand.finalPlan,
          cadence: cand.cadence,
          expectedEndAt: cand.expectedEndAt ? new Date(cand.expectedEndAt) : null,
          adoptionStatus: createAdoption,
          outcome: createOutcome,
          evidence: {
            planQuote: cand.evidence.planQuote,
            adoptionQuote: verdict.adoptionApprove ? cand.evidence.adoptionQuote : '',
            outcomeQuote: verdict.outcomeApprove ? cand.evidence.outcomeQuote : '',
          },
          confidence: cand.confidence,
          sourceSessionId: input.sessionId,
          sourceMessageId: input.lastUserMessageId,
        }, log)
        known.set(row.id, row)
        result.created++
      } else {
        result.skipped++
      }
    } catch (err) {
      if (err instanceof MemoryContentRejectedError) {
        log.warn({ reasons: err.reasons }, 'efficacy candidate rejected by content scan')
      } else {
        log.warn({ error: err instanceof Error ? err.message : String(err) }, 'efficacy candidate failed (non-critical)')
      }
      result.skipped++
    }
  }

  log.info(result, 'efficacy analysis completed')
  return result
}

// ----- 点名召回 -----

async function resolveRecalledRecords(
  userId: string,
  candidate: EfficacyCandidate,
  recentRecords: EfficacyRecord[],
  known: Map<string, EfficacyRecord>,
  logger: Logger,
): Promise<EfficacyRecord[]> {
  const recentIds = new Set(recentRecords.map((r) => r.id))
  const problems = await listNonClosedEfficacyProblems(userId)
  const farPool = problems.filter((p) => !recentIds.has(p.id))
  if (farPool.length === 0) return recentRecords

  // 把近期 + 久远问题列表一起交给 LLM 点名，命中久远项则补进召回集合。
  const matchRaw = await llmCall({
    model: efficacyModel(),
    messages: [
      { role: 'system', content: buildMatchSystemPrompt() },
      { role: 'user', content: buildMatchUserPrompt(candidate, [
        ...recentRecords.map((r) => ({ id: r.id, problem: r.problem, status: r.status })),
        ...farPool,
      ]) },
    ],
    max_tokens: 60,
    temperature: 0,
    enable_thinking: false,
  }, logger)

  const matchId = parseMatchId(matchRaw.choices[0]?.message?.content ?? '')
  if (!matchId || recentIds.has(matchId)) return recentRecords

  const matchedFar = farPool.find((p) => p.id === matchId)
  if (!matchedFar) return recentRecords

  // 命中久远项：取完整 record 补进召回集合（优先用内存缓存，避免重复查询）。
  let record = known.get(matchId) ?? null
  if (!record) {
    record = await getEfficacyRecordById(userId, matchId)
    if (record) known.set(record.id, record)
  }
  return record ? [...recentRecords, record] : recentRecords
}

// ----- lifecycle -----

interface LifecycleDecision {
  action: 'skip' | 'create' | 'update'
  targetId?: string
  finalPlan?: string
  adoptionStatus?: EfficacyAdoptionStatus
  outcome?: EfficacyOutcome
  evidence?: EfficacyEvidence
}

async function resolveLifecycle(
  candidate: EfficacyCandidate,
  recalled: EfficacyRecord[],
  userText: string,
  logger: Logger,
): Promise<LifecycleDecision> {
  const raw = await llmCall({
    model: efficacyModel(),
    messages: [
      { role: 'system', content: buildLifecycleSystemPrompt() },
      { role: 'user', content: buildLifecycleUserPrompt(candidate, recalled) },
    ],
    max_tokens: 400,
    temperature: 0.1,
    enable_thinking: false,
  }, logger)
  return normalizeLifecycleDecision(raw.choices[0]?.message?.content ?? '', recalled.map((r) => r.id), userText)
}

// ----- 二次审核（verify）：状态推进前由独立 LLM 复核，approve 才允许推进 -----

export interface VerifyInput {
  problem: string
  finalPlan: string
  adoptionStatus: EfficacyAdoptionStatus // 本次拟推进到的采纳态（非 unknown 才送审）
  outcome: EfficacyOutcome // 本次拟推进到的疗效态（非 no_feedback 才送审）
  adoptionQuote: string
  outcomeQuote: string
}

export interface VerifyVerdict {
  adoptionApprove: boolean // 采纳推进是否通过；未送审采纳时恒 true
  outcomeApprove: boolean // 疗效推进是否通过；未送审疗效时恒 true
}

/**
 * 对一次「采纳/疗效状态推进」做独立二次审核。三条原则：
 * 1) 原始问题确由【用户】提出；2) 干预方案确由【AI】提出；
 * 3) 用户在对话里明确做出了所声称的采纳/疗效举动，且原话依据对得上。
 * 只有 approve 才允许推进；reject 由调用方降级回默认态。
 * 采纳为 unknown / 疗效为 no_feedback（无推进）时不送审，对应 approve 恒 true。
 */
export async function verifyEfficacyTransition(
  input: VerifyInput,
  transcript: string,
  logger: Logger,
): Promise<VerifyVerdict> {
  const needAdoption = input.adoptionStatus !== 'unknown'
  const needOutcome = input.outcome !== 'no_feedback'
  // 无任何非默认推进则无需审核。
  if (!needAdoption && !needOutcome) return { adoptionApprove: true, outcomeApprove: true }

  const raw = await llmCall({
    model: efficacyModel(),
    messages: [
      { role: 'system', content: buildVerifySystemPrompt() },
      { role: 'user', content: buildVerifyUserPrompt(input, transcript) },
    ],
    max_tokens: 200,
    temperature: 0,
    enable_thinking: false,
  }, logger)
  const verdict = normalizeVerifyVerdict(raw.choices[0]?.message?.content ?? '', { needAdoption, needOutcome })
  if (!verdict.adoptionApprove || !verdict.outcomeApprove) {
    logger.info({ problem: input.problem.slice(0, 40), adoptionApprove: verdict.adoptionApprove, outcomeApprove: verdict.outcomeApprove }, 'efficacy transition rejected by verify')
  }
  return verdict
}

export function buildVerifySystemPrompt(): string {
  return `你是乳腺健康陪伴产品「干预方案疗效」分析的【独立审核员】。上一个分析器从一段医患对话里抽出了"用户采纳/疗效"的结论，你的职责是逐条复核它是否站得住，把站不住的打回。

# 给你的材料
- 一段对话记录：标【用户说】=患者本人，标【AI助手说】=医疗 Agent。
- 分析器给出的一条结论：problem（健康问题）、finalPlan（AI 的方案）、以及它判定的采纳态/疗效态和所引用的患者原话。

# 审核三原则（每条都要成立，否则 reject）
1. 【问题归属】problem 描述的健康问题/症状，确实是【用户说】里患者提出或诉说的，不是 AI 凭空假设的。
2. 【方案归属】finalPlan 确实是【AI助手说】里 AI 主动给出的建议，且不是把患者自述的已有习惯（如"我每天打八段锦""我一直在散步""我基本每天都这么吃"）当成 AI 方案。
3. 【举动落地】只有当被审核的是"采纳/疗效推进"时才查：
   - 采纳：用户在【用户说】里明确表示要照 AI【这次新提的、他之前没在做的】建议去做或已去做；所给 adoptionQuote 必须是患者本人原话、且确实在表达采纳（不是礼貌客套"好的谢谢"、不是陈述自己已有习惯、不是提问/描述症状）。
   - 疗效：用户明确反馈了该方案的效果变化；所给 outcomeQuote 必须是患者本人原话、且确实在反馈效果。

# 判定
- 采纳：三原则（含采纳那条）全成立 → adoptionApprove=true；任一不成立 → false。
- 疗效：原则 1、2 加上疗效那条全成立 → outcomeApprove=true；任一不成立 → false。
- 宁可严格：依据对不上、原话牵强、像客套/陈述习惯，一律打回 false。
- 只对"被送审的维度"判定；未送审的维度恒 true（无需关心）。

只输出 JSON，不要解释：{"adoptionApprove":true,"outcomeApprove":true}`
}

export function buildVerifyUserPrompt(input: VerifyInput, transcript: string): string {
  const lines: string[] = []
  lines.push('【对话记录】：')
  lines.push(truncate(transcript, MAX_TRANSCRIPT_CHARS))
  lines.push('')
  lines.push('【待审核结论】：')
  lines.push(`problem（健康问题）=${input.problem}`)
  lines.push(`finalPlan（AI 方案）=${input.finalPlan}`)
  if (input.adoptionStatus !== 'unknown') {
    lines.push(`【送审·采纳】判定为 ${input.adoptionStatus}，引用患者原话 adoptionQuote="${input.adoptionQuote}"`)
  } else {
    lines.push('【采纳】本次未推进采纳（unknown），无需审核采纳，adoptionApprove 直接 true。')
  }
  if (input.outcome !== 'no_feedback') {
    lines.push(`【送审·疗效】判定为 ${input.outcome}，引用患者原话 outcomeQuote="${input.outcomeQuote}"`)
  } else {
    lines.push('【疗效】本次未推进疗效（no_feedback），无需审核疗效，outcomeApprove 直接 true。')
  }
  return lines.join('\n')
}

/**
 * 解析审核裁决。未送审的维度恒 approve=true；送审维度只有 LLM 明确给 true 才 approve，
 * 解析失败/缺字段一律按 reject（false）兜底——审核不通过比误放行更安全。
 */
export function normalizeVerifyVerdict(
  raw: string,
  sent: { needAdoption: boolean; needOutcome: boolean },
): VerifyVerdict {
  const parsed = parseEfficacyJson(raw)
  const readBool = (v: unknown) => v === true
  return {
    adoptionApprove: sent.needAdoption ? readBool((parsed as { adoptionApprove?: unknown } | null)?.adoptionApprove) : true,
    outcomeApprove: sent.needOutcome ? readBool((parsed as { outcomeApprove?: unknown } | null)?.outcomeApprove) : true,
  }
}

// ----- transcript 拼接 -----

/**
 * 把对话拼成强角色边界的文本：每条消息用清晰的角色标头隔开，消息之间用分隔线，
 * 让 LLM 不会把【AI助手】说的方案误当成【用户】的采纳/疗效原话。
 */
export function formatTranscript(messages: Array<{ role: 'user' | 'assistant'; content: string }>): string {
  return messages
    .map((m) => `【${m.role === 'user' ? '用户说' : 'AI助手说'}】\n${m.content}`)
    .join('\n\n----------------------------------------\n\n')
}

// ----- 提示词（已在 prod 真实数据验证） -----

export function buildExtractorSystemPrompt(): string {
  return `你是乳腺健康陪伴产品的"干预方案疗效"分析器。你不回答用户、不参与对话，只做第三方分析。

# 你分析的材料
user 消息里是一段对话记录，记录的是【一个乳腺健康医疗 Agent 在与一位乳腺患者对话问诊、给健康建议】的过程。记录里：
- 【用户说】= 患者本人。判断"是否采纳、效果如何"，只看患者在这些块里的明确表态。
- 【AI助手说】= 那个医疗 Agent，是"方案"的来源。AI 说的话永远不能当成患者的采纳或疗效反馈。

# 你的目标
找出【AI 主动给患者的健康干预方案】，以及【患者对这些方案的采纳和效果反馈】，按"健康问题"维度整理成记录。

# 判断流程：对你想记录的每一条，依次过这 4 关，任一关不通过就丢弃
1. 它是不是【AI 主动发起、针对某个健康问题的可执行建议】？
   - 是可执行建议：用药/护理、饮食调整、运动调整、复诊安排、练习跟练等。
   - 不是、要丢弃：纯科普/风险分级/情绪安慰/寒暄（没给可执行动作）；产品功能操作（创建提醒、设闹钟、记录打卡、生成卡片、教用户用 App）。
2. 这个做法【最早是谁提出来的】？看它第一次出现在哪个角色的块里。
   - 最早出自【AI助手说】= AI 的方案，保留。
   - 最早出自【用户说】（患者自述"我每天打八段锦""我一直在散步"等已有习惯），AI 只是附和"挺好、继续保持"= 不是 AI 的方案，丢弃这个做法。只保留 AI 在此之外【额外新提】的、患者没在做的建议。
3. 把它【归并到正确的问题维度】。同一个主诉下 AI 分多轮追问、给的多个动作，是同一条；problem 写最初那个主诉，finalPlan 合并最终最具体的所有动作。不要按动作拆条，不要按追问轮次拆条。
4. 判断【采纳和疗效】，只依据【用户说】块里患者的明确原话（见下）。
   - 默认就是 unknown / no_feedback：患者全程只在描述症状、提问、回答你追问，而没说"要照做/试了/有效果"——这是最常见的正常情况，此时 adoptionStatus 必须 unknown、outcome 必须 no_feedback，对应 quote 留空。不要因为对话很长、AI 反复给了方案，就觉得"总该有采纳"而硬填。
   - adoptionQuote / outcomeQuote 只能从【用户说】块逐字摘。绝对不要把【AI助手说】里的方案句（如"试试睡眠模式""帮你找放松跟练视频"）当成患者的采纳原话——那是 AI 在建议，不是患者在采纳。

# 字段规则
- problem：简洁的"健康问题/症状/主诉"短语（不是动作）。
- finalPlan：AI 给的最终、最具体那一版方案；同一问题多动作合并写在一起。
- cadence：oneshot=一次性动作/决策；periodic=需持续反复执行。
- expectedEndAt：仅 periodic 且对话给了明确时长/复查节点时，按当前时间推算 ISO 日期(YYYY-MM-DD)；否则空字符串。
- adoptionStatus（只看【用户说】块患者明确表态）：
  - adopted=患者明确说已照 AI 建议在做/试了；rejected=明确说不做/不打算做/委婉拒绝；partial=只采纳了方案里部分子动作，或打算试还没试；unknown=患者没就采纳与否明确表态。
  - 患者只是提问、诉说担忧、描述症状、回答 AI 追问（如"我没固定位置痛"），都是提供信息，不算采纳 → unknown。
  - 【关键】患者陈述自己【本来就在做/已有的习惯或现状】（如"我每天打八段锦""我基本每天都这么吃""我一直在散步""已服用6个月"），这是在描述既有事实，不是在采纳 AI 的【新】建议 → unknown。只有当患者明确表示要照 AI 【这次新提的、他之前没在做的】建议去做/已去做时，才算 adopted/partial。判断前先回到第 2 关：若这个做法最早出自患者自述，它根本不该作为 AI 方案被采纳。
- outcome（只看【用户说】块患者明确表态）：improved=患者说变好/缓解；unchanged=说没变化；worsened=说变差/新问题；no_feedback=患者没就效果反馈。
- evidence（必须是对话里一字不差的原文，不可编造/改写/拼接，不可写规则说明或字段名）：
  - planQuote 摘【AI助手说】里方案关键句；adoptionQuote 只摘【用户说】里患者表明采纳的原话；outcomeQuote 只摘【用户说】里患者反馈效果的原话。
  - 没有对应原话就留空。adoptionQuote 为空时 adoptionStatus 必须是 unknown；outcomeQuote 为空时 outcome 必须是 no_feedback。

# 例子（每个都标了为什么）
输入片段 A（多轮追问，必须收敛成 1 条）：
【用户说】身体偶尔会疼
【AI助手说】是哪个部位疼？有运动习惯吗？
【用户说】没固定位置，我跑步抗阻
【AI助手说】运动量大可能有关，建议跑步和抗阻错开、抗阻减到70%
【用户说】我练腰腹胸背，每周三次以上
【AI助手说】那更要错开恢复；胸背练后做门框拉伸和猫牛式，腰腹改练平板支撑等静态核心，练后拉伸肩颈腰背各30秒
【用户说】好的我试试错开安排
→ 输出：[{"problem":"运动相关身体疼痛","finalPlan":"跑步和抗阻错开安排、抗阻减到70%重量；胸背练后做门框拉伸和猫牛式，腰腹改练平板支撑等静态核心；练后拉伸肩颈腰背各30秒","cadence":"periodic","adoptionStatus":"partial","outcome":"no_feedback","evidence":{"planQuote":"跑步和抗阻错开、抗阻减到70%","adoptionQuote":"好的我试试错开安排","outcomeQuote":""}}]
（为什么：整段是 AI 围绕"身体疼"一路追问、逐轮细化的【同一个方案】→必须合并成 1 条，不能拆成"运动调整/训练后拉伸/恢复安排"等多条；用户只采纳"错开"这一个子动作→partial）

输入片段 D（AI 主动给多动作方案、用户完全没表态）：
【用户说】8201治疗后脱发严重
【AI助手说】可以每次洗头数掉发量、拍照记录，持续两周观察；外出戴帽子防晒；若持续加重复诊带给医生看
【用户说】头皮没特别不舒服，头发剪很短了
→ 输出：[{"problem":"8201治疗期间脱发","finalPlan":"每次洗头数掉发量、拍照记录持续两周观察；外出戴帽子防晒；持续加重则复诊带给医生看","cadence":"periodic","adoptionStatus":"unknown","outcome":"no_feedback","evidence":{"planQuote":"每次洗头数掉发量、拍照记录，持续两周观察","adoptionQuote":"","outcomeQuote":""}}]
（为什么：方案里多个动作都是 AI 主动提的、同属"脱发"一条→合并，不要把"戴帽子防晒"拆成独立条；用户只在描述现状、没表示要照做任何一项→unknown，adoptionQuote 留空）

输入片段 B：
【用户说】注射亮丙瑞林后情绪低落
【AI助手说】这在治疗初期常见，多数2-3个月缓解
【用户说】每天打八段锦，适当运动能对抗情绪低落
【AI助手说】八段锦很适合，继续打就好；可以记录每次练完的感受，复诊带给医生看
→ 输出：[{"problem":"内分泌治疗初期情绪低落","finalPlan":"记录每次练八段锦后的感受，复诊时带给医生看","cadence":"periodic","adoptionStatus":"unknown","outcome":"no_feedback","evidence":{"planQuote":"记录每次练完的感受，复诊带给医生看","adoptionQuote":"","outcomeQuote":""}}]
（为什么："打八段锦"最早是用户自述的习惯→不是 AI 方案，不记、不判 adopted；只保留 AI 额外新提的"记录感受+复诊"；用户没对这个新建议表态→unknown，adoptionQuote 留空）

输入片段 C：
【用户说】每28天打肚皮针，创建提醒
【AI助手说】已设置好，下次提醒6月26日
【用户说】每天三次餐后口服药也提醒
【AI助手说】已设置每日8:30/13:30/18:00提醒
→ 输出：[]
（为什么：全程是"用户发令→AI执行产品功能操作"，没有任何健康干预方案→空）

# 输出
只输出 JSON，不要代码块、不要解释：
{"items":[{"problem":"...","finalPlan":"...","cadence":"periodic","expectedEndAt":"","adoptionStatus":"unknown","outcome":"no_feedback","confidence":75,"evidence":{"planQuote":"...","adoptionQuote":"","outcomeQuote":""}}]}
cadence 只能 oneshot/periodic；adoptionStatus 只能 adopted/rejected/partial/unknown；outcome 只能 improved/unchanged/worsened/no_feedback。
没有可记录的就输出 {"items":[]}。最多 5 条。`
}

export function buildExtractorUserPrompt(input: {
  transcript: string
  existingRecords: EfficacyRecord[]
  now: Date
}): string {
  const existing = input.existingRecords.length
    ? input.existingRecords
        .map((r, i) => `${i + 1}. problem=${r.problem} | finalPlan=${truncate(r.finalPlan, 160)} | 当前采纳=${r.adoptionStatus} | 当前效果=${r.outcome}`)
        .join('\n')
    : '无'
  return `以下是【一个乳腺健康医疗 Agent 与一位患者对话问诊】的记录片段（按时间升序，可能只是整段问诊的增量部分）。记录里用分隔线隔开每条消息：标【用户说】的是患者本人，标【AI助手说】的是医疗 Agent。请记住：只有【用户说】块能作为采纳/疗效的依据，【AI助手说】块是方案来源、绝不能当成患者的采纳或反馈。

当前时间：${input.now.toISOString()}

【本次待分析对话记录】：
${truncate(input.transcript, MAX_TRANSCRIPT_CHARS)}

【该用户已有的疗效档案】（供你判断：本片段里的反馈是不是在回应这些历史方案；如果是，请输出 problem 与之对应的更新候选）：
${existing}`
}

export function buildMatchSystemPrompt(): string {
  return `你在做"问题维度配对"。给你一个新的健康问题候选，和该用户已有的疗效档案问题列表（每条有 id 和 problem 短描述）。请判断这个新候选是否在描述【同一个身体问题】（同一部位、同一症状/诱因，措辞不同也算）。

- 是同一个问题：输出该条的 id。
- 不同部位、不同症状、不同诱因、或全新问题：输出 "none"。
- 宁可保守：不确定就 none。

只输出 JSON：{"matchId":"<id>"} 或 {"matchId":"none"}`
}

export function buildMatchUserPrompt(
  candidate: EfficacyCandidate,
  records: Array<{ id: string; problem: string; status: string }>,
): string {
  const list = records.map((r) => `- id=${r.id} [${r.status}] ${r.problem}`).join('\n')
  return `新候选问题：${candidate.problem}

已有疗效档案问题列表：
${list}`
}

export function buildLifecycleSystemPrompt(): string {
  return `你判断一个新的"疗效方案候选"如何融入用户已有疗效档案，目标是让疗效清单按问题维度自演化，而不是堆重复碎片。

判定"是否同一条"要严格：必须是【同一个身体问题的同一个方案】才算同一条。下列情况都算【不同问题】，应 create，不要 update 去硬拼：
- 不同部位（如"患侧肩痛" vs "健侧肩痛"）
- 不同诱因或不同问题（如"潮热失眠" vs "情绪低落"，"便秘肛裂" vs "钙片副作用"）
- 同一问题但 AI 给的是另一套独立方案

规则：
- 同一问题的同一方案，且新候选带来了采纳或效果的进展（历史 unknown→现在 adopted/rejected/partial、no_feedback→improved/unchanged/worsened）：输出 update，targetId 指向它，给出推进后的 adoptionStatus/outcome 和（仅在确需修订时给的）finalPlan。不要因为又聊了一次就把两段方案文字拼接膨胀——finalPlan 保持最精炼的最终方案即可。
- 新候选是全新问题、不同部位、或同一问题下明显不同的另一套方案：输出 create。
- 已有 record 已覆盖该候选、且采纳/效果没有任何新进展：输出 skip。不要做没有状态变化的无意义 update。
- 采纳/效果状态只能在用户有新的明确表述时推进；没有新表述就保留历史状态、输出 skip。
- 不做医学判断。

只输出 JSON：
{"action":"skip"}
{"action":"create"}
{"action":"update","targetId":"<id>","adoptionStatus":"adopted","outcome":"improved","finalPlan":"（仅在确需修订时给，否则省略此字段）","evidence":{"adoptionQuote":"...","outcomeQuote":"..."}}`
}

export function buildLifecycleUserPrompt(candidate: EfficacyCandidate, recalled: EfficacyRecord[]): string {
  const existing = recalled
    .map((r) => `id=${r.id}\nproblem=${r.problem}\nfinalPlan=${truncate(r.finalPlan, 200)}\n当前采纳=${r.adoptionStatus} 当前效果=${r.outcome}`)
    .join('\n\n')
  return `新候选：
problem=${candidate.problem}
finalPlan=${candidate.finalPlan}
adoptionStatus=${candidate.adoptionStatus} outcome=${candidate.outcome}

已有疗效档案（候选集合）：
${existing}`
}

// ----- 解析 / 归一 -----

export function parseEfficacyJson(raw: string): Record<string, unknown> | null {
  const s = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
  try { return JSON.parse(s) as Record<string, unknown> } catch {
    const a = s.indexOf('{'), b = s.lastIndexOf('}')
    if (a < 0 || b <= a) return null
    try { return JSON.parse(s.slice(a, b + 1)) as Record<string, unknown> } catch { return null }
  }
}

/**
 * 采纳/疗效原话必须出自患者本人的【用户说】。模型偶尔会把【AI助手说】里的方案原话
 * 误抄进 adoptionQuote/outcomeQuote，导致把 AI 的建议当成患者采纳。这里做"原话落地"
 * 校验：把 quote 与"用户原话合集"都归一化（去空白+标点）后判子串，不命中即视为无依据。
 * 空 quote 无需校验（返回 true）；userText 为空（未提供上下文）时不做校验（返回 true）。
 */
export function quoteIsGrounded(quote: string, userText: string): boolean {
  if (!quote) return true
  if (!userText) return true
  const norm = (s: string) => s.replace(/[\s\p{P}\p{S}]/gu, '')
  const q = norm(quote)
  if (!q) return true
  return norm(userText).includes(q)
}

export function normalizeEfficacyItems(raw: string, userText?: string): EfficacyCandidate[] {
  const parsed = parseEfficacyJson(raw)
  const items = Array.isArray((parsed as { items?: unknown[] } | null)?.items) ? (parsed as { items: unknown[] }).items : []
  const out: EfficacyCandidate[] = []
  const seen = new Set<string>()
  for (const it of items) {
    if (!it || typeof it !== 'object') continue
    const rec = it as Record<string, unknown>
    const problem = typeof rec.problem === 'string' ? rec.problem.trim() : ''
    const finalPlan = typeof rec.finalPlan === 'string' ? rec.finalPlan.trim() : ''
    if (problem.length < 4 || finalPlan.length < 4) continue
    const ev = rec.evidence && typeof rec.evidence === 'object' ? rec.evidence as Record<string, unknown> : {}
    let adoptionStatus = ADOPTION_VALUES.has(rec.adoptionStatus as EfficacyAdoptionStatus) ? rec.adoptionStatus as EfficacyAdoptionStatus : 'unknown'
    let outcome = OUTCOME_VALUES.has(rec.outcome as EfficacyOutcome) ? rec.outcome as EfficacyOutcome : 'no_feedback'
    let adoptionQuote = truncate(typeof ev.adoptionQuote === 'string' ? ev.adoptionQuote : '', 200)
    let outcomeQuote = truncate(typeof ev.outcomeQuote === 'string' ? ev.outcomeQuote : '', 200)
    // 原话落地校验：仅当传入 userText 时生效。采纳/疗效非默认值时，必须有「非空且落地」的患者原话；
    // 空 quote 或不落地都降级——堵住「判了采纳/有效却拿不出患者依据」的无依据推进。
    if (userText !== undefined) {
      if (adoptionStatus !== 'unknown' && !(adoptionQuote && quoteIsGrounded(adoptionQuote, userText))) {
        adoptionStatus = 'unknown'
        adoptionQuote = ''
      }
      if (outcome !== 'no_feedback' && !(outcomeQuote && quoteIsGrounded(outcomeQuote, userText))) {
        outcome = 'no_feedback'
        outcomeQuote = ''
      }
    }
    const candidate: EfficacyCandidate = {
      problem: truncate(problem, 200),
      finalPlan: truncate(finalPlan, 600),
      cadence: rec.cadence === 'periodic' ? 'periodic' : 'oneshot',
      expectedEndAt: normalizeDate(rec.expectedEndAt),
      adoptionStatus,
      outcome,
      confidence: clampScore(rec.confidence, 1, 100, 70),
      evidence: {
        planQuote: truncate(typeof ev.planQuote === 'string' ? ev.planQuote : '', 200),
        adoptionQuote,
        outcomeQuote,
      },
    }
    if (seen.has(candidate.problem)) continue
    seen.add(candidate.problem)
    out.push(candidate)
    if (out.length >= 5) break
  }
  return out
}

export function parseMatchId(raw: string): string | null {
  const parsed = parseEfficacyJson(raw)
  const matchId = (parsed as { matchId?: unknown } | null)?.matchId
  if (typeof matchId !== 'string' || !matchId || matchId === 'none') return null
  return matchId
}

export function normalizeLifecycleDecision(raw: string, allowedIds: string[], userText?: string): LifecycleDecision {
  const parsed = parseEfficacyJson(raw)
  const action = typeof (parsed as { action?: unknown } | null)?.action === 'string' ? (parsed as { action: string }).action : 'skip'
  const allowed = new Set(allowedIds)
  if (action === 'create') return { action: 'create' }
  if (action === 'update') {
    const targetIdRaw = (parsed as { targetId?: unknown }).targetId
    const targetId = typeof targetIdRaw === 'string' && allowed.has(targetIdRaw) ? targetIdRaw : undefined
    if (!targetId) return { action: 'skip' }
    const p = parsed as Record<string, unknown>
    const ev = p.evidence && typeof p.evidence === 'object' ? p.evidence as Record<string, unknown> : undefined
    let adoptionStatus = ADOPTION_VALUES.has(p.adoptionStatus as EfficacyAdoptionStatus) ? p.adoptionStatus as EfficacyAdoptionStatus : undefined
    let outcome = OUTCOME_VALUES.has(p.outcome as EfficacyOutcome) ? p.outcome as EfficacyOutcome : undefined
    let adoptionQuote = truncate(typeof ev?.adoptionQuote === 'string' ? ev.adoptionQuote : '', 200) || undefined
    let outcomeQuote = truncate(typeof ev?.outcomeQuote === 'string' ? ev.outcomeQuote : '', 200) || undefined
    // 原话落地校验：采纳/疗效推进必须有「非空且落地」的患者原话；空 quote 或不落地 → 撤销该推进、清空假原话
    //（仅传入 userText 时生效）。堵住 lifecycle 判了采纳/有效却拿不出患者依据的无依据推进。
    if (userText !== undefined) {
      if (adoptionStatus && adoptionStatus !== 'unknown' && !(adoptionQuote && quoteIsGrounded(adoptionQuote, userText))) {
        adoptionStatus = undefined
        adoptionQuote = undefined
      }
      if (outcome && outcome !== 'no_feedback' && !(outcomeQuote && quoteIsGrounded(outcomeQuote, userText))) {
        outcome = undefined
        outcomeQuote = undefined
      }
    }
    return {
      action: 'update',
      targetId,
      finalPlan: typeof p.finalPlan === 'string' && p.finalPlan.trim() ? truncate(p.finalPlan.trim(), 600) : undefined,
      adoptionStatus,
      outcome,
      evidence: ev ? {
        planQuote: truncate(typeof ev.planQuote === 'string' ? ev.planQuote : '', 200) || undefined,
        adoptionQuote,
        outcomeQuote,
      } : undefined,
    }
  }
  return { action: 'skip' }
}

function normalizeDate(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const m = value.match(/^\d{4}-\d{2}-\d{2}/)
  if (!m) return null
  const t = Date.parse(m[0])
  return Number.isFinite(t) ? m[0] : null
}

function clampScore(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.round(value)))
}

function truncate(text: string, maxChars: number): string {
  const trimmed = (text || '').trim()
  if (trimmed.length <= maxChars) return trimmed
  return `${trimmed.slice(0, maxChars)}...`
}
