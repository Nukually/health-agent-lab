import { isMedicalLiteratureSearchOutput, type MedicalLiteratureSearchOutput } from './medical-literature.js'
import type { InternalVideoTags } from './internal-video.js'
import type { TodoItemStatus } from './todos.js'

export type InterventionMaterialStatus = 'draft' | 'published' | 'archived'

export type InterventionTargetEnv = 'dev' | 'sit' | 'prod'

export interface InterventionMaterialEnvVersion {
  version: string
}

export interface InterventionMaterialEnvPresence {
  dev: InterventionMaterialEnvVersion | null
  sit: InterventionMaterialEnvVersion | null
  prod: InterventionMaterialEnvVersion | null
}

export interface InterventionAssetRef {
  key: string
  contentType: string
  url?: string
}

export interface InterventionMaterialStep {
  stepIndex: number
  durationSec: number
  displayText: string
  ttsText: string
  imageAsset: InterventionAssetRef
  audioAsset: InterventionAssetRef
}

export interface InterventionMaterialRecord {
  materialId: string
  version: string
  status: InterventionMaterialStatus
  sideEffect: string
  scene: string
  actionName: string
  prepareItems: string[]
  precheckQuestion: string
  feedbackQuestion: string
  effectiveRule: string
  fallbackAction: string
  redFlags: string[]
  safetyNote: string
  overviewAsset: InterventionAssetRef
  steps: InterventionMaterialStep[]
  createdAt: string
  updatedAt: string
}

export interface ExistingInterventionAssetInput {
  kind: 'existing'
  key: string
}

export interface UploadInterventionAssetInput {
  kind: 'upload'
  dataUrl: string
}

export type InterventionAssetInput =
  | ExistingInterventionAssetInput
  | UploadInterventionAssetInput

export interface InterventionMaterialStepInput {
  stepIndex: number
  durationSec: number
  displayText: string
  ttsText: string
  image: InterventionAssetInput
}

export interface InterventionMaterialSaveRequest {
  sideEffect: string
  scene: string
  actionName: string
  prepareItems: string[]
  precheckQuestion: string
  feedbackQuestion: string
  effectiveRule: string
  fallbackAction: string
  redFlags: string[]
  safetyNote: string
  overviewImage: InterventionAssetInput
  steps: InterventionMaterialStepInput[]
}

export interface InterventionMaterialPromoteRequest {
  targetEnv: Exclude<InterventionTargetEnv, 'dev'>
}

export interface InterventionMaterialToolOverview {
  totalDurationSec: number
  prepareItems: string[]
  precheckQuestion: string
  feedbackQuestion: string
  effectiveRule: string
  fallbackAction: string
  redFlags: string[]
  safetyNote: string
}

export interface InterventionMaterialToolStepMeta {
  stepIndex: number
  durationSec: number
  displayText: string
}

export interface InterventionMaterialToolStableAssetKeys {
  overviewImageKey: string
  stepImageKeys: string[]
  stepAudioKeys: string[]
}

export interface InterventionMaterialToolSignedUrls {
  overviewImageUrl: string
  stepImageUrls: string[]
  stepAudioUrls: string[]
}

export interface InterventionMaterialProgressSnapshot {
  savedAt: string | null
  viewedAt: string | null
  followStartedAt: string | null
  followCompletedAt: string | null
  totalFollowSec: number
  completedStepCount: number
  totalStepCount: number
  lastStepIndex: number | null
}

export interface InterventionDiscomfortFeedbackState {
  preScore: number | null
  postScore: number | null
}

export type MedicalRiskResourceDifficulty = 'simple' | 'medium' | 'complex'

export interface MedicalRiskResourceTodoContext {
  planId: string
  todoId: string
  scheduledMessageId?: string | null
  feedback?: 'better' | 'same' | 'worse' | null
  status?: TodoItemStatus | null
}

export interface InterventionDiscomfortFeedbackSnapshotItem extends InterventionDiscomfortFeedbackState {
  resourceKind: InterventionDiscomfortFeedbackResourceKind
  resourceId: string
}

export interface InterventionMaterialToolOutput {
  kind: 'intervention_material'
  code: string
  materialId: string
  version: string
  sideEffect: string
  scene: string
  actionName: string
  overview: InterventionMaterialToolOverview
  stepsMeta: InterventionMaterialToolStepMeta[]
  stableAssetKeys: InterventionMaterialToolStableAssetKeys
  currentSignedUrls: InterventionMaterialToolSignedUrls
  progress?: InterventionMaterialProgressSnapshot | null
  discomfortFeedback?: InterventionDiscomfortFeedbackState | null
}

export interface MedicalRiskInterventionResource {
  id: string
  kind: 'intervention_material'
  title: string
  difficulty?: MedicalRiskResourceDifficulty | null
  todoContext?: MedicalRiskResourceTodoContext | null
  code: string
  sideEffect: string
  scene: string
  actionName: string
  material: InterventionMaterialToolOutput
}

export interface MedicalRiskVideoResource {
  id: string
  kind: 'video_resource'
  title: string
  difficulty?: MedicalRiskResourceDifficulty | null
  todoContext?: MedicalRiskResourceTodoContext | null
  url: string
  providerVideoId: string | null
  publishedAt: string | null
  durationSec: number
  thumbnailUrl: string | null
  snippet: string
  sourceQuery: string
  discomfortFeedback?: InterventionDiscomfortFeedbackState | null
}

/**
 * 内部高质量视频资源：内部托管、原生播放器播放、精确打点。
 * generate_plan 优先使用这一类，区别于 bilibili 外链 MedicalRiskVideoResource。
 */
export interface MedicalRiskInternalVideoResource {
  id: string
  kind: 'internal_video'
  title: string
  difficulty?: MedicalRiskResourceDifficulty | null
  todoContext?: MedicalRiskResourceTodoContext | null
  /** catalog 里的稳定视频 id */
  videoId: string
  version: string
  description: string
  durationSec: number
  /** 稳定 OSS key（持久），signed URL 临时 */
  videoKey: string
  posterKey: string
  videoUrl: string
  posterUrl: string
  tags: InternalVideoTags
  sourceRef: string
  discomfortFeedback?: InterventionDiscomfortFeedbackState | null
}

export type MedicalRiskResource =
  | MedicalRiskInterventionResource
  | MedicalRiskVideoResource
  | MedicalRiskInternalVideoResource

export interface MedicalRiskToolOutput {
  kind: 'medical_risk_resources'
  resources: MedicalRiskResource[]
  literatureSearch?: MedicalLiteratureSearchOutput
}

export interface InterventionMaterialRuntimeDetailResponse {
  detail: InterventionMaterialToolOutput
  engagement: InterventionMaterialEngagementRecord | null
  savedEngagement: InterventionMaterialEngagementRecord | null
}

export type InterventionMaterialInteractionEvent =
  | 'view'
  | 'save'
  | 'follow_start'
  | 'progress'
  | 'follow_complete'
  | 'follow_return_overview'

export type InterventionMaterialInteractionSource = 'chat_inline' | 'materials'

export type InterventionDiscomfortFeedbackResourceKind =
  | 'intervention_material'
  | 'video_resource'
  | 'internal_video'

export type InterventionDiscomfortFeedbackTiming = 'pre' | 'post'

export interface InterventionDiscomfortFeedbackRequest {
  sessionId: string
  resourceKind: InterventionDiscomfortFeedbackResourceKind
  resourceId: string
  resourceTitle?: string | null
  resourceContext?: string | null
  toolCallId?: string | null
  engagementId?: string | null
  timing: InterventionDiscomfortFeedbackTiming
  score: number
  source?: InterventionMaterialInteractionSource
  totalFollowSec?: number
  materialDurationSec?: number
}

export interface InterventionDiscomfortFeedbackRecord {
  id: string
  userId: string
  sessionId: string
  resourceKind: InterventionDiscomfortFeedbackResourceKind
  resourceId: string
  resourceTitle: string | null
  resourceContext: string | null
  toolCallId: string | null
  engagementId: string | null
  timing: InterventionDiscomfortFeedbackTiming
  score: number
  source: InterventionMaterialInteractionSource
  totalFollowSec: number | null
  materialDurationSec: number | null
  createdAt: string
  updatedAt: string
}

export interface InterventionDiscomfortFeedbackResponse {
  feedback: InterventionDiscomfortFeedbackRecord
}

export type InterventionEffectFollowupStatus =
  | 'none'
  | 'pending'
  | 'processing'
  | 'sent'
  | 'failed'

export type InterventionFollowupIntentKind =
  | 'effect_question'
  | 'completion_reminder_offer'

export type InterventionFollowupIntentStatus =
  | 'pending'
  | 'generating'
  | 'sent'
  | 'consumed_by_user_message'
  | 'discarded'
  | 'failed'

export type ScheduledProactiveMessagePurpose =
  | 'intervention_completion_reminder'
  | 'medication_reminder'
  | 'review_reminder'
  | 'custom'

export type ScheduledProactiveMessageStatus =
  | 'pending'
  | 'processing'
  | 'sent'
  | 'canceled'
  | 'deleted'
  | 'failed'

export type ScheduledProactiveMessageTimeSource =
  | 'user_explicit'
  | 'ai_inferred_default'

export interface InterventionMaterialInteractionRequest {
  sessionId: string
  toolCallId: string
  event: InterventionMaterialInteractionEvent
  source?: InterventionMaterialInteractionSource
  totalFollowSec?: number
  materialDurationSec?: number
  completedStepCount?: number
  totalStepCount?: number
  lastStepIndex?: number | null
}

export interface InterventionMaterialEngagementRecord {
  id: string
  userId: string
  sessionId: string
  toolCallId: string
  materialId: string
  materialVersion: string
  materialCode: string
  materialDurationSec: number
  savedAt: string | null
  viewedAt: string | null
  followStartedAt: string | null
  followCompletedAt: string | null
  totalFollowSec: number
  completedStepCount: number
  totalStepCount: number
  lastStepIndex: number | null
  reminderConsumedAt: string | null
  effectFollowupDueAt: string | null
  effectFollowupStatus: InterventionEffectFollowupStatus
  effectFollowupSentAt: string | null
  effectFollowupMessageId: string | null
  effectFollowupAttemptCount: number
  effectFollowupLastError: string | null
  createdAt: string
  updatedAt: string
}

export interface InterventionMaterialInteractionResponse {
  engagement: InterventionMaterialEngagementRecord
  assistantMessage?: import('./api.js').MessageRecord | null
}

export interface SavedInterventionMaterialRecord {
  engagement: InterventionMaterialEngagementRecord
  detail: InterventionMaterialToolOutput | null
}

export interface SavedInterventionMaterialListResponse {
  items: SavedInterventionMaterialRecord[]
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function isStepMeta(value: unknown): value is InterventionMaterialToolStepMeta {
  if (!value || typeof value !== 'object') return false
  const step = value as Record<string, unknown>
  return typeof step.stepIndex === 'number'
    && typeof step.durationSec === 'number'
    && typeof step.displayText === 'string'
}

export function isInterventionMaterialToolOutput(
  value: unknown,
): value is InterventionMaterialToolOutput {
  if (!value || typeof value !== 'object') return false
  const raw = value as Record<string, unknown>
  const overview = raw.overview as Record<string, unknown> | undefined
  const stableAssetKeys = raw.stableAssetKeys as Record<string, unknown> | undefined
  const currentSignedUrls = raw.currentSignedUrls as Record<string, unknown> | undefined

  return raw.kind === 'intervention_material'
    && typeof raw.code === 'string'
    && typeof raw.materialId === 'string'
    && typeof raw.version === 'string'
    && typeof raw.sideEffect === 'string'
    && typeof raw.scene === 'string'
    && typeof raw.actionName === 'string'
    && !!overview
    && typeof overview.totalDurationSec === 'number'
    && isStringArray(overview.prepareItems)
    && typeof overview.precheckQuestion === 'string'
    && typeof overview.feedbackQuestion === 'string'
    && typeof overview.effectiveRule === 'string'
    && typeof overview.fallbackAction === 'string'
    && isStringArray(overview.redFlags)
    && typeof overview.safetyNote === 'string'
    && Array.isArray(raw.stepsMeta)
    && raw.stepsMeta.every(isStepMeta)
    && !!stableAssetKeys
    && typeof stableAssetKeys.overviewImageKey === 'string'
    && isStringArray(stableAssetKeys.stepImageKeys)
    && isStringArray(stableAssetKeys.stepAudioKeys)
    && !!currentSignedUrls
    && typeof currentSignedUrls.overviewImageUrl === 'string'
    && isStringArray(currentSignedUrls.stepImageUrls)
    && isStringArray(currentSignedUrls.stepAudioUrls)
}

export function parseInterventionMaterialToolOutput(
  raw: unknown,
): InterventionMaterialToolOutput | null {
  if (typeof raw === 'string') {
    try {
      return parseInterventionMaterialToolOutput(JSON.parse(raw))
    } catch {
      return null
    }
  }

  return isInterventionMaterialToolOutput(raw) ? raw : null
}

function isMedicalRiskVideoResource(
  value: unknown,
): value is MedicalRiskVideoResource {
  if (!value || typeof value !== 'object') return false
  const raw = value as Record<string, unknown>
  return raw.kind === 'video_resource'
    && typeof raw.id === 'string'
    && typeof raw.title === 'string'
    && typeof raw.url === 'string'
    && (typeof raw.providerVideoId === 'string' || raw.providerVideoId === null)
    && (typeof raw.publishedAt === 'string' || raw.publishedAt === null)
    && typeof raw.durationSec === 'number'
    && (typeof raw.thumbnailUrl === 'string' || raw.thumbnailUrl === null)
    && typeof raw.snippet === 'string'
    && typeof raw.sourceQuery === 'string'
    && (raw.difficulty === undefined || raw.difficulty === null || raw.difficulty === 'simple' || raw.difficulty === 'medium' || raw.difficulty === 'complex')
    && (raw.todoContext === undefined || raw.todoContext === null || isMedicalRiskResourceTodoContext(raw.todoContext))
}

function isMedicalRiskInternalVideoResource(
  value: unknown,
): value is MedicalRiskInternalVideoResource {
  if (!value || typeof value !== 'object') return false
  const raw = value as Record<string, unknown>
  return raw.kind === 'internal_video'
    && typeof raw.id === 'string'
    && typeof raw.title === 'string'
    && typeof raw.videoId === 'string'
    && typeof raw.version === 'string'
    && typeof raw.description === 'string'
    && typeof raw.durationSec === 'number'
    && typeof raw.videoKey === 'string'
    && typeof raw.posterKey === 'string'
    && typeof raw.videoUrl === 'string'
    && typeof raw.posterUrl === 'string'
    && typeof raw.sourceRef === 'string'
    && !!raw.tags && typeof raw.tags === 'object'
    && (raw.difficulty === undefined || raw.difficulty === null || raw.difficulty === 'simple' || raw.difficulty === 'medium' || raw.difficulty === 'complex')
    && (raw.todoContext === undefined || raw.todoContext === null || isMedicalRiskResourceTodoContext(raw.todoContext))
}

function isMedicalRiskInterventionResource(
  value: unknown,
): value is MedicalRiskInterventionResource {
  if (!value || typeof value !== 'object') return false
  const raw = value as Record<string, unknown>
  return raw.kind === 'intervention_material'
    && typeof raw.id === 'string'
    && typeof raw.title === 'string'
    && typeof raw.code === 'string'
    && typeof raw.sideEffect === 'string'
    && typeof raw.scene === 'string'
    && typeof raw.actionName === 'string'
    && (raw.difficulty === undefined || raw.difficulty === null || raw.difficulty === 'simple' || raw.difficulty === 'medium' || raw.difficulty === 'complex')
    && (raw.todoContext === undefined || raw.todoContext === null || isMedicalRiskResourceTodoContext(raw.todoContext))
    && isInterventionMaterialToolOutput(raw.material)
}

function isMedicalRiskResourceTodoContext(value: unknown): value is MedicalRiskResourceTodoContext {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const raw = value as Record<string, unknown>
  return typeof raw.planId === 'string'
    && raw.planId.length > 0
    && typeof raw.todoId === 'string'
    && raw.todoId.length > 0
    && (raw.scheduledMessageId === undefined || raw.scheduledMessageId === null || typeof raw.scheduledMessageId === 'string')
    && (raw.feedback === undefined || raw.feedback === null || raw.feedback === 'better' || raw.feedback === 'same' || raw.feedback === 'worse')
    && (
      raw.status === undefined
      || raw.status === null
      || raw.status === 'pending'
      || raw.status === 'notified'
      || raw.status === 'started'
      || raw.status === 'completed'
      || raw.status === 'not_practiced'
    )
}

export function isMedicalRiskToolOutput(value: unknown): value is MedicalRiskToolOutput {
  if (!value || typeof value !== 'object') return false
  const raw = value as Record<string, unknown>
  return raw.kind === 'medical_risk_resources'
    && Array.isArray(raw.resources)
    && raw.resources.every((resource) =>
      isMedicalRiskInterventionResource(resource) ||
      isMedicalRiskVideoResource(resource) ||
      isMedicalRiskInternalVideoResource(resource))
    && (raw.literatureSearch === undefined || isMedicalLiteratureSearchOutput(raw.literatureSearch))
}

export function parseMedicalRiskToolOutput(raw: unknown): MedicalRiskToolOutput | null {
  if (typeof raw === 'string') {
    try {
      return parseMedicalRiskToolOutput(JSON.parse(raw))
    } catch {
      return null
    }
  }
  return isMedicalRiskToolOutput(raw) ? raw : null
}

/**
 * 能产出 `<resource_ref id="..." />` 可引用资源的工具名集合，与前端
 * collectMedicalRiskResources 的渲染口径一致：只有这些工具的输出里出现过的
 * resource id 才是模型可以在正文里引用的合法编号。
 */
export const MEDICAL_RISK_RESOURCE_TOOL_NAMES = new Set([
  'grade_medical_risk',
  'generate_plan',
  'saved_content',
])
