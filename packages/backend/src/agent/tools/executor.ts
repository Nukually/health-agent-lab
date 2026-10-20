/**
 * Tool Executor — 工具执行器
 *
 * 支持多个对模型开放的工具，另保留 update_memory 的 legacy 执行分支用于历史回放/审计：
 * - grade_medical_risk: 对医学问题做风险分级和场景分类，并返回处置策略
 * - generate_plan: 为症状/副作用匹配可跟练的干预卡片或视频资源
 * - memory: 管理用户长期记忆 Profile（user_profiles_memory.user_md）的 add/replace/remove
 * - update_structured_profile: 批量请求更新结构化字段；对每个字段三路分支
 *     1) 命中 rejectedFields（来自 session-events）→ 返回"用户此前已拒绝"，不 emit
 *     2) 当前值等于新值 → 返回"无需更新"，不 emit
 *     3) 否则 → personal 3 字段直接落库；currentConcern + medical 字段生成确认卡片
 * - saved_content: 统一 list/read 用户保存的跟练卡/视频、沟通卡、病历文档和历史未保存内容，读取病历时附加原图
 * - read_product_guide: 按当前客户端实际生效 UI release 返回产品入口、使用边界和 App 下载入口
 * - search_chat_history: 搜索历史对话原始用户-助手轮次
 * - medical_report_consultation_board: 本轮报告图片的三模型并行解读
 * - show_intervention_material: legacy 分支，仅用于历史消息/兼容执行
 * - generate_communication_card: 生成结构化医患协同卡片草稿（聊天内展示，用户稍后可保存）
 * - list_scheduled_tasks / add_scheduled_task / update_scheduled_task: 查看、创建、更新或删除未来主动提醒任务
 * - propose_check_in_draft / propose_check_in_record: 生成可编辑的打卡卡片"草稿"并持久化 card。
 * - save_check_in_card: legacy 执行分支,不再对模型开放;UI 手动保存会直接调 /api/check-ins/cards/:id/save。
 */

import { randomUUID } from 'node:crypto'
import {
  COMMUNICATION_CARD_TEMPLATE_VERSION,
  parseMedicalRiskToolOutput,
  type AskUserQuestionResourcePreview,
  type CheckInDraftToolOutput,
  type CommunicationCardRecord,
  type CommunicationCardToolOutput,
  type InterventionMaterialProgressSnapshot,
  type InterventionMaterialToolOutput,
  type MedicalDocument,
  type MedicalRiskResourceDifficulty,
  type MedicalRiskResource,
  type MedicalRiskToolOutput,
  type SavedInterventionMaterialRecord,
  type TodoToolOutput,
} from '@health-agent/shared'
import {
  appendDailyMemory,
  MemoryContentRejectedError,
  scanMemoryContentForStorage,
} from '../../services/memory.js'
import { runUserMdMemoryTool } from '../../services/user-md-memory.js'
import {
  listCommunicationCards,
  normalizeCommunicationCardDraft,
  renderCommunicationCardMarkdown,
} from '../../services/communication-card.js'
import { getInterventionToolOutputByCode } from '../../services/intervention-material-runtime.js'
import { recordInterventionDemand } from '../../services/intervention-plan-demands.js'
import {
  getInternalVideoRuntimeCatalog,
  selectMatchingInternalVideos,
  toMedicalRiskInternalVideoResource,
} from '../../services/internal-video-runtime.js'
import { resolveInterventionBucketEnv } from '../../services/intervention-material.js'
import { getEnv } from '../../env.js'
import {
  listSavedInterventionMaterials,
  recordInterventionMaterialInteraction,
} from '../../services/intervention-material-engagement.js'
import {
  listUnsavedSentContent,
  type UnsavedSentContentItem,
} from '../../services/saved-content-history.js'
import {
  searchVideoResources,
  toMedicalRiskVideoResource,
} from '../../services/baidu-web-search.js'
import { searchMedicalLiterature } from '../../services/medical-literature-search.js'
import {
  getDocumentsByIds,
  listDocuments,
  type MedicalDocumentWithBase64,
} from '../../services/medical-document.js'
import { runMedicalReportConsultation } from '../../services/medical-report-consultation.js'
import {
  searchChatHistory,
  SearchChatHistoryUserError,
} from '../../services/chat-history-search.js'
import { fetchBase64 } from '../../lib/oss.js'
import { llmCall } from '../../lib/llm.js'
import { stripSystemReminderText } from '../../utils/system-reminder.js'
import { appendSessionEvent } from '../../services/session-events.js'
import { updateUserProfile } from '../../services/user.js'
import { safeRecordAnalyticsEvent } from '../../services/analytics.js'
import { getBackendFeatureSnapshot } from '../../features.js'
import { safeTrackBackendEvent } from '../../services/tracking.js'
import {
  listFutureScheduledTasks,
  parseScheduledTimeInput,
  renderFutureScheduledTasksForTool,
} from '../../services/scheduled-proactive-message.js'
import {
  createTodoPlan,
  stopTodoPlan,
  type TodoInput,
  updateTodoPlan,
} from '../../services/todos.js'
import {
  getCheckInSchemaForTool,
  proposeCheckInDraft,
  proposeCheckInRecord,
  type CheckInSchemaMatchResult,
} from '../../services/check-in.js'
import { validateField, valueLabelOf } from '../../services/profile-validation.js'
import {
  FIELD_LABELS,
  FIELD_ENUM_LABELS,
  MEDICATION_LABELS,
  SELECTABLE_MEDICATION_DURATIONS,
  formatMedicationDurationDetails,
  formatMedicationNames,
  getFieldStorageScope,
  isBreastCancerExtensionField,
  isBreastNoduleExtensionField,
  isMedicalRecordField,
  normalizeMedicalProfileData,
  PERSONAL_INFO_FIELDS,
  requiresHealthProfileConsentForField,
  resolveMedicationDurationMap,
  resolveMedicationItems,
  resolveAllowedMedicalFieldsForAI,
  STRUCTURED_PROFILE_FIELDS,
  type ToolApprovalPayload,
  type ScheduleConfirmationPayload,
  type ScheduleConfirmationPendingTask,
  type ProfileAutoUpdatedPayload,
  type StructuredProfileField,
  type PersonalInfoField,
  type MedicalProfileData,
} from '@health-agent/shared'
import type { AgentRequestContext } from '../types.js'
import { normalizeAskUserQuestionInput } from './ask-user-question.js'
import { UPDATE_STRUCTURED_PROFILE_TOOL } from './update-structured-profile.js'
import { renderCxProductGuide } from './product-ui-guide.js'
import { listAgentSkillMetas, loadAgentSkill } from '../skills/registry.js'

export interface ToolCallInput {
  id: string
  name: string
  arguments: string
}

/** saved_content 读取病历文档的产物：由 loop 负责把 imageBlocks 拼成合成 user 消息插入对话 */
export interface AttachedDocument {
  docId: string
  shortId: string
  title: string | null
  documentDate: string | null
  hospital: string | null
  /** 可直接作为合成 user 消息 content 追加的多模态块：data URL（新文档）或 OSS 签名 URL（历史数据回退） */
  imageBlocks: Array<{ type: 'image_url'; image_url: { url: string } }>
}

export interface AttachedCommunicationCard {
  cardId: string
  shortId: string
  title: string
}

export interface ToolCallResult {
  toolCallId: string
  name: string
  output: string
  /** 提供给前端渲染的结构化结果；若缺省则回退到 output 字符串 */
  displayOutput?: unknown
  durationMs: number
  /** 0..N 个确认卡片 payload，由 loop yield 为 TOOL_APPROVAL_REQUIRED SSE 事件 */
  approvalPayloads?: ToolApprovalPayload[]
  /** 0..N 个 schedule 确认卡 payload，由 loop yield 为 SCHEDULE_CONFIRMATION_REQUIRED 事件 */
  scheduleConfirmations?: ScheduleConfirmationPayload[]
  /** 0..N 个 personal 字段自动落库通知 payload，由 loop yield 为 PROFILE_AUTO_UPDATED */
  autoUpdatedPayloads?: ProfileAutoUpdatedPayload[]
  /** saved_content 读取病历时返回的"附加原图"列表，loop 据此合成 user 消息 */
  attachedDocuments?: AttachedDocument[]
  /** saved_content 读取沟通卡时返回的医患沟通卡片引用，loop 据此合成 UI 引用 chip */
  attachedCommunicationCards?: AttachedCommunicationCard[]
}

export function shouldPauseForAskUserQuestion(result: Pick<ToolCallResult, 'name' | 'displayOutput'>): boolean {
  if (result.name !== 'ask_user_question') return false
  if (!result.displayOutput || typeof result.displayOutput !== 'object' || Array.isArray(result.displayOutput)) return false
  return (result.displayOutput as { kind?: unknown }).kind === 'ask_user_question'
}

const PERSONAL_FIELD_SET = new Set<string>(PERSONAL_INFO_FIELDS)
const STRUCTURED_FIELD_SET = new Set<string>(STRUCTURED_PROFILE_FIELDS)

const MAX_ATTACHED_IMAGES = 12
const MAX_ATTACHED_IMAGE_BASE64_CHARS = 20_000_000
const MAX_CARD_MARKDOWN_CHARS = 24_000
const MEDICAL_RISK_RESOURCE_RERANK_MODEL = 'qwen3.5-flash'
const MEDICAL_RISK_RESOURCE_RERANK_MAX_CONTEXT_CHARS = 16_000
const MEDICAL_RISK_RESOURCE_RERANK_MAX_MESSAGE_CHARS = 1_200
const RESOURCE_PROFILE_EMPTY_VALUE = '未填写'
const MEDICAL_RISK_RESOURCE_PROFILE_RULES = [
  '个人信息+健康档案适配是硬约束，必须和本轮用户需求一起判断；明显不匹配时，输出 NONE 或不引用资源。',
  '如果本轮聊天明确是在替家人/他人咨询，以被咨询对象信息为准；否则默认资源推荐给当前用户本人。',
  '性别=男：不要选择月经不调、经期调理、姨妈、痛经、绝经/围绝经/更年期等女性月经或生殖阶段相关资源。',
  '月经状态=已绝经或治疗相关停经：不要选择月经不调、经期调理、姨妈、痛经、月经推迟、经量异常等仍在来月经人群资源；只有资源明确是绝经/停经后的症状处理且本轮需求匹配时才可考虑。',
  '年龄明显不符：不要给年轻用户选择标题/描述面向 50 岁以上、中老年或老年人的资源；除非个人信息+健康档案吻合，或本轮明确是在咨询该年龄段他人。',
].join('\n')
const COMMUNICATION_CARD_ASSISTANT_REMINDER = [
  '卡片创建成功：UI 会在最终消息附近展示这张医患沟通卡。',
  '最终回答请不要复述整张卡片，只需简短告诉用户卡片已生成，可在上方收藏或编辑。',
  '同时补充两个附件提醒：',
  '1. 如果方便，再补充这些：不清楚的报告、药名、日期、检查以及结果缺失。',
  '2. 这些情况不要等：症状明显加重或出现危急信号时及时就医/急诊/联系医生；本卡只用于就诊沟通准备，不替代医生诊断或治疗建议。',
].join('\n')
// 草稿协议下,值的最终责任在用户(用户在卡片里编辑/确认),所以不再做硬 grounding 拦截。
// LLM 偶尔预填了不准确的数字也无所谓 —— 用户会在表单里看到并改掉。

type ParsedToolArguments =
  | { ok: true; value: any }
  | { ok: false; result: ToolCallResult }

function parseToolArgumentsForExecution(
  toolCall: ToolCallInput,
  start: number,
): ParsedToolArguments {
  try {
    return { ok: true, value: JSON.parse(toolCall.arguments) }
  } catch {
    return {
      ok: false,
      result: {
        toolCallId: toolCall.id,
        name: toolCall.name,
        output: '参数格式错误：工具参数不是合法 JSON。请按工具 schema 重新调用。',
        durationMs: Math.round(performance.now() - start),
      },
    }
  }
}

function renderCheckInSchemaMatchForTool(result: CheckInSchemaMatchResult): string {
  if (result.action === 'matched') {
    const schema = result.schema
    const fields = schema.a2uiSchema.fields
      .map((field) => {
        const type = field.unit ? `${field.type}/${field.unit}` : field.type
        const required = field.required ? '｜必填' : ''
        const options = field.options?.length ? `｜选项:${field.options.join('、')}` : ''
        return `- ${field.key}｜${field.label}｜${type}${required}${options}`
      })
      .join('\n') || '- 无字段'
    return [
      'action=matched',
      `categoryKey=${schema.categoryKey}`,
      `categoryName=${schema.categoryName}`,
      `displayMode=${schema.displayMode}`,
      `schemaVersion=${schema.schemaVersion}`,
      'fields:',
      fields,
      'instruction=后续调用 propose_check_in_record 时传 categoryKey; schema 只是参考,用户本轮明确内容优先,不要漏填。',
    ].join('\n')
  }

  if (result.action === 'candidates') {
    const candidates = result.candidates
      .map((item) => `- ${item.categoryName}｜categoryKey=${item.categoryKey}${item.aliases.length ? `｜别名:${item.aliases.join('、')}` : ''}`)
      .join('\n') || '- 无候选'
    return [
      'action=candidates',
      result.message,
      candidates,
      'instruction=不要猜分类,先让用户确认后再生成卡片。',
    ].join('\n')
  }

  return [
    'action=not_found',
    result.message,
    'instruction=若用户意图已清楚,可直接调用 propose_check_in_record;工具内部会基于 categoryQuery、draftValues 和用户原文创建轻量新分类。',
  ].join('\n')
}

function getLatestUserMessage(ctx: AgentRequestContext) {
  for (let i = ctx.session.messages.length - 1; i >= 0; i--) {
    const msg = ctx.session.messages[i]
    if (msg.role === 'user') return msg
  }
  return null
}

function getLatestUserMessageId(ctx: AgentRequestContext): string | null {
  return getLatestUserMessage(ctx)?.dbId ?? null
}

function getCurrentUserTextContent(ctx: AgentRequestContext): string | null {
  const latestUser = getLatestUserMessage(ctx)
  if (!latestUser) return null
  if (typeof latestUser.content === 'string') return stripSystemReminderText(latestUser.content).trim() || null
  if (!Array.isArray(latestUser.content)) return null
  const text = latestUser.content
    .filter((block): block is { type: 'text'; text: string } => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => stripSystemReminderText(block.text).trim())
    .filter(Boolean)
    .join('\n')
  return text || null
}

export function getCurrentUserImageAttachments(ctx: AgentRequestContext) {
  const latestUser = getLatestUserMessage(ctx)
  if (!latestUser || !Array.isArray(latestUser.content)) return []
  return latestUser.content
    .filter((block) => block?.type === 'image_url' && typeof block.image_url?.url === 'string')
    .map((block, index) => ({
      url: block.image_url?.url ?? '',
      name: `图片信息 ${index + 1}`,
      mimeType: block.image_url?.url?.startsWith('data:image/')
        ? block.image_url.url.slice(5, block.image_url.url.indexOf(';')) || 'image/*'
        : 'image/*',
    }))
    .filter((item) => item.url)
}

type SavedContentType = 'A' | 'B' | 'C'
type SavedContentSavedFilter = 'yes' | 'no'

interface SavedContentId {
  id: string
  type: SavedContentType
  index: number
}

interface SavedContentIndex {
  interventionMaterials: SavedInterventionMaterialRecord[]
  communicationCards: CommunicationCardRecord[]
  medicalDocs: MedicalDocument[]
  unsavedSentItems: UnsavedSentContentItem[]
  unsavedSentTruncated: boolean
}

type SavedContentAItem =
  | { saved: 'yes'; record: SavedInterventionMaterialRecord }
  | { saved: 'no'; item: Extract<UnsavedSentContentItem, { kind: 'intervention_material' | 'video_resource' }> }

type SavedContentBItem =
  | { saved: 'yes'; card: CommunicationCardRecord }
  | { saved: 'no'; item: Extract<UnsavedSentContentItem, { kind: 'communication_card' }> }

const SAVED_CONTENT_TYPES: SavedContentType[] = ['A', 'B', 'C']
const SAVED_CONTENT_TYPE_LABELS: Record<SavedContentType, string> = {
  A: '我的跟练卡/跟练视频',
  B: '我的沟通卡',
  C: '病历文档',
}
const SAVED_CONTENT_DOC_TYPE_LABELS: Record<string, string> = {
  outpatient: '门诊',
  pathology: '病理报告',
  imaging: '影像检查',
  discharge: '出院记录',
  lab: '检验报告',
  other: '其他',
}

function normalizeSavedContentType(raw: unknown): SavedContentType | null {
  if (raw == null || raw === '') return null
  const value = String(raw).trim().toUpperCase()
  if (value === 'A' || value.startsWith('A-') || value.includes('跟练')) return 'A'
  if (value === 'B' || value.startsWith('B-') || value.includes('沟通')) return 'B'
  if (value === 'C' || value.startsWith('C-') || value.includes('病历')) return 'C'
  return null
}

function normalizeSavedContentSavedFilter(raw: unknown): SavedContentSavedFilter | null {
  if (raw == null || raw === '') return null
  const value = String(raw).trim().toLowerCase()
  if (value === 'yes' || value === 'saved' || value === 'true' || value === '已保存' || value === '保存') return 'yes'
  if (value === 'no' || value === 'unsaved' || value === 'false' || value === '未保存' || value === '未收藏') return 'no'
  return null
}

function parseSavedContentId(raw: unknown): SavedContentId | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null
  const value = String(raw).trim().replace(/^\[|\]$/g, '').toUpperCase()
  const match = value.match(/^([ABC])-(\d+)$/)
  if (!match) return null
  const index = Number(match[2])
  if (!Number.isSafeInteger(index) || index < 1) return null
  return { id: `${match[1]}-${index}`, type: match[1] as SavedContentType, index }
}

function buildSavedContentAItems(index: SavedContentIndex): SavedContentAItem[] {
  return [
    ...index.interventionMaterials.map((record): SavedContentAItem => ({ saved: 'yes', record })),
    ...index.unsavedSentItems
      .filter((item): item is Extract<UnsavedSentContentItem, { kind: 'intervention_material' | 'video_resource' }> =>
        item.kind === 'intervention_material' || item.kind === 'video_resource')
      .map((item): SavedContentAItem => ({ saved: 'no', item })),
  ]
}

function buildSavedContentBItems(index: SavedContentIndex): SavedContentBItem[] {
  return [
    ...index.communicationCards.map((card): SavedContentBItem => ({ saved: 'yes', card })),
    ...index.unsavedSentItems
      .filter((item): item is Extract<UnsavedSentContentItem, { kind: 'communication_card' }> =>
        item.kind === 'communication_card')
      .map((item): SavedContentBItem => ({ saved: 'no', item })),
  ]
}

function countSavedContentItems(index: SavedContentIndex): Record<SavedContentType, number> {
  return {
    A: buildSavedContentAItems(index).length,
    B: buildSavedContentBItems(index).length,
    C: index.medicalDocs.length,
  }
}

async function loadSavedContentIndex(
  ctx: AgentRequestContext,
  type: SavedContentType | null,
  savedFilter: SavedContentSavedFilter | null,
  log: any,
): Promise<SavedContentIndex> {
  const [interventionMaterials, communicationCards, medicalDocs, unsavedSent] = await Promise.all([
    (!type || type === 'A') && savedFilter !== 'no'
      ? listSavedInterventionMaterials(ctx.userId, log)
      : Promise.resolve([]),
    (!type || type === 'B') && savedFilter !== 'no'
      ? listCommunicationCards(ctx.userId, log)
      : Promise.resolve([]),
    (!type || type === 'C') && savedFilter !== 'no'
      ? listDocuments(ctx.userId, log)
      : Promise.resolve([]),
    (!type || type === 'A' || type === 'B') && savedFilter !== 'yes'
      ? listUnsavedSentContent(ctx.userId, log)
      : Promise.resolve({ items: [], truncated: false }),
  ])

  return {
    interventionMaterials,
    communicationCards,
    medicalDocs,
    unsavedSentItems: unsavedSent.items,
    unsavedSentTruncated: unsavedSent.truncated,
  }
}

function formatShanghaiMinute(value: string | null | undefined): string {
  if (!value) return '无记录'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date).map((part) => [part.type, part.value]),
  )
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`
}

function oneLine(value: string | null | undefined, fallback = '未命名'): string {
  const text = value?.replace(/\s+/g, ' ').trim()
  return text ? text.slice(0, 120) : fallback
}

function formatDurationText(totalSec: number): string {
  const seconds = Math.max(0, Math.floor(totalSec))
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  const remain = seconds % 60
  return remain > 0 ? `${minutes} 分 ${remain} 秒` : `${minutes} 分钟`
}

interface InterventionProgressLike {
  followStartedAt: string | null
  followCompletedAt: string | null
  lastStepIndex: number | null
  totalFollowSec: number
  totalStepCount: number
  completedStepCount: number
}

function interventionProgressTextFromSnapshot(progress: InterventionProgressLike | null | undefined): string {
  if (!progress) return '尚未开始跟练'
  if (!progress.followStartedAt && !progress.lastStepIndex && progress.totalFollowSec <= 0) return '尚未开始跟练'
  const total = progress.totalStepCount
  const completed = total > 0 ? `${Math.min(progress.completedStepCount, total)}/${total}` : '未记录'
  const status = progress.followCompletedAt ? '已完成过跟练' : '已开始跟练'
  return `${status}；进度 ${completed}；累计 ${formatDurationText(progress.totalFollowSec)}`
}

function interventionProgressText(record: SavedInterventionMaterialRecord): string {
  return interventionProgressTextFromSnapshot(record.engagement)
}

function interventionFollowedText(progress: InterventionProgressLike | null | undefined): string {
  if (!progress?.followStartedAt && !progress?.lastStepIndex && (progress?.totalFollowSec ?? 0) <= 0) return '否'
  return `是（${interventionProgressTextFromSnapshot(progress)}）`
}

function videoFollowedText(item: Extract<UnsavedSentContentItem, { kind: 'video_resource' }>): string {
  if (!item.followed) return '否'
  return item.totalFollowSec > 0
    ? `是（累计 ${formatDurationText(item.totalFollowSec)}）`
    : '是'
}

function renderSavedInterventionListLine(
  record: SavedInterventionMaterialRecord,
  index: number,
): string {
  const id = `A-${index + 1}`
  const detail = record.detail
  const title = oneLine(detail?.actionName, `干预方案 ${record.engagement.materialCode}`)
  const scene = [detail?.sideEffect, detail?.scene].filter(Boolean).join(' / ') || '场景未记录'
  return `- ${id} | 已保存 | ${title} | ${scene} | 原方案编号 ${record.engagement.materialCode} | 保存 ${formatShanghaiMinute(record.engagement.savedAt)} | ${interventionProgressText(record)}`
}

function renderCommunicationCardListLine(card: CommunicationCardRecord, index: number): string {
  const id = `B-${index + 1}`
  return `- ${id} | 已保存 | 《${oneLine(card.title)}》 | 卡片日期 ${card.cardDate} | 更新 ${formatShanghaiMinute(card.updatedAt)}`
}

function renderMedicalDocumentListLine(doc: MedicalDocument, index: number): string {
  const id = `C-${index + 1}`
  const docType = doc.documentType ? SAVED_CONTENT_DOC_TYPE_LABELS[doc.documentType] || doc.documentType : '类型未记录'
  const date = doc.documentDate ?? '日期未记录'
  const hospital = doc.hospital ? ` | ${oneLine(doc.hospital)}` : ''
  return `- ${id} | 已保存 | ${oneLine(doc.title, '未命名文档')} | ${docType} | 就诊/检查 ${date}${hospital} | ${doc.pageCount}页`
}

function renderUnsavedInterventionListLine(
  item: Extract<UnsavedSentContentItem, { kind: 'intervention_material' | 'video_resource' }>,
  index: number,
): string {
  const id = `A-${index + 1}`
  if (item.kind === 'intervention_material') {
    const detail = item.detail
    const scene = [detail.sideEffect, detail.scene].filter(Boolean).join(' / ') || '场景未记录'
    return `- ${id} | 未保存 | 跟练卡 | ${oneLine(item.title)} | ${scene} | 发送 ${formatShanghaiMinute(item.sentAt)} | 是否跟练：${interventionFollowedText(item.progress)}`
  }
  const duration = item.resource.durationSec > 0 ? ` | 时长 ${formatDurationText(item.resource.durationSec)}` : ''
  return `- ${id} | 未保存 | 跟练视频 | ${oneLine(item.title)}${duration} | 发送 ${formatShanghaiMinute(item.sentAt)} | 是否跟练：${videoFollowedText(item)}`
}

function renderUnsavedCommunicationCardListLine(
  item: Extract<UnsavedSentContentItem, { kind: 'communication_card' }>,
  index: number,
): string {
  const id = `B-${index + 1}`
  return `- ${id} | 未保存 | 沟通卡 | 《${oneLine(item.title)}》 | 卡片日期 ${item.draft.cardDate} | 发送 ${formatShanghaiMinute(item.sentAt)}`
}

function renderSavedContentList(
  index: SavedContentIndex,
  typeFilter: SavedContentType | null,
  savedFilter: SavedContentSavedFilter | null,
): { output: string; displayOutput: Record<string, unknown> } {
  const counts = countSavedContentItems(index)
  const selectedTypes = typeFilter ? [typeFilter] : SAVED_CONTENT_TYPES
  const lines: string[] = []

  const displayItems: Array<Record<string, unknown>> = []
  for (const type of selectedTypes) {
    if (!typeFilter) {
      if (lines.length > 0) lines.push('')
      lines.push(`## ${type} ${SAVED_CONTENT_TYPE_LABELS[type]}（${counts[type]}）`)
    }
    if (type === 'A') {
      const items = buildSavedContentAItems(index)
      if (!items.length) {
        lines.push('- 无')
      } else {
        items.forEach((item, i) => {
          if (item.saved === 'yes') {
            lines.push(renderSavedInterventionListLine(item.record, i))
            displayItems.push({ id: `A-${i + 1}`, type, saved: 'yes', title: item.record.detail?.actionName ?? null })
          } else {
            lines.push(renderUnsavedInterventionListLine(item.item, i))
            displayItems.push({ id: `A-${i + 1}`, type, saved: 'no', subtype: item.item.kind, title: item.item.title })
          }
        })
      }
    }
    if (type === 'B') {
      const items = buildSavedContentBItems(index)
      if (!items.length) {
        lines.push('- 无')
      } else {
        items.forEach((item, i) => {
          if (item.saved === 'yes') {
            lines.push(renderCommunicationCardListLine(item.card, i))
            displayItems.push({ id: `B-${i + 1}`, type, saved: 'yes', title: item.card.title })
          } else {
            lines.push(renderUnsavedCommunicationCardListLine(item.item, i))
            displayItems.push({ id: `B-${i + 1}`, type, saved: 'no', subtype: item.item.kind, title: item.item.title })
          }
        })
      }
    }
    if (type === 'C') {
      if (!index.medicalDocs.length) {
        lines.push('- 无')
      } else {
        index.medicalDocs.forEach((doc, i) => {
          lines.push(renderMedicalDocumentListLine(doc, i))
          displayItems.push({ id: `C-${i + 1}`, type, saved: 'yes', title: doc.title })
        })
      }
    }
  }

  if (index.unsavedSentTruncated && savedFilter !== 'yes') {
    lines.push('')
    lines.push('- 未保存历史结果较多，仅纳入最近 50 条可展示记录。')
  }

  if (lines.length > 0) lines.push('')
  lines.push('如果帮用户找到了想要的资源，主动调用 saved_content action=show 展示；严禁在最终回复中提及 A-1/B-1/C-1 这类资源编号，编号仅用于内部工具参数和 resource_ref 标签。')

  return {
    output: lines.join('\n'),
    displayOutput: {
      action: 'list',
      type: typeFilter ?? 'all',
      saved: savedFilter ?? 'all',
      counts,
      items: displayItems,
    },
  }
}

function renderCommunicationCardDraftMarkdown(draft: UnsavedSentContentItem & { kind: 'communication_card' }): string {
  return [
    `# ${draft.draft.title}`,
    '',
    `- 卡片日期：${draft.draft.cardDate}`,
    '',
    `## 就诊目标`,
    draft.draft.visitPurpose || '未填写',
    '',
    `## 我的情况`,
    draft.draft.currentSituation || '未填写',
    '',
    `## 这次建议带上`,
    draft.draft.informationForDoctor || '未填写',
    draft.draft.questionsForDoctor ? ['', `## 我的问题`, draft.draft.questionsForDoctor].join('\n') : null,
  ].filter(Boolean).join('\n')
}

function renderUnsavedSentContentRead(id: string, type: SavedContentType, item: UnsavedSentContentItem): string {
  if (item.kind === 'intervention_material') {
    const detail = item.detail
    const lines = [
      'saved_content_result',
      'action=read',
      `id=${id}`,
      `type=${type} ${SAVED_CONTENT_TYPE_LABELS[type]}`,
      'subtype=跟练卡',
      `title=${detail.actionName}`,
      `scene=${detail.sideEffect} / ${detail.scene}`,
      `material_code=${detail.code}`,
      `sent_at=${formatShanghaiMinute(item.sentAt)}`,
      `saved=否`,
      `followed=${interventionFollowedText(item.progress)}`,
      '',
      '## 总览',
      `- 总时长：${formatDurationText(detail.overview.totalDurationSec)}`,
      `- 准备物品：${detail.overview.prepareItems.length ? detail.overview.prepareItems.join('、') : '无特殊准备'}`,
      `- 练前确认：${detail.overview.precheckQuestion}`,
      `- 效果判断：${detail.overview.effectiveRule}`,
      `- 反馈问题：${detail.overview.feedbackQuestion}`,
      `- 不适/无效处理：${detail.overview.fallbackAction}`,
      `- 安全提醒：${detail.overview.safetyNote}`,
    ]
    if (detail.overview.redFlags.length) {
      lines.push(`- 警示信号：${detail.overview.redFlags.join('；')}`)
    }
    lines.push('')
    lines.push('## 跟练步骤')
    detail.stepsMeta
      .slice()
      .sort((a, b) => a.stepIndex - b.stepIndex)
      .forEach((step) => {
        lines.push(`${step.stepIndex}. ${formatDurationText(step.durationSec)}｜${step.displayText}`)
      })
    lines.push('')
    lines.push('agent_instruction=这是历史会话里已发送但当前未收藏的跟练卡。可帮用户找回、总结或重新说明；不要声称它已保存。')
    return lines.join('\n')
  }

  if (item.kind === 'video_resource') {
    return [
      'saved_content_result',
      'action=read',
      `id=${id}`,
      `type=${type} ${SAVED_CONTENT_TYPE_LABELS[type]}`,
      'subtype=跟练视频',
      `title=${item.resource.title}`,
      `url=${item.resource.url}`,
      item.resource.providerVideoId ? `provider_video_id=${item.resource.providerVideoId}` : null,
      item.resource.publishedAt ? `published_at=${item.resource.publishedAt}` : null,
      `duration=${item.resource.durationSec > 0 ? formatDurationText(item.resource.durationSec) : '未知'}`,
      `source_query=${item.resource.sourceQuery}`,
      `sent_at=${formatShanghaiMinute(item.sentAt)}`,
      `saved=否`,
      `followed=${videoFollowedText(item)}`,
      item.lastFollowedAt ? `last_followed_at=${formatShanghaiMinute(item.lastFollowedAt)}` : null,
      '',
      '## 视频简介',
      item.resource.snippet || '无',
      '',
      'agent_instruction=这是历史会话里已发送但当前未收藏的视频。可把标题和链接返回给用户，或结合简介提醒跟练安全边界；不要声称它已保存。',
    ].filter(Boolean).join('\n')
  }

  const markdown = renderCommunicationCardDraftMarkdown(item)
  return [
    'saved_content_result',
    'action=read',
    `id=${id}`,
    `type=${type} ${SAVED_CONTENT_TYPE_LABELS[type]}`,
    'subtype=沟通卡',
    `title=${item.title}`,
    `sent_at=${formatShanghaiMinute(item.sentAt)}`,
    `saved=否`,
    '',
    '## 历史未保存沟通卡草稿',
    markdown,
    '',
    'agent_instruction=这是历史会话里生成过但当前未保存的沟通卡草稿。可按需引用或提醒用户重新保存；不要声称它已经在我的沟通卡里。',
  ].join('\n')
}

function savedInterventionProgress(record: SavedInterventionMaterialRecord): InterventionMaterialProgressSnapshot {
  const progress = record.engagement
  return {
    savedAt: progress.savedAt,
    viewedAt: progress.viewedAt,
    followStartedAt: progress.followStartedAt,
    followCompletedAt: progress.followCompletedAt,
    totalFollowSec: progress.totalFollowSec,
    completedStepCount: progress.completedStepCount,
    totalStepCount: progress.totalStepCount,
    lastStepIndex: progress.lastStepIndex,
  }
}

function buildInterventionShowResource(
  id: string,
  detail: InterventionMaterialToolOutput,
  progress: InterventionMaterialProgressSnapshot | null,
): MedicalRiskResource {
  return {
    id,
    kind: 'intervention_material',
    title: detail.actionName,
    code: detail.code,
    sideEffect: detail.sideEffect,
    scene: detail.scene,
    actionName: detail.actionName,
    material: {
      ...detail,
      progress: progress ?? detail.progress ?? null,
    },
  }
}

function buildVideoShowResource(
  id: string,
  item: Extract<UnsavedSentContentItem, { kind: 'video_resource' }>,
): MedicalRiskResource {
  return {
    ...item.resource,
    id,
  }
}

function renderSavedContentShowResult(
  id: string,
  label: string,
  note: string,
): string {
  return [
    'saved_content_result',
    'action=show',
    `id=${id}`,
    `resource_ref=<resource_ref id="${id}" />`,
    `title=${label}`,
    note,
    `agent_instruction=用户需要看到这个资源时，最终回答要先用一句自然话引导，再插入 <resource_ref id="${id}" />；不要把资源正文整段复述，也不要说它已重新保存。`,
  ].join('\n')
}

function medicalRiskResourceDisplayOutput(resource: MedicalRiskResource): MedicalRiskToolOutput {
  return {
    kind: 'medical_risk_resources',
    resources: [resource],
  }
}

function renderSavedInterventionRead(
  id: string,
  record: SavedInterventionMaterialRecord,
  detail: InterventionMaterialToolOutput | null,
): string {
  if (!detail) {
    return [
      'saved_content_result',
      'action=read',
      `id=${id}`,
      `type=A ${SAVED_CONTENT_TYPE_LABELS.A}`,
      `status=detail_unavailable`,
      `原方案编号=${record.engagement.materialCode}`,
      `保存时间=${formatShanghaiMinute(record.engagement.savedAt)}`,
      `跟练进度=${interventionProgressText(record)}`,
      'message=已找到收藏记录，但原始跟练卡详情暂不可用。可基于保存时间和进度回答，涉及具体步骤时请向用户说明暂时无法读取详情。',
    ].join('\n')
  }

  const lines = [
    'saved_content_result',
    'action=read',
    `id=${id}`,
    `type=A ${SAVED_CONTENT_TYPE_LABELS.A}`,
    `title=${detail.actionName}`,
    `scene=${detail.sideEffect} / ${detail.scene}`,
    `material_code=${record.engagement.materialCode}`,
    `saved_at=${formatShanghaiMinute(record.engagement.savedAt)}`,
    `progress=${interventionProgressText(record)}`,
    '',
    '## 总览',
    `- 总时长：${formatDurationText(detail.overview.totalDurationSec)}`,
    `- 准备物品：${detail.overview.prepareItems.length ? detail.overview.prepareItems.join('、') : '无特殊准备'}`,
    `- 练前确认：${detail.overview.precheckQuestion}`,
    `- 效果判断：${detail.overview.effectiveRule}`,
    `- 反馈问题：${detail.overview.feedbackQuestion}`,
    `- 不适/无效处理：${detail.overview.fallbackAction}`,
    `- 安全提醒：${detail.overview.safetyNote}`,
  ]
  if (detail.overview.redFlags.length) {
    lines.push(`- 警示信号：${detail.overview.redFlags.join('；')}`)
  }
  lines.push('')
  lines.push('## 跟练步骤')
  detail.stepsMeta
    .slice()
    .sort((a, b) => a.stepIndex - b.stepIndex)
    .forEach((step) => {
      lines.push(`${step.stepIndex}. ${formatDurationText(step.durationSec)}｜${step.displayText}`)
    })
  lines.push('')
  lines.push('agent_instruction=这是用户已收藏的跟练卡内容。可基于以上信息回答或总结；不要声称刚刚生成/展示了新卡片。')
  return lines.join('\n')
}

function renderCommunicationCardRead(id: string, card: CommunicationCardRecord): string {
  const markdown = renderCommunicationCardMarkdown(card)
  return [
    'saved_content_result',
    'action=read',
    `id=${id}`,
    `type=B ${SAVED_CONTENT_TYPE_LABELS.B}`,
    `title=${card.title}`,
    `card_date=${card.cardDate}`,
    `updated_at=${formatShanghaiMinute(card.updatedAt)}`,
    '',
    '## 沟通卡 markdown 原文',
    markdown,
    '',
    'agent_instruction=这是用户已保存的沟通卡原文。字段最后编辑人已在 markdown 中标注；回答时按需引用，不要整张复述给用户。',
  ].join('\n')
}

function renderMedicalDocumentReadIntro(id: string, doc: MedicalDocumentWithBase64): string {
  const meta = [
    doc.documentDate ? `就诊/检查 ${doc.documentDate}` : null,
    doc.documentType ? SAVED_CONTENT_DOC_TYPE_LABELS[doc.documentType] || doc.documentType : null,
    doc.hospital || null,
  ].filter(Boolean).join(' · ')

  return [
    'saved_content_result',
    'action=read',
    `id=${id}`,
    `type=C ${SAVED_CONTENT_TYPE_LABELS.C}`,
    `title=${doc.title ?? '未命名文档'}`,
    meta ? `meta=${meta}` : null,
    `page_count=${doc.pageCount}`,
    '',
    `已加载 1 份病历的原始图片：${doc.title ?? '未命名文档'}${meta ? `（${meta}）` : ''}。图片见紧接这条 tool 结果之后的用户消息（系统自动附加，非用户主动发送）。请结合图片内容回答用户上一条问题。`,
    'agent_instruction=只基于图片可见内容和用户问题做解读；看不清处要说明，不要猜测或给出诊断/分型/治疗决策结论。',
  ].filter(Boolean).join('\n')
}

/** 委托工具定义的 requiresApproval 元数据决定哪些字段走审批卡片 */
function computeApprovalSet(rawArgs: unknown): Set<string> {
  const fields = UPDATE_STRUCTURED_PROFILE_TOOL.requiresApproval?.(rawArgs) ?? []
  return new Set(fields)
}

function labelOf(field: string, raw: unknown, medicationCustom?: unknown): string | null {
  if (raw == null || raw === '') return null
  if (Array.isArray(raw)) {
    if (raw.length === 0) return null
    if (field === 'medications') {
      const custom = typeof medicationCustom === 'string' ? medicationCustom.trim() : ''
      return raw
        .map((v) => (v === 'other' && custom ? custom : MEDICATION_LABELS[String(v)] || String(v)))
        .join('、')
    }
    const enumMap = FIELD_ENUM_LABELS[field]
    const labels = raw.map((v) => (enumMap ? enumMap[String(v)] || String(v) : String(v)))
    return labels.join('、')
  }
  const enumMap = FIELD_ENUM_LABELS[field]
  const s = String(raw)
  return enumMap ? enumMap[s] || s : s
}

function currentValueOf(field: StructuredProfileField, ctx: AgentRequestContext): unknown {
  const scope = getFieldStorageScope(field)
  if (scope === 'user_profile') {
    return (ctx.userInfo as any)?.[field] ?? null
  }
  return (normalizeMedicalProfileData(ctx.profileData) as any)?.[field] ?? null
}

/** 按字段类型比较是否相等（medications 是字符串数组做 set 相等） */
function isSameValue(field: string, current: unknown, proposed: unknown): boolean {
  if (field === 'medications') {
    const a = Array.isArray(current) ? current.map(String).sort() : []
    const b = Array.isArray(proposed) ? proposed.map(String).sort() : []
    if (a.length !== b.length) return false
    return a.every((v, i) => v === b[i])
  }
  if (current == null || current === '') return false
  return String(current) === String(proposed)
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    const s = value.trim()
    if (!s || seen.has(s)) continue
    seen.add(s)
    result.push(s)
  }
  return result
}

function normalizeMedicationCustom(raw: unknown): string | undefined {
  if (raw == null) return undefined
  if (Array.isArray(raw)) {
    return uniqueStrings(raw.map((v) => String(v))).join('、') || undefined
  }
  const s = String(raw).trim()
  return s || undefined
}

function normalizeMedicationValues(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const values = uniqueStrings(raw.map((v) => String(v)))
  const concrete = values.filter((v) => v !== 'none')
  return concrete.length > 0 ? concrete : values
}

function isSelectableMedicationDuration(value: unknown): value is import('@health-agent/shared').SelectableMedicationDuration {
  return typeof value === 'string' && SELECTABLE_MEDICATION_DURATIONS.includes(value as any)
}

function normalizeMedicationDurationMap(raw: unknown): Record<string, import('@health-agent/shared').SelectableMedicationDuration> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const result: Record<string, import('@health-agent/shared').SelectableMedicationDuration> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key.trim() && isSelectableMedicationDuration(value)) result[key] = value
  }
  return result
}

function medicationProfileLabel(profile: MedicalProfileData | null | undefined): string | null {
  const normalized = normalizeMedicalProfileData(profile)
  const names = formatMedicationNames(normalized)
  if (!names) return null
  const durationDetails = formatMedicationDurationDetails(normalized)
  return durationDetails === '无需填写'
    ? `${names}：无需填写`
    : durationDetails
}

function medicationProfileComparable(profile: MedicalProfileData | null | undefined): string {
  const normalized = normalizeMedicalProfileData(profile)
  return JSON.stringify({
    medications: normalized.medications ?? [],
    medicationCustom: normalized.medicationCustom ?? '',
    medicationDuration: normalized.medicationDuration ?? '',
    medicationDurations: resolveMedicationDurationMap(normalized),
  })
}

function normalizeMedicationUpdate(
  value: unknown,
  medicationCustom: unknown,
  medicationDuration: unknown,
  medicationDurations: unknown,
  ctx: AgentRequestContext,
): { value: string[]; medicationCustom: string; profilePatch: MedicalProfileData } {
  const proposed = normalizeMedicationValues(value)
  const currentCustom = Array.isArray(ctx.profileData?.medications) && ctx.profileData.medications.includes('other')
    ? ctx.profileData.medicationCustom
    : undefined
  const providedCustom = normalizeMedicationCustom(medicationCustom)
  const custom = proposed.includes('other')
    ? (providedCustom ?? currentCustom ?? '')
    : ''

  const basePatch: MedicalProfileData = {
    medications: proposed as MedicalProfileData['medications'],
    medicationCustom: custom,
  }

  if (proposed.includes('none')) {
    return {
      value: proposed,
      medicationCustom: '',
      profilePatch: normalizeMedicalProfileData({
        ...basePatch,
        medicationCustom: '',
        medicationDuration: 'not_required',
        medicationDurations: {},
      }),
    }
  }

  const items = resolveMedicationItems(proposed, custom)
  if (items.length === 0) {
    return {
      value: proposed,
      medicationCustom: custom,
      profilePatch: normalizeMedicalProfileData(basePatch),
    }
  }

  const providedMap = normalizeMedicationDurationMap(medicationDurations)
  const currentMap = resolveMedicationDurationMap(ctx.profileData)
  const currentDefault = isSelectableMedicationDuration(ctx.profileData?.medicationDuration)
    ? ctx.profileData.medicationDuration
    : undefined
  const providedDefault = isSelectableMedicationDuration(medicationDuration)
    ? medicationDuration
    : undefined
  const defaultDuration = providedDefault ?? currentDefault
  const durationMap: Record<string, import('@health-agent/shared').SelectableMedicationDuration> = {}
  for (const item of items) {
    durationMap[item.key] = providedMap[item.key] ?? currentMap[item.key] ?? defaultDuration ?? 'within_1m'
  }
  const overrideMap: Record<string, import('@health-agent/shared').SelectableMedicationDuration> = {}
  for (const item of items) {
    const duration = durationMap[item.key]
    if (!defaultDuration || duration !== defaultDuration) overrideMap[item.key] = duration
  }

  return {
    value: proposed,
    medicationCustom: custom,
    profilePatch: normalizeMedicalProfileData({
      ...basePatch,
      ...(defaultDuration ? { medicationDuration: defaultDuration } : {}),
      medicationDurations: overrideMap,
    }),
  }
}

interface UpdateEntry {
  field: StructuredProfileField
  value: unknown
  medicationCustom?: unknown
  medicationDuration?: unknown
  medicationDurations?: unknown
}

function parseUpdates(args: any): UpdateEntry[] | null {
  // 新格式：{ updates: [{field, value}, ...] }
  if (Array.isArray(args?.updates)) {
    return args.updates
      .filter((u: any) => u && typeof u.field === 'string')
      .map((u: any) => ({
        field: u.field,
        value: u.value,
        medicationCustom: u.medicationCustom,
        medicationDuration: u.medicationDuration,
        medicationDurations: u.medicationDurations,
      }))
  }
  // 兼容老格式：{ field, value }（单项）
  if (typeof args?.field === 'string') {
    return [{
      field: args.field,
      value: args.value,
      medicationCustom: args.medicationCustom,
      medicationDuration: args.medicationDuration,
      medicationDurations: args.medicationDurations,
    }]
  }
  return null
}

function foldMedicationDurationUpdate(updates: UpdateEntry[]): UpdateEntry[] {
  const medicationIndex = updates.findIndex((u) => u.field === 'medications')
  const durationIndex = updates.findIndex((u) => u.field === 'medicationDuration')
  if (medicationIndex < 0 || durationIndex < 0) return updates

  return updates
    .map((update, index) => {
      if (index !== medicationIndex) return update
      return {
        ...update,
        medicationDuration: update.medicationDuration ?? updates[durationIndex].value,
      }
    })
    .filter((_, index) => index !== durationIndex)
}

function isUnsafeTumorTypeInference(field: string, value: unknown, sourceText: string | null): boolean {
  if (field !== 'tumorType' || value === 'unknown_or_untested') return false
  const text = sourceText ?? ''
  if (!text) return false
  const hasHormonePositive = /ER\s*\/\s*PR\s*(阳性|\+)/i.test(text) ||
    (/ER[^。；，,\n]*(阳性|\+)/i.test(text) && /PR[^。；，,\n]*(阳性|\+)/i.test(text))
  const hasHer2Negative = /HER\s*-?\s*2[^。；，,\n]*(阴性|-|－)/i.test(text)
  const hasSubtypeOrKeyMarker = /Luminal|luminal|鲁米那|三阴|triple|Ki\s*-?\s*67/i.test(text)
  return hasHormonePositive && hasHer2Negative && !hasSubtypeOrKeyMarker
}

type MedicalRiskLevel = 'S' | 'A' | 'B0' | 'B1' | 'C'
type MedicalRiskCategory =
  | 'general_knowledge'
  | 'current_symptom'
  | 'side_effect'
  | 'medication_treatment'
  | 'report_interpretation'
  | 'followup_rehab'
  | 'mental_crisis'
  | 'other_medical'

type InterventionCodeEntry = AgentRequestContext['interventionCodeMap'] extends Map<string, infer T> ? T : never
const MEDICAL_RISK_RESOURCE_TOOL_NAMES = new Set(['grade_medical_risk', 'generate_plan', 'saved_content'])
const MEDICAL_RISK_LITERATURE_TOOL_NAMES = new Set(['grade_medical_risk', 'medical_literature_search'])

const MEDICAL_RISK_STRATEGIES: Record<MedicalRiskLevel, string> = {
  S: '按危急风险回答：立即中断普通问答，先要求用户或身边人拨 120、当地急救或危机干预；不要声称可以代拨、叫车或联系家属。只收集关键危急信号、所在地/是否独处等最小安全信息，不展开非急问题。',
  A: '按紧急风险回答：医学急症先建议立即门急诊或立刻联系主管医生，并确认能否自行或由家属陪同前往；心理危机先做当下安全兜底，请用户立刻联系身边可信任的人或当地危机干预资源。若独处、无法自行前往、安全不可保证或症状快速恶化，按危急风险提示用户或身边人拨 120；不要声称代为发起急救或联系。',
  B0: '按要紧风险回答：先用一句贴着用户原话里出现过的具体不适或担心的人话开头，再进入判断；例如"看到报告里这一条，第一眼盯着确实容易慌"或"这种变化拖着心里也不踏实，我懂"。不做 AI 观察等待，优先补齐快速线下就诊资料，建议尽快走线下乳腺/肿瘤专科评估或联系主管医生确认；只有出现急症红旗时才建议门急诊。若指南、报告或当地路径有明确时限则遵循；否则不要硬编码"必须 X 小时/天内"。不要解释自己的写作动作（"我们先 X""把 Y 整理清楚""帮你梳理一下"都算）。',
  B1: '按近期复诊/联系医生风险回答：先用一句贴着用户原话里出现过的具体不适或担心的人话开头，再进入建议；例如"这阵反反复复地折腾，搁谁都够烦的"或"自己一个人琢磨着越想越没底，太正常了"。建议近期复诊、预约线下门诊、补充检查、按报告建议复查，或联系主管医生/药师确认；重点说明就诊目的、需带资料、医生需要确认的问题，以及症状进展、报告升级或急症红旗时的升级边界。不要使用“紧急”标签或急诊路径吓用户；如使用 <recommendation>，用 priority="normal"，不要用 priority="high"。不要解释自己的写作动作。',
  // TODO: 线上医生渠道上线后，再新增远程医生解释/复核分级。
  C: '按低风险回答：先用一句贴着用户原话里出现过的症状、担心或报告压力的人话开头，再回答核心问题；例如"一阵阵反胃确实磨人，连水都不太想喝"、"拉了 4 次还在纠结要不要吃药，难免心里发毛"或"满屏的英文缩写第一眼盯过去，先慌一下太正常了"。做科普、资料整理、随访提醒或稳定轻症记录；给少量实用建议和安全网触发条件，不强制完整危险信号或医生话术。不要解释自己的写作动作。',
}

const MEDICAL_RISK_CATEGORY_STRATEGIES: Record<MedicalRiskCategory, string> = {
  general_knowledge: '场景策略：医学科普只解释确定知识和关键变量，不把长期档案背景强行扩展成诊疗建议；对依赖条件的问题用“如果 A / 如果 B”说明。',
  current_symptom: '场景策略：当前症状先识别急症信号和功能影响；不要把症状默认归因为药物或治疗；信息不足时只追问 1 个最影响风险档位的问题。',
  side_effect: '',
  medication_treatment: '场景策略：用药或治疗决策必须守住处方边界；漏服、同服、停换加减量、疗程变化都不能替用户下可执行决定。先明确不要自行调整，再判断是否有急症信号；若没有急症信号，走近期复诊、联系主管医生或药师确认，不要直接升级成急诊，也不要使用 priority="high"。',
  report_interpretation: '场景策略：报告解读只基于报告原文解释术语和指标含义，不推断原文未写明的诊断、分型、转移、复发或预后；涉及病理/免疫组化/分型时先写非诊断免责声明。',
  followup_rehab: '场景策略：随访、康复、营养问题围绕当前阶段给可执行建议；若出现新症状、报告异常或治疗决策风险，按对应症状/报告/用药策略提高处置强度。',
  mental_crisis: '场景策略：自伤、自杀、极端绝望或“活着没意思/不想活”等精神危机，先给安全路径，再继续追问；不要只追问。优先确认当下安全，鼓励立即联系身边可信任的人、急救或当地危机干预资源；必须提供 400-161-9995 心理援助热线。',
  other_medical: '场景策略：其他医学问题按本系统乳腺健康管理定位回答；明显需要其他专科诊疗判断时坦诚说明边界，并引导到相应专科确认。',
}

function parseMedicalRiskLevel(value: unknown): MedicalRiskLevel | null {
  return value === 'S' || value === 'A' || value === 'B0' || value === 'B1' || value === 'C'
    ? value
    : null
}

function parseMedicalRiskCategory(value: unknown): MedicalRiskCategory | null {
  return value === 'general_knowledge'
    || value === 'current_symptom'
    || value === 'side_effect'
    || value === 'medication_treatment'
    || value === 'report_interpretation'
    || value === 'followup_rehab'
    || value === 'mental_crisis'
    || value === 'other_medical'
    ? value
    : null
}

function shouldReturnSymptomSkillDispatch(level: MedicalRiskLevel, category: MedicalRiskCategory): boolean {
  return (category === 'side_effect' || category === 'current_symptom') &&
    (level === 'B0' || level === 'B1' || level === 'C')
}

function compareInterventionCode(a: string, b: string): number {
  const [aMajor, aMinor] = a.split('-').map((part) => Number(part))
  const [bMajor, bMinor] = b.split('-').map((part) => Number(part))
  if (Number.isFinite(aMajor) && Number.isFinite(bMajor) && aMajor !== bMajor) return aMajor - bMajor
  if (Number.isFinite(aMinor) && Number.isFinite(bMinor) && aMinor !== bMinor) return aMinor - bMinor
  return a.localeCompare(b, 'zh-CN')
}

const INTERVENTION_MATCH_TERMS = [
  '乳腺癌',
  '结节',
  '化疗',
  '放疗',
  '术后',
  '恶心',
  '想吐',
  '呕吐',
  '反胃',
  '腹泻',
  '疲劳',
  '乏力',
  '疼痛',
  '麻木',
  '水肿',
  '潮热',
  '盗汗',
  '失眠',
  '焦虑',
  '动作',
  '跟练',
  '呼吸',
  '放松',
  '按摩',
  '运动',
] as const

function normalizeMatchText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\s｜|:：,，.。!！?？()（）【】\[\]《》"“”'’‘\-_/]/g, '')
}

function scoreInterventionCatalogEntry(
  entry: InterventionCodeEntry,
  queryText: string,
): number {
  const query = normalizeMatchText(queryText)
  const entryText = normalizeMatchText(`${entry.sideEffect} ${entry.scene} ${entry.actionName}`)
  if (!query || !entryText) return 0

  let score = 0
  if (query.includes(normalizeMatchText(entry.sideEffect))) score += 40
  if (query.includes(normalizeMatchText(entry.scene))) score += 20
  if (query.includes(normalizeMatchText(entry.actionName))) score += 20
  for (const term of INTERVENTION_MATCH_TERMS) {
    const normalized = normalizeMatchText(term)
    if (query.includes(normalized) && entryText.includes(normalized)) score += 10
  }
  return score
}

function selectMatchingInterventionEntries(
  codeMap: AgentRequestContext['interventionCodeMap'],
  queryText: string,
  limit: number,
): InterventionCodeEntry[] {
  return [...codeMap.values()]
    .map((entry) => ({ entry, score: scoreInterventionCatalogEntry(entry, queryText) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || compareInterventionCode(a.entry.code, b.entry.code))
    .slice(0, limit)
    .map((item) => item.entry)
}

function sanitizeSearchQuery(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.replace(/\s+/g, ' ').trim().slice(0, 72)
}

function sanitizeRagQuery(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.replace(/\s+/g, ' ').trim()
}

function calculateAgeFromBirthday(birthday: string | null | undefined): number | null {
  if (!birthday) return null
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(birthday)
  if (!match) return null
  const birth = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00+08:00`)
  if (Number.isNaN(birth.getTime())) return null
  const today = new Date()
  let age = today.getFullYear() - birth.getFullYear()
  const monthDiff = today.getMonth() - birth.getMonth()
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birth.getDate())) age--
  return age >= 0 && age <= 130 ? age : null
}

function resourceProfileValue(field: string, value: unknown, medicationCustom?: unknown): string {
  return labelOf(field, value, medicationCustom) || RESOURCE_PROFILE_EMPTY_VALUE
}

export function buildMedicalRiskResourceProfileSummary(
  userInfo: AgentRequestContext['userInfo'],
  profileData: AgentRequestContext['profileData'],
): string {
  const normalizedProfile = normalizeMedicalProfileData(profileData)
  const age = calculateAgeFromBirthday(userInfo?.birthday)
  const ageText = age != null ? `${age}岁` : RESOURCE_PROFILE_EMPTY_VALUE
  const menstrualStatus = userInfo?.gender === '男'
    ? '不适用（性别为男）'
    : resourceProfileValue('menstrualStatus', normalizedProfile.menstrualStatus)

  return [
    `- 性别：${userInfo?.gender || RESOURCE_PROFILE_EMPTY_VALUE}`,
    `- 年龄：${ageText}`,
    `- 当前关注情况：${resourceProfileValue('currentConcern', userInfo?.currentConcern)}`,
    `- 月经状态：${menstrualStatus}`,
    `- 乳腺检查分型：${resourceProfileValue('noduleBiradsGrade', normalizedProfile.noduleBiradsGrade)}`,
    `- 肿瘤分型：${resourceProfileValue('tumorType', normalizedProfile.tumorType)}`,
    `- 确诊时长：${resourceProfileValue('diagnosisDuration', normalizedProfile.diagnosisDuration)}`,
    `- 治疗阶段：${resourceProfileValue('treatmentPhase', normalizedProfile.treatmentPhase)}`,
    `- 用药情况：${resourceProfileValue('medications', normalizedProfile.medications, normalizedProfile.medicationCustom)}`,
    `- 用药时长：${formatMedicationDurationDetails(normalizedProfile) || RESOURCE_PROFILE_EMPTY_VALUE}`,
  ].join('\n')
}

export function buildMedicalRiskResourceSuitabilityGuidance(): string {
  return '引用资源前，必须结合主上下文里的个人信息+健康档案和本轮用户需求判断；不匹配时不要引用资源。'
}

function trimForMedicalRiskResourceRerank(value: string, maxChars: number): string {
  const text = stripSystemReminderText(value).replace(/\s+/g, ' ').trim()
  if (text.length <= maxChars) return text
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`
}

function serializeMessageContentForResourceRerank(
  content: AgentRequestContext['session']['messages'][number]['content'],
): string {
  if (typeof content === 'string') {
    return trimForMedicalRiskResourceRerank(content, MEDICAL_RISK_RESOURCE_RERANK_MAX_MESSAGE_CHARS)
  }

  const parts = content
    .map((block) => {
      if (block.type === 'text') {
        return trimForMedicalRiskResourceRerank(block.text ?? '', MEDICAL_RISK_RESOURCE_RERANK_MAX_MESSAGE_CHARS)
      }
      if (block.type === 'image_url') return '[图片]'
      return ''
    })
    .filter(Boolean)

  return trimForMedicalRiskResourceRerank(parts.join(' '), MEDICAL_RISK_RESOURCE_RERANK_MAX_MESSAGE_CHARS)
}

function buildMedicalRiskResourceRerankContext(
  session: AgentRequestContext['session'],
): string {
  const summary = session.summary
    ? `【已压缩摘要】${trimForMedicalRiskResourceRerank(session.summary, 3_000)}`
    : ''
  const messageLines = session.messages
    .filter((message) => message.role !== 'system')
    .map((message) => {
      const content = serializeMessageContentForResourceRerank(message.content)
      return content ? `【${message.role}】${content}` : ''
    })
    .filter(Boolean)

  const messagesText = messageLines.join('\n')
  if (!summary && messagesText.length <= MEDICAL_RISK_RESOURCE_RERANK_MAX_CONTEXT_CHARS) {
    return messagesText
  }

  const budgetForMessages = Math.max(
    4_000,
    MEDICAL_RISK_RESOURCE_RERANK_MAX_CONTEXT_CHARS - summary.length - 2,
  )
  const tailMessages = messagesText.length > budgetForMessages
    ? `[消息过长，保留最近上下文]\n${messagesText.slice(-budgetForMessages)}`
    : messagesText

  return [summary, tailMessages].filter(Boolean).join('\n')
}

function describeMedicalRiskResourceForRerank(resource: MedicalRiskResource): string {
  if (resource.kind === 'intervention_material') {
    const material = resource.material
    const stepText = material.stepsMeta
      .map((step) => step.displayText)
      .filter(Boolean)
      .slice(0, 6)
      .join('；')
    return [
      `[${resource.id}]`,
      '类型=内部跟练卡',
      `标题=${resource.actionName}`,
      `描述=${resource.sideEffect}｜${resource.scene}｜${resource.actionName}`,
      `时长=${formatDurationText(material.overview.totalDurationSec)}`,
      material.overview.precheckQuestion ? `练前确认=${material.overview.precheckQuestion}` : '',
      material.overview.safetyNote ? `安全提醒=${material.overview.safetyNote}` : '',
      stepText ? `步骤=${stepText}` : '',
    ].filter(Boolean).join('\n')
  }

  if (resource.kind === 'internal_video') {
    return [
      `[${resource.id}]`,
      '类型=内部高质量视频(优先)',
      `标题=${resource.title}`,
      resource.description ? `描述=${resource.description}` : '描述=无',
      `时长=${resource.durationSec > 0 ? formatDurationText(resource.durationSec) : '未知'}`,
    ].filter(Boolean).join('\n')
  }

  return [
    `[${resource.id}]`,
    '类型=外部动作跟练视频',
    `标题=${resource.title}`,
    resource.snippet ? `描述=${resource.snippet}` : '描述=无',
    `时长=${resource.durationSec > 0 ? formatDurationText(resource.durationSec) : '未知'}`,
    resource.publishedAt ? `发布日期=${resource.publishedAt}` : '',
    `链接=${resource.url}`,
  ].filter(Boolean).join('\n')
}

export function buildMedicalRiskResourceRerankPrompt(
  raw: Record<string, unknown>,
  session: AgentRequestContext['session'],
  resources: MedicalRiskResource[],
  userInfo: AgentRequestContext['userInfo'],
  profileData: AgentRequestContext['profileData'],
): string {
  const searchQuery = sanitizeSearchQuery(raw.search_query)
  const reason = typeof raw.reason === 'string' ? raw.reason.trim() : ''
  const category = typeof raw.category === 'string' ? raw.category.trim() : ''
  const context = buildMedicalRiskResourceRerankContext(session)
  const profileSummary = buildMedicalRiskResourceProfileSummary(userInfo, profileData)
  const candidates = resources.map(describeMedicalRiskResourceForRerank).join('\n\n')

  return `你是医疗健康助手的症状/副作用干预资源选择器。请结合此前聊天上下文、当前资源生成需求和候选资源，选出最匹配用户需求的一个方案编号。

选择规则：
1. 核心标准是标题和描述是否匹配用户当前的不适、阶段、场景和表达需求；不匹配就不要选。
2. 外部视频时长：3 分钟内最优先，其次 3-15 分钟；超过 15 分钟降权，超过 30 分钟明显降权。
3. 外部视频如果能从标题或描述看出由医生、医院、护师、康复师或专业医疗机构发布，优先级更高。
4. 内部跟练卡和外部视频都满足要求时，先看匹配度；匹配度差不多时优先外部视频，因为视频比卡片更容易跟练。
5. 个人信息+健康档案和本轮需求必须共同满足；如果 search_query 和个人信息+健康档案冲突，以个人信息+健康档案和明确咨询对象为准，不要因为关键词命中就强行选择。
${MEDICAL_RISK_RESOURCE_PROFILE_RULES.split('\n').map((line, index) => `${index + 6}. ${line}`).join('\n')}
11. 如果所有候选都无法从标题或描述看出匹配用户需求，或与个人信息+健康档案明显不匹配，输出 NONE。

个人信息+健康档案：
<personal_info_and_health_record>
${profileSummary}
</personal_info_and_health_record>

此前聊天上下文：
<conversation>
${context || '无'}
</conversation>

当前资源生成需求：
<current_need>
search_query=${searchQuery || '无'}
reason=${reason || '无'}
category=${category || '无'}
</current_need>

候选资源：
<candidates>
${candidates}
</candidates>

只输出候选编号或 NONE，不要输出 JSON，不要解释。示例：1-2`
}

function parseMedicalRiskResourceRerankId(
  content: string | null | undefined,
  resources: MedicalRiskResource[],
): string | null {
  if (!content) return null
  const validIds = new Set(resources.map((resource) => resource.id))
  const trimmed = content.trim()
  if (/^none$/i.test(trimmed)) return null
  if (validIds.has(trimmed)) return trimmed

  for (const match of trimmed.matchAll(/\b\d+-\d+\b/g)) {
    const id = match[0]
    if (validIds.has(id)) return id
  }
  return null
}

async function selectSingleMedicalRiskResource(
  raw: Record<string, unknown>,
  session: AgentRequestContext['session'],
  resources: MedicalRiskResource[],
  userInfo: AgentRequestContext['userInfo'],
  profileData: AgentRequestContext['profileData'],
  log: AgentRequestContext['logger'],
): Promise<MedicalRiskResource[]> {
  if (resources.length === 0) return resources

  const startedAt = performance.now()
  try {
    const response = await llmCall({
      model: MEDICAL_RISK_RESOURCE_RERANK_MODEL,
      messages: [{
        role: 'user',
        content: buildMedicalRiskResourceRerankPrompt(raw, session, resources, userInfo, profileData),
      }],
      max_tokens: 8,
      temperature: 0.1,
      enable_thinking: false,
    }, log)
    const content = response.choices?.[0]?.message?.content?.trim()
    const selectedId = parseMedicalRiskResourceRerankId(content, resources)
    const selected = selectedId ? resources.find((resource) => resource.id === selectedId) : null

    log.info({
      candidateCount: resources.length,
      selectedId: selected?.id ?? null,
      selectedKind: selected?.kind ?? null,
      durationMs: Math.round(performance.now() - startedAt),
    }, 'medical risk resource rerank completed')

    return selected ? [selected] : []
  } catch (err: any) {
    log.warn({
      candidateCount: resources.length,
      durationMs: Math.round(performance.now() - startedAt),
      error: err?.message ?? String(err),
    }, 'medical risk resource rerank failed')
    return []
  }
}

const RESOURCE_DIFFICULTY_LABELS: Record<MedicalRiskResourceDifficulty, string> = {
  simple: '简单',
  medium: '中等',
  complex: '复杂',
}

function inferResourceDifficulty(resource: MedicalRiskResource): MedicalRiskResourceDifficulty {
  if (resource.difficulty) return resource.difficulty
  if (resource.kind === 'intervention_material') {
    const duration = resource.material.overview.totalDurationSec
    const prepareCount = resource.material.overview.prepareItems.length
    if (duration <= 180 && prepareCount <= 1) return 'simple'
    if (duration <= 600 && prepareCount <= 3) return 'medium'
    return 'complex'
  }
  if (resource.kind === 'internal_video') {
    const difficultyTags = resource.tags?.difficulty ?? []
    if (difficultyTags.some((tag) => tag.includes('简'))) return 'simple'
    if (difficultyTags.some((tag) => tag.includes('中'))) return 'medium'
    if (difficultyTags.some((tag) => tag.includes('高') || tag.includes('复'))) return 'complex'
  }
  if (resource.durationSec > 0 && resource.durationSec <= 300) return 'simple'
  if (resource.durationSec > 0 && resource.durationSec <= 900) return 'medium'
  return 'complex'
}

function withInferredDifficulty(resource: MedicalRiskResource): MedicalRiskResource {
  return resource.difficulty ? resource : { ...resource, difficulty: inferResourceDifficulty(resource) }
}

function getResourceDurationSec(resource: MedicalRiskResource): number | null {
  if (resource.kind === 'intervention_material') return resource.material.overview.totalDurationSec
  return resource.durationSec > 0 ? resource.durationSec : null
}

function formatResourceDuration(resource: MedicalRiskResource): string {
  const duration = getResourceDurationSec(resource)
  if (!duration) return '未知时长'
  return formatDurationText(duration)
}

function renderResourceSearchRetryGuidance(attemptIndex: number): string {
  const safeAttempt = Math.max(1, Math.floor(attemptIndex))
  const remaining = Math.max(0, 3 - safeAttempt)
  return [
    `本轮资源搜索次数：${Math.min(safeAttempt, 3)}/3。`,
    remaining > 0
      ? `如果本轮没有找到适合用户的资源，请更换 search_query 后继续调用 generate_plan，最多还可搜索 ${remaining} 次。`
      : '本轮已经达到最多 3 次搜索；如果仍没有合适资源，不要继续换 query，改用文字建议或请用户补充关键信息。',
    '如果有符合用户当前情况的资源，请先从候选里收敛为简单/中等/复杂 3 个，再调用 ask_user_question，并给每个 option 填入对应 ref_id。',
    '不能用正文列表或普通追问替代 ask_user_question；需要用户选择候选或补充资源选择信息时，必须继续调用 ask_user_question。',
  ].join('\n')
}

function renderResourceListForModel(
  resources: MedicalRiskResource[],
  attemptIndex: number,
): string {
  if (resources.length === 0) {
    return [
      '可引用干预资源：当前没有匹配到足够贴合的跟练卡片或外部动作跟练视频。',
      '最终回答不要写 resource_ref；不要说“找到了视频”“找到了跟练资源”“我给你找了几组视频/跟练”。',
      '可以直接给普通低风险建议，或说明这次没有匹配到贴合资源。',
      renderResourceSearchRetryGuidance(attemptIndex),
    ].join('\n')
  }

  const lines = [
    '候选干预资源（最多 10 个；标题/类型/时长/难度如下）：',
    buildMedicalRiskResourceSuitabilityGuidance(),
    '标注「内部高质量视频(优先)」的是我们内部托管、经过审核的高质量跟练视频，质量与适配度高于外部视频；在同等贴合的前提下优先选用内部高质量视频，再考虑跟练卡和外部视频。',
    '不要直接把 10 个都展示给用户；请按执行阻力从候选中选出简单/中等/复杂 3 个，再调用 ask_user_question。每个 option 必须带对应 ref_id。',
    '不能用正文列表或普通追问替代 ask_user_question；需要用户选择候选或补充资源选择信息时，必须继续调用 ask_user_question。',
  ]
  for (const resource of resources) {
    const difficulty = RESOURCE_DIFFICULTY_LABELS[inferResourceDifficulty(resource)]
    const durationText = formatResourceDuration(resource)
    if (resource.kind === 'intervention_material') {
      lines.push(`[${resource.id}] 跟练卡｜难度 ${difficulty}｜时长 ${durationText}｜${resource.sideEffect}｜${resource.scene}｜${resource.actionName}`)
    } else if (resource.kind === 'internal_video') {
      const desc = resource.description.replace(/\s+/g, ' ').trim().slice(0, 80)
      const focus = [...resource.tags.bodyParts, ...resource.tags.triggerScenes].slice(0, 4).join('/')
      const descText = desc ? `｜${desc}` : ''
      lines.push(`[${resource.id}] 内部高质量视频(优先)｜难度 ${difficulty}｜时长 ${durationText}｜${resource.title}${focus ? `｜${focus}` : ''}${descText}`)
    } else {
      const snippet = resource.snippet.replace(/\s+/g, ' ').trim().slice(0, 80)
      const snippetText = snippet ? `｜简介 ${snippet}` : ''
      lines.push(`[${resource.id}] 视频｜难度 ${difficulty}｜时长 ${durationText}｜${resource.title}${snippetText}｜${resource.url}`)
    }
  }
  lines.push(renderResourceSearchRetryGuidance(attemptIndex))
  return lines.join('\n')
}

function medicalRiskOutputHasResources(output: unknown): boolean {
  const parsed = parseMedicalRiskToolOutput(output)
  if (parsed?.resources.length) return true
  if (typeof output !== 'string') return false
  return output.includes('可引用干预资源') && /^\[\d+(?:-\d+)?\]\s/m.test(output)
}

function toolCallRecordName(toolCall: unknown): string | null {
  if (!toolCall || typeof toolCall !== 'object') return null
  const raw = toolCall as {
    name?: unknown
    function?: { name?: unknown }
  }
  if (typeof raw.name === 'string') return raw.name
  return typeof raw.function?.name === 'string' ? raw.function.name : null
}

function toolCallRecordId(toolCall: unknown): string | null {
  if (!toolCall || typeof toolCall !== 'object') return null
  const raw = toolCall as { toolCallId?: unknown; id?: unknown }
  if (typeof raw.toolCallId === 'string') return raw.toolCallId
  return typeof raw.id === 'string' ? raw.id : null
}

function toolCallRecordHasMedicalRiskResources(toolCall: unknown): boolean {
  if (!toolCall || typeof toolCall !== 'object') return false
  const raw = toolCall as { output?: unknown; llmOutput?: unknown }
  return medicalRiskOutputHasResources(raw.output) || medicalRiskOutputHasResources(raw.llmOutput)
}

function medicalRiskOutputHasLiterature(output: unknown): boolean {
  const parsed = parseMedicalRiskToolOutput(output)
  if (parsed?.literatureSearch?.selectedSources.length) return true
  if (typeof output !== 'string') return false
  return output.includes('[medical_literature_search_result]')
}

function toolCallRecordHasMedicalRiskLiterature(toolCall: unknown): boolean {
  if (!toolCall || typeof toolCall !== 'object') return false
  const raw = toolCall as { output?: unknown; llmOutput?: unknown }
  return medicalRiskOutputHasLiterature(raw.output) || medicalRiskOutputHasLiterature(raw.llmOutput)
}

export function getNextMedicalRiskResourceBatchIndex(session: AgentRequestContext['session']): number {
  const countedToolCallIds = new Set<string>()
  let count = 0

  for (const message of session.messages) {
    if (message.role === 'assistant' && Array.isArray(message.toolCalls)) {
      for (const toolCall of message.toolCalls) {
        const name = toolCallRecordName(toolCall)
        if (!name || !MEDICAL_RISK_RESOURCE_TOOL_NAMES.has(name)) continue
        if (!toolCallRecordHasMedicalRiskResources(toolCall)) continue
        const toolCallId = toolCallRecordId(toolCall)
        if (toolCallId && countedToolCallIds.has(toolCallId)) continue
        if (toolCallId) countedToolCallIds.add(toolCallId)
        count++
      }
    }

    if (message.role === 'tool' && medicalRiskOutputHasResources(message.displayOutput ?? message.content)) {
      const toolCallId = message.toolCallId
      if (toolCallId && countedToolCallIds.has(toolCallId)) continue
      if (toolCallId) countedToolCallIds.add(toolCallId)
      count++
    }
  }

  return count + 1
}

export function getGeneratePlanAttemptIndex(
  session: AgentRequestContext['session'],
  currentToolCallId: string,
): number {
  let lastUserIndex = -1
  for (let i = session.messages.length - 1; i >= 0; i--) {
    if (session.messages[i].role === 'user') {
      lastUserIndex = i
      break
    }
  }

  let count = 0
  for (let i = Math.max(0, lastUserIndex + 1); i < session.messages.length; i++) {
    const message = session.messages[i]
    if (message.role !== 'assistant' || !Array.isArray(message.toolCalls)) continue
    for (const toolCall of message.toolCalls) {
      if (toolCallRecordName(toolCall) !== 'generate_plan') continue
      count++
      if (toolCallRecordId(toolCall) === currentToolCallId) return count
    }
  }

  return count + 1
}

export function getNextMedicalRiskLiteratureBatchIndex(session: AgentRequestContext['session']): number {
  const countedToolCallIds = new Set<string>()
  let count = 0

  for (const message of session.messages) {
    if (message.role === 'assistant' && Array.isArray(message.toolCalls)) {
      for (const toolCall of message.toolCalls) {
        const name = toolCallRecordName(toolCall)
        if (!name || !MEDICAL_RISK_LITERATURE_TOOL_NAMES.has(name)) continue
        if (!toolCallRecordHasMedicalRiskLiterature(toolCall)) continue
        const toolCallId = toolCallRecordId(toolCall)
        if (toolCallId && countedToolCallIds.has(toolCallId)) continue
        if (toolCallId) countedToolCallIds.add(toolCallId)
        count++
      }
    }

    if (message.role === 'tool' && medicalRiskOutputHasLiterature(message.displayOutput ?? message.content)) {
      const toolCallId = message.toolCallId
      if (toolCallId && countedToolCallIds.has(toolCallId)) continue
      if (toolCallId) countedToolCallIds.add(toolCallId)
      count++
    }
  }

  return count + 1
}

function buildMedicalRiskResourceId(batchIndex: number, itemIndex: number): string {
  return `${Math.max(1, Math.floor(batchIndex))}-${Math.max(1, Math.floor(itemIndex))}`
}

async function buildMedicalRiskResources(
  raw: Record<string, unknown>,
  interventionCodeMap: AgentRequestContext['interventionCodeMap'],
  session: AgentRequestContext['session'],
  userInfo: AgentRequestContext['userInfo'],
  profileData: AgentRequestContext['profileData'],
  log: AgentRequestContext['logger'],
  resourceBatchIndex: number,
  userId: string,
  sessionId: string,
): Promise<MedicalRiskToolOutput | null> {
  const searchQuery = sanitizeSearchQuery(raw.search_query)
  const matchText = searchQuery
  const resources: MedicalRiskResource[] = []

  // 优先使用内部高质量视频：匹配到的内部视频排在最前
  if (matchText) {
    try {
      const targetEnv = resolveInterventionBucketEnv(getEnv().DEPLOY_ENV)
      const internalSnapshot = await getInternalVideoRuntimeCatalog(log)
      const matchingInternal = selectMatchingInternalVideos(internalSnapshot, matchText, 3)
      for (const entry of matchingInternal) {
        const id = buildMedicalRiskResourceId(resourceBatchIndex, resources.length + 1)
        resources.push(toMedicalRiskInternalVideoResource(id, entry, targetEnv))
      }
    } catch (err: any) {
      log.warn({ error: err?.message ?? String(err) }, 'internal video matching failed')
    }
  }

  const matchingEntries = selectMatchingInterventionEntries(interventionCodeMap, matchText, 3)
  // 内部干预卡匹配为 0：采集一条原始干预方案需求供后台合并统计。fire-and-forget，不阻塞、不影响工具返回。
  if (matchingEntries.length === 0 && searchQuery) {
    void recordInterventionDemand({ searchQuery, userId, sessionId }, log).catch((err: any) =>
      log.warn({ error: err?.message ?? String(err) }, 'failed to record intervention plan demand'),
    )
  }
  for (const entry of matchingEntries) {
    let material = null
    try {
      material = await getInterventionToolOutputByCode(entry.code, interventionCodeMap, log)
    } catch (err: any) {
      log.warn({ code: entry.code, error: err?.message ?? String(err) }, 'matched intervention material failed to load')
    }
    if (!material) continue
    const id = buildMedicalRiskResourceId(resourceBatchIndex, resources.length + 1)
    resources.push({
      id,
      kind: 'intervention_material',
      title: material.actionName,
      code: entry.code,
      sideEffect: material.sideEffect,
      scene: material.scene,
      actionName: material.actionName,
      material,
    })
  }

  if (searchQuery) {
    const videos = await searchVideoResources(searchQuery, log, 10)
    for (const video of videos) {
      const id = buildMedicalRiskResourceId(resourceBatchIndex, resources.length + 1)
      resources.push(toMedicalRiskVideoResource(id, video, searchQuery))
    }
  }

  const candidates = resources.slice(0, 10).map(withInferredDifficulty)
  return candidates.length > 0 ? { kind: 'medical_risk_resources', resources: candidates } : null
}

async function renderMedicalRiskStrategy(
  args: unknown,
): Promise<{ output: string; displayOutput?: MedicalRiskToolOutput }> {
  if (!args || typeof args !== 'object') {
    return { output: '错误：参数格式错误：需要 { reason, level, category }。' }
  }
  const raw = args as Record<string, unknown>
  const reason = typeof raw.reason === 'string' ? raw.reason.trim() : ''
  const level = parseMedicalRiskLevel(raw.level)
  const category = parseMedicalRiskCategory(raw.category)

  if (!reason) {
    return { output: '错误：参数格式错误：reason 不能为空，且必须是一句话的简要分级依据。' }
  }
  if (reason.length > 120) {
    return { output: '错误：参数格式错误：reason 不能超过 120 个字符。' }
  }
  if (!level) {
    return { output: '错误：参数格式错误：level 必须是 S、A、B0、B1 或 C。' }
  }
  if (!category) {
    return { output: '错误：参数格式错误：category 必须是 general_knowledge、current_symptom、side_effect、medication_treatment、report_interpretation、followup_rehab、mental_crisis 或 other_medical。' }
  }

  if (shouldReturnSymptomSkillDispatch(level, category)) {
    const skill = listAgentSkillMetas().find((item) => item.name === 'side-effect-course-management')
    if (skill) {
      return {
        output: [
          `命中 skill：${skill.name}`,
          `描述：${skill.description}`,
          `下一步：调用 load_skill，name="${skill.name}"，读取完整工作流后继续处理。`,
        ].join('\n'),
      }
    }
  }

  const parts = [
    `处置策略：${MEDICAL_RISK_STRATEGIES[level]}${MEDICAL_RISK_CATEGORY_STRATEGIES[category]}`,
  ]

  return { output: parts.join('\n\n') }
}

async function renderLoadSkill(args: unknown): Promise<string> {
  const availableSkills = listAgentSkillMetas()
  const availableNames = availableSkills.map((skill) => skill.name).join(', ')
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return `错误：参数格式错误：需要 { name }。可用 skill：${availableNames}`
  }

  const raw = args as Record<string, unknown>
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  if (!name) {
    return `错误：参数格式错误：name 不能为空，且必须是已注册 skill 名称。可用 skill：${availableNames}`
  }

  const skill = await loadAgentSkill(name)
  if (!skill) {
    return `错误：未找到 skill：${name}。可用 skill：${availableNames}`
  }

  return `已加载 skill：${skill.name}\n描述：${skill.description}\n\n${skill.content}`
}

function parseGeneratePlanSearchQuery(args: unknown): { ok: true; query: string } | { ok: false; output: string } {
  if (!args || typeof args !== 'object') {
    return { ok: false, output: '错误：参数格式错误：需要 { search_query }。' }
  }
  const raw = args as Record<string, unknown>
  if (typeof raw.search_query !== 'string') {
    return { ok: false, output: '错误：参数格式错误：search_query 不能为空，且必须是字符串。' }
  }
  const query = raw.search_query.replace(/\s+/g, ' ').trim()
  if (!query) {
    return { ok: false, output: '错误：参数格式错误：search_query 不能为空。' }
  }
  if (query.length > 72) {
    return { ok: false, output: '错误：参数格式错误：search_query 不能超过 72 个字符。' }
  }
  return { ok: true, query }
}

async function renderGeneratePlan(
  args: unknown,
  interventionCodeMap: AgentRequestContext['interventionCodeMap'],
  session: AgentRequestContext['session'],
  userInfo: AgentRequestContext['userInfo'],
  profileData: AgentRequestContext['profileData'],
  log: AgentRequestContext['logger'],
  resourceBatchIndex: number,
  attemptIndex: number,
  userId: string,
  sessionId: string,
): Promise<{ output: string; displayOutput?: MedicalRiskToolOutput }> {
  if (attemptIndex > 3) {
    return {
      output: '本轮 generate_plan 已达到最多 3 次搜索限制。不要继续换 query 搜索；请基于已有候选收敛，或请用户补充关键信息。',
    }
  }
  const parsed = parseGeneratePlanSearchQuery(args)
  if (!parsed.ok) return { output: parsed.output }

  const raw = {
    search_query: parsed.query,
    category: 'current_symptom_or_side_effect',
  }
  const displayOutput = await buildMedicalRiskResources(
    raw,
    interventionCodeMap,
    session,
    userInfo,
    profileData,
    log,
    resourceBatchIndex,
    userId,
    sessionId,
  )
  return {
    output: renderResourceListForModel(displayOutput?.resources ?? [], attemptIndex),
    displayOutput: displayOutput ?? undefined,
  }
}

function parseMedicalLiteratureSearchQuery(args: unknown): { ok: true; query: string } | { ok: false; output: string } {
  if (!args || typeof args !== 'object') {
    return { ok: false, output: '错误：参数格式错误：需要 { query }。' }
  }
  const raw = args as Record<string, unknown>
  if (typeof raw.query !== 'string') {
    return { ok: false, output: '错误：参数格式错误：query 不能为空，且必须是字符串。' }
  }
  const query = sanitizeRagQuery(raw.query)
  if (!query) {
    return { ok: false, output: '错误：参数格式错误：query 不能为空。' }
  }
  if (query.length > 160) {
    return { ok: false, output: '错误：参数格式错误：query 不能超过 160 个字符。' }
  }
  return { ok: true, query }
}

async function renderMedicalLiteratureSearch(
  args: unknown,
  log: AgentRequestContext['logger'],
  literatureBatchIndex: number,
): Promise<{ output: string; displayOutput?: MedicalRiskToolOutput }> {
  const parsed = parseMedicalLiteratureSearchQuery(args)
  if (!parsed.ok) return { output: parsed.output }

  const result = await searchMedicalLiterature(parsed.query, log, literatureBatchIndex)
  return {
    output: result.llmOutput,
    displayOutput: {
      kind: 'medical_risk_resources',
      resources: [],
      literatureSearch: result.displayOutput,
    },
  }
}

function asAtomicToolResult(result: ToolCallResult, name: string): ToolCallResult {
  return { ...result, name }
}

const SCHEDULE_CONFIRM_TIMEZONE = 'Asia/Shanghai'

/** 把 ISO 时间渲染成用户可读的本地时间标签（默认上海时区），供确认卡展示 */
function scheduleDueAtLabel(dueAtIso: string | null, timezone: string | null): string | null {
  if (!dueAtIso) return null
  const date = new Date(dueAtIso)
  if (Number.isNaN(date.getTime())) return null
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: timezone || SCHEDULE_CONFIRM_TIMEZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(date)
  } catch {
    return dueAtIso
  }
}

/** 频率/类型概要：一次性 or cron 概要 */
function scheduleSummaryLabel(
  scheduleType: ScheduleConfirmationPendingTask['scheduleType'],
  cronExpression: string | null,
): string | null {
  if (scheduleType === 'cron') {
    return cronExpression ? `重复提醒（cron：${cronExpression}）` : '重复提醒'
  }
  if (scheduleType === 'once') return '一次性提醒'
  return null
}

/** 由 pendingTask 组装完整确认卡 payload（含展示标签） */
function buildScheduleConfirmationPayload(
  toolCallId: string,
  pendingTask: ScheduleConfirmationPendingTask,
): ScheduleConfirmationPayload {
  return {
    confirmationId: randomUUID(),
    toolCallId,
    action: pendingTask.action,
    taskName: pendingTask.taskName,
    dueAtLabel: scheduleDueAtLabel(pendingTask.dueAt, pendingTask.timezone),
    scheduleSummary: scheduleSummaryLabel(pendingTask.scheduleType, pendingTask.cronExpression),
    message: pendingTask.message,
    pendingTask,
  }
}

const SCHEDULE_CONFIRM_PENDING_OUTPUT = [
  'ok：确认卡片已展示，等用户点“确认”才生效（现在还没生效，别说已设置好）。',
  '这是日常小操作，正常一句口语化的话提示用户点确认就行，不要写“一句话总结/总结”，也不要任何总括段落或结论块。',
].join('\n')

function legacyScheduleToolCall(toolCall: ToolCallInput, args: Record<string, unknown>): ToolCallInput | null {
  const action = typeof args.action === 'string' ? args.action.trim() : ''
  if (action === 'list') {
    return { id: toolCall.id, name: 'list_scheduled_tasks', arguments: '{}' }
  }
  if (action === 'create') {
    return {
      id: toolCall.id,
      name: 'add_scheduled_task',
      arguments: JSON.stringify({
        task: args.task,
        message: args.message,
        time: args.time,
      }),
    }
  }
  if (action === 'update') {
    return {
      id: toolCall.id,
      name: 'update_scheduled_task',
      arguments: JSON.stringify({
        id: args.id,
        task: args.task,
        message: args.message,
        time: args.time,
      }),
    }
  }
  if (action === 'delete') {
    return {
      id: toolCall.id,
      name: 'update_scheduled_task',
      arguments: JSON.stringify({
        id: args.id,
        status: 'deleted',
      }),
    }
  }
  return null
}

function addMedicalRiskResourcesToMap(
  map: Map<string, MedicalRiskResource>,
  output: unknown,
): void {
  const parsed = parseMedicalRiskToolOutput(output)
  if (!parsed?.resources.length) return
  for (const resource of parsed.resources) {
    if (!map.has(resource.id)) map.set(resource.id, resource)
  }
}

async function collectMedicalRiskResourceMap(
  session: AgentRequestContext['session'],
  sessionId: string,
  requiredRefs?: readonly string[],
): Promise<Map<string, MedicalRiskResource>> {
  const result = new Map<string, MedicalRiskResource>()

  for (const message of session.messages) {
    if (message.role === 'tool') {
      addMedicalRiskResourcesToMap(result, message.displayOutput ?? message.content)
    }
    if (message.role === 'assistant' && Array.isArray(message.toolCalls)) {
      for (const toolCall of message.toolCalls) {
        const name = toolCallRecordName(toolCall)
        if (!name || !MEDICAL_RISK_RESOURCE_TOOL_NAMES.has(name)) continue
        const raw = toolCall as { output?: unknown; llmOutput?: unknown }
        addMedicalRiskResourcesToMap(result, raw.output)
        addMedicalRiskResourcesToMap(result, raw.llmOutput)
      }
    }
  }

  if (requiredRefs?.length && requiredRefs.every((refId) => result.has(refId))) {
    return result
  }

  const [{ eq }, { getDb }, { messages }] = await Promise.all([
    import('drizzle-orm'),
    import('../../db/client.js'),
    import('../../db/schema/index.js'),
  ])
  const rows = await getDb().query.messages.findMany({
    where: eq(messages.sessionId, sessionId),
    columns: { toolCalls: true },
  })
  for (const row of rows) {
    const toolCalls = Array.isArray(row.toolCalls) ? row.toolCalls : []
    for (const toolCall of toolCalls) {
      const name = toolCallRecordName(toolCall)
      if (!name || !MEDICAL_RISK_RESOURCE_TOOL_NAMES.has(name)) continue
      const raw = toolCall as { output?: unknown; llmOutput?: unknown }
      addMedicalRiskResourcesToMap(result, raw.output)
      addMedicalRiskResourcesToMap(result, raw.llmOutput)
    }
  }

  return result
}

function resourcePreviewFromResource(resource: MedicalRiskResource): AskUserQuestionResourcePreview {
  if (resource.kind === 'intervention_material') {
    return {
      refId: resource.id,
      kind: resource.kind,
      title: resource.title,
      thumbnailUrl: resource.material.currentSignedUrls.overviewImageUrl || null,
      durationSec: resource.material.overview.totalDurationSec,
      difficulty: resource.difficulty ?? inferResourceDifficulty(resource),
    }
  }
  if (resource.kind === 'internal_video') {
    return {
      refId: resource.id,
      kind: 'internal_video',
      title: resource.title,
      thumbnailUrl: resource.posterUrl || null,
      durationSec: resource.durationSec > 0 ? resource.durationSec : null,
      difficulty: resource.difficulty ?? inferResourceDifficulty(resource),
    }
  }
  return {
    refId: resource.id,
    kind: resource.kind,
    title: resource.title,
    thumbnailUrl: resource.thumbnailUrl,
    durationSec: resource.durationSec > 0 ? resource.durationSec : null,
    difficulty: resource.difficulty ?? inferResourceDifficulty(resource),
  }
}

function collectAskQuestionResourceRefIds(questions: ReturnType<typeof normalizeAskUserQuestionInput>): string[] {
  const refs = new Set<string>()
  for (const question of questions ?? []) {
    for (const option of question.options) {
      if (option.ref_id) refs.add(option.ref_id)
    }
  }
  return [...refs]
}

function normalizeTodoSourceType(value: string | null): 'intervention' | 'video_resource' | 'custom' {
  if (value === 'intervention' || value === 'video_resource') return value
  return 'custom'
}

function argNumber(args: Record<string, unknown>, key: string): number | null {
  const value = args[key]
  if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value)
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? Math.floor(parsed) : null
  }
  return null
}

function normalizeTodoToolItems(value: unknown): TodoInput[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('todos 不能为空')
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`todos[${index}] 必须是对象`)
    }
    const record = item as Record<string, unknown>
    const date = typeof record.date === 'string' ? record.date.trim() : ''
    const time = typeof record.time === 'string' ? record.time.trim() : ''
    const showPrompt = typeof record.show_prompt === 'string' ? record.show_prompt.trim() : ''
    const prompt = typeof record.prompt === 'string' ? record.prompt.trim() : ''
    if (!date || !time || !showPrompt || !prompt) {
      throw new Error(`todos[${index}] 必须包含 date、time、show_prompt、prompt`)
    }
    return { date, time, showPrompt, prompt }
  })
}

function argString(args: Record<string, unknown>, key: string): string | null {
  const value = args[key]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function todoToolOutputForModel(output: TodoToolOutput): string {
  if (output.kind === 'todos_conflict') {
    const lines = [
      output.message,
      'next_action=ask_user_question',
      '必须发起 ask_user_question，让用户在「替换已有计划」「换一个时间」「先不创建」中选择；不要直接再次调用 todos action=create。',
      '冲突详情：',
    ]
    for (const conflict of output.conflicts) {
      lines.push(`- type=${conflict.type}, plan_id=${conflict.planId}, title=${conflict.planTitle}, target=${conflict.targetSideEffect ?? 'unknown'}, reason=${conflict.reason}`)
      for (const overlap of conflict.overlapTimes ?? []) {
        lines.push(`  - new_time=${overlap.newTime}, existing_time=${overlap.existingTime}, existing_prompt=${overlap.existingTodoPrompt ?? ''}, delta_minutes=${overlap.deltaMinutes}`)
      }
    }
    return lines.join('\n')
  }
  return `${output.message}\n\n${output.plan.todosMd}`
}

export async function executeToolCall(
  toolCall: ToolCallInput,
  ctx: AgentRequestContext,
): Promise<ToolCallResult> {
  const start = performance.now()
  const log = ctx.logger.child({ module: 'tool-executor', tool: toolCall.name })

  try {
    switch (toolCall.name) {
      case 'schedule': {
        const parsedArgs = parseToolArgumentsForExecution(toolCall, start)
        if (!parsedArgs.ok) return parsedArgs.result
        const args = parsedArgs.value && typeof parsedArgs.value === 'object'
          ? parsedArgs.value as Record<string, unknown>
          : {}
        const legacy = legacyScheduleToolCall(toolCall, args)
        if (!legacy) {
          return {
            toolCallId: toolCall.id,
            name: toolCall.name,
            output: '参数格式错误：action 必须是 list、create、update 或 delete。',
            durationMs: Math.round(performance.now() - start),
          }
        }
        return asAtomicToolResult(await executeToolCall(legacy, ctx), toolCall.name)
      }

      case 'todos': {
        const parsedArgs = parseToolArgumentsForExecution(toolCall, start)
        if (!parsedArgs.ok) return parsedArgs.result
        const args = parsedArgs.value && typeof parsedArgs.value === 'object' && !Array.isArray(parsedArgs.value)
          ? parsedArgs.value as Record<string, unknown>
          : {}
        const action = argString(args, 'action')
        if (action === 'create') {
          const resourceRefId = argString(args, 'resource_ref_id')
          const resourceMap = resourceRefId
            ? await collectMedicalRiskResourceMap(ctx.session, ctx.sessionId)
            : null
          const resourceSnapshot = resourceRefId ? resourceMap?.get(resourceRefId) ?? null : null
          if (resourceRefId && !resourceSnapshot) throw new Error(`resource_ref_id 无效或已过期：${resourceRefId}`)
          const explicitSourceType = normalizeTodoSourceType(argString(args, 'source_type'))
          const inferredSourceType = resourceSnapshot?.kind === 'video_resource'
            ? 'video_resource'
            : resourceSnapshot?.kind === 'intervention_material'
              ? 'intervention'
              : explicitSourceType
          const output = await createTodoPlan({
            userId: ctx.userId,
            sessionId: ctx.sessionId,
            title: argString(args, 'title') ?? '',
            timezone: argString(args, 'timezone'),
            sourceType: inferredSourceType,
            sourceId: argString(args, 'source_id'),
            dedupeKey: argString(args, 'dedupe_key'),
            resourceRefId,
            courseDays: argNumber(args, 'course_days'),
            targetSideEffect: argString(args, 'target_side_effect'),
            resourceSnapshot,
            todos: normalizeTodoToolItems(args.todos),
          }, log)
          return {
            toolCallId: toolCall.id,
            name: toolCall.name,
            output: todoToolOutputForModel(output),
            displayOutput: output,
            durationMs: Math.round(performance.now() - start),
          }
        }

        const planId = argString(args, 'plan_id')

        if (action === 'stop') {
          if (!planId) throw new Error('action=stop 时 plan_id 必填')
          const output = await stopTodoPlan({
            userId: ctx.userId,
            planId,
            reason: argString(args, 'reason'),
          }, log)
          return {
            toolCallId: toolCall.id,
            name: toolCall.name,
            output: todoToolOutputForModel(output),
            displayOutput: output,
            durationMs: Math.round(performance.now() - start),
          }
        }

        if (action === 'update') {
          if (!planId) throw new Error('action=update 时 plan_id 必填')
          const resourceRefId = argString(args, 'resource_ref_id')
          const resourceMap = resourceRefId
            ? await collectMedicalRiskResourceMap(ctx.session, ctx.sessionId)
            : null
          const resourceSnapshot = resourceRefId ? resourceMap?.get(resourceRefId) ?? null : null
          if (resourceRefId && !resourceSnapshot) throw new Error(`resource_ref_id 无效或已过期：${resourceRefId}`)
          const explicitSourceType = normalizeTodoSourceType(argString(args, 'source_type'))
          const inferredSourceType = resourceSnapshot?.kind === 'video_resource'
            ? 'video_resource'
            : resourceSnapshot?.kind === 'intervention_material'
              ? 'intervention'
              : explicitSourceType
          const output = await updateTodoPlan({
            userId: ctx.userId,
            sessionId: ctx.sessionId,
            planId,
            title: argString(args, 'title') ?? '',
            timezone: argString(args, 'timezone'),
            sourceType: inferredSourceType,
            sourceId: argString(args, 'source_id'),
            dedupeKey: argString(args, 'dedupe_key'),
            resourceRefId,
            courseDays: argNumber(args, 'course_days'),
            targetSideEffect: argString(args, 'target_side_effect'),
            resourceSnapshot,
            todos: normalizeTodoToolItems(args.todos),
            reason: argString(args, 'reason'),
          }, log)
          return {
            toolCallId: toolCall.id,
            name: toolCall.name,
            output: todoToolOutputForModel(output),
            displayOutput: output,
            durationMs: Math.round(performance.now() - start),
          }
        }

        return {
          toolCallId: toolCall.id,
          name: toolCall.name,
          output: '参数格式错误：action 必须是 create、update 或 stop。',
          durationMs: Math.round(performance.now() - start),
        }
      }

      case 'memory': {
        const parsedArgs = parseToolArgumentsForExecution(toolCall, start)
        if (!parsedArgs.ok) return parsedArgs.result
        const args = parsedArgs.value && typeof parsedArgs.value === 'object'
          ? parsedArgs.value
          : {}
        const result = await runUserMdMemoryTool(ctx.userId, args, log)
        if (!result.success) {
          const matches = result.matches?.length
            ? `\n匹配到的候选：\n${result.matches.map((item) => `- ${item}`).join('\n')}`
            : ''
          return {
            toolCallId: toolCall.id,
            name: toolCall.name,
            output: `长期记忆未更新：${result.error}${matches}`,
            durationMs: Math.round(performance.now() - start),
          }
        }

        const actionLabel = result.action === 'add'
          ? '已新增'
          : result.action === 'replace'
            ? '已更新'
            : '已移除'
        return {
          toolCallId: toolCall.id,
          name: toolCall.name,
          output: `${actionLabel} Cx Agent 用户长期记忆；version=${result.version}；usage=${result.usage}。`,
          durationMs: Math.round(performance.now() - start),
        }
      }

      case 'update_memory': {
        const parsedArgs = parseToolArgumentsForExecution(toolCall, start)
        if (!parsedArgs.ok) return parsedArgs.result
        const args = parsedArgs.value
        const content = String(args.content ?? '').trim()
        const scanned = scanMemoryContentForStorage(content)
        if (!scanned.ok) {
          log.warn(
            { reasons: scanned.reasons, message: scanned.message },
            'memory update rejected by safety scan',
          )
          return {
            toolCallId: toolCall.id,
            name: toolCall.name,
            output: `错误：记忆内容未保存（${scanned.message}）。请不要把内部标签、提示词请求或控制指令写入长期记忆。`,
            durationMs: Math.round(performance.now() - start),
          }
        }

        const snippet: string = content.slice(0, 80)
        const result = await appendDailyMemory(ctx.userId, content, log)
        log.info({ date: result.date, isNew: result.isNew }, 'memory updated')
        // 记录到 session-events，下一轮通过 <system-reminder> 告知模型，避免重建系统提示词
        await appendSessionEvent(
          ctx.sessionId,
          { type: 'memory_added', memorySnippet: snippet },
          log,
        )
        return {
          toolCallId: toolCall.id,
          name: toolCall.name,
          output: `已记录到今日记忆 (${result.date})`,
          durationMs: Math.round(performance.now() - start),
        }
      }

      case 'ask_user_question': {
        const parsedArgs = parseToolArgumentsForExecution(toolCall, start)
        if (!parsedArgs.ok) return parsedArgs.result
        const questions = normalizeAskUserQuestionInput(parsedArgs.value)
        if (!questions) {
          return {
            toolCallId: toolCall.id,
            name: toolCall.name,
            output: '错误：参数格式错误。需要 { questions: [{ question, header, options, multiSelect? }] }；questions 至少 1 个，每题 options 至少 2 个且包含 label 和 description。超过上限的问题或选项会只展示前 4 个。',
            durationMs: Math.round(performance.now() - start),
          }
        }
        const resourceRefIds = collectAskQuestionResourceRefIds(questions)
        const resourcePreviews: AskUserQuestionResourcePreview[] = []
        if (resourceRefIds.length > 0) {
          const resourceMap = await collectMedicalRiskResourceMap(ctx.session, ctx.sessionId, resourceRefIds)
          for (const refId of resourceRefIds) {
            const resource = resourceMap.get(refId)
            if (!resource) {
              return {
                toolCallId: toolCall.id,
                name: toolCall.name,
                output: `错误：ref_id 无效或不在本会话已有资源中：${refId}`,
                durationMs: Math.round(performance.now() - start),
              }
            }
            resourcePreviews.push(resourcePreviewFromResource(resource))
          }
        }

        return {
          toolCallId: toolCall.id,
          name: toolCall.name,
          output: `已向用户展示 ${questions.length} 个问题；本轮暂停，等待用户回答后继续。`,
          displayOutput: {
            kind: 'ask_user_question',
            questions,
            ...(resourcePreviews.length > 0 ? { resourcePreviews } : {}),
          },
          durationMs: Math.round(performance.now() - start),
        }
      }

      case 'grade_medical_risk': {
        const parsedArgs = parseToolArgumentsForExecution(toolCall, start)
        if (!parsedArgs.ok) return parsedArgs.result
        const result = await renderMedicalRiskStrategy(parsedArgs.value)
        return {
          toolCallId: toolCall.id,
          name: toolCall.name,
          output: result.output,
          displayOutput: result.displayOutput,
          durationMs: Math.round(performance.now() - start),
        }
      }

      case 'load_skill': {
        const parsedArgs = parseToolArgumentsForExecution(toolCall, start)
        if (!parsedArgs.ok) return parsedArgs.result
        return {
          toolCallId: toolCall.id,
          name: toolCall.name,
          output: await renderLoadSkill(parsedArgs.value),
          durationMs: Math.round(performance.now() - start),
        }
      }

      case 'generate_plan': {
        const parsedArgs = parseToolArgumentsForExecution(toolCall, start)
        if (!parsedArgs.ok) return parsedArgs.result
        const result = await renderGeneratePlan(
          parsedArgs.value,
          ctx.interventionCodeMap,
          ctx.session,
          ctx.userInfo,
          ctx.profileData,
          log,
          getNextMedicalRiskResourceBatchIndex(ctx.session),
          getGeneratePlanAttemptIndex(ctx.session, toolCall.id),
          ctx.userId,
          ctx.sessionId,
        )
        return {
          toolCallId: toolCall.id,
          name: toolCall.name,
          output: result.output,
          displayOutput: result.displayOutput,
          durationMs: Math.round(performance.now() - start),
        }
      }

      case 'medical_literature_search': {
        const parsedArgs = parseToolArgumentsForExecution(toolCall, start)
        if (!parsedArgs.ok) return parsedArgs.result
        const result = await renderMedicalLiteratureSearch(
          parsedArgs.value,
          log,
          getNextMedicalRiskLiteratureBatchIndex(ctx.session),
        )
        return {
          toolCallId: toolCall.id,
          name: toolCall.name,
          output: result.output,
          displayOutput: result.displayOutput,
          durationMs: Math.round(performance.now() - start),
        }
      }

      case 'update_structured_profile': {
        const parsedArgs = parseToolArgumentsForExecution(toolCall, start)
        if (!parsedArgs.ok) return parsedArgs.result
        const args = parsedArgs.value
        const parsedUpdates = parseUpdates(args)
        const updates = parsedUpdates ? foldMedicationDurationUpdate(parsedUpdates) : null

        if (!updates || updates.length === 0) {
          return {
            toolCallId: toolCall.id,
            name: toolCall.name,
            output: '参数格式错误：需要 { updates: [{field, value}, ...] } 且至少一项。',
            durationMs: Math.round(performance.now() - start),
          }
        }

        // 审批元数据驱动分支：在工具定义上声明哪些字段需审批，executor 只负责分派
        const approvalSet = computeApprovalSet(args)
        const approvalPayloads: ToolApprovalPayload[] = []
        const autoUpdatedPayloads: ProfileAutoUpdatedPayload[] = []
        const lines: string[] = []
        const seenFields = new Set<string>()

        for (const update of updates) {
          const { field } = update
          let value = update.value
          let profilePatch: MedicalProfileData | undefined
          let medicationCustom: string | undefined

          // 同一批内去重：只保留首次
          if (seenFields.has(field)) {
            lines.push(`- ${FIELD_LABELS[field] || field}：同批次内重复，已忽略后续。`)
            continue
          }
          seenFields.add(field)

          if (!STRUCTURED_FIELD_SET.has(field)) {
            lines.push(`- ${field}：不是合法的结构化字段（合法字段：${STRUCTURED_PROFILE_FIELDS.join(', ')}），已跳过。`)
            continue
          }

          const fieldLabel = FIELD_LABELS[field] || field
          if (isUnsafeTumorTypeInference(field, value, getCurrentUserTextContent(ctx))) {
            lines.push(`- ${fieldLabel}：不能仅凭 ER/PR 阳性、HER2 阴性推断肿瘤分型，缺少 Ki-67 等关键信息，本次未发起更新。`)
            log.info({ field, value }, 'tumor type update skipped: unsafe inference from partial markers')
            continue
          }
          const storageScope = getFieldStorageScope(field)
          if (!storageScope) {
            lines.push(`- ${fieldLabel}：缺少字段存储配置，已跳过。`)
            log.warn({ field }, 'structured profile update skipped: missing storage scope')
            continue
          }
          const needsApproval = approvalSet.has(field)
          const isPersonal = !needsApproval && PERSONAL_FIELD_SET.has(field)

          // rejectedFields 拦截仅作用于需审批字段
          if (needsApproval && ctx.rejectedFields.has(field)) {
            lines.push(`- ${fieldLabel}：用户此前已拒绝更新此字段，本次未发起。请不要再尝试。`)
            log.info({ field }, 'structured profile update blocked by rejectedFields')
            continue
          }

          const currentRaw = currentValueOf(field, ctx)
          if (field === 'medications') {
            if (!Array.isArray(value)) {
              lines.push(`- ${fieldLabel}：参数非法（medications 必须是字符串数组），已跳过。`)
              log.warn({ field, value }, 'medications update skipped: value is not an array')
              continue
            }
            const normalized = normalizeMedicationUpdate(
              value,
              update.medicationCustom,
              update.medicationDuration,
              update.medicationDurations,
              ctx,
            )
            value = normalized.value
            medicationCustom = normalized.medicationCustom
            profilePatch = normalized.profilePatch
          }
          if (field === 'medicationDuration') {
            const currentProfile = normalizeMedicalProfileData(ctx.profileData)
            const items = resolveMedicationItems(currentProfile.medications, currentProfile.medicationCustom)
            if (items.length === 0 || currentProfile.medications?.includes('none')) {
              lines.push(`- ${fieldLabel}：当前没有正在使用的药物，无需单独更新用药时长。`)
              continue
            }
            const duration = isSelectableMedicationDuration(value) ? value : undefined
            if (!duration) {
              lines.push(`- ${fieldLabel}：参数非法（medicationDuration 枚举值非法：${value}），已跳过。`)
              log.warn({ field, value }, 'medication duration update skipped: invalid value')
              continue
            }
            const durationMap: Record<string, import('@health-agent/shared').SelectableMedicationDuration> = {}
            for (const item of items) durationMap[item.key] = duration
            profilePatch = normalizeMedicalProfileData({
              medications: currentProfile.medications,
              medicationCustom: currentProfile.medicationCustom,
              medicationDurations: durationMap,
            })
          }
          const currentLabel = field === 'medications' || field === 'medicationDuration'
            ? medicationProfileLabel(ctx.profileData)
            : labelOf(
                field,
                currentRaw,
                undefined,
              )
          const proposedLabel = field === 'medications' || field === 'medicationDuration'
            ? (medicationProfileLabel({
                ...(ctx.profileData ?? {}),
                ...(profilePatch ?? { [field]: value }),
              }) ?? '')
            : (labelOf(field, value, medicationCustom) ?? '')

          // 同值跳过（personal 与 medical 通用）
          const isSame = field === 'medications' || field === 'medicationDuration'
            ? medicationProfileComparable(ctx.profileData) === medicationProfileComparable({
                ...(ctx.profileData ?? {}),
                ...(profilePatch ?? { [field]: value }),
              })
            : isSameValue(field, currentRaw, value)
          if (isSame) {
            lines.push(`- ${fieldLabel}：当前值已为「${currentLabel ?? proposedLabel}」，无需更新。`)
            continue
          }

          // personal 字段：直接落库，无需确认，无二次授权
          if (isPersonal) {
            const validationErr = validateField(field, value)
            if (validationErr) {
              lines.push(`- ${fieldLabel}：参数非法（${validationErr}），已跳过。`)
              log.warn({ field, value, validationErr }, 'personal field auto-update skipped: invalid value')
              continue
            }

            try {
              await updateUserProfile(
                ctx.userId,
                { [field as PersonalInfoField]: value } as import('@health-agent/shared').UserProfileInput,
                log,
              )
            } catch (err: any) {
              lines.push(`- ${fieldLabel}：落库失败（${err?.message ?? '未知错误'}），请稍后再试。`)
              log.error({ field, err: err?.message }, 'personal field auto-update DB error')
              continue
            }

            // 和现有确认卡片路径一致：追加 profile_approved session-event，下一轮 LLM 通过 system-reminder 感知
            await appendSessionEvent(
              ctx.sessionId,
              { type: 'profile_approved', field, valueLabel: valueLabelOf(field, value) },
              log,
            )

            const notice: ProfileAutoUpdatedPayload = {
              noticeId: randomUUID(),
              toolCallId: toolCall.id,
              field: field as PersonalInfoField,
              fieldLabel,
              currentLabel,
              proposedLabel,
              updatedAt: Date.now(),
            }
            autoUpdatedPayloads.push(notice)
            lines.push(`- ${fieldLabel}：已直接更新为「${proposedLabel}」。`)
            log.info({ field, proposedLabel }, 'personal field auto-updated')
            ctx.userInfo = { ...(ctx.userInfo ?? {}), [field]: value }
            continue
          }

          if (isMedicalRecordField(field)) {
            const allowedMedicalFields = new Set(
              resolveAllowedMedicalFieldsForAI(ctx.userInfo?.currentConcern, ctx.userInfo?.gender),
            )
            if (!allowedMedicalFields.has(field)) {
              const hint = isBreastCancerExtensionField(field)
                ? '如用户已进入乳腺肿瘤相关诊疗场景，请先更新 currentConcern=breast_tumor_care。'
                : isBreastNoduleExtensionField(field)
                  ? '如用户已进入乳腺结节随访场景，请先更新 currentConcern=breast_nodule_followup。'
                  : ''
              lines.push(`- ${fieldLabel}：当前关注情况不允许更新该字段。${hint}`)
              log.info({ field, currentConcern: ctx.userInfo?.currentConcern }, 'medical field update blocked by current concern')
              continue
            }
          }

          const validationErr = validateField(field, value)
          if (validationErr) {
            lines.push(`- ${fieldLabel}：参数非法（${validationErr}），已跳过。`)
            log.warn({ field, value, validationErr }, 'structured profile update skipped: invalid value')
            continue
          }

          // currentConcern + medical 字段：维持确认卡片流程
          const approvalId = randomUUID()
          const approvalFieldLabel = field === 'medications' || field === 'medicationDuration'
            ? '用药情况与时长'
            : fieldLabel
          const payload: ToolApprovalPayload = {
            approvalId,
            toolCallId: toolCall.id,
            field,
            fieldLabel: approvalFieldLabel,
            fieldGroup: storageScope === 'medical_record' ? 'medical' : 'personal',
            storageScope,
            requiresHealthProfileConsent: requiresHealthProfileConsentForField(field),
            currentValue: (currentRaw as any) ?? null,
            proposedValue: value as any,
            profilePatch,
            currentLabel,
            proposedLabel,
          }
          approvalPayloads.push(payload)
          const analyticsEvent = {
            userId: ctx.userId,
            sessionId: ctx.sessionId,
            eventName: 'profile_approval_card_triggered',
            dedupeKey: approvalId,
            entityType: 'profile_field',
            entityId: field,
            properties: {
              approvalId,
              toolCallId: toolCall.id,
              field,
              fieldLabel: approvalFieldLabel,
              fieldGroup: payload.fieldGroup,
              storageScope,
              requiresHealthProfileConsent: payload.requiresHealthProfileConsent,
              currentLabel,
              proposedLabel,
            },
          } as const
          await safeRecordAnalyticsEvent(analyticsEvent, log)
          safeTrackBackendEvent(analyticsEvent, log, ctx.trackingContext)
          lines.push(`- ${approvalFieldLabel}：已发送确认卡片（${currentLabel ?? '未填写'} → ${proposedLabel}）。等待用户界面确认。`)
          log.info({ approvalId, field, proposedLabel }, 'structured profile update requested')
        }

        const segments: string[] = []
        if (autoUpdatedPayloads.length > 0) {
          segments.push(`${autoUpdatedPayloads.length} 个个人信息字段已直接落库`)
        }
        if (approvalPayloads.length > 0) {
          segments.push(`${approvalPayloads.length} 张确认卡片已发送给用户（未落库，请不要声称已更新成功）`)
        }
        const header = segments.length > 0 ? segments.join('；') + '。' : '没有需要处理的更新。'

        return {
          toolCallId: toolCall.id,
          name: toolCall.name,
          output: `${header}\n${lines.join('\n')}`,
          durationMs: Math.round(performance.now() - start),
          approvalPayloads: approvalPayloads.length > 0 ? approvalPayloads : undefined,
          autoUpdatedPayloads: autoUpdatedPayloads.length > 0 ? autoUpdatedPayloads : undefined,
        }
      }

      case 'search_chat_history': {
        const parsedArgs = parseToolArgumentsForExecution(toolCall, start)
        if (!parsedArgs.ok) return parsedArgs.result
        const result = await searchChatHistory(ctx.userId, parsedArgs.value, log)
        log.info(
          {
            resultCount: result.results.length,
            truncated: result.truncated,
          },
          'chat history searched',
        )
        return {
          toolCallId: toolCall.id,
          name: toolCall.name,
          output: result.output,
          durationMs: Math.round(performance.now() - start),
        }
      }

      case 'saved_content': {
        const parsedArgs = parseToolArgumentsForExecution(toolCall, start)
        if (!parsedArgs.ok) return parsedArgs.result
        const args = parsedArgs.value
        const action = typeof args?.action === 'string' ? args.action.trim().toLowerCase() : ''
        const typeFilter = normalizeSavedContentType(args?.type)
        const savedFilter = normalizeSavedContentSavedFilter(args?.saved)
        if (args?.type != null && !typeFilter) {
          return {
            toolCallId: toolCall.id,
            name: toolCall.name,
            output: '参数格式错误：type 只能是 A（我的跟练卡/跟练视频）、B（我的沟通卡）或 C（病历文档）。',
            durationMs: Math.round(performance.now() - start),
          }
        }
        if (args?.saved != null && !savedFilter) {
          return {
            toolCallId: toolCall.id,
            name: toolCall.name,
            output: '参数格式错误：saved 只能是 yes（已保存）或 no（未保存）；不传表示全部。',
            durationMs: Math.round(performance.now() - start),
          }
        }

        if (action === 'list') {
          const index = await loadSavedContentIndex(ctx, typeFilter, savedFilter, log)
          const rendered = renderSavedContentList(index, typeFilter, savedFilter)
          return {
            toolCallId: toolCall.id,
            name: toolCall.name,
            output: rendered.output,
            displayOutput: rendered.displayOutput,
            durationMs: Math.round(performance.now() - start),
          }
        }

        if (action !== 'read' && action !== 'show') {
          return {
            toolCallId: toolCall.id,
            name: toolCall.name,
            output: '参数格式错误：action 必须是 list、read 或 show。',
            durationMs: Math.round(performance.now() - start),
          }
        }

        const parsedId = parseSavedContentId(args?.id)
        if (!parsedId) {
          return {
            toolCallId: toolCall.id,
            name: toolCall.name,
            output: '参数格式错误：action=read/show 时 id 必填，格式必须是 A-1、B-2 或 C-3。请先 action=list 获取当前有效编号。',
            durationMs: Math.round(performance.now() - start),
          }
        }
        if (typeFilter && typeFilter !== parsedId.type) {
          return {
            toolCallId: toolCall.id,
            name: toolCall.name,
            output: `参数不一致：type=${typeFilter}，但 id=${parsedId.id} 属于 ${parsedId.type}。请以 id 前缀为准，或重新 list 后再 read。`,
            durationMs: Math.round(performance.now() - start),
          }
        }

        const index = await loadSavedContentIndex(ctx, parsedId.type, savedFilter, log)
        const counts = countSavedContentItems(index)
        const arrayIndex = parsedId.index - 1
        if (parsedId.index > counts[parsedId.type]) {
          return {
            toolCallId: toolCall.id,
            name: toolCall.name,
            output: `未找到 ${parsedId.id}。当前 ${parsedId.type} ${SAVED_CONTENT_TYPE_LABELS[parsedId.type]} 共有 ${counts[parsedId.type]} 个，请先 action=list 获取有效编号。`,
            durationMs: Math.round(performance.now() - start),
          }
        }

        if (action === 'show') {
          if (parsedId.type === 'A') {
            const item = buildSavedContentAItems(index)[arrayIndex]
            if (item.saved === 'no') {
              if (item.item.kind === 'intervention_material') {
                const displayOutput = medicalRiskResourceDisplayOutput(
                  buildInterventionShowResource(parsedId.id, item.item.detail, item.item.progress),
                )
                return {
                  toolCallId: toolCall.id,
                  name: toolCall.name,
                  output: renderSavedContentShowResult(
                    parsedId.id,
                    item.item.title,
                    'show_note=这是历史会话里发送过但当前未保存/未收藏的跟练卡，本次只是重新展示给用户。',
                  ),
                  displayOutput,
                  durationMs: Math.round(performance.now() - start),
                }
              }
              const displayOutput = medicalRiskResourceDisplayOutput(buildVideoShowResource(parsedId.id, item.item))
              return {
                toolCallId: toolCall.id,
                name: toolCall.name,
                output: renderSavedContentShowResult(
                  parsedId.id,
                  item.item.title,
                  'show_note=这是历史会话里发送过但当前未保存/未收藏的跟练视频，本次只是重新展示给用户。',
                ),
                displayOutput,
                durationMs: Math.round(performance.now() - start),
              }
            }
            const detail = item.record.detail ?? await getInterventionToolOutputByCode(
              item.record.engagement.materialCode,
              ctx.interventionCodeMap,
              log,
            )
            if (!detail) {
              return {
                toolCallId: toolCall.id,
                name: toolCall.name,
                output: `无法展示 ${parsedId.id}：原始跟练资源详情暂不可用。若只是需要文字信息，请改用 action=read。`,
                durationMs: Math.round(performance.now() - start),
              }
            }
            const displayOutput = medicalRiskResourceDisplayOutput(
              buildInterventionShowResource(parsedId.id, detail, savedInterventionProgress(item.record)),
            )
            return {
              toolCallId: toolCall.id,
              name: toolCall.name,
              output: renderSavedContentShowResult(
                parsedId.id,
                detail.actionName,
                'show_note=这是用户已保存的跟练资源，本次只是重新展示给用户，不代表新生成。',
              ),
              displayOutput,
              durationMs: Math.round(performance.now() - start),
            }
          }

          if (parsedId.type === 'B') {
            const item = buildSavedContentBItems(index)[arrayIndex]
            if (item.saved === 'no') {
              return {
                toolCallId: toolCall.id,
                name: toolCall.name,
                output: `无法直接展示 ${parsedId.id}：这是一张历史未保存沟通卡草稿。请改用 action=read 读取草稿内容后，再用文字给用户说明。`,
                durationMs: Math.round(performance.now() - start),
              }
            }
            const card = item.card
            return {
              toolCallId: toolCall.id,
              name: toolCall.name,
              output: [
                'saved_content_result',
                'action=show',
                `id=${parsedId.id}`,
                `type=B ${SAVED_CONTENT_TYPE_LABELS.B}`,
                `title=${card.title}`,
                'show_note=已把这张已保存沟通卡作为引用返回给前端展示；最终回答简短说明即可，不要整张复述。',
              ].join('\n'),
              displayOutput: {
                action: 'show',
                type: parsedId.type,
                id: parsedId.id,
                title: card.title,
              },
              durationMs: Math.round(performance.now() - start),
              attachedCommunicationCards: [{
                cardId: card.id,
                shortId: parsedId.id,
                title: card.title,
              }],
            }
          }

          return {
            toolCallId: toolCall.id,
            name: toolCall.name,
            output: `无法直接展示 ${parsedId.id}：病历文档需要 action=read 读取原图后再结合用户问题解读。`,
            durationMs: Math.round(performance.now() - start),
          }
        }

        if (parsedId.type === 'A') {
          const item = buildSavedContentAItems(index)[arrayIndex]
          if (item.saved === 'no') {
            const output = renderUnsavedSentContentRead(parsedId.id, parsedId.type, item.item)
            if (output.length > MAX_CARD_MARKDOWN_CHARS) {
              return {
                toolCallId: toolCall.id,
                name: toolCall.name,
                output: `未保存跟练内容过长（${output.length} / ${MAX_CARD_MARKDOWN_CHARS} 字符），本次未读取。请让用户缩小问题范围后重试。`,
                durationMs: Math.round(performance.now() - start),
              }
            }
            return {
              toolCallId: toolCall.id,
              name: toolCall.name,
              output,
              displayOutput: {
                action: 'read',
                type: parsedId.type,
                saved: item.saved,
                id: parsedId.id,
                subtype: item.item.kind,
                title: item.item.title,
              },
              durationMs: Math.round(performance.now() - start),
            }
          }
          const detail = item.record.detail ?? await getInterventionToolOutputByCode(
            item.record.engagement.materialCode,
            ctx.interventionCodeMap,
            log,
          )
          return {
            toolCallId: toolCall.id,
            name: toolCall.name,
            output: renderSavedInterventionRead(parsedId.id, item.record, detail),
            displayOutput: {
              action: 'read',
              type: parsedId.type,
              saved: item.saved,
              id: parsedId.id,
              title: detail?.actionName ?? null,
            },
            durationMs: Math.round(performance.now() - start),
          }
        }

        if (parsedId.type === 'B') {
          const item = buildSavedContentBItems(index)[arrayIndex]
          if (item.saved === 'no') {
            const output = renderUnsavedSentContentRead(parsedId.id, parsedId.type, item.item)
            if (output.length > MAX_CARD_MARKDOWN_CHARS) {
              return {
                toolCallId: toolCall.id,
                name: toolCall.name,
                output: `未保存沟通卡内容过长（${output.length} / ${MAX_CARD_MARKDOWN_CHARS} 字符），本次未读取。请让用户缩小问题范围后重试。`,
                durationMs: Math.round(performance.now() - start),
              }
            }
            return {
              toolCallId: toolCall.id,
              name: toolCall.name,
              output,
              displayOutput: {
                action: 'read',
                type: parsedId.type,
                saved: item.saved,
                id: parsedId.id,
                subtype: item.item.kind,
                title: item.item.title,
              },
              durationMs: Math.round(performance.now() - start),
            }
          }
          const card = item.card
          const output = renderCommunicationCardRead(parsedId.id, card)
          if (output.length > MAX_CARD_MARKDOWN_CHARS) {
            return {
              toolCallId: toolCall.id,
              name: toolCall.name,
              output: `沟通卡片内容过长（${output.length} / ${MAX_CARD_MARKDOWN_CHARS} 字符），本次未读取。请让用户缩小问题范围后重试。`,
              durationMs: Math.round(performance.now() - start),
            }
          }
          return {
            toolCallId: toolCall.id,
            name: toolCall.name,
            output,
            displayOutput: {
              action: 'read',
              type: parsedId.type,
              saved: item.saved,
              id: parsedId.id,
              title: card.title,
            },
            durationMs: Math.round(performance.now() - start),
            attachedCommunicationCards: [{
              cardId: card.id,
              shortId: parsedId.id,
              title: card.title,
            }],
          }
        }

        const doc = index.medicalDocs[arrayIndex]
        const [docWithImages] = await getDocumentsByIds(ctx.userId, [doc.id], log)
        if (!docWithImages) {
          return {
            toolCallId: toolCall.id,
            name: toolCall.name,
            output: `未找到 ${parsedId.id} 对应的病历文档。请先 action=list 获取当前有效编号。`,
            durationMs: Math.round(performance.now() - start),
          }
        }

        const requestedImageCount = docWithImages.base64Keys.length > 0
          ? docWithImages.base64Keys.length
          : docWithImages.imageUrls.length
        if (requestedImageCount > MAX_ATTACHED_IMAGES) {
          return {
            toolCallId: toolCall.id,
            name: toolCall.name,
            output: `这份病历包含 ${requestedImageCount} 张图片，超过单次上限 ${MAX_ATTACHED_IMAGES} 张。请让用户拆分或缩小资料范围后重试。`,
            durationMs: Math.round(performance.now() - start),
          }
        }

        let imageBlocks: AttachedDocument['imageBlocks'] = []
        if (docWithImages.base64Keys.length > 0) {
          try {
            const base64s = await Promise.all(docWithImages.base64Keys.map((k) => fetchBase64(k)))
            imageBlocks = base64s.map((b64) => ({
              type: 'image_url' as const,
              image_url: { url: `data:image/jpeg;base64,${b64}` },
            }))
          } catch (err: any) {
            log.error({ err: err?.message, docId: docWithImages.id }, 'failed to fetch base64, falling back to signed URLs')
            imageBlocks = docWithImages.imageUrls.map((url) => ({
              type: 'image_url' as const,
              image_url: { url },
            }))
          }
        } else {
          imageBlocks = docWithImages.imageUrls.map((url) => ({
            type: 'image_url' as const,
            image_url: { url },
          }))
        }

        const totalInlineBase64Chars = imageBlocks.reduce((sum, block) => {
          const url = block.image_url.url
          return sum + (url.startsWith('data:image/') ? url.length : 0)
        }, 0)
        if (totalInlineBase64Chars > MAX_ATTACHED_IMAGE_BASE64_CHARS) {
          return {
            toolCallId: toolCall.id,
            name: toolCall.name,
            output: `病历图片总大小超过单次读取上限（${totalInlineBase64Chars} / ${MAX_ATTACHED_IMAGE_BASE64_CHARS} 字符）。请让用户缩小资料范围后重试。`,
            durationMs: Math.round(performance.now() - start),
          }
        }

        const attached: AttachedDocument = {
          docId: docWithImages.id,
          shortId: parsedId.id,
          title: docWithImages.title,
          documentDate: docWithImages.documentDate,
          hospital: docWithImages.hospital,
          imageBlocks,
        }

        return {
          toolCallId: toolCall.id,
          name: toolCall.name,
          output: renderMedicalDocumentReadIntro(parsedId.id, docWithImages),
          displayOutput: {
            action: 'read',
            type: parsedId.type,
            id: parsedId.id,
            title: docWithImages.title,
            imageCount: imageBlocks.length,
          },
          durationMs: Math.round(performance.now() - start),
          attachedDocuments: [attached],
        }
      }

      case 'generate_communication_card': {
        const parsedArgs = parseToolArgumentsForExecution(toolCall, start)
        if (!parsedArgs.ok) return parsedArgs.result
        const args = parsedArgs.value
        const draft = normalizeCommunicationCardDraft(args)
        const output: CommunicationCardToolOutput = {
          kind: 'communication_card_draft',
          success: true,
          templateVersion: COMMUNICATION_CARD_TEMPLATE_VERSION,
          draft,
          assistantReminder: COMMUNICATION_CARD_ASSISTANT_REMINDER,
        }

        log.info(
          {
            title: draft.title,
            cardDate: draft.cardDate,
            hasQuestions: Boolean(draft.questionsForDoctor),
          },
          'communication card draft generated',
        )

        // 记录“已生成”事件，即使后续整轮 assistant
        // 未落库，下一轮也能通过 session-events 感知上一张卡片是否已展示/保存。
        await appendSessionEvent(
          ctx.sessionId,
          {
            type: 'communication_card_generated',
            cardTitle: draft.title,
            cardDate: draft.cardDate,
          },
          log,
        )
        const analyticsEvent = {
          userId: ctx.userId,
          sessionId: ctx.sessionId,
          eventName: 'communication_card_triggered',
          dedupeKey: toolCall.id,
          entityType: 'tool_call',
          entityId: toolCall.id,
          properties: {
            toolCallId: toolCall.id,
            title: draft.title,
            cardDate: draft.cardDate,
          },
        } as const
        await safeRecordAnalyticsEvent(analyticsEvent, log)
        safeTrackBackendEvent(analyticsEvent, log, ctx.trackingContext)

        return {
          toolCallId: toolCall.id,
          name: toolCall.name,
          output: JSON.stringify(output),
          displayOutput: output,
          durationMs: Math.round(performance.now() - start),
        }
      }

      case 'medical_report_consultation_board': {
        const parsedArgs = parseToolArgumentsForExecution(toolCall, start)
        if (!parsedArgs.ok) return parsedArgs.result
        const result = await runMedicalReportConsultation(ctx.session, log, parsedArgs.value)
        return {
          toolCallId: toolCall.id,
          name: toolCall.name,
          output: result.output,
          durationMs: result.durationMs,
        }
      }

	      case 'show_intervention_material': {
        const parsedArgs = parseToolArgumentsForExecution(toolCall, start)
        if (!parsedArgs.ok) return parsedArgs.result
        const args = parsedArgs.value
        const code = typeof args?.code === 'string' ? args.code.trim() : ''
        if (!code) {
          return {
            toolCallId: toolCall.id,
            name: toolCall.name,
            output: '参数格式错误：code 不能为空。',
            durationMs: Math.round(performance.now() - start),
          }
        }

        const output = await getInterventionToolOutputByCode(code, ctx.interventionCodeMap, log)
        if (!output) {
          return {
            toolCallId: toolCall.id,
            name: toolCall.name,
            output: `未找到编号为 ${code} 的干预资料，请改用资料库中存在的编号。`,
            durationMs: Math.round(performance.now() - start),
          }
        }

        const llmSummary = [
          `已展示干预方案 ${code}：${output.sideEffect} / ${output.scene} / ${output.actionName}。`,
          '方案生成成功：总览卡片与跟练按钮会UI上会出现在你回复的最终消息下方，引用时请说下方这张卡片。',
          '不要把全部步骤逐条重复一遍；只需结合当前方案给出简洁引导或安全提醒。',
        ].join('')

        try {
          await recordInterventionMaterialInteraction({
            userId: ctx.userId,
            sessionId: ctx.sessionId,
            toolCallId: toolCall.id,
            event: 'view',
            snapshot: output,
          }, log)
        } catch (err: any) {
          log.warn({ error: err.message }, 'failed to record intervention material card impression')
        }

        log.info({
          code,
          materialId: output.materialId,
          version: output.version,
          stepCount: output.stepsMeta.length,
        }, 'intervention material prepared')

	        return {
	          toolCallId: toolCall.id,
	          name: toolCall.name,
	          output: llmSummary,
	          displayOutput: output,
	          durationMs: Math.round(performance.now() - start),
	        }
	      }

	      case 'propose_check_in_draft': {
	        const parsedArgs = parseToolArgumentsForExecution(toolCall, start)
	        if (!parsedArgs.ok) return parsedArgs.result
	        const args = parsedArgs.value
	        try {
	          const result = await proposeCheckInDraft({
	            userId: ctx.userId,
	            sessionId: ctx.sessionId,
	            toolCallId: toolCall.id,
	            sourceMessageId: getLatestUserMessageId(ctx),
	            draft: {
	              categoryName: args.categoryName,
	              displayMode: args.displayMode,
	              fields: args.fields,
	            },
	            draftValues: args.draftValues && typeof args.draftValues === 'object' ? args.draftValues : null,
	            draftNote: typeof args.draftNote === 'string' ? args.draftNote : null,
	            draftTags: Array.isArray(args.draftTags) ? args.draftTags : [],
	            attachments: getCurrentUserImageAttachments(ctx),
	            recordedAt: typeof args.recordedAt === 'string' ? args.recordedAt : null,
	            sourceText: getCurrentUserTextContent(ctx),
	            supersedesCheckInCardId: typeof args.supersedesCheckInCardId === 'string'
	              ? args.supersedesCheckInCardId
	              : null,
	          })
	          return {
	            toolCallId: toolCall.id,
	            name: toolCall.name,
	            output: [
	              result.message,
	              result.checkInCardId ? `卡片ID:${result.checkInCardId}` : '',
	              result.draftSchema ? `分类:${result.draftSchema.categoryName}` : '',
	              '卡片已展示给用户编辑;最终回答只需邀请用户在卡片里核对/补全后点击保存,不要复述卡片内容,也不要假设已经保存。',
	              result.checkInCardId ? '可在邀请保存的同时,用 Markdown 链接告诉用户保存后可点击 [打卡记录](/check-ins) 查看和管理打卡;必须保留可点击的链接格式,不要只输出页面名。' : '',
	            ].filter(Boolean).join('\n'),
	            displayOutput: result,
	            durationMs: Math.round(performance.now() - start),
	          }
	        } catch (err: any) {
	          return {
	            toolCallId: toolCall.id,
	            name: toolCall.name,
	            output: `生成打卡草稿失败:${err?.message ?? '参数错误'}`,
	            durationMs: Math.round(performance.now() - start),
	          }
	        }
	      }

	      case 'get_check_in_schema': {
	        const parsedArgs = parseToolArgumentsForExecution(toolCall, start)
	        if (!parsedArgs.ok) return parsedArgs.result
	        const args = parsedArgs.value
	        const categoryQuery = typeof args.categoryQuery === 'string' ? args.categoryQuery.trim() : ''
	        const categoryKey = typeof args.categoryKey === 'string' ? args.categoryKey.trim() : ''
	        if (!categoryQuery && !categoryKey) {
	          return {
	            toolCallId: toolCall.id,
	            name: toolCall.name,
	            output: '参数格式错误:categoryQuery 不能为空。',
	            durationMs: Math.round(performance.now() - start),
	          }
	        }
	        try {
	          const result = await getCheckInSchemaForTool({
	            userId: ctx.userId,
	            categoryQuery,
	            categoryKey: categoryKey || null,
	          })
	          return {
	            toolCallId: toolCall.id,
	            name: toolCall.name,
	            output: renderCheckInSchemaMatchForTool(result),
	            displayOutput: result,
	            durationMs: Math.round(performance.now() - start),
	          }
	        } catch (err: any) {
	          return {
	            toolCallId: toolCall.id,
	            name: toolCall.name,
	            output: `读取打卡分类 schema 失败:${err?.message ?? '参数错误'}`,
	            durationMs: Math.round(performance.now() - start),
	          }
	        }
	      }

	      case 'propose_check_in_record': {
	        const parsedArgs = parseToolArgumentsForExecution(toolCall, start)
	        if (!parsedArgs.ok) return parsedArgs.result
	        const args = parsedArgs.value
	        const categoryQuery = typeof args.categoryQuery === 'string' ? args.categoryQuery.trim() : ''
	        if (!categoryQuery) {
	          return {
	            toolCallId: toolCall.id,
	            name: toolCall.name,
	            output: '参数格式错误:categoryQuery 不能为空。',
	            durationMs: Math.round(performance.now() - start),
	          }
	        }
	        try {
	          const result = await proposeCheckInRecord({
	            userId: ctx.userId,
	            sessionId: ctx.sessionId,
	            toolCallId: toolCall.id,
	            sourceMessageId: getLatestUserMessageId(ctx),
	            categoryQuery,
	            categoryKey: typeof args.categoryKey === 'string' ? args.categoryKey.trim() : null,
	            fallbackSchema: {
	              categoryName: args.fallbackCategoryName,
	              displayMode: args.fallbackDisplayMode,
	              fields: args.fallbackFields,
	            },
	            draftValues: args.draftValues && typeof args.draftValues === 'object' ? args.draftValues : null,
	            draftNote: typeof args.draftNote === 'string' ? args.draftNote : null,
	            draftTags: Array.isArray(args.draftTags) ? args.draftTags : [],
	            attachments: getCurrentUserImageAttachments(ctx),
	            recordedAt: typeof args.recordedAt === 'string' ? args.recordedAt : null,
	            sourceText: getCurrentUserTextContent(ctx),
	            supersedesCheckInCardId: typeof args.supersedesCheckInCardId === 'string'
	              ? args.supersedesCheckInCardId
	              : null,
	          })
	          return {
	            toolCallId: toolCall.id,
	            name: toolCall.name,
	            output: [
	              result.message,
	              result.checkInCardId ? `卡片ID:${result.checkInCardId}` : '',
	              result.existingSchema ? `已有分类:${result.existingSchema.categoryName}` : '',
	              result.candidates?.length
	                ? `候选分类:${result.candidates.map((item) => item.categoryName).join('、')}`
	                : '',
	              result.checkInCardId ? '卡片已展示给用户编辑;最终回答只需邀请用户在卡片里核对/补全后点击保存,不要假设已经保存。' : '',
	              result.checkInCardId ? '可在邀请保存的同时,用 Markdown 链接告诉用户保存后可点击 [打卡记录](/check-ins) 查看和管理打卡;必须保留可点击的链接格式,不要只输出页面名。' : '',
	            ].filter(Boolean).join('\n'),
	            displayOutput: result,
	            durationMs: Math.round(performance.now() - start),
	          }
	        } catch (err: any) {
	          return {
	            toolCallId: toolCall.id,
	            name: toolCall.name,
	            output: `生成打卡草稿失败:${err?.message ?? '参数错误'}`,
	            durationMs: Math.round(performance.now() - start),
	          }
	        }
	      }

	      case 'save_check_in_card': {
	        const parsedArgs = parseToolArgumentsForExecution(toolCall, start)
	        if (!parsedArgs.ok) return parsedArgs.result
	        return {
	          toolCallId: toolCall.id,
	          name: toolCall.name,
	          output: [
	            'save_check_in_card_refused',
	            'message=我没有权限替用户保存打卡卡片。请告知用户需要在卡片里核对后手动点击“保存打卡”。',
	            'agentInstruction=最终回答只能说明需要用户手动点击卡片里的“保存打卡”；不要说已经保存,不要生成新的重复卡片。',
	          ].join('\n'),
	          durationMs: Math.round(performance.now() - start),
	        }
	      }

	      case 'list_scheduled_tasks': {
        try {
          const tasks = await listFutureScheduledTasks(ctx.userId)
          return {
            toolCallId: toolCall.id,
            name: toolCall.name,
            output: renderFutureScheduledTasksForTool(tasks),
            displayOutput: {
              action: 'list',
              tasks,
            },
            durationMs: Math.round(performance.now() - start),
          }
        } catch (err: any) {
          return {
            toolCallId: toolCall.id,
            name: toolCall.name,
            output: `定时任务列表读取失败：${err?.message ?? '未知错误'}`,
            durationMs: Math.round(performance.now() - start),
          }
        }
      }

      case 'add_scheduled_task': {
        const parsedArgs = parseToolArgumentsForExecution(toolCall, start)
        if (!parsedArgs.ok) return parsedArgs.result
        const args = parsedArgs.value
        const task = typeof args?.task === 'string' ? args.task : ''
        const message = typeof args?.message === 'string' ? args.message : ''
        const dueAtRaw = typeof args?.time === 'string' ? args.time : ''

        try {
          // 仅校验时间/cron（不合法即时报错），不落库；真正写库在用户点确认后走 /scheduled-tasks/confirm
          const schedule = parseScheduledTimeInput({ time: dueAtRaw })
          const pendingTask: ScheduleConfirmationPendingTask = {
            action: 'add',
            targetTaskId: null,
            taskName: task,
            message,
            dueAt: schedule.dueAt.toISOString(),
            scheduleType: schedule.scheduleType,
            cronExpression: schedule.cronExpression,
            timezone: schedule.timezone,
          }
          const payload = buildScheduleConfirmationPayload(toolCall.id, pendingTask)
          log.info({ confirmationId: payload.confirmationId, action: 'add' }, 'schedule confirmation card requested')
          return {
            toolCallId: toolCall.id,
            name: toolCall.name,
            output: [
              SCHEDULE_CONFIRM_PENDING_OUTPUT,
              '可在提示用户点确认的同时,用 Markdown 链接告诉用户确认后可点击 [提醒](/scheduled-tasks) 查看和管理提醒;必须保留可点击的链接格式,不要只输出页面名。',
            ].join('\n'),
            scheduleConfirmations: [payload],
            durationMs: Math.round(performance.now() - start),
          }
        } catch (err: any) {
          return {
            toolCallId: toolCall.id,
            name: toolCall.name,
            output: `提醒设置失败：${err?.message ?? '参数不合法'}`,
            durationMs: Math.round(performance.now() - start),
          }
        }
      }

      case 'update_scheduled_task': {
        const parsedArgs = parseToolArgumentsForExecution(toolCall, start)
        if (!parsedArgs.ok) return parsedArgs.result
        const args = parsedArgs.value
        const taskId = typeof args?.id === 'number'
          ? Math.floor(args.id)
          : typeof args?.id === 'string'
            ? Math.floor(Number(args.id))
            : NaN
        const dueAtRaw = typeof args?.time === 'string' ? args.time : ''
        const isDelete = args?.status === 'deleted'
        const newTaskName = typeof args?.task === 'string' ? args.task : null
        const newMessage = typeof args?.message === 'string' ? args.message : null

        try {
          if (!Number.isFinite(taskId) || taskId < 1) throw new Error('id 必须是有效任务 ID')
          // 仅校验入参与目标任务存在性，不落库；写库在用户点确认后走 /scheduled-tasks/confirm
          const schedule = dueAtRaw ? parseScheduledTimeInput({ time: dueAtRaw }) : null
          const existing = (await listFutureScheduledTasks(ctx.userId)).find((item) => item.taskId === taskId)
          if (!existing) throw new Error(`未找到 ID ${taskId} 的未来任务`)

          // dueAt/scheduleType 仅在用户本次确实改了时间时才带上；否则保持 null（confirm 不动原排程）
          const pendingTask: ScheduleConfirmationPendingTask = {
            action: isDelete ? 'delete' : 'update',
            targetTaskId: taskId,
            // delete 用现有名展示；update 带上"要改成"的字段（taskName/message 仅在本次提供时才落库）
            taskName: isDelete ? existing.taskName : (newTaskName ?? existing.taskName),
            message: isDelete ? null : newMessage,
            dueAt: isDelete ? null : (schedule?.dueAt.toISOString() ?? null),
            scheduleType: isDelete ? null : (schedule?.scheduleType ?? null),
            cronExpression: isDelete ? null : (schedule?.cronExpression ?? null),
            timezone: isDelete ? null : (schedule?.timezone ?? null),
          }
          const payload = buildScheduleConfirmationPayload(toolCall.id, pendingTask)
          log.info({ confirmationId: payload.confirmationId, action: pendingTask.action, taskId }, 'schedule confirmation card requested')
          return {
            toolCallId: toolCall.id,
            name: toolCall.name,
            output: SCHEDULE_CONFIRM_PENDING_OUTPUT,
            scheduleConfirmations: [payload],
            durationMs: Math.round(performance.now() - start),
          }
        } catch (err: any) {
          return {
            toolCallId: toolCall.id,
            name: toolCall.name,
            output: `定时任务更新失败：${err?.message ?? '参数不合法'}`,
            durationMs: Math.round(performance.now() - start),
          }
        }
      }

      case 'read_product_guide': {
        const parsedArgs = parseToolArgumentsForExecution(toolCall, start)
        if (!parsedArgs.ok) return parsedArgs.result
        const args = parsedArgs.value && typeof parsedArgs.value === 'object'
          ? parsedArgs.value as Record<string, unknown>
          : {}
        return {
          toolCallId: toolCall.id,
          name: toolCall.name,
          output: renderCxProductGuide({
            features: getBackendFeatureSnapshot(),
            clientEnvironment: ctx.clientEnvironment,
            topic: args.topic,
          }),
          durationMs: Math.round(performance.now() - start),
        }
      }

      default:
        throw new Error(`Unknown tool: ${toolCall.name}`)
    }
  } catch (err: any) {
    if (err instanceof SearchChatHistoryUserError) {
      log.warn({ message: err.message }, 'chat history search rejected')
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        output: `错误：${err.message}`,
        durationMs: Math.round(performance.now() - start),
      }
    }
    if (err instanceof MemoryContentRejectedError) {
      log.warn({ reasons: err.reasons }, 'memory update rejected by storage safety scan')
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        output: '错误：记忆内容未保存（内容未通过长期记忆安全检查）。',
        durationMs: Math.round(performance.now() - start),
      }
    }
    log.error({ error: err.message }, 'tool execution failed')
    return {
      toolCallId: toolCall.id,
      name: toolCall.name,
      output: `工具执行失败: ${err.message}`,
      durationMs: Math.round(performance.now() - start),
    }
  }
}
