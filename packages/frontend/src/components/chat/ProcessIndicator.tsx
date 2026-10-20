/**
 * ProcessIndicator — 思考过程指示器
 *
 * 内联：迷你文字条（流式：橙 spinner + 当前阶段名 shimmer 流光 + 实时叙述；完成态：助手点 + 语义概要 + chevron）
 * 点击：打开 BottomSheet 查看完整时间线（思考过程）
 *
 * 数据来源：
 * - 流式 / 历史 → 系统派生的 ProcessStep（text 叙述 / tool_call / tool_plan / doc_view / protocol_recovery）
 * - legacy 兜底 → 老消息的 message.thinking（含 <phase> 协议）走 thinking 解析
 */

import { useState, useEffect, useRef } from 'react'
import type { ProcessStep } from '../../stores/slices/chat.js'
import type { AskUserQuestionItem, AskUserQuestionToolOutput, MedicalLiteratureSearchOutput, MedicalLiteratureSource, ToolCallRecord } from '@health-agent/shared'
import { getToolUiMeta, parseMedicalRiskToolOutput } from '@health-agent/shared'
import BottomSheet from '../ui/BottomSheet.js'
import AskUserQuestionTimelineContent from './AskUserQuestionTimelineContent.js'
import { MedicalLiteratureSourceContent } from '../../lib/a2ui/components/MedicalLiteratureSourceDialog.js'
import {
  cleanThinkingContent,
  displayPhasePill,
  extractActivePhase,
  makeThinkingSummary,
  parseThinkingTimeline,
  splitPersistedThinkingParts,
  type ThinkingTimelineItem,
} from './thinkingPhaseParser.js'

// ─── Helpers ───

const TOOL_MIN_VISUAL_MS = 600
const NARRATION_PREVIEW_INTERVAL_MS = 600
const NARRATION_PREVIEW_MAX_CHARS = 96
const SUMMARY_MAX_PARTS = 4

function toolLabel(name: string): string {
  return getToolUiMeta(name).title
}

/** 从 ask_user_question 工具 output 取出原始问题+选项（历史/分享页已持久化在 tool_call.output）。 */
function parseAskUserQuestionOutput(output: unknown): AskUserQuestionItem[] | null {
  if (!output || typeof output !== 'object') return null
  const raw = output as Partial<AskUserQuestionToolOutput>
  if (raw.kind !== 'ask_user_question' || !Array.isArray(raw.questions)) return null
  const questions = raw.questions.filter(
    (q): q is AskUserQuestionItem => Boolean(q?.question) && Array.isArray(q?.options) && q.options.length > 0,
  )
  return questions.length > 0 ? questions : null
}

function toolActiveLabel(name: string): string {
  return getToolUiMeta(name).activeLabel
}

function toolDetailText(name: string): string {
  return getToolUiMeta(name).detailText
}

function toolDoneLabel(name: string): string {
  return getToolUiMeta(name).doneLabel
}

function toolTimelineText(name: string, isActive: boolean): string {
  return isActive ? toolDetailText(name) : toolDoneLabel(name)
}

function toolErrorText(output: unknown): string | null {
  if (typeof output !== 'string') return null
  const trimmed = output.trim()
  if (/^(错误|Error|工具执行失败|参数格式错误|.{0,12}失败[：:])/.test(trimmed)) return trimmed
  return null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function textValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function formatScheduledTime(value: unknown): string | null {
  const raw = textValue(value)
  if (!raw) return null
  const date = new Date(raw)
  if (!Number.isFinite(date.getTime())) return raw
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date)
}

function scheduledTaskTimelineText(
  name: string | undefined,
  isActive: boolean,
  input: unknown,
  output: unknown,
): string | null {
  if (!name || !['schedule', 'list_scheduled_tasks', 'add_scheduled_task', 'update_scheduled_task'].includes(name)) {
    return null
  }

  const inputRecord = asRecord(input)
  const outputRecord = asRecord(output)
  const scheduleAction = textValue(outputRecord?.action) ?? textValue(inputRecord?.action)

  if (name === 'list_scheduled_tasks' || scheduleAction === 'list') {
    const tasks = Array.isArray(outputRecord?.tasks) ? outputRecord.tasks : []
    if (tasks.length === 0) return isActive ? toolDetailText(name) : '当前没有未来提醒'
    return `已查看 ${tasks.length} 个未来提醒`
  }

  const taskName =
    textValue(outputRecord?.taskName) ??
    textValue(inputRecord?.taskName) ??
    textValue(inputRecord?.task) ??
    null
  const dueAt =
    formatScheduledTime(outputRecord?.dueAt) ??
    formatScheduledTime(inputRecord?.dueAt) ??
    formatScheduledTime(inputRecord?.time)
  const status = textValue(outputRecord?.status)

  const parts: string[] = []
  if (scheduleAction === 'delete' || status === 'deleted') {
    parts.push('已取消提醒')
  }
  if (taskName) parts.push(`主题：${taskName}`)
  if (dueAt) parts.push(`提醒时间：${dueAt}`)

  if (parts.length > 0) return parts.join('\n')
  return toolTimelineText(name, isActive)
}

function medicalRiskTimelineText(
  name: string | undefined,
  isActive: boolean,
  input: unknown,
): string | null {
  if (name !== 'grade_medical_risk') return null

  const inputRecord = asRecord(input)
  const analysis = textValue(inputRecord?.analysis) ?? textValue(inputRecord?.reason)
  const level = textValue(inputRecord?.level)
  const category = textValue(inputRecord?.category)
  const ragQuery = textValue(inputRecord?.ragQuery)
  const searchQuery = textValue(inputRecord?.searchQuery)

  const parts: string[] = []
  if (analysis) parts.push(`分析：${analysis}`)
  if (level) parts.push(`分级：${level}`)
  if (category) parts.push(`类型：${category}`)
  if (ragQuery) parts.push(`知识库：${ragQuery}`)
  if (searchQuery) parts.push(`资源搜索：${searchQuery}`)

  if (parts.length > 0) return parts.join('\n')
  return isActive ? toolDetailText(name) : toolDoneLabel(name)
}

/** load_skill：用具体技能名替代通用文案，如「已加载副作用疗程管理技能」。 */
function loadSkillTimelineText(name: string | undefined, isActive: boolean, input: unknown): string | null {
  if (name !== 'load_skill') return null
  const displayName = input && typeof input === 'object'
    ? (input as { displayName?: unknown }).displayName
    : undefined
  if (typeof displayName !== 'string' || !displayName) return null
  return isActive ? `加载${displayName}技能中...` : `已加载${displayName}技能`
}

function parseMedicalLiteratureOutput(output: unknown): MedicalLiteratureSearchOutput | null {
  return parseMedicalRiskToolOutput(output)?.literatureSearch ?? null
}

function medicalLiteratureSummary(output: MedicalLiteratureSearchOutput | null, isActive: boolean): string {
  if (!output) return isActive ? '正在检索医学资料' : '已检索医学资料'
  const searched = output.candidateCount ?? output.scoreQualifiedCount ?? output.searchedCount
  return `搜索 ${searched} 篇文献，返回 ${output.selectedCount} 篇相关`
}

function isStreamingActiveStep(step: DisplayStep, now: number): boolean {
  if (step.isActive) return true
  if (step.type !== 'tool_call' || step.timestamp == null) return false
  const durationMs = step.toolDuration ?? 0
  return now < step.timestamp + Math.max(durationMs, TOOL_MIN_VISUAL_MS)
}

function protocolRecoveryTitle(reason?: string): string {
  if (reason === 'duplicate_answer_prefix') return '调整回答角度'
  if (reason === 'xml_tool_call_in_answer' || reason === 'xml_tool_call_in_final_answer') return '修正工具调用'
  if (reason === 'missing_final_answer') return '重新整理回答'
  if (reason === 'dangling_reference') return '重新匹配资源'
  return '修正输出格式'
}

function protocolRecoveryActiveLabel(reason?: string): string {
  return `${protocolRecoveryTitle(reason)}中...`
}

function protocolRecoveryDetail(reason?: string): string {
  if (reason === 'duplicate_answer_prefix') return '上一版回答与前文过于相似，已自动换一个角度重新组织。'
  if (reason === 'xml_tool_call_in_answer' || reason === 'xml_tool_call_in_final_answer') return '模型把工具调用写进了正文，已自动修正后继续。'
  if (reason === 'missing_final_answer') return '模型输出格式不完整，已自动整理后继续回答。'
  if (reason === 'dangling_reference') return '模型引用了还没取到的资源，已自动重新匹配后继续。'
  return '模型输出触发了协议修正，已自动恢复并继续。'
}

function nextStreamingToolExpiry(steps: DisplayStep[], now: number): number | null {
  let minDelay: number | null = null
  for (const step of steps) {
    if (step.isActive || step.type !== 'tool_call' || step.timestamp == null) continue
    const durationMs = step.toolDuration ?? 0
    const delay = step.timestamp + Math.max(durationMs, TOOL_MIN_VISUAL_MS) - now
    if (delay <= 0) continue
    if (minDelay == null || delay < minDelay) minDelay = delay
  }
  return minDelay
}

function clampNarrationPreview(line: string): string {
  const normalized = line.replace(/\s+/g, ' ').trim()
  if (normalized.length <= NARRATION_PREVIEW_MAX_CHARS) return normalized
  return `...${normalized.slice(-NARRATION_PREVIEW_MAX_CHARS)}`
}

function latestNonEmptyLine(content: string): string {
  const lines = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  return lines[lines.length - 1] ?? ''
}

/** 流式实时预览：从最后一个 thinking（隐藏思考）节点取最新一行，作为「仍在思考」的滚动文字。 */
function latestThinkingPreviewLine(steps: DisplayStep[]): string {
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i]
    if (step.type !== 'thinking') continue
    const latestPhase = step.thinkingTimeline?.[step.thinkingTimeline.length - 1]
    const source = latestPhase?.content || cleanThinkingContent(step.rawContent || step.content)
    const latest = latestNonEmptyLine(source)
    if (latest) return clampNarrationPreview(latest)
  }
  return ''
}

/** 流式实时预览兜底：无 thinking 节点时，从最后一个 text（中间叙述）节点取最新一行。 */
function latestNarrationPreviewLine(steps: DisplayStep[]): string {
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i]
    if (step.type !== 'text') continue
    const latest = latestNonEmptyLine(step.content)
    if (latest) return clampNarrationPreview(latest)
  }
  return ''
}

/** 流式预览取值：优先隐藏 thinking 的最新一行；无 thinking 时回退到中间叙述。 */
function latestStreamingPreviewLine(steps: DisplayStep[]): string {
  return latestThinkingPreviewLine(steps) || latestNarrationPreviewLine(steps)
}

/** 完成态语义概要：把过程节点的工具/动作标题串成「风险分级 · 检索资料 · 跟练计划」。 */
function completedProcessSummary(steps: DisplayStep[]): string | null {
  const summaries: string[] = []
  for (const step of steps) {
    let label: string | null = null
    if (step.type === 'tool_call' && step.toolName) label = toolLabel(step.toolName)
    else if (step.type === 'doc_view') label = '查看病历'
    else if (step.type === 'protocol_recovery') label = protocolRecoveryTitle(step.protocolReason)
    else if (step.type === 'thinking' && step.summary && step.summary !== '方案规划') label = step.summary
    if (!label) continue
    if (!summaries.includes(label)) summaries.push(label)
  }
  if (summaries.length === 0) return null
  return summaries.slice(0, SUMMARY_MAX_PARTS).join(' · ')
}

function useThrottledText(value: string, delayMs: number): string {
  const [displayed, setDisplayed] = useState(value)
  const latestRef = useRef(value)
  const timerRef = useRef<number | null>(null)

  useEffect(() => {
    latestRef.current = value

    if (!value) {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current)
        timerRef.current = null
      }
      setDisplayed('')
      return
    }

    if (value === displayed || timerRef.current !== null) return
    if (!displayed) {
      setDisplayed(value)
      return
    }

    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      setDisplayed(latestRef.current)
    }, delayMs)
  }, [delayMs, displayed, value])

  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
  }, [])

  return displayed
}

/** 流式 pill 文案：根据最后一个活跃 step 选择 "{工具名}中..." / "思考中..." */
function activeStreamingLabel(steps: DisplayStep[], now: number): string {
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i]
    if (!isStreamingActiveStep(s, now)) continue
    if (s.type === 'tool_call' && s.toolName) {
      return toolActiveLabel(s.toolName)
    }
    if (s.type === 'doc_view') {
      return '查看病历图片中...'
    }
    if (s.type === 'protocol_recovery') {
      return protocolRecoveryActiveLabel(s.protocolReason)
    }
    if (s.type === 'tool_plan' && s.toolName) {
      return '工具规划中...'
    }
    if (s.type === 'thinking') {
      const phase = extractActivePhase(s.rawContent || '')
      if (phase) return displayPhasePill(phase) ?? '思考中...'
      return '思考中...'
    }
  }
  return '思考中...'
}

function stickyStreamingLabel(
  steps: DisplayStep[],
  answerStartedAt?: number | null,
  now?: number,
): string | null {
  if (answerStartedAt != null) return null
  if (now != null && steps.some((step) => isStreamingActiveStep(step, now))) return null

  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i]
    if (step.type === 'tool_call' && step.toolName) {
      return toolActiveLabel(step.toolName)
    }
    if (step.type === 'doc_view') {
      return '查看病历图片中...'
    }
    if (step.type === 'protocol_recovery') {
      return protocolRecoveryActiveLabel(step.protocolReason)
    }
    if (step.type === 'tool_plan' && step.toolName) {
      return '工具规划中...'
    }
    if (step.type === 'thinking') {
      const phase = extractActivePhase(step.rawContent || '')
      return phase ? displayPhasePill(phase) ?? '思考中...' : '思考中...'
    }
  }

  return steps.length > 0 ? '思考中...' : null
}

// ─── Display step model (unifies streaming + finalized + legacy) ───

interface DisplayStep {
  type: 'thinking' | 'tool_plan' | 'tool_call' | 'text' | 'doc_view' | 'protocol_recovery'
  summary: string
  content: string
  rawContent?: string
  thinkingTimeline?: ThinkingTimelineItem[]
  toolName?: string
  toolInput?: unknown
  toolOutput?: unknown
  toolDuration?: number
  isActive: boolean
  timestamp?: number
  docTitles?: Array<string | null>
  docCount?: number
  protocolReason?: string
  retryAttempt?: number
}

function buildThinkingStep(
  rawContent: string,
  isActive: boolean,
  timestamp?: number,
): DisplayStep {
  return {
    type: 'thinking',
    summary: makeThinkingSummary(rawContent),
    content: cleanThinkingContent(rawContent),
    rawContent,
    thinkingTimeline: parseThinkingTimeline(rawContent, isActive),
    isActive,
    timestamp,
  }
}

function buildToolStep(tc: ToolCallRecord): DisplayStep {
  return {
    type: 'tool_call',
    summary: toolLabel(tc.name),
    content: '',
    toolName: tc.name,
    toolInput: tc.input,
    toolOutput: tc.output,
    toolDuration: tc.durationMs,
    isActive: false,
  }
}

/** 系统派生过程节点 → DisplayStep（end2end：text 是中间叙述纯文本，不是 thinking 协议）。 */
function buildFromProcessSteps(steps: ProcessStep[]): DisplayStep[] {
  return steps.map((s) => {
    if (s.type === 'thinking') {
      return buildThinkingStep(s.content, s.isActive, s.timestamp)
    }
    if (s.type === 'tool_plan') {
      const content = s.content || (s.toolName ? `准备调用：${toolLabel(s.toolName)}` : '')
      return {
        type: 'tool_plan' as const,
        summary: s.toolName ? `工具规划：${toolLabel(s.toolName)}` : '工具规划',
        content,
        toolName: s.toolName,
        isActive: s.isActive,
        timestamp: s.timestamp,
      }
    }
    if (s.type === 'tool_call') {
      return {
        type: 'tool_call' as const,
        summary: toolLabel(s.name),
        content: '',
        toolName: s.name,
        toolInput: s.input,
        toolOutput: s.output,
        toolDuration: s.durationMs,
        isActive: s.isActive,
        timestamp: s.timestamp,
      }
    }
    if (s.type === 'doc_view') {
      const names = s.titles.map((t) => t ?? '未命名文档')
      const summary = names.length > 0
        ? `查看病历 ${names.join('、')}`
        : `查看 ${s.count} 份病历原图`
      return {
        type: 'doc_view' as const,
        summary,
        content: '',
        isActive: s.isActive,
        timestamp: s.timestamp,
        docTitles: s.titles,
        docCount: s.count,
      }
    }
    if (s.type === 'protocol_recovery') {
      return {
        type: 'protocol_recovery' as const,
        summary: protocolRecoveryTitle(s.reason),
        content: protocolRecoveryDetail(s.reason),
        protocolReason: s.reason,
        retryAttempt: s.retryAttempt,
        isActive: s.isActive,
        timestamp: s.timestamp,
      }
    }
    // text（中间叙述）：纯文本节点，无 isActive
    return {
      type: 'text' as const,
      summary: s.content.length > 40 ? s.content.slice(0, 40) + '...' : s.content,
      content: s.content,
      isActive: false,
      timestamp: s.timestamp,
    }
  })
}

/** legacy 兜底：老消息只有 message.thinking（可能含 <phase> 协议）+ toolCalls。 */
function buildFromMessage(
  thinking: string | null | undefined,
  toolCalls: ToolCallRecord[] | null | undefined,
): DisplayStep[] {
  const steps: DisplayStep[] = []
  const calls = toolCalls ?? []
  if (thinking) {
    const thinkingParts = splitPersistedThinkingParts(thinking)
    if (thinkingParts.length > 1) {
      thinkingParts.forEach((part, index) => {
        steps.push(buildThinkingStep(part, false))
        if (calls[index]) steps.push(buildToolStep(calls[index]))
      })
      for (let i = thinkingParts.length; i < calls.length; i++) {
        steps.push(buildToolStep(calls[i]))
      }
      return steps
    }
    steps.push(buildThinkingStep(thinking, false))
  }
  for (const tc of calls) {
    steps.push(buildToolStep(tc))
  }
  return steps
}

// ─── Sub-components ───

function OrangeSpinner({ size = 16 }: { size?: number }) {
  return (
    <div className="orange-spinner" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="12" r="10" fill="#F5A623" />
        <circle cx="12" cy="12" r="8.5" fill="#FFF5EE" />
        <line x1="12" y1="3.5" x2="12" y2="20.5" stroke="#F5A623" strokeWidth="0.6" />
        <line x1="4.6" y1="7.75" x2="19.4" y2="16.25" stroke="#F5A623" strokeWidth="0.6" />
        <line x1="4.6" y1="16.25" x2="19.4" y2="7.75" stroke="#F5A623" strokeWidth="0.6" />
        <path d="M12 12 L12 3.5 A8.5 8.5 0 0 1 19.4 7.75 Z" fill="#FDBA74" opacity="0.6" />
        <path d="M12 12 L19.4 7.75 A8.5 8.5 0 0 1 19.4 16.25 Z" fill="#FB923C" opacity="0.5" />
        <path d="M12 12 L19.4 16.25 A8.5 8.5 0 0 1 12 20.5 Z" fill="#FDBA74" opacity="0.6" />
        <path d="M12 12 L12 20.5 A8.5 8.5 0 0 1 4.6 16.25 Z" fill="#FB923C" opacity="0.5" />
        <path d="M12 12 L4.6 16.25 A8.5 8.5 0 0 1 4.6 7.75 Z" fill="#FDBA74" opacity="0.6" />
        <path d="M12 12 L4.6 7.75 A8.5 8.5 0 0 1 12 3.5 Z" fill="#FB923C" opacity="0.5" />
        <circle cx="12" cy="12" r="1.8" fill="#FFF5EE" />
      </svg>
    </div>
  )
}

function ChevronRight({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="var(--color-text-muted)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, opacity: 0.7 }}>
      <polyline points="9 18 15 12 9 6" />
    </svg>
  )
}

// ─── Timeline view (inside bottom sheet) ───

type ProcessTimelineEntryType = 'thinking' | 'tool_plan' | 'tool_call' | 'text' | 'doc_view' | 'protocol_recovery' | 'complete'

interface ProcessTimelineEntry {
  key: string
  type: ProcessTimelineEntryType
  title: string
  content: React.ReactNode
  isActive: boolean
  toolName?: string
  collapsible: boolean
  contentKind?: 'text' | 'pill' | 'literature'
}

function docViewLine(step: DisplayStep): string {
  const titles = step.docTitles ?? []
  if (titles.length > 0) {
    return `已附加病历：${titles.map((t) => t ?? '未命名文档').join('、')}`
  }
  return `已附加 ${step.docCount ?? 0} 份病历原图`
}

function buildTimelineEntries(
  steps: DisplayStep[],
  isStreaming: boolean,
  onOpenLiteratureSource: (source: MedicalLiteratureSource) => void,
  showCompleteNode: boolean,
  renderToolEntryCard?: (toolName: string, isActive: boolean) => React.ReactNode | null,
  askUserQuestionAnswerText?: string,
): ProcessTimelineEntry[] {
  const entries: ProcessTimelineEntry[] = []

  steps.forEach((step, stepIndex) => {
    if (step.type === 'thinking') {
      const phases = step.thinkingTimeline ?? []
      if (phases.length > 0) {
        phases.forEach((phase, phaseIndex) => {
          entries.push({
            key: `thinking-${stepIndex}-${phase.phase}-${phaseIndex}`,
            type: 'thinking',
            title: phase.title,
            content: phase.content || (phase.isActive ? '...' : ''),
            isActive: phase.isActive,
            collapsible: true,
          })
        })
        return
      }

      entries.push({
        key: `thinking-${stepIndex}`,
        type: 'thinking',
        title: step.summary || '思考过程',
        content: step.content || (step.isActive ? '...' : ''),
        isActive: step.isActive,
        collapsible: true,
      })
      return
    }

    if (step.type === 'tool_call') {
      if (step.toolName === 'medical_literature_search') {
        const literatureOutput = parseMedicalLiteratureOutput(step.toolOutput)
        entries.push({
          key: `tool-${step.toolName}-${stepIndex}`,
          type: 'tool_call',
          title: toolLabel(step.toolName),
          content: (
            <MedicalLiteratureTimelineContent
              output={literatureOutput}
              isActive={step.isActive}
              onOpenSource={onOpenLiteratureSource}
            />
          ),
          isActive: step.isActive,
          toolName: step.toolName,
          collapsible: false,
          contentKind: 'literature',
        })
        return
      }

      // 需求确认：回显 AI 原始问题+选项+用户最终勾选（问题/选项已持久化在 tool_call.output）
      if (step.toolName === 'ask_user_question' && !step.isActive) {
        const askQuestions = parseAskUserQuestionOutput(step.toolOutput)
        if (askQuestions) {
          entries.push({
            key: `tool-${step.toolName}-${stepIndex}`,
            type: 'tool_call',
            title: toolLabel(step.toolName),
            content: (
              <AskUserQuestionTimelineContent
                questions={askQuestions}
                answerText={askUserQuestionAnswerText}
              />
            ),
            isActive: step.isActive,
            toolName: step.toolName,
            collapsible: true,
            contentKind: 'literature',
          })
          return
        }
      }

      // 业务卡片注入（如病历解读完成卡）：由 AssistantMessage 提供，替代米色文字摘要
      const injectedCard = step.toolName && !step.isActive
        ? renderToolEntryCard?.(step.toolName, step.isActive)
        : null
      if (injectedCard) {
        entries.push({
          key: `tool-${step.toolName ?? 'unknown'}-${stepIndex}`,
          type: 'tool_call',
          title: step.toolName ? toolLabel(step.toolName) : '工具调用',
          content: injectedCard,
          isActive: step.isActive,
          toolName: step.toolName,
          collapsible: false,
          contentKind: 'literature',
        })
        return
      }

      const medicalRiskContent = medicalRiskTimelineText(
        step.toolName,
        step.isActive,
        step.toolInput,
      )
      const loadSkillContent = loadSkillTimelineText(step.toolName, step.isActive, step.toolInput)
      const content = scheduledTaskTimelineText(
        step.toolName,
        step.isActive,
        step.toolInput,
        step.toolOutput,
      )
      const errorContent = step.isActive ? null : toolErrorText(step.toolOutput)
      entries.push({
        key: `tool-${step.toolName ?? 'unknown'}-${stepIndex}`,
        type: 'tool_call',
        title: step.toolName ? toolLabel(step.toolName) : '工具调用',
        content: errorContent ?? medicalRiskContent ?? loadSkillContent ?? content ?? (step.toolName ? toolTimelineText(step.toolName, step.isActive) : '正在处理相关步骤。'),
        isActive: step.isActive,
        toolName: step.toolName,
        collapsible: true,
        contentKind: 'pill',
      })
      return
    }

    if (step.type === 'tool_plan') {
      entries.push({
        key: `tool-plan-${stepIndex}`,
        type: 'tool_plan',
        title: step.toolName ? `工具规划：${toolLabel(step.toolName)}` : '工具规划',
        content: step.content || (step.toolName ? `准备调用：${toolLabel(step.toolName)}` : ''),
        isActive: step.isActive,
        collapsible: true,
      })
      return
    }

    if (step.type === 'doc_view') {
      entries.push({
        key: `doc-view-${stepIndex}`,
        type: 'doc_view',
        title: '查看病历原图',
        content: docViewLine(step),
        isActive: step.isActive,
        collapsible: true,
      })
      return
    }

    if (step.type === 'protocol_recovery') {
      entries.push({
        key: `protocol-recovery-${step.protocolReason ?? 'unknown'}-${stepIndex}`,
        type: 'protocol_recovery',
        title: step.summary,
        content: step.content,
        isActive: step.isActive,
        collapsible: true,
      })
      return
    }

    // text（中间叙述）：作为「处理思路」纯文本展示
    if (step.type === 'text') {
      const content = step.content.trim()
      if (!content) return
      entries.push({
        key: `text-${stepIndex}`,
        type: 'text',
        title: '处理思路',
        content,
        isActive: false,
        collapsible: true,
      })
    }
  })

  if (!isStreaming && showCompleteNode && entries.length > 0) {
    entries.push({
      key: 'complete',
      type: 'complete',
      title: '完成',
      content: '',
      isActive: false,
      collapsible: false,
    })
  }

  return entries
}

function ChevronToggle({ open }: { open: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="var(--color-text-muted)"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{
        flexShrink: 0,
        transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
        transition: 'transform 0.16s ease',
      }}
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  )
}

/** Step icon for timeline view */
function StepIcon({
  type,
  name,
  title,
  isActive,
}: {
  type: ProcessTimelineEntryType
  name?: string
  title: string
  isActive: boolean
}) {
  const stroke = isActive ? 'var(--color-primary)' : 'var(--color-primary-dark)'

  if (type === 'complete') {
    return (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
        <circle cx="12" cy="12" r="9" />
        <polyline points="8 12.5 10.8 15.2 16.5 8.8" />
      </svg>
    )
  }

  if (type === 'tool_call') {
    // Globe for search-like tools
    if (name && (name.includes('search') || name.includes('web'))) {
      return (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
          <circle cx="12" cy="12" r="10" />
          <line x1="2" y1="12" x2="22" y2="12" />
          <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
        </svg>
      )
    }
    // Gear for other tools
    return (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </svg>
    )
  }

  if (type === 'doc_view' || title.includes('下一步')) {
    return (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
        <path d="M6 3h9l3 3v15H6z" />
        <path d="M14 3v4h4" />
        <path d="M9 11h6" />
        <path d="M9 15h6" />
      </svg>
    )
  }

  if (type === 'text') {
    return (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
        <path d="M5 6h14" />
        <path d="M5 12h14" />
        <path d="M5 18h10" />
      </svg>
    )
  }

  // Thinking / protocol_recovery / tool_plan: filled circle
  return (
    <div style={{
      width: 10,
      height: 10,
      borderRadius: 5,
      background: stroke,
      flexShrink: 0,
      ...(isActive ? { animation: 'pulse 1.5s ease-in-out infinite' } : {}),
    }} />
  )
}

function ProcessTimelineSheet({ entries }: { entries: ProcessTimelineEntry[] }) {
  const [collapsedKeys, setCollapsedKeys] = useState<Set<string>>(() => new Set())

  function toggleEntry(key: string) {
    setCollapsedKeys((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  return (
    <div style={sheetStyles.timeline}>
      {entries.map((entry, index) => (
        <ProcessTimelineRow
          key={entry.key}
          entry={entry}
          isLast={index === entries.length - 1}
          isCollapsed={collapsedKeys.has(entry.key)}
          onToggle={() => toggleEntry(entry.key)}
        />
      ))}
    </div>
  )
}

function ProcessTimelineRow({
  entry,
  isLast,
  isCollapsed,
  onToggle,
}: {
  entry: ProcessTimelineEntry
  isLast: boolean
  isCollapsed: boolean
  onToggle: () => void
}) {
  const hasContent = hasTimelineEntryContent(entry.content)
  const canToggle = entry.collapsible && hasContent
  const expanded = !isCollapsed

  return (
    <div style={sheetStyles.item}>
      <div style={sheetStyles.markerCol}>
        <div style={sheetStyles.iconWrap}>
          <StepIcon
            type={entry.type}
            name={entry.toolName}
            title={entry.title}
            isActive={entry.isActive}
          />
        </div>
        {!isLast && <div style={sheetStyles.connector} />}
      </div>

      <div style={sheetStyles.contentCol}>
        <button
          type="button"
          style={{
            ...sheetStyles.header,
            cursor: canToggle ? 'pointer' : 'default',
          }}
          onClick={canToggle ? onToggle : undefined}
          aria-expanded={canToggle ? expanded : undefined}
        >
          <span style={{
            ...sheetStyles.title,
            ...(entry.isActive ? sheetStyles.activeTitle : {}),
          }}>
            {entry.title}
          </span>
          {canToggle && <ChevronToggle open={expanded} />}
        </button>

        {hasContent && expanded && (
          <div
            style={entry.contentKind === 'literature'
              ? sheetStyles.literatureContent
              : entry.type === 'tool_call' || entry.type === 'doc_view'
              ? sheetStyles.oneLine
              : sheetStyles.text}
          >
            {entry.content}
          </div>
        )}
      </div>
    </div>
  )
}

function hasTimelineEntryContent(content: React.ReactNode): boolean {
  if (content == null || content === false) return false
  if (typeof content === 'string') return content.trim().length > 0
  return true
}

function MedicalLiteratureTimelineContent({
  output,
  isActive,
  onOpenSource,
}: {
  output: MedicalLiteratureSearchOutput | null
  isActive: boolean
  onOpenSource: (source: MedicalLiteratureSource) => void
}) {
  const [expanded, setExpanded] = useState(() => !isActive && !!output?.selectedSources.length)
  const sources = output?.selectedSources ?? []
  const summary = medicalLiteratureSummary(output, isActive)

  useEffect(() => {
    if (!isActive && sources.length > 0) setExpanded(true)
  }, [isActive, sources.length])

  return (
    <>
      <button
        type="button"
        style={{
          ...sheetStyles.literatureSummary,
          ...(sources.length === 0 ? { cursor: 'default' } : {}),
        }}
        onClick={() => sources.length > 0 && setExpanded((value) => !value)}
        aria-expanded={sources.length > 0 ? expanded : undefined}
      >
        <span>{summary}</span>
        {sources.length > 0 && <ChevronToggle open={expanded} />}
      </button>
      {expanded && sources.length > 0 && (
        <div style={sheetStyles.literatureList}>
          {sources.map((source) => (
            <button
              key={`${source.id}-${source.title}`}
              type="button"
              style={sheetStyles.literatureItem}
              onClick={() => onOpenSource(source)}
            >
              <span style={sheetStyles.literatureRank}>[{source.id}]</span>
              <span style={sheetStyles.literatureInfo}>
                <span style={sheetStyles.literatureTitle}>{source.title}</span>
                <span style={sheetStyles.literatureMeta}>
                  {[source.articleClass, source.pubYear != null ? String(source.pubYear) : '', source.chunks.length > 1 ? `${source.chunks.length} 个片段` : ''].filter(Boolean).join(' · ') || '医学资料'}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
    </>
  )
}

const sheetStyles: Record<string, React.CSSProperties> = {
  timeline: {
    display: 'flex',
    flexDirection: 'column',
    padding: '4px 0 10px',
  },
  item: {
    display: 'flex',
    alignItems: 'stretch',
    gap: 14,
    minWidth: 0,
  },
  markerCol: {
    width: 24,
    flexShrink: 0,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
  },
  iconWrap: {
    width: 24,
    minHeight: 32,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 2,
  },
  connector: {
    width: 2,
    flex: 1,
    minHeight: 18,
    margin: '4px 0 8px',
    borderRadius: 2,
    background: 'rgba(184, 112, 90, 0.18)',
  },
  contentCol: {
    flex: 1,
    minWidth: 0,
    paddingBottom: 22,
  },
  header: {
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    background: 'transparent',
    border: 'none',
    textAlign: 'left',
    padding: '2px 0',
  },
  title: {
    flex: 1,
    minWidth: 0,
    fontSize: 17,
    lineHeight: '26px',
    fontWeight: 700,
    color: 'var(--color-primary-dark)',
    letterSpacing: 0,
    wordBreak: 'break-word',
  },
  activeTitle: {
    color: 'var(--color-primary)',
  },
  text: {
    marginTop: 8,
    fontSize: 16,
    lineHeight: 1.78,
    color: 'var(--color-text)',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
  oneLine: {
    marginTop: 8,
    display: 'inline-block',
    maxWidth: '100%',
    padding: '8px 14px',
    borderRadius: 18,
    background: 'rgba(240, 230, 221, 0.62)',
    color: 'var(--color-text-secondary)',
    fontSize: 15,
    lineHeight: '22px',
    whiteSpace: 'pre-line',
    wordBreak: 'break-word',
  },
  literatureContent: {
    marginTop: 10,
    minWidth: 0,
  },
  literatureSummary: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    maxWidth: '100%',
    padding: '9px 15px',
    borderRadius: 20,
    border: 'none',
    background: 'rgba(240, 230, 221, 0.68)',
    color: 'var(--color-text-secondary)',
    fontSize: 15,
    lineHeight: '22px',
    cursor: 'pointer',
    WebkitTapHighlightColor: 'transparent',
  },
  literatureList: {
    marginTop: 12,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  literatureItem: {
    width: '100%',
    display: 'flex',
    alignItems: 'flex-start',
    gap: 10,
    textAlign: 'left',
    padding: '10px 12px',
    borderRadius: 12,
    border: '1px solid rgba(226, 220, 216, 0.92)',
    background: 'rgba(255, 255, 255, 0.86)',
    color: 'var(--color-text)',
    cursor: 'pointer',
    WebkitTapHighlightColor: 'transparent',
  },
  literatureRank: {
    flexShrink: 0,
    color: '#BF6F58',
    fontSize: 14,
    lineHeight: '22px',
    fontWeight: 800,
  },
  literatureInfo: {
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 3,
  },
  literatureTitle: {
    color: 'var(--color-text)',
    fontSize: 14,
    lineHeight: '21px',
    fontWeight: 700,
    wordBreak: 'break-word',
  },
  literatureMeta: {
    color: '#AFA49D',
    fontSize: 12,
    lineHeight: '18px',
  },
}

// ─── Main component ───

interface Props {
  // 系统派生过程节点（流式 timeline.steps / 历史 message.processTimeline）
  steps?: ProcessStep[]
  isStreaming?: boolean
  answerStartedAt?: number | null
  // legacy 兜底：老消息只有 message.thinking
  thinking?: string | null
  toolCalls?: ToolCallRecord[] | null
  durationMs?: number
  // 穿插分段时，仅末段概要条在 BottomSheet 末尾显示「完成」节点；中间段为 false
  showCompleteNode?: boolean
  // 穿插分段时，仅末段概要条显示总时长；中间段只显示语义概要（避免显示 0.0s）
  showDuration?: boolean
  // BottomSheet 时间线节点的业务卡片注入（如病历解读完成卡），替代米色文字摘要
  renderToolEntryCard?: (toolName: string, isActive: boolean) => React.ReactNode | null
  // 紧随该轮的用户答案消息正文，用于在「需求确认」时间线节点回显用户最终勾选
  askUserQuestionAnswerText?: string
}

export default function ProcessIndicator({
  steps: rawSteps,
  isStreaming = false,
  answerStartedAt,
  thinking,
  toolCalls,
  durationMs: externalDurationMs,
  showCompleteNode = true,
  showDuration = true,
  renderToolEntryCard,
  askUserQuestionAnswerText,
}: Props) {
  const [sheetOpen, setSheetOpen] = useState(false)
  const [activeLiteratureSource, setActiveLiteratureSource] = useState<MedicalLiteratureSource | null>(null)
  const [now, setNow] = useState(() => Date.now())

  // Build unified display steps
  const displaySteps = rawSteps
    ? buildFromProcessSteps(rawSteps)
    : buildFromMessage(thinking, toolCalls)

  // 流式 tool 最短可视时长到期后刷新 now（让 spinner 自然落幕）
  useEffect(() => {
    if (!isStreaming) return
    const delay = nextStreamingToolExpiry(displaySteps, now)
    if (delay == null) return
    const timer = window.setTimeout(() => setNow(Date.now()), delay)
    return () => window.clearTimeout(timer)
  }, [displaySteps, isStreaming, now])

  // 实时叙述预览（节流 600ms）。useThrottledText 含 hook，必须在任何 early return 之前调用，
  // 保证 hook 调用顺序在 displaySteps 空/非空切换时稳定（displaySteps 为空时取到 '' 也安全）。
  const rawNarrationPreview = answerStartedAt == null ? latestStreamingPreviewLine(displaySteps) : ''
  const narrationPreview = useThrottledText(rawNarrationPreview, NARRATION_PREVIEW_INTERVAL_MS)

  // 没有任何过程节点：不渲染（简单回复，正文由 AssistantMessage 兜底）
  if (displaySteps.length === 0) return null

  // 总耗时：第一个过程节点 → 回答开始；否则用外部 durationMs / 工具耗时累加
  const firstTs = displaySteps[0].timestamp
  const endTs = answerStartedAt ?? undefined
  const spanMs = firstTs && endTs ? endTs - firstTs : 0
  const toolSumMs = displaySteps.reduce((sum, s) => sum + (s.toolDuration || 0), 0)
  const totalDurationMs = spanMs > 0 ? spanMs : (externalDurationMs || toolSumMs)
  const timelineEntries = buildTimelineEntries(displaySteps, isStreaming, setActiveLiteratureSource, showCompleteNode, renderToolEntryCard, askUserQuestionAnswerText)
  function formatDuration(ms: number): string {
    return `${(ms / 1000).toFixed(1)}s`
  }

  // ─── Inline mini bar ───
  const stickyLabel = stickyStreamingLabel(displaySteps, answerStartedAt, now)
  const completedSummary = completedProcessSummary(displaySteps)
  const hasStreamingActiveStep =
    isStreaming &&
    (displaySteps.some((s) => isStreamingActiveStep(s, now)) || !!stickyLabel)

  const barContent = hasStreamingActiveStep ? (
    // 流式：spinner + 阶段名（shimmer 流光）+ 实时叙述（节流 600ms）
    <div
      style={narrationPreview ? styles.streamingBar : styles.streamingBarSingle}
      onClick={() => setSheetOpen(true)}
      role="button"
      tabIndex={0}
    >
      <div style={styles.streamingHeader}>
        <OrangeSpinner size={12} />
        <span className="cx-text-shimmer" style={styles.streamingLabel}>
          {stickyLabel ?? activeStreamingLabel(displaySteps, now)}
        </span>
        {narrationPreview && <ChevronRight size={11} />}
      </div>
      {narrationPreview && (
        <span style={styles.previewText}>{narrationPreview}</span>
      )}
    </div>
  ) : (
    // 完成态：助手点 + 语义概要 + 时长 + chevron
    <div style={styles.idleBar} onClick={() => setSheetOpen(true)} role="button" tabIndex={0}>
      <span style={styles.dot} />
      <span style={styles.idleText}>
        {`${completedSummary ?? '已思考'}${showDuration && totalDurationMs > 0 ? ` · ${formatDuration(totalDurationMs)}` : ''}`}
      </span>
      <ChevronRight size={11} />
    </div>
  )

  return (
    <>
      {barContent}
      <BottomSheet
        open={sheetOpen}
        onClose={() => {
          setActiveLiteratureSource(null)
          setSheetOpen(false)
        }}
        onBack={activeLiteratureSource ? () => setActiveLiteratureSource(null) : undefined}
        title={activeLiteratureSource ? '医学资料详情' : '思考过程'}
      >
        {activeLiteratureSource
          ? <MedicalLiteratureSourceContent source={activeLiteratureSource} />
          : <ProcessTimelineSheet entries={timelineEntries} />}
      </BottomSheet>
    </>
  )
}

const styles: Record<string, React.CSSProperties> = {
  // 完成态迷你 inline 条：无边框 / 极淡暖橙底 / 11px 字 / 自适应宽
  idleBar: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    maxWidth: '100%',
    padding: '3px 9px',
    borderRadius: 11,
    background: 'rgba(255, 245, 238, 0.5)',
    border: 'none',
    cursor: 'pointer',
    marginBottom: 8,
    transition: 'background 0.15s',
    animation: 'fadeIn 0.3s ease',
    WebkitTapHighlightColor: 'transparent',
  },
  idleText: {
    fontSize: 11,
    lineHeight: '16px',
    color: 'var(--color-text-muted)',
    fontWeight: 500,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    background: 'var(--color-primary, #C77A5F)',
    flexShrink: 0,
  },
  // 流式单行条（无叙述预览时）
  streamingBarSingle: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    maxWidth: '100%',
    padding: '3px 9px',
    borderRadius: 11,
    background: 'rgba(255, 245, 238, 0.5)',
    border: 'none',
    cursor: 'pointer',
    marginBottom: 8,
    transition: 'background 0.15s',
    animation: 'fadeIn 0.3s ease',
    WebkitTapHighlightColor: 'transparent',
  },
  // 流式双行条（带实时叙述预览）
  streamingBar: {
    display: 'inline-flex',
    flexDirection: 'column',
    alignItems: 'stretch',
    gap: 3,
    maxWidth: '100%',
    minWidth: 0,
    padding: '5px 9px 6px',
    borderRadius: 11,
    background: 'rgba(255, 245, 238, 0.6)',
    border: 'none',
    cursor: 'pointer',
    marginBottom: 8,
    transition: 'background 0.15s',
    animation: 'fadeIn 0.3s ease',
    WebkitTapHighlightColor: 'transparent',
  },
  streamingHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    minWidth: 0,
  },
  streamingLabel: {
    fontSize: 11,
    lineHeight: '16px',
    fontWeight: 600,
    whiteSpace: 'nowrap',
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  previewText: {
    display: 'block',
    maxWidth: '100%',
    fontSize: 11,
    lineHeight: '16px',
    color: 'var(--color-text-muted)',
    opacity: 0.55,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
}
