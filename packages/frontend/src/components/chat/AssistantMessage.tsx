/**
 * AssistantMessage — 统一的 AI 消息组件
 *
 * 两种模式：
 * 1. 已完成消息：从 MessageRecord 渲染 thinking → toolCalls → content
 * 2. 流式消息：从 processTimeline + answerText 实时渲染
 *
 * 布局：左对齐，无气泡，avatar + 垂直内容流
 */

import { lazy, Suspense, useState, useEffect, useMemo, useCallback, type ReactNode } from 'react'
import A2uiRenderer from '../../lib/a2ui/renderer.js'
import type {
  MessageRecord,
  FeedbackRating,
  ApiResponse,
  ShareSessionResponse,
  SyntheticDocPreview,
  SyntheticCommunicationCardPreview,
  MedicalLiteratureSource,
  MedicalRiskResource,
  MedicalRiskResourceTodoContext,
  ToolCallRecord,
  TodoToolOutput,
  TodoToolPlanOutput,
  TodoToolPlanSummary,
  TodoToolTodoSummary,
} from '@health-agent/shared'
import { parseMedicalRiskToolOutput, replaceToolNameAliases } from '@health-agent/shared'
import type { ProcessStep, ProcessTimeline } from '../../stores/slices/chat.js'
import { api } from '../../services/api.js'
import { reportAnalyticsEvent } from '../../services/analytics.js'
import { stripAnswerTags, toAssistantClipboardText } from '../../utils/text.js'
import { copyText, copyTextLazy } from '../../utils/clipboard.js'
import { formatMessageTimestamp } from '../../utils/date.js'
import { ttsPlayer, useTTSPlayerPhase, useTTSOwner } from '../../hooks/useTTSPlayer.js'
import ProcessIndicator from './ProcessIndicator.js'
import ToolOutputBlocks, {
  resolveRenderKind,
  renderCompletedToolCard,
  renderPendingToolCard,
  shouldRenderCompletedToolOutputBlock,
  shouldRenderPendingToolOutputBlock,
  type ToolCardRenderContext,
} from './ToolOutputBlocks.js'
import ScheduleConfirmCard, { ScheduleResultCard } from './ScheduleConfirmCard.js'
import { useStore } from '../../stores/index.js'
import DeferredRender from './DeferredRender.js'
import ReferenceChip from '../../lib/a2ui/components/ReferenceChip.js'
import CommunicationCardReferenceChip from './CommunicationCardReferenceChip.js'
import MedicalLiteratureSourceDialog from '../../lib/a2ui/components/MedicalLiteratureSourceDialog.js'
import { splitLeadingThinkingProtocol } from './thinkingPhaseParser.js'

type MessageRecordWithProcessTimeline = MessageRecord & { processTimeline?: ProcessStep[] }

const InterventionMaterialInline = lazy(() => import('./InterventionMaterialInline.js'))
const VideoResourceInline = lazy(() => import('./VideoResourceInline.js'))
const InternalVideoInline = lazy(() => import('./InternalVideoInline.js'))
const TodosInline = lazy(() => import('./TodosInline.js'))
const MedicalReportConsultationInline = lazy(() => import('./MedicalReportConsultationInline.js'))

function LazyResourceOutput({ children }: { children: ReactNode }) {
  return (
    <DeferredRender>
      <Suspense fallback={null}>
        {children}
      </Suspense>
    </DeferredRender>
  )
}

interface Props {
  // Finalized message
  message?: MessageRecord
  // Streaming mode
  isStreaming?: boolean
  timeline?: ProcessTimeline
  answerText?: string
  toolCalls?: MessageRecord['toolCalls']
  // Common
  sessionId: string | null
  feedback?: FeedbackRating | null
  isFavorited?: boolean
  showReadonlyFeedback?: boolean
  timestamp?: number | null
  processDurationMs?: number
  // 被中断的消息：若提供 onRetry，则「已中断」chip 旁显示重试按钮
  onRetry?: () => void
  referenceDocs?: SyntheticDocPreview[]
  referenceCommunicationCards?: SyntheticCommunicationCardPreview[]
  medicalRiskResources?: MedicalRiskResourceMap
  medicalLiteratureSources?: MedicalLiteratureSourceMap
  videoResourceSource?: 'chat_inline' | 'materials' | 'shared_view'
  sharedToken?: string | null
  supersedeCheckInDrafts?: boolean
  hideAskUserQuestion?: boolean
  onAskUserQuestionSubmit?: (content: string) => void
  /** 紧随该轮的用户答案消息正文，用于「需求确认」时间线节点回显用户最终勾选 */
  askUserQuestionAnswerText?: string
  onTodoFeedbackSubmit?: (content: string) => void
  onFavoriteChange?: (messageId: string, saved: boolean) => void
}

/** 切开的橙子旋转 spinner */
function OrangeSpinner() {
  return (
    <div className="orange-spinner" style={{ width: 16, height: 16 }}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
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

export type MedicalRiskResourceMap = Map<string, { toolCallId: string | null; resource: MedicalRiskResource }>
export type MedicalLiteratureSourceMap = Map<string, MedicalLiteratureSource>
const MEDICAL_RISK_RESOURCE_TOOL_NAMES = new Set(['grade_medical_risk', 'generate_plan', 'saved_content'])
const MEDICAL_LITERATURE_SOURCE_TOOL_NAMES = new Set(['grade_medical_risk', 'medical_literature_search'])

/**
 * 过程时间线分段：以中间叙述（text 节点）为切点，把整轮 steps 切成多段，
 * 实现「概要条1 → 中间正文1 → 概要条2 → 最终正文」的穿插渲染。
 * 每段 = 该段的过程节点（不含 text，用于生成概要条）+ 段尾的中间叙述文本。
 * 末段 narration 为 null（其正文由最终 content / answerText 承载）。
 */
interface ProcessSegment {
  processSteps: ProcessStep[]
  narration: string | null
}

function splitProcessSegments(steps: ProcessStep[] | undefined): ProcessSegment[] {
  if (!steps?.length) return []
  const segments: ProcessSegment[] = []
  let current: ProcessStep[] = []
  for (const step of steps) {
    if (step.type === 'text') {
      const narration = step.content.trim()
      // text 作为切点：结束当前段（即使没有过程节点，也允许纯叙述段）
      if (narration || current.length > 0) {
        segments.push({ processSteps: current, narration: narration || null })
        current = []
      }
      continue
    }
    current.push(step)
  }
  // 残余过程节点作为末段（正文接最终回答）
  if (current.length > 0) {
    segments.push({ processSteps: current, narration: null })
  }
  return segments
}

function parseTodoToolOutput(value: unknown): TodoToolPlanOutput | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Partial<TodoToolOutput> & Record<string, unknown>
  const plan = raw.plan
  if (raw.kind !== 'todos' || !plan || typeof plan !== 'object') return null
  const planRecord = plan as Partial<TodoToolPlanSummary>
  if (typeof planRecord.id !== 'string' || !Array.isArray(planRecord.todos)) return null
  return value as TodoToolPlanOutput
}

function isTodoSummaryClosed(todo: TodoToolTodoSummary): boolean {
  return todo.status === 'completed' || todo.status === 'not_practiced'
}

function pickTodoForInlineResource(plan: TodoToolPlanSummary): TodoToolTodoSummary | null {
  const todos = Array.isArray(plan.todos) ? plan.todos : []
  return todos.find((todo) => !isTodoSummaryClosed(todo)) ?? todos[0] ?? null
}

function buildTodoContextForPlanResource(plan: TodoToolPlanSummary): {
  resourceRefId: string
  todoContext: MedicalRiskResourceTodoContext
} | null {
  if (typeof plan.resourceRefId !== 'string' || !plan.resourceRefId) return null
  const todo = pickTodoForInlineResource(plan)
  if (!todo?.id) return null
  return {
    resourceRefId: plan.resourceRefId,
    todoContext: {
      planId: plan.id,
      todoId: todo.id,
      feedback: todo.feedback ?? null,
      status: todo.status,
    },
  }
}

function scheduleStepText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function formatScheduleStepTime(value: unknown): string | null {
  const raw = scheduleStepText(value)
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

/** 从 schedule tool_call step 的 input 派生只读结果卡展示信息（action/主题/时间） */
function scheduleResultInfo(step: Extract<ProcessStep, { type: 'tool_call' }>): {
  action: 'add' | 'update' | 'delete'
  taskName: string | null
  dueAtLabel: string | null
} {
  const input = (step.input && typeof step.input === 'object' && !Array.isArray(step.input)
    ? step.input
    : {}) as Record<string, unknown>
  // action 来源：schedule 工具走 input.action；旧拆分工具按工具名/status 推断
  const inputAction = scheduleStepText(input.action)
  const isDelete = inputAction === 'delete' || scheduleStepText(input.status) === 'deleted'
  const action: 'add' | 'update' | 'delete' = isDelete
    ? 'delete'
    : inputAction === 'update' || step.name === 'update_scheduled_task'
      ? 'update'
      : 'add'
  const taskName = scheduleStepText(input.taskName) ?? scheduleStepText(input.task)
  const dueAtLabel = formatScheduleStepTime(input.dueAt) ?? formatScheduleStepTime(input.time)
  return { action, taskName, dueAtLabel }
}

export function collectMedicalRiskResources(
  toolCalls: ToolCallRecord[] | null | undefined,
): MedicalRiskResourceMap {
  const result: MedicalRiskResourceMap = new Map()
  const todoContextsByResourceId = new Map<string, MedicalRiskResourceTodoContext>()
  for (const toolCall of toolCalls ?? []) {
    if (MEDICAL_RISK_RESOURCE_TOOL_NAMES.has(toolCall.name)) {
      const parsed = parseMedicalRiskToolOutput(toolCall.output)
      if (parsed) {
        for (const resource of parsed.resources) {
          if (!result.has(resource.id)) {
            result.set(resource.id, {
              toolCallId: toolCall.toolCallId ?? null,
              resource,
            })
          }
        }
      }
    }
    if (toolCall.name === 'todos') {
      const todoOutput = parseTodoToolOutput(toolCall.output)
      const planContext = todoOutput ? buildTodoContextForPlanResource(todoOutput.plan) : null
      if (planContext) {
        todoContextsByResourceId.set(planContext.resourceRefId, planContext.todoContext)
      }
    }
  }
  for (const [resourceId, todoContext] of todoContextsByResourceId) {
    const item = result.get(resourceId)
    if (!item || item.resource.todoContext) continue
    result.set(resourceId, {
      ...item,
      resource: {
        ...item.resource,
        todoContext,
      },
    })
  }
  return result
}

export function collectMedicalLiteratureSources(
  toolCalls: ToolCallRecord[] | null | undefined,
): MedicalLiteratureSourceMap {
  const result: MedicalLiteratureSourceMap = new Map()
  for (const toolCall of toolCalls ?? []) {
    if (!MEDICAL_LITERATURE_SOURCE_TOOL_NAMES.has(toolCall.name)) continue
    const parsed = parseMedicalRiskToolOutput(toolCall.output)
    const sources = parsed?.literatureSearch?.selectedSources ?? []
    for (const source of sources) {
      const key = source.id.toLowerCase()
      if (!result.has(key)) result.set(key, source)
    }
  }
  return result
}

export default function AssistantMessage({
  message,
  isStreaming = false,
  timeline,
  answerText,
  toolCalls,
  sessionId,
  feedback: initialFeedback,
  isFavorited: initialFavorited = false,
  showReadonlyFeedback = false,
  timestamp,
  processDurationMs,
  onRetry,
  referenceDocs,
  referenceCommunicationCards,
  medicalRiskResources: sessionMedicalRiskResources,
  medicalLiteratureSources: sessionMedicalLiteratureSources,
  videoResourceSource = 'chat_inline',
  sharedToken,
  supersedeCheckInDrafts = false,
  hideAskUserQuestion = false,
  onAskUserQuestionSubmit,
  askUserQuestionAnswerText,
  onTodoFeedbackSubmit,
  onFavoriteChange,
}: Props) {
  const rawMessageContent = message?.content ?? ''
  const finalizedProtocolSplit = useMemo(() => {
    if (isStreaming || !message) return null
    const split = splitLeadingThinkingProtocol(message.content)
    if (!split) return null
    if (!split.closed && !split.answer.trim()) return null
    return split
  }, [isStreaming, message?.content])
  const displayMessageContent = replaceToolNameAliases(finalizedProtocolSplit?.answer ?? rawMessageContent)
  const [copied, setCopied] = useState(false)
  const [shared, setShared] = useState(false)
  const [localFeedback, setLocalFeedback] = useState<FeedbackRating | null>(initialFeedback ?? null)
  // schedule 确认卡内联到时间线节点：待确认队列与已处理结果（点完/历史/分享页则回退文字终态）
  const pendingScheduleConfirmations = useStore((s) => s.pendingScheduleConfirmations)
  const scheduleConfirmationResults = useStore((s) => s.scheduleConfirmationResults)
  const [localFavorited, setLocalFavorited] = useState(initialFavorited)
  const [favoriteSaving, setFavoriteSaving] = useState(false)
  const ttsPhase = useTTSPlayerPhase()
  const ttsOwner = useTTSOwner()
  const visibleReferenceDocs = useMemo(
    () => dedupeReferenceDocs(referenceDocs),
    [referenceDocs],
  )
  const visibleReferenceCommunicationCards = useMemo(
    () => dedupeReferenceCommunicationCards(referenceCommunicationCards),
    [referenceCommunicationCards],
  )
  const localMedicalRiskResources = useMemo(
    () => collectMedicalRiskResources(isStreaming ? toolCalls : message?.toolCalls),
    [isStreaming, message?.toolCalls, toolCalls],
  )
  const medicalRiskResources = sessionMedicalRiskResources ?? localMedicalRiskResources
  const localMedicalLiteratureSources = useMemo(
    () => collectMedicalLiteratureSources(isStreaming ? toolCalls : message?.toolCalls),
    [isStreaming, message?.toolCalls, toolCalls],
  )
  const medicalLiteratureSources = localMedicalLiteratureSources.size > 0
    ? localMedicalLiteratureSources
    : sessionMedicalLiteratureSources ?? localMedicalLiteratureSources
  const citationSources = useMemo(
    () => Array.from(medicalLiteratureSources.values()),
    [medicalLiteratureSources],
  )
  const citedLiteratureSources = useMemo(
    () => collectCitedLiteratureSources(isStreaming ? answerText ?? '' : displayMessageContent, citationSources),
    [answerText, citationSources, displayMessageContent, isStreaming],
  )
  const interventionMaterialSource = videoResourceSource === 'shared_view' ? 'shared_view' : 'chat_inline'
  const renderMedicalRiskResource = useCallback((id: string) => {
    const item = medicalRiskResources.get(id)
    if (!item) return null
    if (item.resource.kind === 'intervention_material') {
      const virtualToolCallId = item.toolCallId
        ? `${item.toolCallId}:resource:${item.resource.id}`
        : null
      return (
        <LazyResourceOutput>
          <InterventionMaterialInline
            output={item.resource.material}
            sessionId={sessionId}
            toolCallId={virtualToolCallId}
            source={interventionMaterialSource}
            todoContext={item.resource.todoContext}
            onTodoFeedbackSubmit={onTodoFeedbackSubmit}
          />
        </LazyResourceOutput>
      )
    }
    if (item.resource.kind === 'internal_video') {
      const virtualToolCallId = item.toolCallId
        ? `${item.toolCallId}:resource:${item.resource.id}`
        : null
      return (
        <LazyResourceOutput>
          <InternalVideoInline
            resource={item.resource}
            sessionId={sessionId}
            toolCallId={virtualToolCallId}
            source={interventionMaterialSource}
          />
        </LazyResourceOutput>
      )
    }
    return (
      <LazyResourceOutput>
        <VideoResourceInline
          resource={item.resource}
          sessionId={sessionId}
          source={videoResourceSource}
          sharedToken={sharedToken}
          onTodoFeedbackSubmit={onTodoFeedbackSubmit}
        />
      </LazyResourceOutput>
    )
  }, [interventionMaterialSource, medicalRiskResources, onTodoFeedbackSubmit, sessionId, sharedToken, videoResourceSource])
  // 单个工具调用 → 对应业务卡片。过程时间线已折叠进 ProcessIndicator 的 BottomSheet，
  // 这些交互/展示卡片必须留在主聊天流（用户要能点击 schedule 确认、ask_user_question 追问等），
  // 因此由下方 renderInlineToolCards 遍历当前轮 tool_call 收集到正文区，而不是内联进时间线节点。
  // 走 ToolOutputBlocks 的 renderKind 单卡分发，避免在此硬编码工具名/组件映射。
  const renderToolCard = useCallback((toolName: string, toolCallId?: string) => {
    const source = isStreaming ? toolCalls : message?.toolCalls
    const tc = (source ?? []).find((item) =>
      toolCallId ? item.toolCallId === toolCallId : item.name === toolName)
    const renderKind = resolveRenderKind(toolName)

    // todos 跟练计划卡：保留专属渲染（TodosInline 有自己的数据形状校验）。
    if (renderKind === 'todos') {
      if (!tc || tc.output == null) return null
      return (
        <LazyResourceOutput>
          <TodosInline output={tc.output} disableNavigation={videoResourceSource === 'shared_view'} />
        </LazyResourceOutput>
      )
    }

    // schedule 确认卡：三态内联在节点下方——
    // ① 终态（已确认/已拒绝）→ 只读结果卡，数据取自持久化的 step.scheduleConfirmation，历史重载也在；
    // ② 待确认 → 可交互确认卡（来自 pending 队列）；
    // ③ 其它（流式中/无卡）→ null，回退节点文字详情。
    if (renderKind === 'scheduled_task') {
      const steps = isStreaming
        ? timeline?.steps
        : (message as MessageRecordWithProcessTimeline | undefined)?.processTimeline
      const step = (steps ?? []).find(
        (s): s is Extract<ProcessStep, { type: 'tool_call' }> =>
          s.type === 'tool_call' && s.toolCallId === toolCallId,
      )
      // 终态：用持久化在 step 上的 scheduleConfirmation（点确认/拒绝后由 markScheduleStepInMessage
      // 即时写入内存，历史/分享页由后端落库重放），渲染只读结果卡。
      const terminal = step?.scheduleConfirmation === 'confirmed' || step?.scheduleConfirmation === 'rejected'
        ? step.scheduleConfirmation
        : null
      if (terminal && step) {
        const info = scheduleResultInfo(step)
        return (
          <ScheduleResultCard
            action={info.action}
            status={terminal}
            taskName={info.taskName}
            dueAtLabel={info.dueAtLabel}
            taskId={step.scheduledTaskId}
            disableNavigation={videoResourceSource === 'shared_view'}
            inline
          />
        )
      }
      if (isStreaming) return null
      const confirmation = pendingScheduleConfirmations.find((c) =>
        c.toolCallId === toolCallId
        && (c.messageId == null || c.messageId === message?.id))
      if (!confirmation || scheduleConfirmationResults[confirmation.confirmationId]) return null
      return <ScheduleConfirmCard payload={confirmation} inline />
    }

    const ctx: ToolCardRenderContext = {
      sessionId,
      interventionMaterialSource,
      supersededByNewerUserMessage: supersedeCheckInDrafts,
      hideAskUserQuestion,
      onAskUserQuestionSubmit,
    }

    // 沟通卡 / 打卡卡：工具完成即出卡。
    if (renderKind === 'communication_card' || renderKind === 'check_in') {
      if (tc?.output != null && shouldRenderCompletedToolOutputBlock(tc.name)) {
        return renderCompletedToolCard(renderKind, tc, ctx)
      }
      if (isStreaming && (tc == null || tc.output == null) && shouldRenderPendingToolOutputBlock(toolName)) {
        return renderPendingToolCard(renderKind, { toolCallId, name: toolName }, ctx)
      }
      return null
    }

    // 病历解读卡：进行中显示炫酷动画卡（running/settling）；answer 开始后 / 完成态 / 历史重放
    // 都凝固成静态完成卡（保留三专家+扫描质感，停掉流动动画），替代米色「已完成病历解读」文字框。
    if (renderKind === 'medical_report_consultation') {
      // 完成态：finalized 或 streaming 已进入 answer 阶段 → 静态完成卡
      const settled = !isStreaming || !!answerText || timeline?.answerStartedAt != null
      // 完成态：完成卡不再堆在主流，改由 BottomSheet「思考过程」对应节点渲染（见 renderToolEntryCard）
      if (settled) return null
      // 进行中：流式 pending 动画卡（按 step.isActive 区分 running/settling）
      const steps = (timeline?.steps ?? []).filter((step): step is Extract<ProcessTimeline['steps'][number], { type: 'tool_call' }> =>
        step.type === 'tool_call' && step.name === 'medical_report_consultation_board')
      const step = toolCallId
        ? steps.find((s) => s.toolCallId === toolCallId)
        : steps[steps.length - 1]
      if (!step) return null
      const phase: 'running' | 'settling' = step.isActive ? 'running' : 'settling'
      return renderPendingToolCard(renderKind, { toolCallId, name: toolName, phase }, ctx)
    }

    return null
  }, [
    answerText,
    hideAskUserQuestion,
    interventionMaterialSource,
    isStreaming,
    // 注意：依赖整个 message（而非仅 id/toolCalls）——点确认后 markScheduleStepInMessage 只改
    // message.processTimeline，id/toolCalls 不变；不依赖 message 会读到旧闭包，终态卡不刷新。
    message,
    onAskUserQuestionSubmit,
    pendingScheduleConfirmations,
    scheduleConfirmationResults,
    sessionId,
    supersedeCheckInDrafts,
    timeline,
    toolCalls,
  ])
  // 当前轮所有工具调用 → 业务卡片，收集到正文区（过程时间线已折叠进 BottomSheet）。
  // 遍历源：流式合并 timeline.steps 的 tool_call（含进行中、尚未落到 toolCalls 的）与 toolCalls；
  // 终态用 message.toolCalls。按 toolCallId（无则 name+序号）去重，保持调用顺序。
  const renderInlineToolCards = useCallback((): ReactNode[] => {
    const ordered: Array<{ toolCallId?: string; name: string }> = []
    const seen = new Set<string>()
    const push = (toolCallId: string | undefined, name: string) => {
      const key = toolCallId ?? `${name}#${ordered.length}`
      if (seen.has(key)) return
      seen.add(key)
      ordered.push({ toolCallId, name })
    }
    if (isStreaming) {
      for (const step of timeline?.steps ?? []) {
        if (step.type === 'tool_call') push(step.toolCallId, step.name)
      }
      for (const tc of toolCalls ?? []) push(tc.toolCallId, tc.name)
    } else {
      for (const tc of message?.toolCalls ?? []) push(tc.toolCallId, tc.name)
    }
    const cards: ReactNode[] = []
    for (const { toolCallId, name } of ordered) {
      const card = renderToolCard(name, toolCallId)
      if (card) cards.push(<div key={toolCallId ?? `${name}-${cards.length}`}>{card}</div>)
    }
    return cards
  }, [isStreaming, message?.toolCalls, renderToolCard, timeline, toolCalls])
  // BottomSheet 时间线节点的业务卡片注入：病历解读完成卡放到「病历解读协会」节点下，
  // 替代米色「已完成病历解读」文字框（纯展示无交互，进 BottomSheet 不影响可达性）。
  const renderToolEntryCard = useCallback((toolName: string): ReactNode | null => {
    if (toolName === 'medical_report_consultation_board') {
      return (
        <LazyResourceOutput>
          <MedicalReportConsultationInline done />
        </LazyResourceOutput>
      )
    }
    return null
  }, [])
  // 过程流穿插渲染：概要条1 → 中间正文1 → 概要条2 →（最终正文由调用方接续）。
  // 中间叙述（text 节点）从 BottomSheet 拿出来，作为正文块直接展示在主聊天流。
  const renderProcessFlow = useCallback((
    steps: ProcessStep[] | undefined,
    streaming: boolean,
    answerStartedAt: number | null | undefined,
    totalDurationMs: number | undefined,
  ): ReactNode[] => {
    const segments = splitProcessSegments(steps)
    if (segments.length === 0) return []
    const nodes: ReactNode[] = []
    segments.forEach((segment, index) => {
      const isLastSegment = index === segments.length - 1
      if (segment.processSteps.length > 0) {
        // 关键：只有末段跟随整轮流式态（可能仍在进行）；前面的段一律固定成完成态，
        // 否则已结束的段会因 isStreaming 跟着重新计时/转圈。中间段不显示时长（仅语义概要）。
        nodes.push(
          <ProcessIndicator
            key={`pi-${index}`}
            steps={segment.processSteps}
            isStreaming={isLastSegment ? streaming : false}
            answerStartedAt={isLastSegment ? answerStartedAt : undefined}
            durationMs={isLastSegment ? totalDurationMs : undefined}
            showCompleteNode={isLastSegment}
            showDuration={isLastSegment}
            renderToolEntryCard={renderToolEntryCard}
            askUserQuestionAnswerText={askUserQuestionAnswerText}
          />,
        )
      }
      if (segment.narration) {
        nodes.push(
          <div key={`narr-${index}`} className="markdown-body" style={styles.markdown}>
            <A2uiRenderer
              content={replaceToolNameAliases(stripAnswerTags(segment.narration))}
              renderResource={renderMedicalRiskResource}
              citationSources={citationSources}
            />
          </div>,
        )
      }
    })
    return nodes
  }, [citationSources, renderMedicalRiskResource, renderToolEntryCard, askUserQuestionAnswerText])
  const pendingToolCalls = useMemo(
    () => (isStreaming && timeline
      ? timeline.steps
        .filter((step): step is Extract<ProcessTimeline['steps'][number], { type: 'tool_call' }> =>
          step.type === 'tool_call' && step.isActive)
        .map((step) => ({
          toolCallId: step.toolCallId,
          name: step.name,
        }))
      : []),
    [isStreaming, timeline],
  )
  const streamingInterventionPendingCalls = useMemo(() => {
    if (!isStreaming) return []

    const merged = [...pendingToolCalls]
    for (const tc of toolCalls ?? []) {
      if (tc.name !== 'show_intervention_material') continue
      if (tc.output == null) continue
      const duplicated = merged.some((item) =>
        item.toolCallId
          ? item.toolCallId === tc.toolCallId
          : item.name === tc.name,
      )
      if (!duplicated) {
        merged.push({
          toolCallId: tc.toolCallId,
          name: tc.name,
        })
      }
    }
    return merged
  }, [isStreaming, pendingToolCalls, toolCalls])
  useEffect(() => {
    setLocalFeedback(initialFeedback ?? null)
  }, [initialFeedback])

  useEffect(() => {
    setLocalFavorited(initialFavorited)
  }, [initialFavorited])

  // 本条消息是否正处于朗读中（owner 匹配 + 播放器非 idle/error）
  const isThisTTSActive = !!message && ttsOwner === message.id && (ttsPhase === 'connecting' || ttsPhase === 'playing')

  function handlePlayTTS() {
    if (!message || !displayMessageContent) return
    const result = ttsPlayer.toggleText(displayMessageContent, message.id)
    if (result.action === 'started') {
      reportAnalyticsEvent('message_play_voice', {
        sessionId: sessionId ?? null,
        entityType: 'message',
        entityId: message.id,
      })
    }
    result.playback.catch((err) => {
      console.warn('[TTS] playText failed:', err)
    })
  }

  async function handleCopy() {
    const text = message ? displayMessageContent : answerText || ''
    const copyPayload = toAssistantClipboardText(text)
    if (!copyPayload) return
    const ok = await copyText(copyPayload)
    if (!ok) return
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
    if (message) {
      reportAnalyticsEvent('message_copy_text', {
        sessionId: sessionId ?? null,
        entityType: 'message',
        entityId: message.id,
      })
    }
  }

  async function handleShare() {
    if (!sessionId || !message) return
    // 关键：必须在 onClick 同步栈里直接调用 copyTextLazy，中间不能有 await，
    // 否则 iOS transient user activation 失效，clipboard 写入会被 WebKit 拒绝。
    const urlPromise = api
      .post<ApiResponse<ShareSessionResponse>>(`/share/${sessionId}`, {
        upToMessageId: message.id,
      })
      .then((res) => {
        if (!res.data?.shareUrl) throw new Error('no share url')
        return window.location.origin + res.data.shareUrl
      })
    try {
      const ok = await copyTextLazy(urlPromise)
      if (!ok) return
      setShared(true)
      setTimeout(() => setShared(false), 2000)
      reportAnalyticsEvent('message_copy_link', {
        sessionId,
        entityType: 'message',
        entityId: message.id,
      })
    } catch (err) {
      console.error('Failed to share:', err)
    }
  }

  function handleFeedback(rating: FeedbackRating) {
    if (!sessionId || !message) return
    const newRating = localFeedback === rating ? null : rating
    setLocalFeedback(newRating)
    api.post('/feedback', { messageId: message.id, sessionId, rating }).catch(() => {})
  }

  async function handleFavorite() {
    if (!sessionId || !message || favoriteSaving) return
    const nextSaved = !localFavorited
    setFavoriteSaving(true)
    setLocalFavorited(nextSaved)
    onFavoriteChange?.(message.id, nextSaved)
    try {
      if (nextSaved) {
        await api.post('/message-favorites', { sessionId, messageId: message.id })
        reportAnalyticsEvent('message_favorite_save', {
          sessionId,
          entityType: 'message',
          entityId: message.id,
        })
      } else {
        await api.delete(`/message-favorites/${message.id}?sessionId=${encodeURIComponent(sessionId)}`)
        reportAnalyticsEvent('message_favorite_remove', {
          sessionId,
          entityType: 'message',
          entityId: message.id,
        })
      }
    } catch (err) {
      console.error('Failed to toggle message favorite:', err)
      setLocalFavorited(!nextSaved)
      onFavoriteChange?.(message.id, !nextSaved)
    } finally {
      setFavoriteSaving(false)
    }
  }

  // ─── Streaming mode ───
  if (isStreaming && timeline) {
    const inlineToolCards = renderInlineToolCards()
    // 首 token 前空白：还没有任何过程节点、也没有正文 → 用「思考中」占位，避免一段空白让用户以为卡死
    const showThinkingPlaceholder = timeline.steps.length === 0 && !answerText
    const processFlow = renderProcessFlow(timeline.steps, true, timeline.answerStartedAt, undefined)
    return (
      <div style={styles.row}>
        <div style={styles.avatar}>HA</div>
        <div style={styles.contentCol}>
          {showThinkingPlaceholder && (
            <div style={styles.thinkingPlaceholder}>
              <OrangeSpinner />
              <span className="cx-text-shimmer" style={styles.thinkingText}>思考中...</span>
            </div>
          )}

          {/* 过程流穿插：概要条 → 中间正文 → 概要条 …（最终正文在下方独立渲染） */}
          {processFlow}

          {/* 业务卡片留主聊天流：todos / schedule 确认 / 沟通卡 / 打卡卡 / 病历解读 */}
          {inlineToolCards.length > 0 && (
            <div style={styles.toolCards}>{inlineToolCards}</div>
          )}

          <ToolOutputBlocks
            toolCalls={toolCalls}
            sessionId={sessionId}
            pendingToolCalls={pendingToolCalls}
            renderKinds={['ask_user_question']}
            hideAskUserQuestion={hideAskUserQuestion}
            onAskUserQuestionSubmit={onAskUserQuestionSubmit}
          />

          {(visibleReferenceDocs.length > 0 || visibleReferenceCommunicationCards.length > 0) && (
            <div style={styles.referenceRow}>
              {visibleReferenceDocs.map((doc, index) => (
                <ReferenceChip
                  key={`${doc.docId ?? 'doc'}-${doc.shortId ?? 'short'}-${index}`}
                  doc={doc}
                />
              ))}
              {visibleReferenceCommunicationCards.map((card, index) => (
                <CommunicationCardReferenceChip
                  key={`${card.cardId ?? 'card'}-${card.shortId ?? 'short'}-${index}`}
                  card={card}
                />
              ))}
            </div>
          )}

          <ToolOutputBlocks
            toolCalls={null}
            sessionId={sessionId}
            pendingToolCalls={streamingInterventionPendingCalls}
            renderKinds={['intervention_material']}
            interventionMaterialSource={interventionMaterialSource}
          />

          {/* 正文独立气泡（不再塞进过程时间线，消除「正文 + 时间线」两个大气泡） */}
          {answerText && (
            <>
              <div className="markdown-body" style={styles.markdown}>
                <A2uiRenderer
                  content={replaceToolNameAliases(stripAnswerTags(answerText))}
                  streaming
                  renderResource={renderMedicalRiskResource}
                  citationSources={citationSources}
                />
                <span style={styles.cursor}>▊</span>
              </div>
              <div style={styles.disclaimer}>内容由AI生成仅供参考，持续不适请及时就医</div>
            </>
          )}

          {timestamp && answerText && (
            <span style={styles.timestamp}>{formatMessageTimestamp(timestamp)}</span>
          )}
        </div>
      </div>
    )
  }

  // ─── Finalized message mode ───
  if (!message) return null

  const finalizedProcessSteps = (message as MessageRecordWithProcessTimeline).processTimeline
  const hasContent = !!displayMessageContent
  const showFeedbackButtons = !!sessionId || showReadonlyFeedback
  const isReadonlyFeedback = !sessionId && showReadonlyFeedback
  const inlineToolCards = renderInlineToolCards()
  const showFavoriteButton = !!sessionId && hasContent && !message.interrupted
  // 有过程时间线 → 穿插渲染（概要条 → 中间正文 → 概要条 …）；否则走 legacy thinking 兜底
  const finalizedProcessFlow = (finalizedProcessSteps?.length ?? 0) > 0
    ? renderProcessFlow(finalizedProcessSteps, false, undefined, processDurationMs ?? message.processDurationMs)
    : null

  return (
    <div style={styles.row}>
      <div style={styles.avatar}>HA</div>
      <div style={styles.contentCol}>
        {/* 过程流穿插：概要条 → 中间正文 → 概要条 …（最终正文在下方独立渲染） */}
        {finalizedProcessFlow ?? (
          /* legacy 兜底：老消息只有 message.thinking，无过程节点穿插 */
          <ProcessIndicator
            thinking={message.thinking}
            toolCalls={message.toolCalls}
            durationMs={processDurationMs ?? message.processDurationMs}
            renderToolEntryCard={renderToolEntryCard}
          />
        )}

        {/* 业务卡片留主聊天流：todos / schedule 确认 / 沟通卡 / 打卡卡 / 病历解读 */}
        {inlineToolCards.length > 0 && (
          <div style={styles.toolCards}>{inlineToolCards}</div>
        )}

        <ToolOutputBlocks
          toolCalls={message.toolCalls}
          sessionId={sessionId}
          renderKinds={['ask_user_question']}
          hideAskUserQuestion={hideAskUserQuestion}
          onAskUserQuestionSubmit={onAskUserQuestionSubmit}
        />

        {(visibleReferenceDocs.length > 0 || visibleReferenceCommunicationCards.length > 0) && (
          <div style={styles.referenceRow}>
            {visibleReferenceDocs.map((doc, index) => (
              <ReferenceChip
                key={`${doc.docId ?? 'doc'}-${doc.shortId ?? 'short'}-${index}`}
                doc={doc}
              />
            ))}
            {visibleReferenceCommunicationCards.map((card, index) => (
              <CommunicationCardReferenceChip
                key={`${card.cardId ?? 'card'}-${card.shortId ?? 'short'}-${index}`}
                card={card}
              />
            ))}
          </div>
        )}

        <ToolOutputBlocks
          toolCalls={message.toolCalls}
          sessionId={sessionId}
          renderKinds={['intervention_material']}
          interventionMaterialSource={interventionMaterialSource}
        />

        {/* 正文独立气泡（不再塞进过程时间线，消除「正文 + 时间线」两个大气泡） */}
        {hasContent && (
          <>
            <div className="markdown-body" style={styles.markdown}>
              <A2uiRenderer
                content={stripAnswerTags(displayMessageContent)}
                renderResource={renderMedicalRiskResource}
                citationSources={citationSources}
              />
            </div>
            <div style={styles.disclaimer}>内容由AI生成仅供参考，持续不适请及时就医</div>
          </>
        )}

        {message.createdAt && (
          <span style={styles.timestamp}>{formatMessageTimestamp(message.createdAt)}</span>
        )}

        {message.interrupted && (
          <div style={styles.interruptedRow}>
            <span style={styles.interruptedChip}>已中断</span>
            {onRetry && (
              <button style={styles.retryBtn} onClick={onRetry} title="重试">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="1 4 1 10 7 10" />
                  <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
                </svg>
                <span>重试</span>
              </button>
            )}
          </div>
        )}

        {/* Action bar */}
        <div style={styles.actionBar}>
          {hasContent && (
            <button
              style={{
                ...styles.actionButton,
                ...(isThisTTSActive ? styles.ttsActive : {}),
              }}
              onClick={handlePlayTTS}
              title={isThisTTSActive ? '停止朗读' : '朗读'}
            >
              {isThisTTSActive ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                  <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                  <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                </svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                  <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                </svg>
              )}
            </button>
          )}
          {hasContent && (
            <button style={styles.actionButton} onClick={handleCopy} title="复制">
              {copied ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--color-success)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
              )}
            </button>
          )}
          {sessionId && (
            <>
              <button
                style={styles.actionButton}
                onClick={handleShare}
                title={shared ? '链接已复制' : '分享至此'}
              >
                {shared ? (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--color-success)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                ) : (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                  </svg>
                )}
              </button>
            </>
          )}
          {showFeedbackButtons && (
            <>
              <button
                style={{
                  ...styles.actionButton,
                  ...(isReadonlyFeedback ? styles.readonlyActionButton : {}),
                  ...(localFeedback === 'like' ? styles.feedbackLikeActive : {}),
                }}
                onClick={isReadonlyFeedback ? undefined : () => handleFeedback('like')}
                title="有帮助"
                aria-pressed={localFeedback === 'like'}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill={localFeedback === 'like' ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3H14z" />
                  <path d="M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3" />
                </svg>
              </button>
              <button
                style={{
                  ...styles.actionButton,
                  ...(isReadonlyFeedback ? styles.readonlyActionButton : {}),
                  ...(localFeedback === 'dislike' ? styles.feedbackDislikeActive : {}),
                }}
                onClick={isReadonlyFeedback ? undefined : () => handleFeedback('dislike')}
                title="没帮助"
                aria-pressed={localFeedback === 'dislike'}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill={localFeedback === 'dislike' ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3H10z" />
                  <path d="M17 2h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17" />
                </svg>
              </button>
            </>
          )}
          {showFavoriteButton && (
            <button
              style={{
                ...styles.actionButton,
                ...(localFavorited ? styles.favoriteActive : {}),
                ...(favoriteSaving ? styles.actionButtonBusy : {}),
              }}
              onClick={handleFavorite}
              disabled={favoriteSaving}
              title={localFavorited ? '取消收藏' : '收藏'}
              aria-pressed={localFavorited}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill={localFavorited ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M19 21l-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
              </svg>
            </button>
          )}
        </div>

        {hasContent && citedLiteratureSources.length > 0 && (
          <RelatedMedicalLiteratureBlock sources={citedLiteratureSources} />
        )}
      </div>
    </div>
  )
}

function RelatedMedicalLiteratureBlock({ sources }: { sources: MedicalLiteratureSource[] }) {
  const [activeSource, setActiveSource] = useState<MedicalLiteratureSource | null>(null)
  const [expanded, setExpanded] = useState(false)
  if (sources.length === 0) return null

  const visibleSources = expanded ? sources : sources.slice(0, 3)
  const hasMore = sources.length > visibleSources.length

  return (
    <div style={styles.relatedLiterature}>
      <div style={styles.relatedLiteratureHeader}>
        <span style={styles.relatedLiteratureIcon}>
          <LiteratureStackIcon />
        </span>
        <span style={styles.relatedLiteratureTitle}>相关资料</span>
        <span style={styles.relatedLiteratureCount}>{sources.length} 篇</span>
      </div>
      <div style={styles.relatedLiteratureList}>
        {visibleSources.map((source) => {
          const meta = [
            source.articleClass,
            source.pubYear != null ? String(source.pubYear) : '',
          ].filter(Boolean).join(' · ')
          return (
            <button
              key={`${source.id}-${source.title}`}
              type="button"
              style={styles.relatedLiteratureItem}
              onClick={() => setActiveSource(source)}
            >
              <span style={styles.relatedLiteratureText}>
                <span style={styles.relatedLiteratureItemTitle}>
                  <span style={styles.relatedLiteratureRank}>[{source.id}]</span>
                  {source.title}
                </span>
                {meta && <span style={styles.relatedLiteratureMeta}>{meta}</span>}
              </span>
            </button>
          )
        })}
      </div>
      {hasMore && (
        <button
          type="button"
          style={styles.relatedLiteratureMore}
          onClick={() => setExpanded(true)}
        >
          查看全部资料
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
      )}
      <MedicalLiteratureSourceDialog
        source={activeSource}
        onClose={() => setActiveSource(null)}
      />
    </div>
  )
}

function collectCitedLiteratureSources(
  content: string,
  sources: MedicalLiteratureSource[],
): MedicalLiteratureSource[] {
  if (!content || sources.length === 0) return []
  const citedIds = new Set(
    [...content.matchAll(/\[((?:d-\d+-\d+)|(?:\d+))\]/gi)].map((match) => match[1].toLowerCase()),
  )
  if (citedIds.size === 0) return []
  return sources.filter((source) => citedIds.has(source.id.toLowerCase()))
}

function LiteratureStackIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </svg>
  )
}

function dedupeReferenceDocs(referenceDocs?: SyntheticDocPreview[]): SyntheticDocPreview[] {
  if (!referenceDocs?.length) return []

  const seen = new Set<string>()
  const result: SyntheticDocPreview[] = []

  for (const doc of referenceDocs) {
    const key =
      doc.docId ||
      (doc.shortId != null ? `short:${doc.shortId}` : null) ||
      (doc.title ? `title:${doc.title}` : null) ||
      (doc.imageUrls?.[0] ? `image:${doc.imageUrls[0].slice(0, 64)}` : null)
    if (!key || seen.has(key)) continue
    seen.add(key)
    result.push(doc)
  }

  return result
}

function dedupeReferenceCommunicationCards(
  referenceCards?: SyntheticCommunicationCardPreview[],
): SyntheticCommunicationCardPreview[] {
  if (!referenceCards?.length) return []

  const seen = new Set<string>()
  const result: SyntheticCommunicationCardPreview[] = []

  for (const card of referenceCards) {
    const key =
      card.cardId ||
      (card.shortId ? `short:${card.shortId}` : null) ||
      (card.title ? `title:${card.title}` : null)
    if (!key || seen.has(key)) continue
    seen.add(key)
    result.push(card)
  }

  return result
}

const styles: Record<string, React.CSSProperties> = {
  row: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 'var(--chat-row-gap, 10px)',
    padding: '8px var(--chat-content-padding-right, var(--chat-horizontal-padding, 16px)) 8px var(--chat-content-padding-left, var(--chat-horizontal-padding, 16px))',
    maxWidth: '100%',
    animation: 'fadeIn 0.2s ease',
  },
  avatar: {
    flexShrink: 0,
    width: 'var(--chat-avatar-size, 28px)',
    height: 'var(--chat-avatar-size, 28px)',
    borderRadius: 'calc(var(--chat-avatar-size, 28px) * 0.285)',
    background: 'var(--color-avatar-bg)',
    color: 'var(--color-primary)',
    fontSize: 13,
    fontWeight: 600,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
  },
  contentCol: {
    flex: 1,
    minWidth: 0,
    maxWidth: 'var(--chat-assistant-max-width, 92%)',
  },
  markdown: {
    fontSize: 'var(--font-size-chat)',
    lineHeight: 1.65,
    color: 'var(--color-text)',
    wordBreak: 'break-word',
  },
  toolCards: {
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    marginBottom: 10,
  },
  thinkingPlaceholder: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 7,
    padding: '3px 9px',
    borderRadius: 11,
    background: 'rgba(255, 245, 238, 0.5)',
    marginBottom: 8,
    animation: 'fadeIn 0.3s ease',
  },
  thinkingText: {
    fontSize: 12,
    lineHeight: '16px',
    fontWeight: 600,
  },
  referenceRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 6,
    margin: '6px 0 10px',
  },
  cursor: {
    display: 'inline-block',
    color: 'var(--color-text-muted)',
    animation: 'blink 1s step-end infinite',
    marginLeft: 2,
  },
  timestamp: {
    display: 'block',
    fontSize: 11,
    color: 'var(--color-text-muted)',
    marginTop: 6,
  },
  interruptedRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginTop: 6,
  },
  interruptedChip: {
    display: 'inline-block',
    fontSize: 11,
    color: 'var(--color-text-muted)',
    background: 'var(--color-surface)',
    padding: '2px 8px',
    borderRadius: 10,
  },
  retryBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    fontSize: 11,
    color: 'var(--color-primary)',
    background: 'transparent',
    border: '1px solid var(--color-border)',
    padding: '2px 8px',
    borderRadius: 10,
    cursor: 'pointer',
  },
  disclaimer: {
    fontSize: 11,
    color: 'var(--color-text-muted)',
    opacity: 0.6,
    marginTop: 8,
    lineHeight: 1.4,
  },
  actionBar: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginTop: 4,
  },
  relatedLiterature: {
    marginTop: 18,
    padding: '16px 14px 14px',
    borderRadius: 24,
    background: 'linear-gradient(180deg, rgba(255, 252, 248, 0.98), rgba(255, 247, 239, 0.92))',
    border: '1px solid rgba(232, 221, 212, 0.78)',
    boxShadow: '0 14px 34px rgba(154, 102, 74, 0.08)',
  },
  relatedLiteratureHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginBottom: 12,
  },
  relatedLiteratureIcon: {
    width: 28,
    height: 28,
    borderRadius: 14,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#C56F52',
    background: 'rgba(250, 238, 229, 0.9)',
  },
  relatedLiteratureTitle: {
    fontSize: 16,
    lineHeight: '24px',
    color: 'var(--color-text)',
    fontWeight: 800,
  },
  relatedLiteratureCount: {
    fontSize: 13,
    lineHeight: '18px',
    color: '#AFA49D',
    fontWeight: 700,
  },
  relatedLiteratureList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  relatedLiteratureItem: {
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    textAlign: 'left',
    border: '1px solid rgba(226, 220, 216, 0.95)',
    background: 'rgba(255, 255, 255, 0.94)',
    borderRadius: 14,
    padding: '11px 12px',
    cursor: 'pointer',
    color: 'var(--color-text)',
    boxShadow: '0 6px 18px rgba(76, 59, 48, 0.045)',
    WebkitTapHighlightColor: 'transparent',
  },
  relatedLiteratureRank: {
    color: '#BF6F58',
    fontWeight: 800,
    marginRight: 8,
    flexShrink: 0,
  },
  relatedLiteratureText: {
    minWidth: 0,
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  relatedLiteratureItemTitle: {
    color: 'var(--color-text)',
    fontSize: 14,
    lineHeight: '20px',
    fontWeight: 700,
    display: 'block',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    wordBreak: 'normal',
    flex: 1,
    minWidth: 0,
  },
  relatedLiteratureMeta: {
    color: '#AFA49D',
    fontSize: 13,
    lineHeight: '20px',
    flexShrink: 0,
    whiteSpace: 'nowrap',
  },
  relatedLiteratureMore: {
    width: '100%',
    marginTop: 12,
    height: 32,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    border: 'none',
    background: 'transparent',
    color: '#A88476',
    fontSize: 13,
    fontWeight: 700,
    cursor: 'pointer',
    WebkitTapHighlightColor: 'transparent',
  },
  actionButton: {
    width: 28,
    height: 28,
    borderRadius: 6,
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: 'var(--color-text-muted)',
    transition: 'color 0.15s',
    // 阻止 iOS 长按弹出系统 callout / 选中高亮，避免菜单残留遮挡点击
    WebkitTouchCallout: 'none',
    WebkitUserSelect: 'none',
    userSelect: 'none',
    WebkitTapHighlightColor: 'transparent',
  },
  actionButtonBusy: {
    opacity: 0.55,
    cursor: 'default',
  },
  readonlyActionButton: {
    cursor: 'default',
  },
  feedbackLikeActive: {
    color: '#D4876C',
  },
  feedbackDislikeActive: {
    color: '#D98B8B',
  },
  ttsActive: {
    color: 'var(--color-brand)',
  },
  favoriteActive: {
    color: '#D4876C',
  },
}
