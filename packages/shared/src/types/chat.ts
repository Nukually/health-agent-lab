import type {
  PersonalInfoFieldKey,
  StructuredFieldStorageScope,
  StructuredProfileFieldKey,
} from '../constants/medical.js'
import type { MedicalProfileData } from './user.js'
import type { ScheduledProactiveMessageScheduleType } from './scheduled-task.js'

// === SSE Stream Event Types ===

export type StreamEventType =
  | 'compaction_start'
  | 'compaction_end'
  | 'thinking_start'
  | 'thinking_delta'
  | 'thinking_end'
  | 'tool_call_start'
  | 'tool_call_end'
  | 'text_delta'
  | 'answer_start'
  | 'iteration_start'
  | 'message_end'
  | 'assistant_output_retracted'
  | 'error'
  | 'tool_approval_required'
  | 'schedule_confirmation_required'
  | 'profile_auto_updated'
  | 'medical_document_save_suggestion'
  | 'document_attached'
  | 'communication_card_attached'

export interface StreamEvent {
  type: StreamEventType
  data: string // JSON-encoded payload
}

// === Stream Event Payloads ===

export interface ThinkingDeltaPayload {
  content: string
}

export interface ToolCallStartPayload {
  toolCallId: string
  name: string
  /** 仅少量轻量工具会下发可读摘要；默认工具不下发完整入参。 */
  input?: unknown
}

export interface ToolCallEndPayload {
  toolCallId: string
  name: string
  /** 仅业务卡片类工具会下发渲染所需结果；默认工具不下发 LLM tool_result。 */
  output?: unknown
  durationMs: number
}

export interface TextDeltaPayload {
  content: string
}

export interface MessageEndPayload {
  messageId: string
  inputTokens: number
  outputTokens: number
  totalMs: number
}

export interface AssistantOutputRetractedPayload {
  reason: 'xml_tool_call_in_final_answer' | 'missing_final_answer' | 'duplicate_answer_prefix' | 'internal_protocol_leakage' | string
  toolName?: string
  /** 将被撤回的工具名泄漏折叠为前端安全工具规划展示；前端只渲染工具中文名，不展示原始文本。 */
  displayAsToolPlan?: boolean
  /** 协议恢复重试或失败时清掉前端临时工具规划，避免泄漏草稿残留。 */
  clearTransientToolPlan?: boolean
  retryAttempt: number
}

export interface CompactionEndPayload {
  messagesCompacted: number
  messagesRetained: number
}

export interface IterationStartPayload {
  iteration: number
}

export interface ErrorPayload {
  message: string
  code?: string
}

/**
 * tool_approval_required — 前端展示确认卡片让用户同意 / 拒绝结构化档案字段更新。
 * 后端 emit 后不等待；用户同意时前端调 POST /api/medical/profile/patch 独立落库。
 */
export type StructuredProfileField = StructuredProfileFieldKey

export interface ToolApprovalPayload {
  approvalId: string
  toolCallId: string
  field: StructuredProfileField
  fieldLabel: string
  fieldGroup: 'personal' | 'medical'
  storageScope: StructuredFieldStorageScope
  requiresHealthProfileConsent: boolean
  currentValue: string | string[] | null
  proposedValue: string | string[]
  /** 同意确认卡后要落库的档案 patch；用于 medications + medicationCustom 这类联动字段。 */
  profilePatch?: MedicalProfileData
  /** 当前字段对应的中文展示值（已做枚举→label 转换） */
  currentLabel: string | null
  proposedLabel: string
}

/**
 * schedule_confirmation_required — schedule 工具发起 add/update/delete 后，前端展示确认卡片。
 * 工具本轮不落库；用户点"同意"时前端调 POST /api/scheduled-tasks/confirm 落库，
 * 点"拒绝"时调 POST /api/scheduled-tasks/reject 登记；两种结果都通过 session-event
 * 在下一轮 <system-reminder> 告知 LLM。
 */
export type ScheduleConfirmationAction = 'add' | 'update' | 'delete'

/**
 * confirm 接口落库所需的归一化参数。executor 已完成时间解析/校验，confirm 直接消费，
 * 不再二次解析，避免歧义。delete 只需 targetTaskId；add/update 带 schedule 字段。
 */
export interface ScheduleConfirmationPendingTask {
  action: ScheduleConfirmationAction
  /** update/delete 目标的用户维度数字 ID；add 时为 null */
  targetTaskId: number | null
  taskName: string | null
  message: string | null
  /** 解析后的下一次触发 ISO 时间；delete 时为 null */
  dueAt: string | null
  scheduleType: ScheduledProactiveMessageScheduleType | null
  cronExpression: string | null
  timezone: string | null
}

export interface ScheduleConfirmationPayload {
  confirmationId: string
  toolCallId: string
  /** 产生该卡片的 assistant 消息 id；message_end 落地后由前端回填，用于点击后 patch 该消息的 processTimeline 终态 */
  messageId?: string
  action: ScheduleConfirmationAction
  /** 展示用任务名 */
  taskName: string | null
  /** 展示用时间描述（如"今天 18:00"或 cron 概要）；delete 时可为 null */
  dueAtLabel: string | null
  /** 展示用频率/类型概要 */
  scheduleSummary: string | null
  /** 展示用提醒内容；delete 时可为 null */
  message: string | null
  /** 落库执行所需参数 */
  pendingTask: ScheduleConfirmationPendingTask
}

/**
 * profile_auto_updated — 个人信息 3 字段（nickname/birthday/gender）由工具直接落库后
 * 通知前端在聊天流中渲染一条轻量只读提示条，不需用户确认、无二次授权。
 */
export type PersonalInfoField = PersonalInfoFieldKey

export interface ProfileAutoUpdatedPayload {
  noticeId: string
  toolCallId: string
  field: PersonalInfoField
  fieldLabel: string
  currentLabel: string | null
  proposedLabel: string
  updatedAt: number
}

/**
 * medical_document_save_suggestion — 本轮报告类图片已完成即时解读后，前端展示
 * “保存到健康档案”按钮；用户点击后走独立后台任务，不阻塞当前 SSE/agent loop。
 */
export interface MedicalDocumentSaveSuggestionPayload {
  suggestionId: string
  sessionId: string
  sourceMessageId: string
  toolCallId: string
  imageCount: number
  imageHashes: string[]
  documentHash: string
  createdAt: number
}

/**
 * document_attached — saved_content 读取病历后，loop 在 tool_result 之后
 * 立即把病历原图以合成 user 消息注入上下文；前端据此在当前 assistant 气泡的
 * ProcessIndicator 里显示"查看病历图片中..."动态 pill，避免 UI 停在"已思考"。
 */
export interface DocumentAttachedPayload {
  docIds: string[]
  shortIds: string[]
  titles: Array<string | null>
}

export interface CommunicationCardAttachedPayload {
  cards: Array<{
    cardId: string
    shortId: string
    title: string
  }>
}
