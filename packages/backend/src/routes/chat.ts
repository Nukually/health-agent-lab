import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { z } from 'zod'
import { getAgentTools, toLLMToolSchema } from '../agent/tools/index.js'
import { authMiddleware } from '../middleware/auth.js'
import { requireActiveAccount } from '../middleware/active-account.js'
import { rateLimitMiddleware } from '../middleware/rate-limit.js'
import { createSessionState, addMessage, abortSession, type ChatMessage, type SessionState } from '../state/session.js'
import { agentLoop } from '../agent/loop.js'
import { runPreCompact, runPostCompact } from '../agent/hooks/index.js'
import { assemblePromptManagementPrompt, assembleSystemPrompt } from '../agent/prompt/assembler.js'
import { saveMessage, loadSessionMessages, reuseLatestUserMessageForRetry, truncateSessionForEdit } from '../services/message.js'
import {
  attachImageAssetsToMessage,
  getModelImageBlockGroupsForAssetIds,
  replaceMessageImageAssets,
  type ModelImageBlockGroup,
} from '../services/image-asset.js'
import { createSession, getSession } from '../services/session.js'
import { getFullProfile } from '../services/user.js'
import { listDocuments } from '../services/medical-document.js'
import {
  filterAlreadyRenderedRelevantItems,
  MemoryManager,
  renderRelevantMemoryContextBlock,
  type MemoryContextSnapshot,
} from '../services/memory-manager.js'
import { scheduleMemoryReviewForTurn } from '../services/memory-reviewer.js'
import { getRecentStructuredProfiles } from '../services/structured-profile.js'
import { getCommunicationCardPromptSummary } from '../services/communication-card.js'
import { generateSessionTitle } from '../services/titleGen.js'
import { compactIfNeeded } from '../services/compact.js'
import {
  buildPromptDocIdMap,
  buildPromptCommunicationCardIdMap,
  getSessionPromptSnapshot,
  getSessionPromptSnapshotLookup,
  setSessionPromptSnapshot,
  invalidateSessionPrompt,
} from '../services/prompt-cache.js'
import { getInterventionRuntimeCatalog } from '../services/intervention-material-runtime.js'
import { listDraftCheckInCardsForPrompt } from '../services/check-in.js'
import { checkInDraftCardsContext } from '../agent/prompt/sections/check-in-context.js'
import {
  getSessionEvents,
  clearSessionEvents,
  getUserExternalEvents,
  mergeEventsForReminder,
  renderEventsReminderWithMaps,
  rejectedFieldsFromEvents,
} from '../services/session-events.js'
import {
  consumePendingInterventionEngagementReminders,
} from '../services/intervention-material-engagement.js'
import { consumeScheduledTodoReminderForTurn, listActiveTodoPlansForPrompt } from '../services/todos.js'
import {
  buildClientEnvironmentReminder,
  resolveClientEnvironment,
  type ResolvedClientEnvironment,
} from '../services/client-environment.js'
import { getEnv } from '../env.js'
import { getBackendFeatureSignature, getBackendFeatureSnapshot } from '../features.js'
import { estimateMessagesTokens } from '../utils/tokens.js'
import { getClientToolInput, sanitizeToolCallsForClient } from '../utils/tool-call-client.js'
import { attachProcessTimelineToRawResponse, hydrateProcessTimelineToolOutputs } from '../utils/process-timeline-client.js'
import { contentHasTrustedReminder } from '../utils/untrusted-user-content.js'
import {
  areLatestTwoRealUserMessagesIdentical,
  extractMessageTextContent,
  findLatestRealUserMessageIndex,
} from '../utils/repeated-user-message.js'
import {
  MAX_MESSAGE_LENGTH,
  isFeatureEnabled,
  type ChatSendSyncResponse,
  type ChatTransportModeResponse,
  type DocumentAttachedPayload,
  type MedicalDocumentSaveSuggestionPayload,
  type MedicalProfileData,
  type MessageRecord,
  type MessageProcessStep,
  type ProfileAutoUpdatedPayload,
  type ToolApprovalPayload,
  type ScheduleConfirmationPayload,
  type ToolCallRecord,
} from '@health-agent/shared'
import { getPrefixState } from '../services/prefix-tracker.js'
import { getChatTransportMode } from '../services/chat-transport.js'
import { issueWsTicket, WS_TICKET_TTL_SECONDS } from '../services/ws-ticket.js'
import {
  buildFirstActivationAssistantMessage,
  buildFirstActivationSceneReminder,
  isFirstActivationConversation,
} from '../services/first-activation.js'
import {
  getAgentRecommendedQuestionsForUser,
} from '../services/recommended-question-agent.js'
import type { Logger } from '../lib/logger.js'
import type { ToolDefinition } from '../api/types.js'
import {
  finishLangfuseAgentTrace,
  syncLangfuseSystemPrompt,
  startLangfuseAgentTrace,
  type LangfuseAgentTrace,
  type LangfusePromptRef,
} from '../observability/langfuse.js'

const chatRoutes = new Hono()

chatRoutes.use('*', authMiddleware)
chatRoutes.use('*', requireActiveAccount)

const wsTicketSchema = z.object({
  purpose: z.enum(['asr', 'tts']),
})

const chatSendSchema = z.object({
  sessionId: z.string().uuid().optional(),
  content: z.string().max(MAX_MESSAGE_LENGTH, '消息内容过长'),
  images: z.array(z.string()).optional(),
  imageAssetIds: z.array(z.string().uuid()).max(10, '最多上传10张图片').optional(),
  firstActivation: z.boolean().optional(),
  retryLatestUserMessage: z.boolean().optional(),
  // 编辑历史 user 消息：发送前丢弃从末尾往前数第 N 条真实 user 消息（含）到结尾的全部消息
  discardUserTurnsFromEnd: z.number().int().positive().optional(),
  recommendedQuestion: z.object({
    interactionId: z.string().trim().min(1).max(160),
    source: z.literal('agent'),
    question: z.string().trim().min(1).max(80),
    rank: z.number().int().positive().max(3),
    cached: z.boolean().optional(),
    generatedAt: z.string().trim().max(80).nullable().optional(),
  }).optional(),
  clientEnvironment: z.object({
    surface: z.string().max(40).nullable().optional(),
    platform: z.string().max(40).nullable().optional(),
    source: z.string().max(40).nullable().optional(),
    appVersion: z.string().max(80).nullable().optional(),
    versionCode: z.union([z.string().max(80), z.number()]).nullable().optional(),
    bridgeVersion: z.string().max(40).nullable().optional(),
    h5BuildVersion: z.string().max(80).nullable().optional(),
    uiReleaseId: z.string().max(80).nullable().optional(),
    uiVariant: z.string().max(80).nullable().optional(),
    userAgent: z.string().max(512).nullable().optional(),
  }).optional(),
}).refine(
  (data) => data.content.trim().length > 0 ||
    (data.images && data.images.length > 0) ||
    (data.imageAssetIds && data.imageAssetIds.length > 0),
  { message: '请输入消息内容或上传图片', path: ['content'] },
).refine(
  (data) => !data.retryLatestUserMessage || !!data.sessionId,
  { message: '重试当前消息需要 sessionId', path: ['sessionId'] },
).refine(
  (data) => !(data.firstActivation && data.retryLatestUserMessage),
  { message: '首次激活场景不支持编辑重试', path: ['retryLatestUserMessage'] },
).refine(
  (data) => !data.discardUserTurnsFromEnd || !!data.sessionId,
  { message: '编辑消息需要 sessionId', path: ['sessionId'] },
).refine(
  (data) => !(data.discardUserTurnsFromEnd && data.retryLatestUserMessage),
  { message: '编辑与重试不能同时进行', path: ['discardUserTurnsFromEnd'] },
).refine(
  (data) => !(data.firstActivation && data.discardUserTurnsFromEnd),
  { message: '首次激活场景不支持编辑', path: ['discardUserTurnsFromEnd'] },
)

type ChatSendInput = z.infer<typeof chatSendSchema>

// POST /api/chat/ws-ticket — short-lived one-time ticket for ASR/TTS WebSocket auth
chatRoutes.post('/ws-ticket', async (c) => {
  const logger = c.get('logger')
  const userId = c.get('userId')
  const body = await c.req.json().catch(() => ({}))
  const parsed = wsTicketSchema.safeParse(body)

  if (!parsed.success) {
    return c.json({ success: false, error: '语音鉴权类型无效' }, 400)
  }

  const ticket = await issueWsTicket(userId, parsed.data.purpose, logger)
  return c.json({
    success: true,
    data: {
      ticket,
      expiresInSec: WS_TICKET_TTL_SECONDS,
    },
  })
})

// GET /api/chat/recommended-questions — 首页推荐问题（独立推荐 Agent + Redis 缓存锁）
chatRoutes.get('/recommended-questions', async (c) => {
  const logger = c.get('logger')
  const userId = c.get('userId')
  const data = await getAgentRecommendedQuestionsForUser(userId, logger)
  return c.json({ success: true, data })
})

interface PreparedChatTurn {
  sessionId: string
  sessionState: SessionState
  userInfo: Awaited<ReturnType<typeof getFullProfile>>['user']
  profileData: MedicalProfileData | null
  profileUpdatedAt: Date | null
  memoryContext: MemoryContextSnapshot
  medicalDocs: Awaited<ReturnType<typeof listDocuments>>
  communicationCards: Awaited<ReturnType<typeof getCommunicationCardPromptSummary>>
  structuredProfileTrend: Awaited<ReturnType<typeof getRecentStructuredProfiles>>
  isNewSession: boolean
  requestReminders: string[]
  clientEnvironment: ResolvedClientEnvironment
  latestUserMessageId: string | null
  latestUserMessageContent: string
  latestUserImageCount: number
  memoryPrefetchContext: string | null
}

interface PreparedAgentRuntime {
  systemPrompt: string
  userProfileSystemPrompt: string | null
  systemCachePrefixLength?: number
  promptContextReminder: string | null
  tools: readonly ToolDefinition[]
  docIdMap: Map<string, string>
  communicationCardIdMap: Map<string, string>
  interventionCodeMap: Awaited<ReturnType<typeof getInterventionRuntimeCatalog>>['codeMap']
  sessionEvents: Awaited<ReturnType<typeof getSessionEvents>>
  eventsReminder: string
  rejectedFields: Set<string>
  promptFromCache: boolean
  promptExpired: boolean
  promptFeatureMismatch: boolean
  featureSignature: string
  memoryEnablePersist: boolean
  langfusePrompt: LangfusePromptRef | null
}

interface PersistedAssistantTurn {
  savedMessageId: string | null
  message: MessageRecord | null
  interrupted: boolean
  llmRetryCount: number
}

function schedulePostTurnMemoryReview(input: {
  prepared: PreparedChatTurn
  persisted: PersistedAssistantTurn
  hadError: boolean
  logger: Logger
}): void {
  if (input.hadError || input.persisted.interrupted || !input.persisted.message) return

  scheduleMemoryReviewForTurn({
    userId: input.prepared.sessionState.userId,
    sessionId: input.prepared.sessionId,
    userMessageId: input.prepared.latestUserMessageId,
    assistantMessageId: input.persisted.savedMessageId,
    userMessageContent: input.prepared.latestUserMessageContent,
    assistantMessageContent: input.persisted.message.content,
    imageCount: input.prepared.latestUserImageCount,
    logger: input.logger,
  })
}

function getDebugAssistantContent(message: ChatMessage): string {
  if (message.role !== 'assistant') {
    return typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
  }

  const rawAssistantContent =
    typeof message.rawResponse === 'object' &&
    message.rawResponse !== null &&
    'rawAssistantContent' in message.rawResponse &&
    typeof (message.rawResponse as { rawAssistantContent?: unknown }).rawAssistantContent === 'string'
      ? (message.rawResponse as { rawAssistantContent: string }).rawAssistantContent
      : null

  if (rawAssistantContent) return rawAssistantContent

  return typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
}

function tryParseJson<T>(data: string): T | null {
  try {
    return JSON.parse(data) as T
  } catch {
    return null
  }
}

function startChatLangfuseTrace(input: {
  route: '/api/chat/send' | '/api/chat/send-sync'
  requestId: string
  userId: string
  chatInput: ChatSendInput
  prepared: PreparedChatTurn
  runtime: PreparedAgentRuntime
}): LangfuseAgentTrace {
  return startLangfuseAgentTrace({
    name: 'cx.agent.chat',
    userId: input.userId,
    requestId: input.requestId,
    sessionId: input.prepared.sessionId,
    input: {
      content: input.chatInput.content,
      imageCount: (input.chatInput.imageAssetIds?.length ?? 0) + (input.chatInput.images?.length ?? 0),
      retryLatestUserMessage: input.chatInput.retryLatestUserMessage ?? false,
      firstActivation: input.chatInput.firstActivation ?? false,
      clientEnvironment: input.prepared.clientEnvironment,
    },
    tags: ['chat', input.route.endsWith('send-sync') ? 'sync' : 'sse', input.runtime.featureSignature],
    metadata: {
      requestId: input.requestId,
      route: input.route,
      promptFromCache: input.runtime.promptFromCache,
      promptExpired: input.runtime.promptExpired,
      promptFeatureMismatch: input.runtime.promptFeatureMismatch,
      promptLength: input.runtime.systemPrompt.length,
      featureSignature: input.runtime.featureSignature,
      toolCount: input.runtime.tools.length,
      tools: input.runtime.tools.map((tool) => tool.function.name).join(','),
      isNewSession: input.prepared.isNewSession,
      requestReminderCount: input.prepared.requestReminders.length + (input.runtime.promptContextReminder ? 1 : 0),
      promptContextReminderLength: input.runtime.promptContextReminder?.length ?? 0,
      langfusePromptName: input.runtime.langfusePrompt?.name,
      langfusePromptVersion: input.runtime.langfusePrompt?.version,
      langfusePromptHash: input.runtime.langfusePrompt?.promptHash.slice(0, 16),
    },
  })
}

function getLLMRetryCountFromRawResponse(rawResponse: unknown): number {
  if (!rawResponse || typeof rawResponse !== 'object' || Array.isArray(rawResponse)) return 0
  const retryCount = (rawResponse as { llmRetryCount?: unknown }).llmRetryCount
  if (typeof retryCount === 'number' && Number.isFinite(retryCount) && retryCount > 0) {
    return Math.floor(retryCount)
  }
  const attempts = (rawResponse as { llmRetryAttempts?: unknown }).llmRetryAttempts
  if (Array.isArray(attempts)) return attempts.length
  return 0
}

function getAbsorbedToolPlanName(rawResponse: unknown): string | null {
  if (!rawResponse || typeof rawResponse !== 'object' || Array.isArray(rawResponse)) return null
  const plan = (rawResponse as { absorbedToolPlan?: unknown }).absorbedToolPlan
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return null
  const toolName = (plan as { toolName?: unknown }).toolName
  return typeof toolName === 'string' && toolName.trim() ? toolName.trim() : null
}

function buildProcessTimelineSnapshot(
  turnMsgs: ChatMessage[],
  toolDurations: number[],
  extraSteps: MessageProcessStep[] = [],
): MessageProcessStep[] {
  const steps: MessageProcessStep[] = []
  let timestamp = 0
  let toolIdx = 0

  for (const m of turnMsgs) {
    if (m.role !== 'assistant') continue

    // 隐藏思考过程节点（thinking 协议）：作为可折叠的“已思考”气泡按时间顺序回放。
    if (m.thinking) {
      steps.push({
        type: 'thinking',
        content: m.thinking,
        isActive: false,
        timestamp: timestamp++,
      })
    }

    const raw = (m.toolCalls as Array<{
      id: string
      function: { name: string; arguments: string }
    }> | undefined) ?? []
    // 有工具调用的 assistant 轮（stop_reason=tool_calls）：
    // - 若正文里的工具名泄漏被吸收为工具规划（detector 撤回折叠），回放成 tool_plan 折叠节点；
    // - 否则其正文是工具调用前的中间叙述，作为 text 过程节点按时间顺序保留。
    // 启用 thinking 协议后，规划走隐藏 thinking，正文通常为空，text 节点自然不承载规划。
    const absorbedToolPlanName = raw.length > 0 ? getAbsorbedToolPlanName(m.rawResponse) : null
    if (absorbedToolPlanName) {
      steps.push({
        type: 'tool_plan',
        content: '',
        toolName: absorbedToolPlanName,
        isActive: false,
        timestamp: timestamp++,
      })
    } else if (raw.length > 0) {
      const narration = stringContent(m.content)
      if (narration.trim()) {
        steps.push({
          type: 'text',
          content: narration,
          timestamp: timestamp++,
        })
      }
    }
    for (const tc of raw) {
      let input: unknown = null
      try { input = JSON.parse(tc.function.arguments) } catch { /* keep null */ }
      steps.push({
        type: 'tool_call',
        toolCallId: tc.id,
        name: tc.function.name,
        input: getClientToolInput(tc.function.name, input),
        durationMs: toolDurations[toolIdx],
        isActive: false,
        timestamp: timestamp++,
      })
      toolIdx++
    }
  }

  for (const step of extraSteps) {
    if (step.type === 'protocol_recovery' || step.type === 'doc_view') {
      steps.push({
        ...step,
        isActive: false,
        timestamp: timestamp++,
      })
    }
  }

  return steps
}

function stringContent(content: ChatMessage['content']): string {
  return typeof content === 'string' ? content : JSON.stringify(content) ?? ''
}

function attachProcessTimelineAndReplayContent(
  rawResponse: unknown,
  processTimeline: MessageProcessStep[],
  finalAssistantContent: string,
): unknown {
  const base = attachProcessTimelineToRawResponse(rawResponse, processTimeline)
  return {
    ...(base && typeof base === 'object' && !Array.isArray(base) ? base as Record<string, unknown> : {}),
    finalAssistantContent,
  }
}

function buildProtocolRecoveryStep(data: string): MessageProcessStep | null {
  const payload = tryParseJson<{ reason?: string; retryAttempt?: number }>(data)
  if (!payload?.reason) return null
  if (payload.reason === 'xml_tool_call_in_answer') return null
  return {
    type: 'protocol_recovery',
    reason: payload.reason,
    retryAttempt: payload.retryAttempt,
    isActive: false,
    timestamp: 0,
  }
}

function buildUserMessage(
  content: string,
  images?: string[],
  imageAssetIds?: string[],
  imageBlocks?: Array<{ type: 'image_url'; image_url: { url: string; detail: 'high' } }>,
  imageBlockGroups?: ModelImageBlockGroup[],
): ChatMessage {
  const allImageBlocks = [
    ...(imageBlocks ?? []),
    ...(imageBlocks?.length ? [] : (images ?? []).map((url) => ({ type: 'image_url' as const, image_url: { url } }))),
  ]

  if (!allImageBlocks.length) {
    return { role: 'user', content, untrustedInput: true }
  }

  return {
    role: 'user',
    content: [
      ...(content ? [{ type: 'text' as const, text: content }] : []),
      ...allImageBlocks,
    ],
    imageAssetIds,
    imageBlockGroups,
    untrustedInput: true,
  }
}

function sessionHasTrustedReminder(sessionState: SessionState): boolean {
  return sessionState.messages.some((message) =>
    message.role === 'user' && contentHasTrustedReminder(message.content),
  )
}

function buildAgentRequestReminders(
  prepared: PreparedChatTurn,
  runtime: PreparedAgentRuntime,
): string[] {
  return [
    runtime.promptContextReminder,
    ...prepared.requestReminders,
  ].filter((reminder): reminder is string => typeof reminder === 'string' && reminder.length > 0)
}

function buildRepeatedUserMessageReminder(): string {
  return `[conversation-pattern:repeated_user_message]
用户连续两次发送了完全相同的消息。这通常可能表示用户对上一轮回复不满意、没有获得想要的信息，或希望你换一种方式处理。
本轮不要机械重复上一轮的正文、开头或同一张工具卡片；请给出与上一轮明显不同的回答角度、结构或重点。
在不编造医学事实的前提下，先回应用户的原问题，再主动询问用户是否对前面的回答很不满意、是否希望你换一种方式说明或处理。`
}

async function prepareChatTurn(
  userId: string,
  input: ChatSendInput,
  logger: Logger,
  options: { userAgent?: string | null } = {},
): Promise<PreparedChatTurn> {
  const { content, images = [], imageAssetIds, firstActivation, retryLatestUserMessage, discardUserTurnsFromEnd } = input
  let latestUserMessageId: string | null = null
  let { sessionId } = input
  const clientEnvironment = resolveClientEnvironment({
    hint: input.clientEnvironment,
    userAgent: options.userAgent,
  })

  let existingSummary: string | null = null
  let isNewSession = false
  let shouldGenerateTitleFromUserMessage = false
  if (!sessionId) {
    const session = await createSession(userId, undefined, logger)
    sessionId = session.id
    isNewSession = true
    shouldGenerateTitleFromUserMessage = true
  } else {
    const existing = await getSession(sessionId, logger)
    if (!existing || existing.userId !== userId) {
      throw Object.assign(new Error('会话不存在'), { status: 404 })
    }
    existingSummary = existing.summary ?? null
    isNewSession = existing.messageCount === 0
    shouldGenerateTitleFromUserMessage = isNewSession
  }

  const imageBlockGroups = imageAssetIds?.length
    ? await getModelImageBlockGroupsForAssetIds(userId, imageAssetIds)
    : []
  const imageBlocks = imageBlockGroups.flatMap((group) => group.imageBlocks)
  const userMessage = buildUserMessage(content, images, imageAssetIds, imageBlocks, imageBlockGroups)

  if (retryLatestUserMessage) {
    const targetMessageId = await reuseLatestUserMessageForRetry(sessionId, userMessage, logger)
    if (imageAssetIds) {
      await replaceMessageImageAssets(userId, targetMessageId, imageAssetIds)
    }
  } else if (discardUserTurnsFromEnd) {
    // 编辑历史 user 消息：先丢弃该轮及其之后的全部消息，再走下方普通分支追加新 user 消息
    const { summaryReset } = await truncateSessionForEdit(sessionId, discardUserTurnsFromEnd, logger)
    if (summaryReset) existingSummary = null
  }

  const existingMessages = await loadSessionMessages(sessionId, logger)
  if (retryLatestUserMessage) {
    isNewSession = existingMessages.length <= 1
  }
  const isFirstActivationConversationSession = isFirstActivationConversation(existingMessages)
  const shouldInjectFirstActivation = firstActivation === true && existingMessages.length === 0
  const sessionMessages = isFirstActivationConversationSession
    ? [buildFirstActivationAssistantMessage(), ...existingMessages]
    : existingMessages
  if (retryLatestUserMessage) {
    const latestUserIdx = findLatestRealUserMessageIndex(sessionMessages)
    if (latestUserIdx >= 0) {
      sessionMessages[latestUserIdx].untrustedInput = true
      latestUserMessageId = sessionMessages[latestUserIdx].dbId ?? null
    }
  }
  const shouldInjectRepeatedUserMessageReminder =
    !retryLatestUserMessage &&
    areLatestTwoRealUserMessagesIdentical([...sessionMessages, userMessage])

  const memoryManager = new MemoryManager(logger)
  const features = getBackendFeatureSnapshot()
  const [
    { user: userInfo, medical },
    memoryContext,
    medicalDocs,
    communicationCards,
    structuredProfileTrend,
    engagementReminders,
    checkInDraftCards,
  ] = await Promise.all([
    getFullProfile(userId, logger),
    memoryManager.loadContext(userId, { query: content }),
    listDocuments(userId, logger),
    getCommunicationCardPromptSummary(userId, logger),
    getRecentStructuredProfiles(userId, 7),
    consumePendingInterventionEngagementReminders(userId, sessionId, logger),
    isFeatureEnabled(features, 'checkInRecords') ? listDraftCheckInCardsForPrompt(userId, sessionId) : Promise.resolve([]),
  ])
  const checkInDraftCardsReminder = checkInDraftCardsContext(checkInDraftCards)

  const existingTokens = estimateMessagesTokens(sessionMessages)
  const sessionState = createSessionState({
    sessionId,
    userId,
    logger,
    existingMessages: sessionMessages,
    tokenCount: existingTokens,
    summary: existingSummary,
  })
  if (shouldInjectFirstActivation) {
    addMessage(sessionState, buildFirstActivationAssistantMessage())
  }

  if (!retryLatestUserMessage) {
    addMessage(sessionState, userMessage)

    const userMessageDbId = await saveMessage(sessionId, userMessage, logger)
    userMessage.dbId = userMessageDbId
    latestUserMessageId = userMessageDbId
    if (imageAssetIds?.length) {
      await attachImageAssetsToMessage(userId, userMessageDbId, imageAssetIds)
    }

    if (shouldGenerateTitleFromUserMessage) {
      generateSessionTitle(content || '[图片咨询]', sessionId, logger).catch(() => {})
    }
  }

  const priorUserContextText = sessionMessages
    .filter((message) => message.role === 'user')
    .map((message) => extractMessageTextContent(message.content))
    .join('\n')
  const relevantItemsForReminder = filterAlreadyRenderedRelevantItems(
    memoryContext.relevantItems,
    priorUserContextText,
  )
  const memoryPrefetchContext = renderRelevantMemoryContextBlock(relevantItemsForReminder)
  const scheduledTodoReminder = await consumeScheduledTodoReminderForTurn({
    userId,
    sessionId,
    latestUserMessageId,
    latestUserMessageContent: content.trim(),
  }, logger)
  const activeTodoPlansReminder = await listActiveTodoPlansForPrompt(userId)

  return {
    sessionId,
    sessionState,
    userInfo,
    profileData: medical?.profileData || null,
    profileUpdatedAt: medical?.updatedAt ?? null,
    memoryContext,
    medicalDocs,
    communicationCards,
    structuredProfileTrend,
    isNewSession,
    clientEnvironment,
    latestUserMessageId,
    latestUserMessageContent: content.trim(),
    latestUserImageCount: images.length,
    memoryPrefetchContext,
    requestReminders: [
      buildClientEnvironmentReminder(clientEnvironment),
      ...(shouldInjectFirstActivation
        ? [
            buildFirstActivationSceneReminder({
              currentConcern: userInfo?.currentConcern ?? null,
              gender: userInfo?.gender ?? null,
              profileData: medical?.profileData || null,
            }),
          ]
        : []),
      ...engagementReminders,
      ...(checkInDraftCardsReminder ? [checkInDraftCardsReminder] : []),
      ...(scheduledTodoReminder ? [scheduledTodoReminder] : []),
      ...(activeTodoPlansReminder ? [activeTodoPlansReminder] : []),
      ...(shouldInjectRepeatedUserMessageReminder
        ? [buildRepeatedUserMessageReminder()]
        : []),
    ],
  }
}

async function prepareAgentRuntime(
  prepared: PreparedChatTurn,
  logger: Logger,
  opts: {
    onCompactionStart?: () => Promise<void>
    onCompactionEnd?: (data: { messagesCompacted: number; messagesRetained: number }) => Promise<void>
  } = {},
): Promise<PreparedAgentRuntime> {
  const {
    sessionId,
    sessionState,
    userInfo,
    profileData,
    profileUpdatedAt,
    medicalDocs,
    communicationCards,
    memoryContext,
    structuredProfileTrend,
    isNewSession,
  } = prepared

  const features = getBackendFeatureSnapshot()
  const activeTools = getAgentTools(features)
  const activeFeatureSignature = getBackendFeatureSignature()
  const promptLookup = await getSessionPromptSnapshotLookup(sessionId, logger, {
    featureSignature: activeFeatureSignature,
  })
  let promptSnapshot = promptLookup.snapshot
  let promptFromCache = promptSnapshot !== null
  let promptExpired = promptLookup.expired
  let promptFeatureMismatch = !!promptLookup.featureMismatch

  try {
    const probeLen = promptSnapshot?.prompt.length ?? 4000
    const compactionResult = await compactIfNeeded(sessionState, probeLen, logger, async () => {
      await runPreCompact({ session: sessionState, logger, reason: 'proactive' })
      await opts.onCompactionStart?.()
    })

    if (compactionResult.performed) {
      sessionState.prefixChangeExpected = 'proactive'
      await runPostCompact({
        session: sessionState,
        logger,
        reason: 'proactive',
        messagesCompacted: compactionResult.messagesCompacted ?? 0,
        messagesRetained: compactionResult.messagesRetained ?? 0,
      })
      await opts.onCompactionEnd?.({
        messagesCompacted: compactionResult.messagesCompacted ?? 0,
        messagesRetained: compactionResult.messagesRetained ?? 0,
      })
      await invalidateSessionPrompt(sessionId, logger)
      await clearSessionEvents(sessionId, logger)
      promptSnapshot = null
      promptFromCache = false
      promptExpired = false
      promptFeatureMismatch = false
      logger.info(
        {
          messagesCompacted: compactionResult.messagesCompacted,
          messagesRetained: compactionResult.messagesRetained,
        },
        'context compacted, prompt cache invalidated',
      )
    }
  } catch (err: any) {
    logger.error({ error: err.message }, 'compaction failed, proceeding with full context')
    await opts.onCompactionEnd?.({ messagesCompacted: 0, messagesRetained: 0 })
  }

  let systemPrompt: string
  let docIdMap: Map<string, string>
  let communicationCardIdMap: Map<string, string>
  let interventionCodeMap: PreparedAgentRuntime['interventionCodeMap']
  let langfusePrompt: LangfusePromptRef | null = promptSnapshot?.promptManagementPrompt
    ? promptSnapshot.langfusePrompt ?? null
    : null
  let promptContextReminder: string | null = null
  let promptJustAssembled = false

  if (!promptSnapshot) {
    const hasTrustedReminder = sessionHasTrustedReminder(sessionState)
    const interventionCatalog = await getInterventionRuntimeCatalog(logger)
    const assembled = assembleSystemPrompt({
      userInfo,
      profileData,
      profileUpdatedAt,
      medicalDocs,
      communicationCards,
      checkInSchemas: null,
      savedInterventionMaterials: null,
      interventionCatalog,
      recentSessions: null,
      profileMemory: memoryContext.profileMemory,
      todayMemory: memoryContext.todayMemory,
      structuredProfileTrend,
      summary: sessionState.summary,
      features,
      logger,
    })
    promptJustAssembled = true
    promptContextReminder = hasTrustedReminder ? null : assembled.dynamicPromptReminder || null
    const snapshotCreatedAt = Date.now()
    langfusePrompt = await syncLangfuseSystemPrompt({
      prompt: assembled.promptManagementPrompt,
      logger,
      featureSignature: activeFeatureSignature,
      promptFromCache: false,
      metadata: {
        sessionId,
        createdAt: snapshotCreatedAt,
        interventionCatalogGroupCount: interventionCatalog.groups.length,
      },
    })
    const snapshot = {
      prompt: assembled.prompt,
      userProfileSystemPrompt: assembled.userProfileSystemPrompt,
      promptManagementPrompt: assembled.promptManagementPrompt,
      createdAt: snapshotCreatedAt,
      staticPrefixLength: assembled.staticPrefixLength,
      dynamicPromptReminder: assembled.dynamicPromptReminder,
      docIds: Array.from(assembled.docIdMap.values()),
      cardIds: Array.from(assembled.communicationCardIdMap.values()),
      interventionCatalogGroups: interventionCatalog.groups,
      featureSignature: activeFeatureSignature,
      langfusePrompt,
    }
    await setSessionPromptSnapshot(
      sessionId,
      snapshot,
      logger,
    )
    promptSnapshot = {
      ...snapshot,
      interventionCodeMap: interventionCatalog.codeMap,
    }
    if ((promptExpired || promptFeatureMismatch) && !sessionState.prefixChangeExpected) {
      sessionState.prefixChangeExpected = 'prompt_expired'
    }
  }

  if (promptSnapshot) {
    systemPrompt = promptSnapshot.prompt
    docIdMap = buildPromptDocIdMap(promptSnapshot.docIds)
    communicationCardIdMap = buildPromptCommunicationCardIdMap(promptSnapshot.cardIds)
    interventionCodeMap = promptSnapshot.interventionCodeMap
    if (!langfusePrompt) {
      const promptManagementPrompt = promptSnapshot.promptManagementPrompt ?? assemblePromptManagementPrompt({
        interventionCatalog: {
          targetEnv: 'dev',
          version: 'prompt-snapshot',
          groups: promptSnapshot.interventionCatalogGroups,
          codeMap: promptSnapshot.interventionCodeMap,
        },
        features,
      })
      langfusePrompt = await syncLangfuseSystemPrompt({
        prompt: promptManagementPrompt,
        logger,
        featureSignature: activeFeatureSignature,
        promptFromCache,
        metadata: { sessionId, promptSnapshotCreatedAt: promptSnapshot.createdAt },
      })
      if (!promptSnapshot.promptManagementPrompt) {
        await setSessionPromptSnapshot(sessionId, {
          prompt: promptSnapshot.prompt,
          promptManagementPrompt,
          createdAt: promptSnapshot.createdAt,
          docIds: promptSnapshot.docIds,
          cardIds: promptSnapshot.cardIds,
          interventionCatalogGroups: promptSnapshot.interventionCatalogGroups,
          featureSignature: promptSnapshot.featureSignature,
          langfusePrompt,
          staticPrefixLength: promptSnapshot.staticPrefixLength,
          dynamicPromptReminder: promptSnapshot.dynamicPromptReminder ?? '',
          userProfileSystemPrompt: promptSnapshot.userProfileSystemPrompt ?? null,
        }, logger)
        promptSnapshot = {
          ...promptSnapshot,
          promptManagementPrompt,
          langfusePrompt,
        }
      }
    }
    if (
      !promptJustAssembled &&
      !sessionHasTrustedReminder(sessionState) &&
      promptSnapshot.dynamicPromptReminder
    ) {
      promptContextReminder = promptSnapshot.dynamicPromptReminder
    }
  } else {
    throw new Error('prompt snapshot unavailable after assembly')
  }
  logger.info({
    promptFromCache,
    promptLength: systemPrompt.length,
    userProfileSystemPromptLength: promptSnapshot.userProfileSystemPrompt?.length ?? 0,
    promptContextReminderLength: promptContextReminder?.length ?? 0,
    featureSignature: activeFeatureSignature,
    toolCount: activeTools.length,
  }, 'system prompt prepared')

  const sessionEvents = await getSessionEvents(sessionId, logger)
  const userExternalEvents = await getUserExternalEvents(sessionState.userId, logger)
  const eventsForReminder = mergeEventsForReminder(
    sessionEvents,
    userExternalEvents,
    promptSnapshot.createdAt,
  )
  const renderedEvents = renderEventsReminderWithMaps(eventsForReminder, {
    docIdMap,
    communicationCardIdMap,
  })
  return {
    systemPrompt,
    userProfileSystemPrompt: promptSnapshot.userProfileSystemPrompt ?? null,
    systemCachePrefixLength: promptSnapshot.staticPrefixLength,
    promptContextReminder,
    tools: activeTools,
    docIdMap: renderedEvents.docIdMap,
    communicationCardIdMap: renderedEvents.communicationCardIdMap,
    interventionCodeMap,
    sessionEvents,
    eventsReminder: renderedEvents.text,
    rejectedFields: rejectedFieldsFromEvents(sessionEvents),
    promptFromCache,
    promptExpired,
    promptFeatureMismatch,
    featureSignature: activeFeatureSignature,
    memoryEnablePersist: isFeatureEnabled(features, 'MEMORY_ENABLE_PERSIST'),
    langfusePrompt,
  }
}

async function persistAssistantTurn(
  sessionId: string,
  sessionState: SessionState,
  startMsgIdx: number,
  toolDurations: number[],
  firstProcessTs: number | null,
  answerStartTs: number | null,
  logger: Logger,
  opts: { hadError?: boolean; extraProcessSteps?: MessageProcessStep[] } = {},
): Promise<PersistedAssistantTurn> {
  const interrupted = sessionState.abortController.signal.aborted
  const turnMsgs = sessionState.messages.slice(startMsgIdx)
  const lastAssistant = [...turnMsgs].reverse().find((m) => m.role === 'assistant')
  if (!lastAssistant) {
    return {
      savedMessageId: null,
      message: null,
      interrupted,
      llmRetryCount: 0,
    }
  }

  const lastAssistantContent = stringContent(lastAssistant.content)
  // 最终回答只来自无工具调用的收尾 assistant 轮（stop_reason=stop）；有工具调用轮的正文
  // 是中间叙述，已作为 text 过程节点进入 timeline，不计入正文，避免堆到底部当成最终答案。
  const displayContent = turnMsgs
    .filter((m) => m.role === 'assistant' && !((m.toolCalls as unknown[] | undefined)?.length))
    .map((m) => stringContent(m.content))
    .join('')
  if (opts.hadError && !interrupted && lastAssistantContent.trim().length === 0) {
    logger.warn(
      { sessionId },
      'skipping persistence of tool-only assistant message after failed turn',
    )
    return {
      savedMessageId: null,
      message: null,
      interrupted,
      llmRetryCount: 0,
    }
  }

  const toolResultById = new Map<string, { llmOutput: string; displayOutput?: unknown }>()
  for (const m of turnMsgs) {
    if (m.role === 'tool' && m.toolCallId) {
      const llmOutput = typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
      toolResultById.set(m.toolCallId, {
        llmOutput,
        displayOutput: m.displayOutput,
      })
    }
  }

  const normalizedToolCalls: ToolCallRecord[] = []
  let toolIdx = 0
  let llmInputTokens = 0
  let llmCachedInputTokens = 0
  let llmCacheCreationInputTokens = 0
  let assistantStepIndex = 0

  for (const m of turnMsgs) {
    if (m.role !== 'assistant') continue
    llmInputTokens += m.llmInputTokens ?? 0
    llmCachedInputTokens += m.llmCachedInputTokens ?? 0
    llmCacheCreationInputTokens += m.llmCacheCreationInputTokens ?? 0
    const assistantToolCallContent =
      typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
    const raw = (m.toolCalls as Array<{
      id: string
      function: { name: string; arguments: string }
    }> | undefined) ?? []
    const keptNative: typeof raw = []
    const currentAssistantStepIndex = raw.length > 0 ? assistantStepIndex++ : null

    for (const tc of raw) {
      const toolResult = toolResultById.get(tc.id)
      if (interrupted && toolResult === undefined) {
        toolIdx++
        continue
      }
      let input: unknown = null
      try { input = JSON.parse(tc.function.arguments) } catch { /* keep null */ }
      normalizedToolCalls.push({
        toolCallId: tc.id,
        name: tc.function.name,
        input,
        rawArguments: tc.function.arguments,
        assistantToolCallContent,
        assistantStepIndex: currentAssistantStepIndex ?? undefined,
        llmOutput: toolResult?.llmOutput ?? '',
        output: toolResult?.displayOutput ?? toolResult?.llmOutput ?? '',
        durationMs: toolDurations[toolIdx],
      })
      keptNative.push(tc)
      toolIdx++
    }

    if (interrupted) {
      ;(m as ChatMessage).toolCalls = keptNative.length ? keptNative : undefined
    }
  }

  const rawProcessTimeline = buildProcessTimelineSnapshot(
    turnMsgs,
    toolDurations,
    opts.extraProcessSteps,
  )
  const clientToolCalls = sanitizeToolCallsForClient(normalizedToolCalls)
  const processTimeline = hydrateProcessTimelineToolOutputs(rawProcessTimeline, clientToolCalls) ?? rawProcessTimeline

  const persisted: ChatMessage = {
    ...lastAssistant,
    content: displayContent,
    toolCalls: normalizedToolCalls.length
      ? (normalizedToolCalls as unknown as ChatMessage['toolCalls'])
      : undefined,
    rawResponse: attachProcessTimelineAndReplayContent(
      lastAssistant.rawResponse,
      processTimeline,
      lastAssistantContent,
    ),
    llmInputTokens: llmInputTokens || undefined,
    llmCachedInputTokens: llmCachedInputTokens || undefined,
    llmCacheCreationInputTokens: llmCacheCreationInputTokens || undefined,
    interrupted: interrupted || undefined,
    outputTps: lastAssistant.outputTps,
  }
  if (firstProcessTs && answerStartTs && answerStartTs > firstProcessTs) {
    persisted.processDurationMs = answerStartTs - firstProcessTs
  }
  const llmRetryCount = getLLMRetryCountFromRawResponse(persisted.rawResponse)

  let savedMessageId: string
  try {
    savedMessageId = await saveMessage(sessionId, persisted, logger)
  } catch (err) {
    logger.error(
      { err, sessionId, contentLength: displayContent.length },
      'assistant message persist failed',
    )
    throw err
  }

  return {
    savedMessageId,
    interrupted,
    llmRetryCount,
    message: {
      id: savedMessageId,
      role: 'assistant',
      content: displayContent,
      thinking: persisted.thinking ?? null,
      toolCalls: clientToolCalls,
      processTimeline,
      processDurationMs: persisted.processDurationMs,
      outputTps: persisted.outputTps,
      interrupted: interrupted || undefined,
      createdAt: new Date().toISOString(),
    },
  }
}

chatRoutes.get('/transport-mode', async (c) => {
  const logger = c.get('logger')
  const userId = c.get('userId')
  const { mode, uaBucket } = await getChatTransportMode(userId, c.req.header('user-agent') || null)
  logger.info(
    {
      userId,
      uaBucket,
      mode,
      matchedFallback: mode === 'sync',
    },
    'chat transport mode resolved',
  )
  const data: ChatTransportModeResponse = { mode, uaBucket }
  return c.json({ success: true, data })
})

// POST /api/chat/send → SSE stream
chatRoutes.post(
  '/send',
  rateLimitMiddleware({
    windowMs: 1_000,
    max: 1,
    keyPrefix: 'rl:chat',
    keyExtractor: (c) => c.get('userId'),
  }),
  async (c) => {
    const logger = c.get('logger')
    const userId = c.get('userId')
    const reqStartTs = Date.now()

    const body = await c.req.json()
    const parsed = chatSendSchema.safeParse(body)
    if (!parsed.success) {
      return c.json({ success: false, error: parsed.error.issues[0].message }, 400)
    }

    let prepared: PreparedChatTurn
    try {
      prepared = await prepareChatTurn(userId, parsed.data, logger, {
        userAgent: c.req.header('user-agent') || null,
      })
    } catch (err: any) {
      if (err?.status === 404 || err?.status === 409) {
        return c.json({ success: false, error: err.message }, err.status)
      }
      throw err
    }

    const { sessionId, sessionState, userInfo, profileData } = prepared

    let firstProcessTs: number | null = null
    let answerStartTs: number | null = null
    let firstAnswerTextTs: number | null = null

    let resolveDone!: () => void
    const streamDone = new Promise<void>((r) => { resolveDone = r })
    c.set('streamDone', streamDone)

    return streamSSE(c, async (stream) => {
      const onClientAbort = () => {
        logger.info({ sessionId }, 'client aborted request, cancelling agent loop')
        abortSession(sessionState)
      }
      let outputTps: number | null = null
      let llmRetryCount: number | null = null
      let langfuseTrace: LangfuseAgentTrace | undefined
      let langfuseTraceFinished = false
      const finishTrace = (payload: Parameters<typeof finishLangfuseAgentTrace>[1]) => {
        if (langfuseTraceFinished) return
        langfuseTraceFinished = true
        finishLangfuseAgentTrace(langfuseTrace, payload)
      }

      try {
        c.req.raw.signal.addEventListener('abort', onClientAbort)
        stream.onAbort(() => abortSession(sessionState))

        await stream.writeSSE({ event: 'session', data: JSON.stringify({ sessionId }) })

        const runtime = await prepareAgentRuntime(prepared, logger, {
          onCompactionStart: async () => {
            await stream.writeSSE({ event: 'compaction_start', data: '{}' })
          },
          onCompactionEnd: async (data) => {
            await stream.writeSSE({ event: 'compaction_end', data: JSON.stringify(data) })
          },
        })
        langfuseTrace = startChatLangfuseTrace({
          route: '/api/chat/send',
          requestId: c.get('requestId'),
          userId,
          chatInput: parsed.data,
          prepared,
          runtime,
        })

        const gen = agentLoop({
          session: sessionState,
          userInfo,
          profileData,
          systemPrompt: runtime.systemPrompt,
          userProfileSystemPrompt: runtime.userProfileSystemPrompt,
          systemCachePrefixLength: runtime.systemCachePrefixLength,
          tools: runtime.tools,
          docIdMap: runtime.docIdMap,
          communicationCardIdMap: runtime.communicationCardIdMap,
          interventionCodeMap: runtime.interventionCodeMap,
          sessionEvents: runtime.sessionEvents,
          requestReminders: buildAgentRequestReminders(prepared, runtime),
          memoryPrefetchContext: prepared.memoryPrefetchContext,
          memoryEnablePersist: runtime.memoryEnablePersist,
          clientEnvironment: prepared.clientEnvironment,
          eventsReminder: runtime.eventsReminder,
          rejectedFields: runtime.rejectedFields,
          trackingContext: c.get('trackingContext'),
          langfuseTrace,
          langfusePrompt: runtime.langfusePrompt,
          logger,
        })

        let pendingMessageEnd: { type: string; data: string } | null = null
        const startMsgIdx = sessionState.messages.length
        const toolDurations: number[] = []
        const extraProcessSteps: MessageProcessStep[] = []
        let sawError = false

        for await (const event of gen) {
          if (
            firstProcessTs === null &&
            (event.type === 'thinking_start' ||
              event.type === 'tool_call_start' ||
              event.type === 'document_attached' ||
              event.type === 'assistant_output_retracted')
          ) {
            firstProcessTs = Date.now()
          }

          if (event.type === 'document_attached') {
            const payload = tryParseJson<DocumentAttachedPayload>(event.data)
            if (payload) {
              extraProcessSteps.push({
                type: 'doc_view',
                titles: payload.titles,
                count: payload.titles.length,
                isActive: false,
                timestamp: 0,
              })
            }
          } else if (event.type === 'answer_start') {
            answerStartTs = Date.now()
          } else if (
            event.type === 'text_delta' &&
            answerStartTs !== null &&
            firstAnswerTextTs === null
          ) {
            firstAnswerTextTs = Date.now()
          } else if (event.type === 'assistant_output_retracted') {
            const step = buildProtocolRecoveryStep(event.data)
            if (step) {
              extraProcessSteps.push(step)
            }
            answerStartTs = null
            firstAnswerTextTs = null
          } else if (event.type === 'tool_call_end') {
            const parsedToolEnd = tryParseJson<{ durationMs?: number }>(event.data)
            if (typeof parsedToolEnd?.durationMs === 'number') {
              toolDurations.push(parsedToolEnd.durationMs)
            }
          }

          if (event.type === 'message_end') {
            pendingMessageEnd = event
            continue
          }
          if (event.type === 'error') {
            sawError = true
          }
          await stream.writeSSE({ event: event.type, data: event.data })
        }

        const persisted = await persistAssistantTurn(
          sessionId,
          sessionState,
          startMsgIdx,
          toolDurations,
          firstProcessTs,
          answerStartTs,
          logger,
          { hadError: sawError, extraProcessSteps },
        )
        outputTps = persisted.message?.outputTps ?? null
        llmRetryCount = sessionState.llmRetryCount ?? persisted.llmRetryCount
        finishTrace({
          output: persisted.message
            ? {
                messageId: persisted.savedMessageId,
                content: persisted.message.content,
                interrupted: persisted.interrupted,
              }
            : { interrupted: persisted.interrupted },
          metadata: {
            sawError,
            outputTps,
            llmRetryCount,
            messageSaved: Boolean(persisted.savedMessageId),
          },
          error: sawError ? new Error('chat stream emitted error event') : undefined,
        })
        schedulePostTurnMemoryReview({
          prepared,
          persisted,
          hadError: sawError,
          logger,
        })

        if (pendingMessageEnd && persisted.savedMessageId) {
          let data = pendingMessageEnd.data
          try {
            const parsedMessageEnd = JSON.parse(pendingMessageEnd.data)
            parsedMessageEnd.messageId = persisted.savedMessageId
            if (persisted.interrupted) parsedMessageEnd.interrupted = true
            if (outputTps !== null) parsedMessageEnd.outputTps = outputTps
            data = JSON.stringify(parsedMessageEnd)
          } catch {
            // keep original data on parse failure
          }
          await stream.writeSSE({ event: pendingMessageEnd.type, data })
        } else if (persisted.interrupted && persisted.savedMessageId) {
          await stream.writeSSE({
            event: 'message_end',
            data: JSON.stringify({ messageId: persisted.savedMessageId, interrupted: true }),
          })
        }
      } catch (err) {
        logger.error(
          { err, sessionId, phase: 'sse-stream' },
          'SSE stream aborted with exception',
        )
        finishTrace({
          metadata: {
            phase: 'sse-stream',
            outputTps,
            llmRetryCount,
          },
          error: err,
        })
        throw err
      } finally {
        c.req.raw.signal.removeEventListener('abort', onClientAbort)
        c.set('chatMetrics', {
          sessionId,
          processTtftMs: firstProcessTs !== null ? firstProcessTs - reqStartTs : null,
          answerTtftMs: firstAnswerTextTs !== null ? firstAnswerTextTs - reqStartTs : null,
          outputTps,
          llmRetryCount,
          recommendedQuestion: parsed.data.recommendedQuestion ?? null,
        })
        resolveDone()
      }
    })
  },
)

chatRoutes.post(
  '/send-sync',
  rateLimitMiddleware({
    windowMs: 1_000,
    max: 1,
    keyPrefix: 'rl:chat',
    keyExtractor: (c) => c.get('userId'),
  }),
  async (c) => {
    const logger = c.get('logger')
    const userId = c.get('userId')
    const reqStartTs = Date.now()

    const body = await c.req.json()
    const parsed = chatSendSchema.safeParse(body)
    if (!parsed.success) {
      return c.json({ success: false, error: parsed.error.issues[0].message }, 400)
    }

    let prepared: PreparedChatTurn
    try {
      prepared = await prepareChatTurn(userId, parsed.data, logger, {
        userAgent: c.req.header('user-agent') || null,
      })
    } catch (err: any) {
      if (err?.status === 404 || err?.status === 409) {
        return c.json({ success: false, error: err.message }, err.status)
      }
      throw err
    }

    const { sessionId, sessionState, userInfo, profileData } = prepared

    let firstProcessTs: number | null = null
    let answerStartTs: number | null = null
    let firstAnswerTextTs: number | null = null
    const approvals: ToolApprovalPayload[] = []
    const scheduleConfirmations: ScheduleConfirmationPayload[] = []
    const profileNotices: ProfileAutoUpdatedPayload[] = []
    const medicalDocumentSaveSuggestions: MedicalDocumentSaveSuggestionPayload[] = []
    const documentAttachments: DocumentAttachedPayload[] = []
    let pendingError: { message?: string; code?: string } | null = null
    const toolDurations: number[] = []
    const extraProcessSteps: MessageProcessStep[] = []
    let outputTps: number | null = null
    let llmRetryCount: number | null = null
    let langfuseTrace: LangfuseAgentTrace | undefined
    let langfuseTraceFinished = false
    const finishTrace = (payload: Parameters<typeof finishLangfuseAgentTrace>[1]) => {
      if (langfuseTraceFinished) return
      langfuseTraceFinished = true
      finishLangfuseAgentTrace(langfuseTrace, payload)
    }
    const startMsgIdx = sessionState.messages.length
    const onClientAbort = () => {
      logger.info({ sessionId }, 'client aborted sync request, cancelling agent loop')
      abortSession(sessionState)
    }

    try {
      c.req.raw.signal.addEventListener('abort', onClientAbort)

      const runtime = await prepareAgentRuntime(prepared, logger)
      langfuseTrace = startChatLangfuseTrace({
        route: '/api/chat/send-sync',
        requestId: c.get('requestId'),
        userId,
        chatInput: parsed.data,
        prepared,
        runtime,
      })
      const gen = agentLoop({
        session: sessionState,
        userInfo,
        profileData,
        systemPrompt: runtime.systemPrompt,
        userProfileSystemPrompt: runtime.userProfileSystemPrompt,
        systemCachePrefixLength: runtime.systemCachePrefixLength,
        tools: runtime.tools,
        docIdMap: runtime.docIdMap,
        communicationCardIdMap: runtime.communicationCardIdMap,
        interventionCodeMap: runtime.interventionCodeMap,
        sessionEvents: runtime.sessionEvents,
        requestReminders: buildAgentRequestReminders(prepared, runtime),
        memoryPrefetchContext: prepared.memoryPrefetchContext,
        memoryEnablePersist: runtime.memoryEnablePersist,
        clientEnvironment: prepared.clientEnvironment,
        eventsReminder: runtime.eventsReminder,
        rejectedFields: runtime.rejectedFields,
        trackingContext: c.get('trackingContext'),
        langfuseTrace,
        langfusePrompt: runtime.langfusePrompt,
        logger,
      })

      for await (const event of gen) {
        if (
          firstProcessTs === null &&
          (event.type === 'thinking_start' ||
            event.type === 'tool_call_start' ||
            event.type === 'document_attached' ||
            event.type === 'assistant_output_retracted')
        ) {
          firstProcessTs = Date.now()
        }
        if (event.type === 'answer_start') {
          answerStartTs = Date.now()
          continue
        }
        if (
          event.type === 'text_delta' &&
          answerStartTs !== null &&
          firstAnswerTextTs === null
        ) {
          firstAnswerTextTs = Date.now()
        }
        if (event.type === 'assistant_output_retracted') {
          const step = buildProtocolRecoveryStep(event.data)
          if (step) {
            extraProcessSteps.push(step)
          }
          answerStartTs = null
          firstAnswerTextTs = null
          continue
        }
        if (event.type === 'tool_call_end') {
          const parsedToolEnd = tryParseJson<{ durationMs?: number }>(event.data)
          if (typeof parsedToolEnd?.durationMs === 'number') {
            toolDurations.push(parsedToolEnd.durationMs)
          }
          continue
        }
        if (event.type === 'tool_approval_required') {
          const payload = tryParseJson<ToolApprovalPayload>(event.data)
          if (payload) approvals.push(payload)
          continue
        }
        if (event.type === 'schedule_confirmation_required') {
          const payload = tryParseJson<ScheduleConfirmationPayload>(event.data)
          if (payload) scheduleConfirmations.push(payload)
          continue
        }
        if (event.type === 'profile_auto_updated') {
          const payload = tryParseJson<ProfileAutoUpdatedPayload>(event.data)
          if (payload) profileNotices.push(payload)
          continue
        }
        if (event.type === 'medical_document_save_suggestion') {
          const payload = tryParseJson<MedicalDocumentSaveSuggestionPayload>(event.data)
          if (payload) medicalDocumentSaveSuggestions.push(payload)
          continue
        }
        if (event.type === 'document_attached') {
          const payload = tryParseJson<DocumentAttachedPayload>(event.data)
          if (payload) {
            documentAttachments.push(payload)
            extraProcessSteps.push({
              type: 'doc_view',
              titles: payload.titles,
              count: payload.titles.length,
              isActive: false,
              timestamp: 0,
            })
          }
          continue
        }
        if (event.type === 'error') {
          pendingError = tryParseJson<{ message?: string; code?: string }>(event.data) ?? {
            message: event.data,
          }
        }
      }

      const persisted = await persistAssistantTurn(
        sessionId,
        sessionState,
        startMsgIdx,
        toolDurations,
        firstProcessTs,
        answerStartTs,
        logger,
        { hadError: pendingError !== null, extraProcessSteps },
      )
      outputTps = persisted.message?.outputTps ?? null
      llmRetryCount = sessionState.llmRetryCount ?? persisted.llmRetryCount

      const data: ChatSendSyncResponse = {
        sessionId,
        message: persisted.message,
        approvals: approvals.length ? approvals : undefined,
        scheduleConfirmations: scheduleConfirmations.length ? scheduleConfirmations : undefined,
        profileNotices: profileNotices.length ? profileNotices : undefined,
        medicalDocumentSaveSuggestions: medicalDocumentSaveSuggestions.length
          ? medicalDocumentSaveSuggestions
          : undefined,
        documentAttachments: documentAttachments.length ? documentAttachments : undefined,
        errorCode: pendingError?.code,
        errorMessage: pendingError?.message,
      }
      finishTrace({
        output: {
          messageId: persisted.savedMessageId,
          content: persisted.message?.content ?? null,
          errorCode: pendingError?.code,
        },
        metadata: {
          hadError: pendingError !== null,
          approvalCount: approvals.length,
          profileNoticeCount: profileNotices.length,
          medicalDocumentSaveSuggestionCount: medicalDocumentSaveSuggestions.length,
          documentAttachmentCount: documentAttachments.length,
          outputTps,
          llmRetryCount,
        },
        error: pendingError ? new Error(pendingError.message ?? pendingError.code ?? 'chat sync emitted error') : undefined,
      })
      schedulePostTurnMemoryReview({
        prepared,
        persisted,
        hadError: pendingError !== null,
        logger,
      })

      return c.json({ success: true, data })
    } catch (err) {
      finishTrace({
        metadata: {
          outputTps,
          llmRetryCount,
        },
        error: err,
      })
      throw err
    } finally {
      c.req.raw.signal.removeEventListener('abort', onClientAbort)
      c.set('chatMetrics', {
        sessionId,
        processTtftMs: firstProcessTs !== null ? firstProcessTs - reqStartTs : null,
        answerTtftMs: firstAnswerTextTs !== null ? firstAnswerTextTs - reqStartTs : null,
        outputTps,
        llmRetryCount,
        recommendedQuestion: parsed.data.recommendedQuestion ?? null,
      })
    }
  },
)

// GET /api/chat/debug/:sessionId — full LLM context for debugging (dev only)
chatRoutes.get('/debug/:sessionId', async (c) => {
  const env = getEnv()
  const debugFeatures = getBackendFeatureSnapshot()
  if (env.DEPLOY_ENV === 'prod' || !isFeatureEnabled(debugFeatures, 'llmContextDashboard')) {
    return c.json({ success: false, error: 'debug API disabled' }, 403)
  }

  const logger = c.get('logger')
  const userId = c.get('userId')
  const sessionId = c.req.param('sessionId')
  const memoryManager = new MemoryManager(logger)

  const session = await getSession(sessionId, logger)
  if (!session || session.userId !== userId) {
    return c.json({ success: false, error: 'session not found' }, 404)
  }

  const existingMessages = await loadSessionMessages(sessionId, logger)
  const [
    { user: debugUserInfo, medical: debugMedical },
    debugMemoryContext,
    debugMedicalDocs,
    debugCommunicationCards,
    debugStructuredProfileTrend,
  ] = await Promise.all([
    getFullProfile(userId, logger).catch(() => ({ user: null, medical: null })),
    memoryManager.loadContext(userId),
    listDocuments(userId, logger),
    getCommunicationCardPromptSummary(userId, logger),
    getRecentStructuredProfiles(userId, 7),
  ])

  // 调试视图要和运行时一致：优先读取会话冻结的 prompt 快照，缺失时再按当前上下文现算
  const debugFeatureSignature = getBackendFeatureSignature()
  const debugTools = getAgentTools(debugFeatures)
  let debugPromptSnapshot = await getSessionPromptSnapshot(sessionId, logger, {
    featureSignature: debugFeatureSignature,
  })
  let systemPrompt = debugPromptSnapshot?.prompt ?? null
  let userProfileSystemPrompt = debugPromptSnapshot?.userProfileSystemPrompt ?? null
  if (!systemPrompt) {
    const interventionCatalog = await getInterventionRuntimeCatalog(logger)
    const assembledDebugPrompt = assembleSystemPrompt({
      userInfo: debugUserInfo,
      profileData: debugMedical?.profileData || null,
      profileUpdatedAt: debugMedical?.updatedAt ?? null,
      medicalDocs: debugMedicalDocs,
      communicationCards: debugCommunicationCards,
      checkInSchemas: null,
      savedInterventionMaterials: null,
      interventionCatalog,
      recentSessions: null,
      profileMemory: debugMemoryContext.profileMemory,
      todayMemory: debugMemoryContext.todayMemory,
      structuredProfileTrend: debugStructuredProfileTrend,
      summary: session.summary ?? null,
      features: debugFeatures,
      logger,
    })
    systemPrompt = assembledDebugPrompt.prompt
    userProfileSystemPrompt = assembledDebugPrompt.userProfileSystemPrompt
  }

  // reminder 已在首次发送给 LLM 时固化到每条 user 的 content（见 agent/loop.ts），
  // debug 视图直接透出 DB 原形即可，避免二次 inject 导致两份 reminder 叠加展示。
  const debugMessages = isFirstActivationConversation(existingMessages)
    ? [buildFirstActivationAssistantMessage(), ...existingMessages]
    : existingMessages
  const rawMessages = debugMessages.map((m) => {
    const base: Record<string, unknown> = {
      role: m.role,
      content: getDebugAssistantContent(m),
    }
    if (m.role === 'tool' && m.toolCallId) base.tool_call_id = m.toolCallId
    if (m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length) {
      base.tool_calls = m.toolCalls
    }
    return base
  })

  const llmMessages = [
    { role: 'system' as const, content: systemPrompt },
    ...(userProfileSystemPrompt ? [{ role: 'system' as const, content: userProfileSystemPrompt }] : []),
    ...rawMessages,
  ]

  const prefixStability = await getPrefixState(sessionId)

  return c.json({
    success: true,
    data: {
      sessionId,
      model: env.LLM_MODEL,
      systemPromptLength: systemPrompt.length,
      messagesCount: debugMessages.length,
      messages: llmMessages,
      tools: debugTools.map(toLLMToolSchema),
      prefixStability,
    },
  })
})

export default chatRoutes
