import type {
  InterventionMaterialToolOutput,
  MedicalRiskInternalVideoResource,
  MedicalRiskResourceTodoContext,
  MedicalRiskVideoResource,
} from './intervention-material.js'

export type TodoPlanStatus = 'not_started' | 'in_progress' | 'completed' | 'stopped'

export type TodoItemStatus = 'pending' | 'notified' | 'started' | 'completed' | 'not_practiced'

export type TodoItemClosedReason =
  | 'feedback'
  | 'user_not_practiced'
  | 'auto_completed_before_next_trigger'
  | 'auto_not_practiced_before_next_trigger'

export type TodoFeedback = 'better' | 'same' | 'worse'

export type TodoPlanSourceType = 'intervention' | 'video_resource' | 'custom'

export type TodoPlanAction = 'create' | 'update' | 'stop'

export interface TodoToolTodoSummary {
  id: string
  date: string
  time: string
  showPrompt: string
  prompt: string
  scheduleId?: string | null
  status: TodoItemStatus
  feedback?: TodoFeedback | null
  notifiedAt?: string | null
  startedAt?: string | null
  completedAt?: string | null
  closedReason?: TodoItemClosedReason | null
}

export interface TodoToolPlanSummary {
  id: string
  title: string
  status: TodoPlanStatus
  timezone: string
  sourceType: TodoPlanSourceType
  sourceId?: string | null
  resourceRefId?: string | null
  courseDays?: number | null
  targetSideEffect?: string | null
  dedupeKey?: string | null
  todosMd: string
  todos: TodoToolTodoSummary[]
  createdAt: string
  updatedAt: string
  startedAt?: string | null
  completedAt?: string | null
  stoppedAt?: string | null
}

export type TodoPlanConflictType =
  | 'same_target_active_plan'
  | 'time_slot_overlap'
  | 'duplicate_source'

export interface TodoPlanConflictOverlapTime {
  newTime: string
  existingTime: string
  existingTodoPrompt?: string | null
  deltaMinutes: number
}

export interface TodoPlanConflict {
  type: TodoPlanConflictType
  planId: string
  planTitle: string
  targetSideEffect?: string | null
  reason: string
  overlapTimes?: TodoPlanConflictOverlapTime[]
}

export interface TodoToolPlanOutput {
  kind: 'todos'
  action: TodoPlanAction
  plan: TodoToolPlanSummary
  previousPlanId?: string | null
  message: string
}

export interface TodoToolConflictOutput {
  kind: 'todos_conflict'
  action: 'create'
  sourceAction: 'create'
  conflicts: TodoPlanConflict[]
  message: string
  nextAction: 'ask_user_question'
}

export type TodoToolOutput = TodoToolPlanOutput | TodoToolConflictOutput

export interface TodoFeedbackRequest {
  sessionId: string
  planId: string
  feedback: TodoFeedback
}

export interface TodoFeedbackResponse {
  plan: TodoToolPlanSummary
  todo: TodoToolTodoSummary
}

export interface TodoStartRequest {
  sessionId: string
  planId: string
}

export interface TodoStartResponse {
  plan: TodoToolPlanSummary
  todo: TodoToolTodoSummary
}

/** 「我的提醒」跟练计划 Tab：列出当前用户的跟练计划（含每日 todos）。 */
export interface TodoPlanListResponse {
  plans: TodoToolPlanSummary[]
}

/**
 * 单条 todo 事项的可播放资源。日历详情点播时按 kind 渲染对应播放器，
 * 并把 todoContext 喂回播放器/反馈栏以记录完成。
 * 干预素材的 toolCallId 用于复用聊天内「开始跟练」交互（来自原会话的工具调用）。
 */
export type TodoItemPlayableResource =
  | {
      kind: 'intervention_material'
      sessionId: string
      toolCallId: string | null
      output: InterventionMaterialToolOutput
      todoContext: MedicalRiskResourceTodoContext
    }
  | {
      kind: 'internal_video'
      sessionId: string
      toolCallId: string | null
      resource: MedicalRiskInternalVideoResource
      todoContext: MedicalRiskResourceTodoContext
    }
  | {
      kind: 'video_resource'
      sessionId: string
      resource: MedicalRiskVideoResource
      todoContext: MedicalRiskResourceTodoContext
    }

export interface TodoItemResourceResponse {
  resource: TodoItemPlayableResource | null
}
