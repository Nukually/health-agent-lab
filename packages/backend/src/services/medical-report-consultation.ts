import type { ChatMessage, SessionState } from '../state/session.js'
import type { ContentBlock } from '../api/types.js'
import type { Logger } from '../lib/logger.js'
import { llmCallPrimaryOnly } from '../lib/llm.js'
import {
  extractMessageTextContent,
  findLatestRealUserMessageIndex,
  isSyntheticToolAttachmentUserMessage,
} from '../utils/repeated-user-message.js'
import { stripSystemReminderText } from '../utils/system-reminder.js'

export const MEDICAL_REPORT_EXPERT_MODELS = [
  'kimi-k2.6',
  'qwen3.6-plus',
  'kimi-k2.5',
] as const

type MedicalReportExpertModel = typeof MEDICAL_REPORT_EXPERT_MODELS[number]

export interface MedicalReportInput {
  userText: string
  imageBlocks: Array<{ type: 'image_url'; image_url: { url: string } }>
  capturedTimeText: string
}

interface MedicalReportImageGroup {
  imageIndex: number
  imageBlocks: Array<{ type: 'image_url'; image_url: { url: string } }>
}

export interface MedicalReportConsultationToolInput {
  /** 报告原文清晰写出的出具日期，格式 YYYY-MM-DD。兼容 YYYY--MM--DD 输入并归一化。 */
  reportIssuedDate?: string
}

interface ExpertResult {
  model: MedicalReportExpertModel
  ok: boolean
  content?: string
  error?: string
  durationMs: number
}

interface ImageExpertResultGroup {
  imageIndex: number
  results: ExpertResult[]
}

export interface MedicalReportConsultationResult {
  output: string
  imageCount: number
  successCount: number
  durationMs: number
}

export type MedicalReportExpertRunner = (
  model: MedicalReportExpertModel,
  input: MedicalReportInput,
  logger: Logger,
) => Promise<string>

const MAX_EXPERT_RESULT_CHARS = 3_500
const MAX_PARALLEL_MEDICAL_REPORT_IMAGES = 5

function formatShanghaiCurrentTime(now = new Date()): string {
  return now.toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'long',
    hourCycle: 'h23',
  })
}

function getShanghaiDateParts(now = new Date()): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value)
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
  }
}

function formatShanghaiDate(now = new Date()): string {
  const current = getShanghaiDateParts(now)
  return `${String(current.year).padStart(4, '0')}-${String(current.month).padStart(2, '0')}-${String(current.day).padStart(2, '0')}`
}

export function normalizeReportIssuedDate(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  if (!value) return null

  const match = value.match(/^(\d{4})(-{1,2}|\/|\.)(\d{1,2})(?:\2)(\d{1,2})$/)
  if (!match) return null

  const year = Number(match[1])
  const month = Number(match[3])
  const day = Number(match[4])
  const date = new Date(Date.UTC(year, month - 1, day))
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null
  }

  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

export function calculateReportAgeInMonths(
  reportIssuedDate: string,
  now = new Date(),
): { months: number | null; currentDate: string; isFuture: boolean } {
  const normalized = normalizeReportIssuedDate(reportIssuedDate)
  const current = getShanghaiDateParts(now)
  const currentDate = formatShanghaiDate(now)
  if (!normalized) return { months: null, currentDate, isFuture: false }

  const [year, month, day] = normalized.split('-').map(Number)
  let months = (current.year - year) * 12 + (current.month - month)
  if (current.day < day) months -= 1
  if (months < 0) return { months: null, currentDate, isFuture: true }
  return { months, currentDate, isFuture: false }
}

export function formatReportAge(months: number): string {
  if (months <= 0) return '距今 0 个月（未满 1 个月）'
  if (months < 12) return `距今 ${months} 个月`

  const years = Math.floor(months / 12)
  const remainingMonths = months % 12
  return remainingMonths > 0
    ? `距今 ${years} 年 ${remainingMonths} 个月`
    : `距今 ${years} 年`
}

function extractImageBlocks(content: ChatMessage['content']): Array<{ type: 'image_url'; image_url: { url: string } }> {
  if (!Array.isArray(content)) return []
  return content
    .filter((block): block is ContentBlock & { type: 'image_url' } =>
      block.type === 'image_url' && typeof block.image_url?.url === 'string' && block.image_url.url.length > 0,
    )
    .map((block) => ({ type: 'image_url', image_url: { url: block.image_url.url } }))
}

export function extractLatestRealUserMedicalReportInput(session: SessionState): {
  userText: string
  imageBlocks: Array<{ type: 'image_url'; image_url: { url: string } }>
  imageGroups: MedicalReportImageGroup[]
} | null {
  const idx = findLatestRealUserMessageIndex(session.messages)
  if (idx < 0) return null

  const message = session.messages[idx]
  if (isSyntheticToolAttachmentUserMessage(message)) return null

  const imageBlocks = extractImageBlocks(message.content)
  if (imageBlocks.length === 0) return null
  const imageGroups = message.imageBlockGroups?.length
    ? message.imageBlockGroups
        .map((group, index) => ({
          imageIndex: index + 1,
          imageBlocks: group.imageBlocks
            .filter((block) => typeof block.image_url?.url === 'string' && block.image_url.url.length > 0)
            .map((block) => ({ type: 'image_url' as const, image_url: { url: block.image_url.url } })),
        }))
        .filter((group) => group.imageBlocks.length > 0)
    : imageBlocks.map((block, index) => ({ imageIndex: index + 1, imageBlocks: [block] }))

  return {
    userText: stripSystemReminderText(extractMessageTextContent(message.content)).trim(),
    imageBlocks,
    imageGroups: imageGroups.length > 0
      ? imageGroups
      : imageBlocks.map((block, index) => ({ imageIndex: index + 1, imageBlocks: [block] })),
  }
}

function buildExpertSystemPrompt(model: MedicalReportExpertModel): string {
  return `你是“病历解读协会”的专家模型 ${model}，任务是只根据用户本轮上传的病历/检查报告图片做医学知识解读准备。

请严格遵守：
- 只转述图片中清晰可见的原文、日期、数值、单位、阳性/阴性、报告结论；看不清就写“看不清/无法确认”。
- 不根据指标推断报告未明确写明的诊断、转移、确诊阳性/阴性、复发、分期、分子分型或预后好坏。
- 涉及病理、免疫组化、HER2/ER/PR/Ki-67 或治疗决策依据时，只解释一般医学含义，最终以病理科或主治医生意见为准。
- 若图片中有疑似矛盾、异常或录入错误的数字/单位/结论，按图片可见原文记录，并标为“需核对”，不要擅自纠正常见值。
- 不输出时间相关判断；报告日期可以作为图片可见原文记录，但不要计算距今多久、报告新旧、最近/既往或治疗时长。
- 专家结果会交给主 agent 复核；请保持简洁，避免长篇科普。

输出中文，按以下结构：
1. 看清的报告原文/关键事实：最多 8 条，每条包含原文证据。
2. 指标或术语的一般含义：最多 6 条，只讲一般含义，不下诊断。
3. 看不清/有分歧/需要医生核对：最多 6 条。`
}

async function callExpertModel(
  model: MedicalReportExpertModel,
  input: MedicalReportInput,
  logger: Logger,
): Promise<string> {
  const sliceHint = input.imageBlocks.length > 1
    ? `本次随附的 ${input.imageBlocks.length} 张图是同一张长报告的连续切片，请合并阅读，不要当成多份报告。\n`
    : ''
  const response = await llmCallPrimaryOnly(
    {
      model,
      messages: [
        { role: 'system', content: buildExpertSystemPrompt(model) },
        {
          role: 'user',
          content: [
            ...input.imageBlocks,
            {
              type: 'text',
              text: input.userText
                ? `用户原问题：${input.userText}\n${sliceHint}请结合图片按系统要求输出。`
                : `用户只上传了图片。\n${sliceHint}请结合图片按系统要求输出。`,
            },
          ],
        },
      ],
      temperature: 0.6,
      max_tokens: 2200,
      enable_thinking: false,
    },
    logger,
  )

  return response.choices[0]?.message?.content?.trim() || '（该专家模型未返回可用文本）'
}

function truncateExpertContent(content: string): string {
  if (content.length <= MAX_EXPERT_RESULT_CHARS) return content
  return `${content.slice(0, MAX_EXPERT_RESULT_CHARS)}\n[expert_result_truncated: 该专家结果过长，已截断；请不要把截断处当作完整依据。]`
}

function formatExpertResult(result: ExpertResult): string {
  if (!result.ok) {
    return `#### ${result.model}\n- 状态：失败\n- 错误：${result.error ?? '未知错误'}\n- 耗时：${result.durationMs}ms`
  }

  return `#### ${result.model}\n- 状态：成功\n- 耗时：${result.durationMs}ms\n\n${truncateExpertContent(result.content ?? '')}`
}

function formatImageExpertResultGroup(group: ImageExpertResultGroup): string {
  return `### 图片 ${group.imageIndex}：三位专家识别结果\n${group.results.map(formatExpertResult).join('\n\n')}`
}

function buildToolOutput(params: {
  capturedTimeText: string
  reportIssuedDate: string | null
  reportAgeMonths: number | null
  reportAgeCurrentDate: string
  reportAgeIsFuture: boolean
  imageCount: number
  imageResults: ImageExpertResultGroup[]
}): string {
  const totalExpertCount = params.imageCount * MEDICAL_REPORT_EXPERT_MODELS.length
  const successCount = params.imageResults.reduce(
    (sum, group) => sum + group.results.filter((r) => r.ok).length,
    0,
  )
  const expertBlocks = params.imageResults.map(formatImageExpertResultGroup).join('\n\n')
  const reliability =
    successCount >= 2
      ? `本次总计 ${successCount}/${totalExpertCount} 份专家结果返回成功。请主 agent 自己重新对照图片，只输出“自己能看清/确认”且“同一图片的专家结果之间形成共识”的内容。`
      : `本次总计只有 ${successCount}/${totalExpertCount} 份专家结果返回成功，专家依据不足。请主 agent 主要基于图片可见原文谨慎回答，不要把单一专家意见当成事实。`
  const reportAgeText = params.reportIssuedDate
    ? params.reportAgeIsFuture
      ? '无法计算（报告出具日期晚于当前系统日期，请核对报告日期）'
      : params.reportAgeMonths === null
        ? '无法计算（报告出具日期格式异常）'
        : formatReportAge(params.reportAgeMonths)
    : '未计算（工具入参未提供 reportIssuedDate；若图片原文清楚写有报告出具时间，主 agent 应重新调用本工具并传入该日期）'

  return `[medical_report_consultation_board_result]
当前系统时间(time_anchor)：${params.capturedTimeText} Asia/Shanghai
报告出具时间(report_issued_date)：${params.reportIssuedDate ?? '未提供'}
当前系统日期(current_date)：${params.reportAgeCurrentDate}
报告距今(report_age)：${reportAgeText}
本轮图片数量：${params.imageCount}
专家模型：${MEDICAL_REPORT_EXPERT_MODELS.join('、')}
并发策略：工具内部最多同时处理 ${MAX_PARALLEL_MEDICAL_REPORT_IMAGES} 张图片；超过部分已按队列分批处理。同一张长图的多个切片仍归为同一张上传图片。

## 专家结果
${expertBlocks}

## 给主 agent 的安全提醒
- 专家模型也可能看错、漏读或理解错；专家结果不是诊断结论，也不能替代医生判读。
- ${reliability}

基于返回成功专家识别结果之间的共识，结合报告原文，帮患者理解
"这份报告说明了什么、关键指标通常意味着什么、医生还需要结合什么"。

【解读依据】
以返回成功专家结果一致确认、且可在原文核实的内容为准；存在分歧或无法核实的部分标注"待核实"；图像受限区域标注"无法确认"，不做推断。

【时间判断】
报告新旧、治疗阶段等时间信息，只使用工具返回的 time_anchor、report_issued_date、report_age，不使用模型内置日期。

【表达】
- 对每项关键发现说明：该指标的一般临床含义 → 通常辅助判断什么 → 为何还需医生结合病史/影像/病理确认。
- 直接进入主题，不复述专家结果，不把参数列成清单后就结束。`
}

async function runExpertModelsForImage(params: {
  imageIndex: number
  imageBlocks: MedicalReportInput['imageBlocks']
  expertInput: MedicalReportInput
  logger: Logger
  runner: MedicalReportExpertRunner
}): Promise<ImageExpertResultGroup> {
  const imageInput: MedicalReportInput = {
    ...params.expertInput,
    imageBlocks: params.imageBlocks,
  }
  const settled = await Promise.allSettled(
    MEDICAL_REPORT_EXPERT_MODELS.map(async (model): Promise<ExpertResult> => {
      const expertStart = performance.now()
      try {
        const content = await params.runner(
          model,
          imageInput,
          params.logger.child({ imageIndex: params.imageIndex, expertModel: model }),
        )
        return {
          model,
          ok: true,
          content,
          durationMs: Math.round(performance.now() - expertStart),
        }
      } catch (err: any) {
        return {
          model,
          ok: false,
          error: err?.message ?? String(err),
          durationMs: Math.round(performance.now() - expertStart),
        }
      }
    }),
  )

  return {
    imageIndex: params.imageIndex,
    results: settled.map((item, idx) => {
      if (item.status === 'fulfilled') return item.value
      return {
        model: MEDICAL_REPORT_EXPERT_MODELS[idx],
        ok: false,
        error: item.reason?.message ?? String(item.reason),
        durationMs: 0,
      }
    }),
  }
}

export async function runMedicalReportConsultation(
  session: SessionState,
  logger: Logger,
  toolInput: MedicalReportConsultationToolInput = {},
  runner: MedicalReportExpertRunner = callExpertModel,
): Promise<MedicalReportConsultationResult> {
  const start = performance.now()
  const input = extractLatestRealUserMedicalReportInput(session)
  if (!input) {
    return {
      output: '错误：medical_report_consultation_board 只能在本轮真实用户消息包含图片时调用；当前未发现可用于病历解析的本轮图片。请不要继续调用本工具，直接让用户上传清晰的病历/检查报告图片后再解读。',
      imageCount: 0,
      successCount: 0,
      durationMs: Math.round(performance.now() - start),
    }
  }

  const capturedNow = new Date()
  const capturedTimeText = formatShanghaiCurrentTime(capturedNow)
  const reportIssuedDate = normalizeReportIssuedDate(toolInput.reportIssuedDate)
  const reportAge = reportIssuedDate ? calculateReportAgeInMonths(reportIssuedDate, capturedNow) : null
  const expertInput: MedicalReportInput = {
    ...input,
    capturedTimeText,
  }

  const imageResults: ImageExpertResultGroup[] = []
  for (let offset = 0; offset < input.imageGroups.length; offset += MAX_PARALLEL_MEDICAL_REPORT_IMAGES) {
    const imageBatch = input.imageGroups.slice(offset, offset + MAX_PARALLEL_MEDICAL_REPORT_IMAGES)
    const batchResults = await Promise.all(
      imageBatch.map((group) =>
        runExpertModelsForImage({
          imageIndex: group.imageIndex,
          imageBlocks: group.imageBlocks,
          expertInput,
          logger,
          runner,
        }),
      ),
    )
    imageResults.push(...batchResults)
  }
  const successCount = imageResults.reduce(
    (sum, group) => sum + group.results.filter((r) => r.ok).length,
    0,
  )

  logger.info(
    {
      imageCount: input.imageBlocks.length,
      successCount,
      totalExpertCount: input.imageGroups.length * MEDICAL_REPORT_EXPERT_MODELS.length,
      totalImageBlockCount: input.imageBlocks.length,
      maxParallelImages: MAX_PARALLEL_MEDICAL_REPORT_IMAGES,
      models: MEDICAL_REPORT_EXPERT_MODELS,
      durationMs: Math.round(performance.now() - start),
    },
    'medical report consultation completed',
  )

  return {
    output: buildToolOutput({
      capturedTimeText,
      reportIssuedDate,
      reportAgeMonths: reportAge?.months ?? null,
      reportAgeCurrentDate: reportAge?.currentDate ?? formatShanghaiDate(capturedNow),
      reportAgeIsFuture: reportAge?.isFuture ?? false,
      imageCount: input.imageGroups.length,
      imageResults,
    }),
    imageCount: input.imageGroups.length,
    successCount,
    durationMs: Math.round(performance.now() - start),
  }
}
