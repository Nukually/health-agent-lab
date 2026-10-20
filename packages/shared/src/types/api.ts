import type { CurrentConcern } from './user.js'
import type { UserChannelSourceInfo } from '../channel-source.js'
import type {
  ClientExperienceSnapshot,
  ClientSurface,
  UiReleaseId,
  UiVariantKey,
} from '../client-experience.js'
import type { FeatureSnapshot } from '../features.js'

// === Request Types ===

export interface SendCodeRequest {
  phone: string
}

export interface LoginConsentStatusRequest {
  phone: string
}

export interface LoginConsentStatusResponse {
  hasCurrentLoginConsent: boolean
}

export interface LoginRequest {
  phone: string
  code: string
  agreementAccepted: boolean
  channelCode?: string
}

export interface LoginResponse {
  token: string
  user: UserProfile
  userSource?: UserChannelSourceInfo | null
  needsProfile: boolean
  requireCompleteProfile: boolean
  consents: import('./consent.js').UserConsent[]
  features?: FeatureSnapshot
  experience?: ClientExperienceSnapshot
  appDownloads?: AppDownloadUrls
}

export interface UserProfile {
  id: string
  phone: string
  nickname: string | null
  avatarUrl: string | null
  birthday: string | null
  gender: string | null
  currentConcern: CurrentConcern | null
}

export interface ProfileResponse {
  user: Pick<UserProfile, 'nickname' | 'birthday' | 'gender' | 'currentConcern'>
  medical: import('./user.js').MedicalRecord | null
}

export interface ChatSendRequest {
  sessionId?: string
  content: string
  images?: string[] // base64 or URLs for multimodal
  imageAssetIds?: string[]
  firstActivation?: boolean
  /** 复用并可覆盖当前会话最后一条 user 消息，而不是新建一条 user 消息 */
  retryLatestUserMessage?: boolean
  clientEnvironment?: ClientEnvironmentHint
}

export interface ClientEnvironmentHint {
  surface?: ClientSurface | string | null
  platform?: string | null
  source?: string | null
  userAgent?: string | null
  appVersion?: string | null
  versionCode?: string | number | null
  bridgeVersion?: string | null
  h5BuildVersion?: string | null
  uiReleaseId?: UiReleaseId | string | null
  uiVariant?: UiVariantKey | string | null
}

export interface ClientExperienceResponse {
  features: FeatureSnapshot
  experience: ClientExperienceSnapshot
  userSource?: UserChannelSourceInfo | null
  appDownloads?: AppDownloadUrls
}

export interface AppDownloadUrls {
  android: string
  ios: string
  harmony: string
}

export type ChatTransportMode = 'stream' | 'sync'

export type ChatTransportUaBucket = 'default' | 'ios_webkit'

// === Response Types ===

export interface ApiResponse<T = unknown> {
  success: boolean
  data?: T
  error?: string
}

export interface ChatTransportModeResponse {
  mode: ChatTransportMode
  uaBucket: ChatTransportUaBucket
}

export interface SessionListItem {
  id: string
  title: string | null
  messageCount: number
  updatedAt: string
}

export interface SessionListResponse {
  items: SessionListItem[]
  hasMore: boolean
  /** 最后一项的 updatedAt（ISO），作为下一页 `before` 游标；无更多时为 null */
  nextCursor: string | null
}

export interface SessionDetail {
  id: string
  title: string | null
  messageCount: number
  updatedAt: string
  isFirstActivationConversation?: boolean
  messages: MessageRecord[]
  /** 是否还有更早的历史可向上翻页 */
  hasMore: boolean
  /** 当前已加载消息中最早一条的 createdAt（ISO），作为下一页游标；空会话为 null */
  oldestCreatedAt: string | null
}

export interface SyntheticDocPreview {
  /** 后端文档主键；当前轮实时生成时可能仅有它，没有 imageUrls */
  docId?: string | null
  /** prompt 里给模型使用的短 ID；用于把 <reference doc_id="d-1" /> 映射回原图 */
  shortId?: string | null
  title?: string | null
  /** 历史消息回放时可直接携带；当前轮实时生成也允许缺省，前端会按 docId 懒加载 */
  imageUrls?: string[]
}

export interface SyntheticCommunicationCardPreview {
  /** communication_cards 主键；前端点击引用 chip 时按需拉取详情 */
  cardId?: string | null
  /** prompt 里给模型使用的短 ID，例如 c-1 */
  shortId?: string | null
  title?: string | null
}

export interface MessageImageAttachment {
  assetId: string
  thumbUrl: string
  displayUrl?: string
  originalUrl?: string
  width: number
  height: number
}

export interface ImageAssetUploadResponse {
  assets: MessageImageAttachment[]
}

export interface MessageRecord {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  images?: string[]
  imageAttachments?: MessageImageAttachment[]
  thinking: string | null
  toolCalls: ToolCallRecord[] | null
  /** 服务端持久化的过程时间线快照；分享页/历史页优先用它恢复原始流式顺序 */
  processTimeline?: MessageProcessStep[]
  processDurationMs?: number
  /** 输出 token per second，排除首 chunk 前等待时间。 */
  outputTps?: number
  createdAt: string
  /** 仅前端使用：错误消息的语义化错误码（见 @health-agent/shared ERROR_CODES） */
  errorCode?: string
  /** 仅前端使用：标记该 errorCode 消息是一次 retry 后再次失败的结果；用于 CONTEXT_TOO_LONG 限次（压过两轮仍失败即关闭 retry 按钮） */
  retriedOnce?: boolean
  /** 该条消息是被用户手动中断的部分结果；前端据此显示"已中断"chip，后端据此在回放给 LLM 时注入 [用户手动中断] 标记 */
  interrupted?: boolean
  /** 该 user 消息是 saved_content 读取病历原图后的合成消息（非用户主动发送）。前端应跳过气泡渲染，仅在 LLM 上下文里保留 */
  synthetic?: boolean
  /** synthetic user 消息里按文档切分后的原图预览元数据；供引用 chip 在聊天内直接打开原图 */
  syntheticDocs?: SyntheticDocPreview[]
  /** synthetic user 消息里的医患沟通卡片预览元数据；供引用 chip 点击后打开卡片 */
  syntheticCommunicationCards?: SyntheticCommunicationCardPreview[]
}

export interface ToolCallRecord {
  toolCallId?: string
  name: string
  /** 对外返回时默认剥离；少量轻量工具会保留可读摘要。完整入参仅后端 DB 内部保留用于回放与审计。 */
  input: unknown
  /** 工具调用原始 arguments JSON 字符串；用于跨轮回放时保持 prefix 字节稳定 */
  rawArguments?: string
  /** tool_calls 那条 assistant 消息在调用工具前的原始 content；通常为空串 */
  assistantToolCallContent?: string
  /** 同一 assistant turn 内第几次原生 assistant(tool_calls)；用于跨轮按真实 LLM 序列回放。 */
  assistantStepIndex?: number
  /** 回放给 LLM 的精简 tool_result 文本；缺省时退回序列化 output */
  llmOutput?: string
  /** 默认工具对外返回 null；业务卡片类/轻量摘要工具返回前端渲染所需结构化结果。 */
  output: unknown
  durationMs?: number
}

/** `thinking` is legacy-only for messages created before the public agent timeline. */
export type MessageProcessStep =
  | { type: 'thinking'; content: string; isActive: boolean; timestamp: number }
  | { type: 'tool_plan'; content: string; toolName?: string; transient?: boolean; isActive: boolean; timestamp: number }
  | { type: 'tool_call'; toolCallId?: string; name: string; input?: unknown; output?: unknown; durationMs?: number; isActive: boolean; timestamp: number; scheduleConfirmation?: 'pending' | 'confirmed' | 'rejected'; scheduledTaskId?: string }
  | { type: 'text'; content: string; timestamp: number }
  | { type: 'doc_view'; titles: Array<string | null>; count: number; isActive: boolean; timestamp: number }
  | { type: 'protocol_recovery'; reason: string; retryAttempt?: number; isActive: boolean; timestamp: number }

export interface ChatSendSyncResponse {
  sessionId: string
  message: MessageRecord | null
  approvals?: import('./chat.js').ToolApprovalPayload[]
  scheduleConfirmations?: import('./chat.js').ScheduleConfirmationPayload[]
  profileNotices?: import('./chat.js').ProfileAutoUpdatedPayload[]
  medicalDocumentSaveSuggestions?: import('./chat.js').MedicalDocumentSaveSuggestionPayload[]
  documentAttachments?: import('./chat.js').DocumentAttachedPayload[]
  errorCode?: string
  errorMessage?: string
}

// === Feedback Types ===

export type FeedbackRating = 'like' | 'dislike'

// === Share Types ===

export interface ShareSessionRequest {
  upToMessageId: string
}

export interface ShareSessionResponse {
  shareToken: string
  shareUrl: string
}

export interface SharedSessionDetail {
  sessionId: string
  title: string | null
  messageCount: number
  createdAt: string
  messages: MessageRecord[]
  feedbackMap: Record<string, FeedbackRating>
}

export interface MessageFeedbackRequest {
  messageId: string
  sessionId: string
  rating: FeedbackRating
}

export interface MessageFeedbackRecord {
  messageId: string
  rating: FeedbackRating
  createdAt: string
}

// === Message Favorite Types ===

export interface MessageFavoriteRecord {
  id: string
  sessionId: string
  messageId: string
  userMessageId: string | null
  userContentSnapshot: string | null
  contentSnapshot: string
  contentPreview: string
  sessionTitle: string | null
  messageCreatedAt: string
  createdAt: string
  updatedAt: string
}

export interface MessageFavoriteListResponse {
  items: MessageFavoriteRecord[]
  hasMore: boolean
  nextCursor: string | null
}

export interface MessageFavoriteCreateRequest {
  sessionId: string
  messageId: string
}

export interface SessionMessageFavoritesResponse {
  messageIds: string[]
}
