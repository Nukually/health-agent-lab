import { lazy, Suspense, type ReactNode } from 'react'
import {
  getToolUiMeta,
  type InterventionMaterialInteractionSource,
  type ToolCallRecord,
  type ToolRenderKind,
} from '@health-agent/shared'
import DeferredRender from './DeferredRender.js'

const CommunicationCardInline = lazy(() => import('./CommunicationCardInline.js'))
const InterventionMaterialInline = lazy(() => import('./InterventionMaterialInline.js'))
const MedicalReportConsultationInline = lazy(() => import('./MedicalReportConsultationInline.js'))
const CheckInInline = lazy(() => import('./CheckInInline.js'))
const AskUserQuestionInline = lazy(() => import('./AskUserQuestionInline.js'))

function LazyToolOutput({ children }: { children: ReactNode }) {
  return (
    <DeferredRender>
      <Suspense fallback={null}>
        {children}
      </Suspense>
    </DeferredRender>
  )
}

export interface PendingToolCall {
  toolCallId?: string
  name: string
  phase?: 'running' | 'settling'
}

interface Props {
  toolCalls: ToolCallRecord[] | null | undefined
  sessionId: string | null
  pendingToolCalls?: PendingToolCall[]
  renderKinds?: ToolRenderKind[]
  interventionMaterialSource?: InterventionMaterialInteractionSource | 'shared_view'
  supersededByNewerUserMessage?: boolean
  hideAskUserQuestion?: boolean
  onAskUserQuestionSubmit?: (content: string) => void
}

const LOCAL_RENDER_KIND_BY_NAME: Record<string, ToolRenderKind> = {
  generate_communication_card: 'communication_card',
  show_intervention_material: 'intervention_material',
  medical_report_consultation_board: 'medical_report_consultation',
  propose_check_in_draft: 'check_in',
  propose_check_in_record: 'check_in',
  save_check_in_card: 'check_in',
  ask_user_question: 'ask_user_question',
}

export function resolveRenderKind(name: string): ToolRenderKind {
  return LOCAL_RENDER_KIND_BY_NAME[name] ?? getToolUiMeta(name).renderKind
}

/** 单卡分发上下文：renderKind → 组件 渲染时需要的环境参数 */
export interface ToolCardRenderContext {
  sessionId: string | null
  interventionMaterialSource?: InterventionMaterialInteractionSource | 'shared_view'
  supersededByNewerUserMessage?: boolean
  hideAskUserQuestion?: boolean
  onAskUserQuestionSubmit?: (content: string) => void
}

/**
 * 单个已完成 tool call → 业务卡片。renderKind→组件 映射的唯一来源，
 * ToolOutputBlocks 自身和 ProcessIndicator 内联（renderToolCard）都复用此函数。
 */
export function renderCompletedToolCard(
  renderKind: ToolRenderKind,
  tc: ToolCallRecord,
  ctx: ToolCardRenderContext,
  key?: string,
): ReactNode {
  const k = key ?? tc.toolCallId ?? tc.name
  if (renderKind === 'communication_card') {
    return (
      <LazyToolOutput key={k}>
        <CommunicationCardInline
          output={tc.output}
          sessionId={ctx.sessionId}
          toolCallId={tc.toolCallId ?? null}
        />
      </LazyToolOutput>
    )
  }
  if (renderKind === 'intervention_material') {
    return (
      <LazyToolOutput key={k}>
        <InterventionMaterialInline
          output={tc.output}
          sessionId={ctx.sessionId}
          toolCallId={tc.toolCallId ?? null}
          source={ctx.interventionMaterialSource ?? 'chat_inline'}
        />
      </LazyToolOutput>
    )
  }
  if (renderKind === 'check_in') {
    return (
      <LazyToolOutput key={k}>
        <CheckInInline
          output={tc.output}
          supersededByNewerUserMessage={ctx.supersededByNewerUserMessage ?? false}
        />
      </LazyToolOutput>
    )
  }
  if (renderKind === 'ask_user_question') {
    if (ctx.hideAskUserQuestion) return null
    return (
      <LazyToolOutput key={k}>
        <AskUserQuestionInline
          output={tc.output}
          onSubmit={ctx.onAskUserQuestionSubmit}
        />
      </LazyToolOutput>
    )
  }
  return null
}

/**
 * 单个 pending/active tool call → loading 态业务卡片。同样是唯一映射来源。
 * medical_report_consultation 仅在此 pending 路径出现（带 phase）。
 */
export function renderPendingToolCard(
  renderKind: ToolRenderKind,
  pending: PendingToolCall,
  ctx: ToolCardRenderContext,
  key?: string,
): ReactNode {
  const k = key ?? pending.toolCallId ?? pending.name
  if (renderKind === 'intervention_material') {
    return (
      <LazyToolOutput key={k}>
        <InterventionMaterialInline
          sessionId={ctx.sessionId}
          toolCallId={pending.toolCallId ?? null}
          loading
          source={ctx.interventionMaterialSource ?? 'chat_inline'}
        />
      </LazyToolOutput>
    )
  }
  if (renderKind === 'communication_card') {
    return (
      <LazyToolOutput key={k}>
        <CommunicationCardInline
          sessionId={ctx.sessionId}
          toolCallId={pending.toolCallId ?? null}
          loading
        />
      </LazyToolOutput>
    )
  }
  if (renderKind === 'check_in') {
    return (
      <LazyToolOutput key={k}>
        <CheckInInline loading />
      </LazyToolOutput>
    )
  }
  if (renderKind === 'medical_report_consultation') {
    return (
      <LazyToolOutput key={k}>
        <MedicalReportConsultationInline
          loading
          phase={pending.phase ?? 'running'}
        />
      </LazyToolOutput>
    )
  }
  return null
}

export function shouldRenderPendingToolOutputBlock(name: string): boolean {
  if (name === 'ask_user_question') return false
  return resolveRenderKind(name) !== 'check_in'
}

export function shouldRenderCompletedToolOutputBlock(name: string): boolean {
  return name !== 'save_check_in_card'
}

export default function ToolOutputBlocks({
  toolCalls,
  sessionId,
  pendingToolCalls = [],
  renderKinds,
  interventionMaterialSource = 'chat_inline',
  supersededByNewerUserMessage = false,
  hideAskUserQuestion = false,
  onAskUserQuestionSubmit,
}: Props) {
  const allowedKinds = renderKinds ? new Set(renderKinds) : null
  const renderedToolCalls = (toolCalls ?? []).filter((tc) => {
    if (!shouldRenderCompletedToolOutputBlock(tc.name)) return false
    const renderKind = resolveRenderKind(tc.name)
    return !allowedKinds || allowedKinds.has(renderKind)
  })
  const renderedToolCallIds = new Set(renderedToolCalls.map((tc) => tc.toolCallId).filter(Boolean))
  const renderedPendingCalls = pendingToolCalls.filter((tc) => {
    if (!shouldRenderPendingToolOutputBlock(tc.name)) return false
    const renderKind = resolveRenderKind(tc.name)
    if (allowedKinds && !allowedKinds.has(renderKind)) return false
    if (tc.toolCallId && renderedToolCallIds.has(tc.toolCallId)) return false
    return true
  })

  if (renderedToolCalls.length === 0 && renderedPendingCalls.length === 0) return null

  const ctx: ToolCardRenderContext = {
    sessionId,
    interventionMaterialSource,
    supersededByNewerUserMessage,
    hideAskUserQuestion,
    onAskUserQuestionSubmit,
  }

  return (
    <>
      {renderedToolCalls.map((tc, idx) =>
        renderCompletedToolCard(
          resolveRenderKind(tc.name),
          tc,
          ctx,
          tc.toolCallId ?? `${tc.name}-${idx}`,
        ),
      )}
      {renderedPendingCalls.map((tc, idx) =>
        renderPendingToolCard(
          resolveRenderKind(tc.name),
          tc,
          ctx,
          tc.toolCallId ?? `pending-${tc.name}-${idx}`,
        ),
      )}
    </>
  )
}
