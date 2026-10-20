import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { useParams, useNavigate, useLocation } from 'react-router-dom'
import { useStore } from '../stores/index.js'
import { hasNativeBridge } from '../lib/nativeBridge.js'
import { openNativeDebug } from '../lib/nativeDebug.js'
import { useSSE } from '../hooks/useSSE.js'
import {
  syncScheduledTaskCalendarFromToolOutput,
  syncScheduledTaskCalendarsFromMessages,
} from '../lib/scheduledTaskCalendarSync.js'
import { api } from '../services/api.js'
import { createClientId } from '../utils/id.js'
import { buildClientEnvironmentHint } from '../utils/clientEnvironment.js'
import { mergeLatestSessionMessages } from '../utils/chatMessages.js'
import { resolveChatEntrypointFeatures } from '../features.js'
import { ttsPlayer, useTTSPlayerPhase } from '../hooks/useTTSPlayer.js'
import { isAssistantAutoTTSBlocked } from '../lib/interventionFollowAudio.js'
import MessageList, { type MessageListHandle } from '../components/chat/MessageList.js'
import InputBar, { type InputBarHandle } from '../components/chat/InputBar.js'
import DebugPanel from '../components/chat/DebugPanel.js'
import HistoryPanel from '../components/chat/HistoryPanel.js'
import HealthProfileConsentDialog from '../components/agreement/HealthProfileConsentDialog.js'
import { useHealthProfileConsent } from '../hooks/useHealthProfileConsent.js'
import type {
  MessageRecord,
  ApiResponse,
  MessageFeedbackRecord,
  SessionMessageFavoritesResponse,
  ChatSendSyncResponse,
  ChatTransportModeResponse,
  DocumentAttachedPayload,
  CommunicationCardAttachedPayload,
  AssistantOutputRetractedPayload,
  MedicalDocumentSaveSuggestionPayload,
  RecommendedQuestionInteraction,
  MessageImageAttachment,
} from '@health-agent/shared'
import { ERROR_CODES, FIRST_ACTIVATION_WELCOME_MESSAGE, isFeatureEnabled } from '@health-agent/shared'
import { EMPTY_STREAM, type ProcessStep } from '../stores/slices/chat.js'

const newChatIconUrl = new URL('../assets/icons/new-chat.svg', import.meta.url).href
const DRAWER_ANIM_MS = 420
const NATIVE_ACTIVE_SESSION_REVALIDATE_MS = 5_000
const headerIconSvgStyle: React.CSSProperties = {
  width: 'var(--chat-header-icon-size, 20px)',
  height: 'var(--chat-header-icon-size, 20px)',
  display: 'block',
  flexShrink: 0,
}

// 新建会话（sid 未知）时桶的临时 key 前缀，onSessionId 后 rekey 到真 sid
const NEW_CHAT_KEY_PREFIX = '__new__:'

const IS_MOBILE =
  typeof navigator !== 'undefined' &&
  (/Mobi|Android|iPhone|iPad|iPod|HarmonyOS|OpenHarmony/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1))

function triggerLightHaptic(duration = 8): void {
  if (!IS_MOBILE) return
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return
  navigator.vibrate(duration)
}

/** 流式自动播是否启用：受全局开关和端类型共同约束 */
function shouldAutoTTS(): boolean {
  const { showTtsControl } = resolveChatEntrypointFeatures(useStore.getState().features)
  return showTtsControl
    && useStore.getState().ttsEnabled
    && !isAssistantAutoTTSBlocked()
}

type MessageRecordWithProcessTimeline = MessageRecord & { processTimeline?: ProcessStep[] }

function snapshotProcessSteps(steps: ProcessStep[]): ProcessStep[] {
  return steps.map((step) => ({ ...step }))
}

function withProcessTimeline(
  message: MessageRecord,
  steps: ProcessStep[],
): MessageRecordWithProcessTimeline {
  return {
    ...message,
    processTimeline: snapshotProcessSteps(steps),
  }
}

function collectProcessText(steps: ProcessStep[]): string {
  return steps
    .filter((s): s is Extract<ProcessStep, { type: 'text' }> => s.type === 'text')
    .map((s) => s.content)
    .join('')
}

function resolveFinalAssistantTextAndTimeline(bucket: {
  answerText: string
  accumulatedToolCalls: unknown[]
  processTimeline: { steps: ProcessStep[] }
}): { finalText: string; processSteps: ProcessStep[] } {
  if (bucket.answerText) {
    return { finalText: bucket.answerText, processSteps: bucket.processTimeline.steps }
  }

  // 没有最终回答（answer_start 后无正文，或回答草稿已被后续工具回收为 text 节点）：
  // - 有工具调用：中间叙述保留为 timeline 内联节点，正文留空，不堆到底部。
  // - 无工具调用：纯文本简单回复，作为正文返回（timeline 对纯文本节点会自动隐藏）。
  if (bucket.accumulatedToolCalls.length > 0) {
    return { finalText: '', processSteps: bucket.processTimeline.steps }
  }
  const finalText = collectProcessText(bucket.processTimeline.steps)
  return { finalText, processSteps: bucket.processTimeline.steps }
}

function getWelcomeTypingDelay(char: string): number {
  if (char === '\n') return 35
  if ('，,、；;：:'.includes(char)) return 18
  if ('。！？.!?'.includes(char)) return 28
  return 5
}

export default function Chat() {
  const { sessionId: routeSessionId } = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  const { send, abort } = useSSE()

  const messages = useStore((s) => s.messages)
  const setMessages = useStore((s) => s.setMessages)
  const addMessage = useStore((s) => s.addMessage)
  const setCurrentSession = useStore((s) => s.setCurrentSession)
  const upsertSession = useStore((s) => s.upsertSession)
  const removeSessionFromStore = useStore((s) => s.removeSession)
  const setHasMoreMessages = useStore((s) => s.setHasMoreMessages)
  const setOldestMessageCursor = useStore((s) => s.setOldestMessageCursor)
  const setLoadingOlder = useStore((s) => s.setLoadingOlder)
  const feedbackMap = useStore((s) => s.feedbackMap)
  const favoriteMap = useStore((s) => s.favoriteMap)
  const processDurationMap = useStore((s) => s.processDurationMap)
  const setFeedbackMap = useStore((s) => s.setFeedbackMap)
  const setFavoriteMap = useStore((s) => s.setFavoriteMap)
  const setFavorite = useStore((s) => s.setFavorite)
  const setLastUserPayload = useStore((s) => s.setLastUserPayload)
  const removeMessage = useStore((s) => s.removeMessage)
  const queueApproval = useStore((s) => s.queueApproval)
  const flushApprovals = useStore((s) => s.flushApprovals)
  const clearApprovals = useStore((s) => s.clearApprovals)
  const queueScheduleConfirmation = useStore((s) => s.queueScheduleConfirmation)
  const flushScheduleConfirmations = useStore((s) => s.flushScheduleConfirmations)
  const clearScheduleConfirmations = useStore((s) => s.clearScheduleConfirmations)
  const attachMessageIdToScheduleConfirmations = useStore((s) => s.attachMessageIdToScheduleConfirmations)
  const restoreScheduleConfirmationsForMessages = useStore((s) => s.restoreScheduleConfirmationsForMessages)
  const dropApprovalsRequiringHealthProfileConsent = useStore((s) => s.dropApprovalsRequiringHealthProfileConsent)
  const pendingApprovals = useStore((s) => s.pendingApprovals)
  const addProfileNotice = useStore((s) => s.addProfileNotice)
  const clearProfileNotices = useStore((s) => s.clearProfileNotices)
  const addMedicalDocumentSaveSuggestion = useStore((s) => s.addMedicalDocumentSaveSuggestion)
  const dismissUntouchedMedicalDocumentSaveSuggestionsForToolCall = useStore(
    (s) => s.dismissUntouchedMedicalDocumentSaveSuggestionsForToolCall,
  )
  const clearMedicalDocumentSaveSuggestions = useStore((s) => s.clearMedicalDocumentSaveSuggestions)
  const featureSnapshot = useStore((s) => s.features)
  const ttsEnabled = useStore((s) => s.ttsEnabled)
  const setTtsEnabled = useStore((s) => s.setTtsEnabled)
  const ttsPhase = useTTSPlayerPhase()

  // Stream actions
  const initStream = useStore((s) => s.initStream)
  const rekeyStream = useStore((s) => s.rekeyStream)
  const clearStream = useStore((s) => s.clearStream)
  const updateStream = useStore((s) => s.updateStream)
  const streamStartIteration = useStore((s) => s.streamStartIteration)
  const streamAppendThinking = useStore((s) => s.streamAppendThinking)
  const streamEndThinking = useStore((s) => s.streamEndThinking)
  const streamStartToolCall = useStore((s) => s.streamStartToolCall)
  const streamEndToolCall = useStore((s) => s.streamEndToolCall)
  const streamDocumentAttached = useStore((s) => s.streamDocumentAttached)
  const streamAppendText = useStore((s) => s.streamAppendText)
  const streamStartAnswer = useStore((s) => s.streamStartAnswer)
  const streamAppendAnswerText = useStore((s) => s.streamAppendAnswerText)
  const streamRetractDraft = useStore((s) => s.streamRetractDraft)
  const streamFinalizeMessage = useStore((s) => s.streamFinalizeMessage)

  const [currentSessionId, setSessionId] = useState<string | null>(routeSessionId || null)
  const [showDebug, setShowDebug] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [isHistoryClosing, setIsHistoryClosing] = useState(false)
  const [sessionNotFound, setSessionNotFound] = useState(false)
  const [isPreparingSend, setIsPreparingSend] = useState(false)
  const [showFirstActivationWelcome, setShowFirstActivationWelcome] = useState(false)
  const [firstActivationWelcomeText, setFirstActivationWelcomeText] = useState('')
  const [entrypointRefreshTick, setEntrypointRefreshTick] = useState(0)
  const [isFirstActivationWelcomeStreaming, setIsFirstActivationWelcomeStreaming] = useState(false)
  const [firstActivationWelcomeSessionId, setFirstActivationWelcomeSessionId] = useState<string | null>(null)
  const syncRequestCounterRef = useRef(0)
  const sendLockRef = useRef(false)
  const welcomePlaybackTimersRef = useRef<number[]>([])
  const drawerCloseTimerRef = useRef<number | null>(null)
  const messageListRef = useRef<MessageListHandle | null>(null)
  const inputBarRef = useRef<InputBarHandle | null>(null)
  // 编辑用户消息：记录待截断的"从末尾数第 N 条真实 user 消息"；点编辑只回填输入框，
  // 真正截断在重新发送时进行；切换/新建会话时清空。
  const pendingEditTurnsRef = useRef<number | null>(null)
  const shouldInjectFirstActivationRef = useRef(false)
  const suppressCurrentSessionRestoreRef = useRef(false)
  // 发送链路读这个 ref，避免“点了新会话但组件还没完成重渲染”时误带上旧 sessionId。
  const viewSessionIdRef = useRef<string | null>(routeSessionId || null)
  const showHealthEducationPlaza = isFeatureEnabled(featureSnapshot, 'healthEducationPlaza')
  const showMyDoctorEntry = isFeatureEnabled(featureSnapshot, 'myDoctorEntry')
  const showCheckInRecordsEntry = isFeatureEnabled(featureSnapshot, 'checkInRecords')
  const showScheduledTaskEntry = isFeatureEnabled(featureSnapshot, 'agentScheduledTasks')
  const showMaterialsAdminEntry = isFeatureEnabled(featureSnapshot, 'materialUploadAdmin')
  const showLlmContextDashboard = isFeatureEnabled(featureSnapshot, 'llmContextDashboard')
  const chatEntrypointFeatures = useMemo(
    () => resolveChatEntrypointFeatures(featureSnapshot),
    [entrypointRefreshTick, featureSnapshot],
  )
  const showTtsControl = chatEntrypointFeatures.showTtsControl
  const showNativeDebugEntry = chatEntrypointFeatures.showNativeDebugEntry
  const focusMessageId = (() => {
    const raw = new URLSearchParams(location.search).get('focusMessageId')
    return raw && /^[0-9a-f-]{36}$/i.test(raw) ? raw : null
  })()

  // 当前视图对应的桶 key（真 sid 或新建会话的临时 key），rekey 后更新
  const [activeStreamKey, setActiveStreamKey] = useState<string | null>(null)

  // 按当前视图挑出对应桶；切走的会话若还在后台流，用户回来时自动读到对应桶继续渲染
  const activeStream = useStore((s) => {
    if (activeStreamKey && s.sessionStreams[activeStreamKey]) {
      return s.sessionStreams[activeStreamKey]
    }
    if (currentSessionId && s.sessionStreams[currentSessionId]) {
      return s.sessionStreams[currentSessionId]
    }
    return EMPTY_STREAM
  })
  const isStreaming = activeStream.isStreaming
  const isSyncPending = isStreaming && activeStream.transport === 'sync'
  const isSseStreaming = isStreaming && activeStream.transport !== 'sync'
  const isCompacting = activeStream.isCompacting
  const processTimeline = activeStream.processTimeline
  const answerText = activeStream.answerText
  const streamingToolCalls = activeStream.accumulatedToolCalls
  const responseStartTime = activeStream.responseStartTime
  const showNewChatHeaderButton = !!currentSessionId || messages.length > 0

  useEffect(() => {
    const refreshEntrypointFeatures = () => {
      setEntrypointRefreshTick((value) => value + 1)
    }

    window.addEventListener('cx-native-ready', refreshEntrypointFeatures)
    return () => {
      window.removeEventListener('cx-native-ready', refreshEntrypointFeatures)
    }
  }, [])

  const clearWelcomePlaybackTimers = useCallback(() => {
    for (const timer of welcomePlaybackTimersRef.current) {
      window.clearTimeout(timer)
    }
    welcomePlaybackTimersRef.current = []
  }, [])

  const clearDrawerCloseTimer = useCallback(() => {
    if (drawerCloseTimerRef.current !== null) {
      window.clearTimeout(drawerCloseTimerRef.current)
      drawerCloseTimerRef.current = null
    }
  }, [])

  const openHistory = useCallback((withHaptic = true) => {
    clearDrawerCloseTimer()
    setIsHistoryClosing(false)
    setShowHistory(true)
    if (withHaptic) triggerLightHaptic(8)
  }, [clearDrawerCloseTimer])

  const closeHistory = useCallback((withHaptic = true) => {
    if (!showHistory || isHistoryClosing) return
    clearDrawerCloseTimer()
    setIsHistoryClosing(true)
    if (withHaptic) triggerLightHaptic(6)
    drawerCloseTimerRef.current = window.setTimeout(() => {
      setShowHistory(false)
      setIsHistoryClosing(false)
      drawerCloseTimerRef.current = null
    }, DRAWER_ANIM_MS)
  }, [clearDrawerCloseTimer, isHistoryClosing, showHistory])

  const closeHistoryImmediately = useCallback(() => {
    clearDrawerCloseTimer()
    setShowHistory(false)
    setIsHistoryClosing(false)
  }, [clearDrawerCloseTimer])

  const handleOpenNativeDebug = useCallback(() => {
    closeHistoryImmediately()
    void openNativeDebug()
  }, [closeHistoryImmediately])

  useEffect(() => {
    const state = location.state as {
      openSidebar?: boolean
      showFirstActivationWelcome?: boolean
    } | null

    if (state?.openSidebar) {
      openHistory(false)
    }

    const shouldShowFirstActivationWelcome = !routeSessionId && state?.showFirstActivationWelcome === true
    if (shouldShowFirstActivationWelcome) {
      clearWelcomePlaybackTimers()
      shouldInjectFirstActivationRef.current = true
      setShowFirstActivationWelcome(true)
      setFirstActivationWelcomeText('')
      setIsFirstActivationWelcomeStreaming(true)
      setFirstActivationWelcomeSessionId(null)

      const chars = Array.from(FIRST_ACTIVATION_WELCOME_MESSAGE)
      let elapsed = 50

      chars.forEach((char) => {
        const timer = window.setTimeout(() => {
          setFirstActivationWelcomeText((prev) => prev + char)
          welcomePlaybackTimersRef.current = welcomePlaybackTimersRef.current.filter((id) => id !== timer)
        }, elapsed)
        welcomePlaybackTimersRef.current.push(timer)
        elapsed += getWelcomeTypingDelay(char)
      })

      const finalizeTimer = window.setTimeout(() => {
        setFirstActivationWelcomeText(FIRST_ACTIVATION_WELCOME_MESSAGE)
        setIsFirstActivationWelcomeStreaming(false)
        welcomePlaybackTimersRef.current = welcomePlaybackTimersRef.current.filter((id) => id !== finalizeTimer)
      }, elapsed + 40)
      welcomePlaybackTimersRef.current.push(finalizeTimer)
    }

    if (state?.openSidebar || state?.showFirstActivationWelcome) {
      navigate(location.pathname, { replace: true, state: {} })
    }
  }, [clearWelcomePlaybackTimers, location.pathname, location.state, navigate, openHistory, routeSessionId])

  useEffect(() => () => {
    clearWelcomePlaybackTimers()
    clearDrawerCloseTimer()
    ttsPlayer.stop()
  }, [clearDrawerCloseTimer, clearWelcomePlaybackTimers])

  useEffect(() => {
    if (suppressCurrentSessionRestoreRef.current) return
    // 只有 URL 明确指向 /chat/:sessionId 时才把发送目标绑定到已有会话。
    // 裸 /chat 一律表示“新对话草稿”，不能从本地 state/store 恢复旧 session，
    // 否则用户点击新对话后，快速发送或 HMR/重挂载时可能把消息追加到上一轮历史会话。
    viewSessionIdRef.current = routeSessionId ?? null
  }, [routeSessionId])

  // Load messages when navigating to an existing session
  useEffect(() => {
    let cancelled = false
    const isStartingFreshChat = suppressCurrentSessionRestoreRef.current
    const preservePendingFirstActivationWelcome = (
      !routeSessionId &&
      (
        showFirstActivationWelcome ||
        (
          location.state as {
            showFirstActivationWelcome?: boolean
          } | null
        )?.showFirstActivationWelcome === true
      )
    )
    // 切视图立即终止 TTS：老会话已推入 <audio> 的音频不会跟着 view 走
    ttsPlayer.stop()
    if (!preservePendingFirstActivationWelcome) {
      clearWelcomePlaybackTimers()
    }
    // 切换/新建会话时清空未处理的 approval 队列 & personal 通知条，避免跨 session 残留
    clearApprovals()
    clearScheduleConfirmations()
    clearProfileNotices()
    clearMedicalDocumentSaveSuggestions()
    setSessionNotFound(false)
    if (routeSessionId && !isStartingFreshChat) {
      suppressCurrentSessionRestoreRef.current = false
      shouldInjectFirstActivationRef.current = false
      const shouldKeepFirstActivationWelcome =
        showFirstActivationWelcome &&
        firstActivationWelcomeSessionId === routeSessionId
      if (!shouldKeepFirstActivationWelcome) {
        setShowFirstActivationWelcome(false)
        setFirstActivationWelcomeText('')
        setIsFirstActivationWelcomeStreaming(false)
        setFirstActivationWelcomeSessionId(null)
      }
      setSessionId(routeSessionId)
      setCurrentSession(routeSessionId)
      // 切到已存在的会话：若此 sid 有后台桶，activeStreamKey 指向它；否则清空
      const hasBucket = !!useStore.getState().sessionStreams[routeSessionId]
      setActiveStreamKey(hasBucket ? routeSessionId : null)
      setLoadingOlder(false)
      const sessionParams = new URLSearchParams({ limit: '30' })
      if (focusMessageId) sessionParams.set('focusMessageId', focusMessageId)
      api.get<ApiResponse<{
        messages: MessageRecord[]
        hasMore: boolean
        oldestCreatedAt: string | null
        isFirstActivationConversation?: boolean
      }>>(`/sessions/${routeSessionId}?${sessionParams.toString()}`)
        .then((res) => {
          if (cancelled || !res.data) return
          const loadedMessages = res.data.messages ?? []
          const lastLoadedMessage = loadedMessages[loadedMessages.length - 1]
          const staleStream = lastLoadedMessage?.role === 'assistant'
            && useStore.getState().sessionStreams[routeSessionId]?.isStreaming

          if (staleStream) {
            // iOS 微信偶发流式尾态没收口时，session reload 已拿到最终 assistant 落库消息，
            // 说明这条流在后端其实已经结束；这里清掉残留 bucket，避免
            // “上面有正式回复，下面还挂着思考中/Stop 按钮”的双态 UI。
            clearStream(routeSessionId)
            setActiveStreamKey((prev) => (prev === routeSessionId ? null : prev))
            console.info('[chat] cleared stale stream after session reload', {
              sessionId: routeSessionId,
              loadedMessageCount: loadedMessages.length,
            })
          }

          setHasMoreMessages(res.data.hasMore)
          setOldestMessageCursor(res.data.oldestCreatedAt)
          setMessages(loadedMessages)
          // 还原本会话仍待确认的 schedule 卡片：上一步 clearScheduleConfirmations 只清了内存，
          // 这里按本会话的 assistant message id 从 sessionStorage 把未确认卡片补回（已确认/已拒绝的
          // 由 processTimeline 终态展示，不重复弹卡）。
          restoreScheduleConfirmationsForMessages(
            loadedMessages.filter((m) => m.role === 'assistant').map((m) => m.id),
          )
          syncScheduledTaskCalendarsFromMessages(loadedMessages)
          if (res.data.isFirstActivationConversation) {
            setShowFirstActivationWelcome(true)
            setFirstActivationWelcomeText(FIRST_ACTIVATION_WELCOME_MESSAGE)
            setIsFirstActivationWelcomeStreaming(false)
            setFirstActivationWelcomeSessionId(routeSessionId)
          }
        })
        .catch((err: Error & { status?: number }) => {
          if (cancelled) return
          if (err?.status === 404) {
            setSessionNotFound(true)
            setMessages([])
            setFeedbackMap({})
            setFavoriteMap({})
            setHasMoreMessages(false)
            setOldestMessageCursor(null)
            return
          }
          setMessages([])
          setFeedbackMap({})
          setFavoriteMap({})
          setHasMoreMessages(false)
          setOldestMessageCursor(null)
        })
      api.get<ApiResponse<MessageFeedbackRecord[]>>(`/feedback/${routeSessionId}`)
        .then((res) => {
          if (cancelled) return
          if (res.data) {
            const map: Record<string, 'like' | 'dislike'> = {}
            for (const f of res.data) map[f.messageId] = f.rating
            setFeedbackMap(map)
          }
        })
        .catch(() => {
          if (!cancelled) setFeedbackMap({})
        })
      api.get<ApiResponse<SessionMessageFavoritesResponse>>(`/message-favorites/session/${routeSessionId}`)
        .then((res) => {
          if (cancelled) return
          const ids = res.data?.messageIds ?? []
          const map: Record<string, true> = {}
          for (const id of ids) map[id] = true
          setFavoriteMap(map)
        })
        .catch(() => {
          if (!cancelled) setFavoriteMap({})
        })
    } else {
      suppressCurrentSessionRestoreRef.current = false
      viewSessionIdRef.current = null
      setMessages([])
      setFeedbackMap({})
      setFavoriteMap({})
      setSessionId(null)
      setCurrentSession(null)
      setActiveStreamKey(null)
      setHasMoreMessages(false)
      setOldestMessageCursor(null)
      setLoadingOlder(false)
    }
    // 切 view 不 abort 后台流、不清桶：后端跑完会自然落库，用户回来 fetch 历史
    return () => {
      cancelled = true
    }
  }, [
    clearApprovals,
    clearMedicalDocumentSaveSuggestions,
    clearProfileNotices,
    clearStream,
    clearWelcomePlaybackTimers,
    firstActivationWelcomeSessionId,
    focusMessageId,
    location.state,
    location.search,
    routeSessionId,
    showFirstActivationWelcome,
    setCurrentSession,
    setFavoriteMap,
    setFeedbackMap,
    setHasMoreMessages,
    setLoadingOlder,
    setMessages,
    setOldestMessageCursor,
    setTtsEnabled,
    restoreScheduleConfirmationsForMessages,
  ])

  // 桶 k 所属视图是否为当前视图
  const isBucketInView = useCallback((k: string): boolean => {
    const state = useStore.getState()
    const bucket = state.sessionStreams[k]
    if (!bucket) return false
    if (activeStreamKey === k) return true
    if (bucket.boundSessionId && state.currentSessionId === bucket.boundSessionId) return true
    return false
  }, [activeStreamKey])

  const fetchLatestSession = useCallback(async (sessionId: string) => {
    return api.get<ApiResponse<{
      messages: MessageRecord[]
      hasMore: boolean
      oldestCreatedAt: string | null
      isFirstActivationConversation?: boolean
    }>>(`/sessions/${sessionId}?limit=30`)
  }, [])

  useEffect(() => {
    if (!routeSessionId || !hasNativeBridge()) return

    let cancelled = false
    let inFlight = false

    const revalidateActiveSession = async () => {
      if (cancelled || inFlight) return
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return

      const state = useStore.getState()
      const stream = state.sessionStreams[routeSessionId]
      if (state.currentSessionId !== routeSessionId || stream?.isStreaming) return

      inFlight = true
      try {
        const res = await fetchLatestSession(routeSessionId)
        if (cancelled || !res.data) return

        const latestMessages = res.data.messages ?? []
        const currentMessages = useStore.getState().messages
        const mergedMessages = mergeLatestSessionMessages(currentMessages, latestMessages)
        if (mergedMessages !== currentMessages) {
          setMessages(mergedMessages)
          useStore.getState().loadSessions(true).catch(() => undefined)
        }
      } catch {
        // Native WebView 下用于补偿服务端主动消息，失败保持静默，下一轮重试。
      } finally {
        inFlight = false
      }
    }

    const interval = window.setInterval(revalidateActiveSession, NATIVE_ACTIVE_SESSION_REVALIDATE_MS)
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') void revalidateActiveSession()
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      cancelled = true
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [
    fetchLatestSession,
    routeSessionId,
    setMessages,
  ])

  const appendSyntheticDocs = useCallback((data: DocumentAttachedPayload) => {
    addMessage({
      id: createClientId('synthetic-msg'),
      role: 'user',
      content: '',
      thinking: null,
      toolCalls: null,
      synthetic: true,
      syntheticDocs: data.shortIds.map((shortId, index) => ({
        docId: data.docIds[index] ?? null,
        shortId,
        title: data.titles[index] ?? null,
      })),
      createdAt: new Date().toISOString(),
    })
  }, [addMessage])

  const appendSyntheticCommunicationCards = useCallback((data: CommunicationCardAttachedPayload) => {
    addMessage({
      id: createClientId('synthetic-msg'),
      role: 'user',
      content: '',
      thinking: null,
      toolCalls: null,
      synthetic: true,
      syntheticCommunicationCards: data.cards.map((card) => ({
        cardId: card.cardId,
        shortId: card.shortId,
        title: card.title,
      })),
      createdAt: new Date().toISOString(),
    })
  }, [addMessage])

  const recoverSessionAfterStreamFailure = useCallback(async (sessionId: string) => {
    const delays = [0, 350, 800]

    for (const delay of delays) {
      if (delay > 0) {
        await new Promise((resolve) => window.setTimeout(resolve, delay))
      }

      try {
        const res = await fetchLatestSession(sessionId)
        if (!res.data) continue

        setMessages(res.data.messages ?? [])
        syncScheduledTaskCalendarsFromMessages(res.data.messages ?? [])
        setHasMoreMessages(res.data.hasMore)
        setOldestMessageCursor(res.data.oldestCreatedAt)

        const lastMessage = res.data.messages?.[res.data.messages.length - 1]
        if (lastMessage?.role === 'assistant') {
          console.info('[chat] recovered session after stream failure', {
            sessionId,
            messageCount: res.data.messages.length,
          })
          return true
        }
      } catch {
        // swallow and retry
      }
    }

    addMessage({
      id: createClientId('error-msg'),
      role: 'assistant',
      content: '',
      thinking: null,
      toolCalls: null,
      createdAt: new Date().toISOString(),
      errorCode: ERROR_CODES.NETWORK_ERROR,
    })
    return false
  }, [
    addMessage,
    fetchLatestSession,
    setHasMoreMessages,
    setMessages,
    setOldestMessageCursor,
  ])

  const resolveTransportMode = useCallback(async (): Promise<'stream' | 'sync'> => {
    if (hasNativeBridge()) return 'stream'

    try {
      const res = await api.get<ApiResponse<ChatTransportModeResponse>>('/chat/transport-mode')
      return res.data?.mode === 'sync' ? 'sync' : 'stream'
    } catch {
      return 'stream'
    }
  }, [])

  const runSendSync = useCallback(async (
    text: string,
    sessionId: string | null,
    images?: string[],
    imageAssetIds?: string[],
    isRetry: boolean = false,
    firstActivation: boolean = false,
    retryLatestUserMessage: boolean = false,
    recommendedQuestion?: RecommendedQuestionInteraction,
    discardUserTurnsFromEnd?: number,
  ) => {
    let resolvedSessionId = sessionId
    let initialKey: string | null = null

    try {
      if (retryLatestUserMessage && !resolvedSessionId) {
        throw new Error('retryLatestUserMessage requires session id')
      }

      if (!resolvedSessionId) {
        const created = await api.post<ApiResponse<{
          id: string
          title: string | null
          messageCount: number
          updatedAt: string
        }>>('/sessions')
        const createdSession = created.data
        if (!createdSession?.id) throw new Error('empty session create response')

        resolvedSessionId = createdSession.id
        viewSessionIdRef.current = resolvedSessionId
        navigate(`/chat/${resolvedSessionId}`, { replace: true })
        setSessionId(resolvedSessionId)
        setCurrentSession(resolvedSessionId)
        upsertSession(createdSession)
      }

      if (!resolvedSessionId) throw new Error('missing session id')

      suppressCurrentSessionRestoreRef.current = false

      if (firstActivation) {
        setFirstActivationWelcomeSessionId(resolvedSessionId)
      }

      const requestKey = `sync-req-${++syncRequestCounterRef.current}`
      const streamKey = resolvedSessionId
      initialKey = streamKey
      initStream(streamKey, requestKey, resolvedSessionId, 'sync')
      setActiveStreamKey(streamKey)

      const res = await api.post<ApiResponse<ChatSendSyncResponse>>('/chat/send-sync', {
        content: text,
        sessionId: resolvedSessionId,
        images,
        imageAssetIds,
        firstActivation,
        retryLatestUserMessage: retryLatestUserMessage || undefined,
        discardUserTurnsFromEnd,
        clientEnvironment: buildClientEnvironmentHint(),
        recommendedQuestion,
      })

      const data = res.data
      if (!data) throw new Error('empty sync response')

      let finalKey = streamKey
      if (streamKey !== data.sessionId) {
        rekeyStream(streamKey, data.sessionId)
        finalKey = data.sessionId
        viewSessionIdRef.current = data.sessionId
        navigate(`/chat/${data.sessionId}`, { replace: true })
        setSessionId(data.sessionId)
        setCurrentSession(data.sessionId)
        setActiveStreamKey(data.sessionId)
      }
      if (firstActivation) {
        setFirstActivationWelcomeSessionId(data.sessionId)
      }

      if (data.documentAttachments?.length) {
        for (const payload of data.documentAttachments) {
          if (isBucketInView(finalKey)) appendSyntheticDocs(payload)
        }
      }

      if (data.medicalDocumentSaveSuggestions?.length && isBucketInView(finalKey)) {
        for (const payload of data.medicalDocumentSaveSuggestions) {
          addMedicalDocumentSaveSuggestion(payload)
        }
      }

      if (data.message) {
        for (const toolCall of data.message.toolCalls ?? []) {
          syncScheduledTaskCalendarFromToolOutput(toolCall.output)
        }
        updateStream(finalKey, { messageFinalized: true })
        streamFinalizeMessage(finalKey, data.message)
      } else {
        clearStream(finalKey)
      }

      if (data.profileNotices?.length) {
        for (const payload of data.profileNotices) addProfileNotice(payload)
      }
      if (data.approvals?.length) {
        for (const payload of data.approvals) queueApproval(payload)
        flushApprovals()
      }
      if (data.scheduleConfirmations?.length) {
        for (const payload of data.scheduleConfirmations) queueScheduleConfirmation(payload)
        if (data.message?.id) attachMessageIdToScheduleConfirmations(data.message.id)
        flushScheduleConfirmations()
      }
      if (data.errorCode) {
        addMessage({
          id: createClientId('error-msg'),
          role: 'assistant',
          content: '',
          thinking: null,
          toolCalls: null,
          createdAt: new Date().toISOString(),
          errorCode: data.errorCode,
          retriedOnce: isRetry || undefined,
        })
      }

      const existing = useStore.getState().sessions.find((s) => s.id === data.sessionId)
      // 编辑场景删除条数不定，跳过乐观 delta，靠下方 loadSessions 对账
      const skipOptimisticCount = retryLatestUserMessage || !!discardUserTurnsFromEnd
      const messageCountDelta = data.message ? 2 : 1
      upsertSession({
        id: data.sessionId,
        title: existing?.title ?? null,
        messageCount: skipOptimisticCount
          ? (existing?.messageCount ?? 0)
          : (existing?.messageCount ?? 0) + messageCountDelta,
        updatedAt: new Date().toISOString(),
      })
      if (skipOptimisticCount || !existing?.title) {
        setTimeout(() => {
          useStore.getState().loadSessions(true)
        }, skipOptimisticCount ? 0 : 1200)
      }
    } catch (err) {
      if (initialKey) clearStream(initialKey)
      const message = (err as Error).message?.toLowerCase?.() || ''
      if ((message === 'load failed' || message === 'illegal access') && resolvedSessionId) {
        await recoverSessionAfterStreamFailure(resolvedSessionId)
        return
      }
      addMessage({
        id: createClientId('error-msg'),
        role: 'assistant',
        content: '',
        thinking: null,
        toolCalls: null,
        createdAt: new Date().toISOString(),
        errorCode:
          (err as Error & { code?: string; status?: number }).code ||
          ((err as Error & { status?: number }).status === 429
            ? ERROR_CODES.USER_RATE_LIMITED
            : ERROR_CODES.UNKNOWN_ERROR),
        retriedOnce: isRetry || undefined,
      })
    }
  }, [
    addMessage,
    addMedicalDocumentSaveSuggestion,
    addProfileNotice,
    appendSyntheticDocs,
    appendSyntheticCommunicationCards,
    clearStream,
    flushApprovals,
    flushScheduleConfirmations,
    attachMessageIdToScheduleConfirmations,
    initStream,
    recoverSessionAfterStreamFailure,
    isBucketInView,
    queueApproval,
    queueScheduleConfirmation,
    rekeyStream,
    setCurrentSession,
    streamFinalizeMessage,
    updateStream,
    upsertSession,
    navigate,
  ])

  // 真实 SSE 启动：分配桶 → wire callback → 发 fetch
  const runSend = useCallback((
    text: string,
    sessionId: string | null,
    images?: string[],
    imageAssetIds?: string[],
    isRetry: boolean = false,
    firstActivation: boolean = false,
    retryLatestUserMessage: boolean = false,
    onTerminal?: () => void,
    recommendedQuestion?: RecommendedQuestionInteraction,
    discardUserTurnsFromEnd?: number,
  ) => {
    // 先拿 requestKey（通过 send 返回）。新会话：桶 key = 临时 `__new__:${requestKey}`；
    // 已有会话：桶 key = sid。
    const cbRef = { current: null as ReturnType<typeof makeCallbacks> | null }
    const keyRef = { current: '' }

    const makeCallbacks = () => ({
      onSessionId: (sid: string) => {
        // rekey 桶到真 sid
        if (keyRef.current !== sid) {
          ttsPlayer.rebindStreamOwner(keyRef.current, sid)
          rekeyStream(keyRef.current, sid)
          keyRef.current = sid
        }
        viewSessionIdRef.current = sid
        suppressCurrentSessionRestoreRef.current = false
        if (firstActivation) {
          setFirstActivationWelcomeSessionId(sid)
        }
        // 新建会话路径：把路由/视图对齐到 sid
        if (!routeSessionId && !sessionId) {
          navigate(`/chat/${sid}`, { replace: true })
          setSessionId(sid)
          setCurrentSession(sid)
          setActiveStreamKey(sid)
          const existing = useStore.getState().sessions.find((s) => s.id === sid)
          upsertSession({
            id: sid,
            title: existing?.title ?? null,
            messageCount: existing?.messageCount ?? 0,
            updatedAt: new Date().toISOString(),
          })
        }
      },
      onCompactionStart: () => updateStream(keyRef.current, { isCompacting: true }),
      onCompactionEnd: () => updateStream(keyRef.current, { isCompacting: false }),
      onIterationStart: (data: { iteration: number }) => streamStartIteration(keyRef.current, data.iteration),
      onToolCallStart: (data: { toolCallId: string; name: string; input?: unknown }) => {
        const k = keyRef.current
        const bucket = useStore.getState().sessionStreams[k]
        const hadAnswerDraft = !!bucket?.answerText.trim() && bucket.processTimeline.isAnswering
        streamStartToolCall(k, data)
        if (hadAnswerDraft && isBucketInView(k) && shouldAutoTTS()) ttsPlayer.stop()
      },
      onToolCallEnd: (data: { toolCallId: string; name: string; output?: unknown; durationMs: number }) => {
        streamEndToolCall(keyRef.current, data)
        if (data.name === 'medical_report_consultation_board') {
          dismissUntouchedMedicalDocumentSaveSuggestionsForToolCall(data.toolCallId)
        }
        syncScheduledTaskCalendarFromToolOutput(data.output)
      },
      onDocumentAttached: (data: { docIds: string[]; shortIds: string[]; titles: Array<string | null> }) => {
        const k = keyRef.current
        streamDocumentAttached(k, { titles: data.titles, count: data.titles.length })

        if (!isBucketInView(k)) return
        appendSyntheticDocs(data)
      },
      onCommunicationCardAttached: (data: CommunicationCardAttachedPayload) => {
        const k = keyRef.current
        if (!isBucketInView(k)) return
        appendSyntheticCommunicationCards(data)
      },
      onToolApprovalRequired: (payload: Parameters<typeof queueApproval>[0]) => {
        const inView = isBucketInView(keyRef.current)
        if (inView) queueApproval(payload)
      },
      onScheduleConfirmationRequired: (payload: Parameters<typeof queueScheduleConfirmation>[0]) => {
        const inView = isBucketInView(keyRef.current)
        if (inView) queueScheduleConfirmation(payload)
      },
      onProfileAutoUpdated: (payload: Parameters<typeof addProfileNotice>[0]) => {
        const inView = isBucketInView(keyRef.current)
        if (inView) addProfileNotice(payload)
      },
      onMedicalDocumentSaveSuggestion: (payload: MedicalDocumentSaveSuggestionPayload) => {
        const inView = isBucketInView(keyRef.current)
        if (inView) addMedicalDocumentSaveSuggestion(payload)
      },
      onThinkingStart: () => updateStream(keyRef.current, { isThinking: true, thinkingStartTime: Date.now() }),
      onThinkingDelta: (content: string) => streamAppendThinking(keyRef.current, content),
      onThinkingEnd: () => streamEndThinking(keyRef.current),
      onTextDelta: (content: string) => {
        const k = keyRef.current
        const bucket = useStore.getState().sessionStreams[k]
        if (!bucket) return
        if (bucket.processTimeline.isAnswering) {
          streamAppendAnswerText(k, content)
          if (isBucketInView(k) && shouldAutoTTS()) {
            const nextBucket = useStore.getState().sessionStreams[k]
            if (nextBucket?.processTimeline.isAnswering) {
              ttsPlayer.pushDelta(content, k)
            } else {
              ttsPlayer.stop()
            }
          }
        } else {
          streamAppendText(k, content)
        }
      },
      onAnswerStart: () => {
        const k = keyRef.current
        streamStartAnswer(k)
        updateStream(k, { responseStartTime: Date.now() })
        if (isBucketInView(k) && shouldAutoTTS()) ttsPlayer.startStream(k)
      },
      onAssistantOutputRetracted: (payload: AssistantOutputRetractedPayload) => {
        const k = keyRef.current
        if (isBucketInView(k) && shouldAutoTTS()) ttsPlayer.stop()
        streamRetractDraft(k, {
          recoveryReason: payload.reason === 'xml_tool_call_in_answer' ? undefined : payload.reason,
          retryAttempt: payload.retryAttempt,
          displayAsToolPlan: payload.displayAsToolPlan,
          toolName: payload.toolName,
          clearTransientToolPlan: payload.clearTransientToolPlan,
        })
      },
      onMessageEnd: (data: { messageId: string; inputTokens: number; outputTokens: number; totalMs: number; interrupted?: boolean }) => {
        const k = keyRef.current
        const bucket = useStore.getState().sessionStreams[k]
        if (!bucket) return
        const inView = isBucketInView(k)
        if (inView && shouldAutoTTS()) ttsPlayer.endStream(k)

        const { finalText, processSteps } = resolveFinalAssistantTextAndTimeline(bucket)
        const interrupted = data.interrupted === true
        const assistantMsg: MessageRecord = {
          id: data.messageId,
          role: 'assistant',
          content: finalText,
          thinking: null,
          toolCalls: bucket.accumulatedToolCalls.length > 0 ? bucket.accumulatedToolCalls : null,
          createdAt: new Date().toISOString(),
          interrupted: interrupted || undefined,
        }
        updateStream(k, { messageFinalized: true })
        streamFinalizeMessage(k, withProcessTimeline(assistantMsg, processSteps))
        if (inView) {
          flushApprovals()
          // 先把 messageId 回填到本轮确认卡，再 flush，保证点击时能定位回写
          if (data.messageId) attachMessageIdToScheduleConfirmations(data.messageId)
          flushScheduleConfirmations()
        }

        const sid = bucket.boundSessionId
        if (sid) {
          const existing = useStore.getState().sessions.find((s) => s.id === sid)
          // 编辑场景删除条数不定，跳过乐观 delta，靠下方 loadSessions 对账
          const skipOptimisticCount = retryLatestUserMessage || !!discardUserTurnsFromEnd
          const messageCountDelta = 2
          upsertSession({
            id: sid,
            title: existing?.title ?? null,
            messageCount: skipOptimisticCount
              ? (existing?.messageCount ?? 0)
              : (existing?.messageCount ?? 0) + messageCountDelta,
            updatedAt: new Date().toISOString(),
          })
          if (skipOptimisticCount || !existing?.title) {
            setTimeout(() => {
              useStore.getState().loadSessions(true)
            }, skipOptimisticCount ? 0 : 1200)
          }
        }
      },
      onError: (error: { message: string; code?: string; status?: number; recoverByReload?: boolean }) => {
        onTerminal?.()
        console.error('SSE error:', error)
        const k = keyRef.current
        if (isBucketInView(k) && shouldAutoTTS()) ttsPlayer.stop()

        if (error.recoverByReload && (routeSessionId || sessionId || useStore.getState().currentSessionId)) {
          const targetSessionId =
            useStore.getState().sessionStreams[k]?.boundSessionId ||
            sessionId ||
            routeSessionId ||
            useStore.getState().currentSessionId
          clearStream(k)
          if (targetSessionId) {
            void recoverSessionAfterStreamFailure(targetSessionId)
            return
          }
        }

        const code =
          error.code ||
          (error.status === 429 ? ERROR_CODES.USER_RATE_LIMITED : ERROR_CODES.UNKNOWN_ERROR)

        if (isBucketInView(k)) {
          // 先把流式期间已经渲染给用户看的部分答案落成一条 interrupted 消息，
          // 否则 clearStream 之后屏幕会瞬间"空白"（iOS 微信 WKWebView 中断 SSE 时的典型现象）
          const bucket = useStore.getState().sessionStreams[k]
          if (bucket && !bucket.messageFinalized) {
            const { finalText, processSteps } = resolveFinalAssistantTextAndTimeline(bucket)
            if (finalText) {
              const interruptedMessage: MessageRecord = {
                id: createClientId('assistant-msg'),
                role: 'assistant',
                content: finalText,
                thinking: null,
                toolCalls: bucket.accumulatedToolCalls.length > 0 ? bucket.accumulatedToolCalls : null,
                createdAt: new Date().toISOString(),
                interrupted: true,
              }
              streamFinalizeMessage(k, withProcessTimeline(interruptedMessage, processSteps))
            }
          }
          addMessage({
            id: createClientId('error-msg'),
            role: 'assistant',
            content: '',
            thinking: null,
            toolCalls: null,
            createdAt: new Date().toISOString(),
            errorCode: code,
            retriedOnce: isRetry || undefined,
          })
        }
        clearStream(k)
      },
      onDone: () => {
        onTerminal?.()
        const k = keyRef.current
        const bucket = useStore.getState().sessionStreams[k]
        if (!bucket) return
        const inView = isBucketInView(k)

        if (inView && shouldAutoTTS() && bucket.stopRequested) {
          ttsPlayer.stop()
        }

        if (!bucket.messageFinalized && bucket.isStreaming) {
          const { finalText, processSteps } = resolveFinalAssistantTextAndTimeline(bucket)
          const interrupted = bucket.stopRequested
          if (finalText || interrupted) {
            const assistantMsg: MessageRecord = {
              id: createClientId('assistant-msg'),
              role: 'assistant',
              content: finalText,
              thinking: null,
              toolCalls: bucket.accumulatedToolCalls.length > 0 ? bucket.accumulatedToolCalls : null,
              createdAt: new Date().toISOString(),
              interrupted: interrupted || undefined,
            }
            streamFinalizeMessage(k, withProcessTimeline(assistantMsg, processSteps))
          } else {
            clearStream(k)
          }
        } else if (!bucket.messageFinalized) {
          clearStream(k)
        }
        if (inView) {
          flushApprovals()
          // 错误/中断路径：消息用的是临时 client id，无法据此回写持久化终态，
          // 故不 attach messageId；卡片仍可点击（内存即时态 + 下一轮 reminder 生效）。
          flushScheduleConfirmations()
        }
      },
    })

    cbRef.current = makeCallbacks()
    try {
      const requestKey = send(
        text,
        sessionId,
        cbRef.current,
        images,
        imageAssetIds,
        firstActivation,
        retryLatestUserMessage,
        recommendedQuestion,
        discardUserTurnsFromEnd,
      )

      // 桶初始 key：已有 sid → sid；新建会话 → 临时 key
      const initialKey = sessionId ?? `${NEW_CHAT_KEY_PREFIX}${requestKey}`
      keyRef.current = initialKey
      initStream(initialKey, requestKey, sessionId, 'stream')
      setActiveStreamKey(initialKey)
    } catch (err) {
      onTerminal?.()
      throw err
    }
  }, [
    addMessage,
    addMedicalDocumentSaveSuggestion,
    appendSyntheticDocs,
    appendSyntheticCommunicationCards,
    addProfileNotice,
    clearStream,
    dismissUntouchedMedicalDocumentSaveSuggestionsForToolCall,
    flushApprovals,
    flushScheduleConfirmations,
    attachMessageIdToScheduleConfirmations,
    initStream,
    recoverSessionAfterStreamFailure,
    queueApproval,
    queueScheduleConfirmation,
    rekeyStream,
    routeSessionId,
    setCurrentSession,
    streamAppendAnswerText,
    streamAppendText,
    streamAppendThinking,
    streamEndThinking,
    streamEndToolCall,
    streamFinalizeMessage,
    streamStartAnswer,
    streamRetractDraft,
    streamStartIteration,
    streamStartToolCall,
    updateStream,
    upsertSession,
    navigate,
    send,
  ])

  const startSendWithResolvedTransport = useCallback(async (
    text: string,
    sessionId: string | null,
    images?: string[],
    imageAssetIds?: string[],
    isRetry: boolean = false,
    firstActivation: boolean = false,
    retryLatestUserMessage: boolean = false,
    onTerminal?: () => void,
    recommendedQuestion?: RecommendedQuestionInteraction,
    discardUserTurnsFromEnd?: number,
  ) => {
    setIsPreparingSend(true)
    try {
      const mode = await resolveTransportMode()
      if (mode === 'sync') {
        await runSendSync(
          text,
          sessionId,
          images,
          imageAssetIds,
          isRetry,
          firstActivation,
          retryLatestUserMessage,
          recommendedQuestion,
          discardUserTurnsFromEnd,
        )
        onTerminal?.()
        return
      }
      runSend(text, sessionId, images, imageAssetIds, isRetry, firstActivation, retryLatestUserMessage, onTerminal, recommendedQuestion, discardUserTurnsFromEnd)
    } catch (err) {
      onTerminal?.()
      throw err
    } finally {
      setIsPreparingSend(false)
    }
  }, [resolveTransportMode, runSend, runSendSync])

  const handleSend = useCallback((
    text: string,
    images?: string[],
    imageAssetIds?: string[],
    imageAttachments?: MessageImageAttachment[],
    recommendedQuestion?: RecommendedQuestionInteraction,
  ) => {
    if (sendLockRef.current) return
    const sendSessionId = suppressCurrentSessionRestoreRef.current
      ? null
      : viewSessionIdRef.current
    // 按当前视图桶判断是否流式中（本 view 流式时禁发）
    const currentKeyNow = activeStreamKey
      ?? sendSessionId
    const activeBucket = currentKeyNow
      ? useStore.getState().sessionStreams[currentKeyNow]
      : undefined
    if (activeBucket?.isStreaming || isPreparingSend) return
    sendLockRef.current = true
    const releaseSendLock = () => {
      sendLockRef.current = false
    }

    // 提交新问题时立即停止上一条回答的手动/自动语音播报。
    ttsPlayer.stop()

    // 清历史 error 气泡
    const prevMessages = useStore.getState().messages
    for (const m of prevMessages) {
      if (m.errorCode) removeMessage(m.id)
    }

    // 消费 pending 编辑锚点：发送时才丢弃被编辑消息及其之后的历史（视图 + 下方通知后端）
    const discardUserTurnsFromEnd = pendingEditTurnsRef.current ?? undefined
    pendingEditTurnsRef.current = null
    if (discardUserTurnsFromEnd) {
      const live = useStore.getState().messages
      let seen = 0
      let cutoffIdx = -1
      for (let i = live.length - 1; i >= 0; i--) {
        const m = live[i]
        if (m.role !== 'user' || m.synthetic) continue
        seen += 1
        if (seen === discardUserTurnsFromEnd) { cutoffIdx = i; break }
      }
      if (cutoffIdx >= 0) setMessages(live.slice(0, cutoffIdx))
    }

    setLastUserPayload({ content: text, images, imageAssetIds, imageAttachments })

    const firstActivation = shouldInjectFirstActivationRef.current
    const viewingSessionId = sendSessionId
    const shouldPreserveFirstActivationWelcome =
      showFirstActivationWelcome &&
      firstActivationWelcomeSessionId !== null &&
      firstActivationWelcomeSessionId === viewingSessionId
    shouldInjectFirstActivationRef.current = false
    if (firstActivation) {
      clearWelcomePlaybackTimers()
      setShowFirstActivationWelcome(true)
      setFirstActivationWelcomeText(FIRST_ACTIVATION_WELCOME_MESSAGE)
      setIsFirstActivationWelcomeStreaming(false)
      if (sendSessionId) {
        setFirstActivationWelcomeSessionId(sendSessionId)
      }
    } else if (shouldPreserveFirstActivationWelcome) {
      clearWelcomePlaybackTimers()
      setFirstActivationWelcomeText(FIRST_ACTIVATION_WELCOME_MESSAGE)
      setIsFirstActivationWelcomeStreaming(false)
    } else {
      clearWelcomePlaybackTimers()
      setShowFirstActivationWelcome(false)
      setFirstActivationWelcomeText('')
      setIsFirstActivationWelcomeStreaming(false)
      setFirstActivationWelcomeSessionId(null)
    }

    const userMsg: MessageRecord = {
      id: createClientId('user-msg'),
      role: 'user',
      content: text,
      images: images || undefined,
      imageAttachments,
      thinking: null,
      toolCalls: null,
      createdAt: new Date().toISOString(),
    }
    addMessage(userMsg)

    void startSendWithResolvedTransport(
      text,
      sendSessionId,
      images,
      imageAssetIds,
      false,
      firstActivation,
      false,
      releaseSendLock,
      recommendedQuestion,
      discardUserTurnsFromEnd,
    ).catch(releaseSendLock)
  }, [
    activeStreamKey,
    addMessage,
    clearWelcomePlaybackTimers,
    firstActivationWelcomeSessionId,
    isPreparingSend,
    removeMessage,
    setLastUserPayload,
    setMessages,
    showFirstActivationWelcome,
    startSendWithResolvedTransport,
  ])

  const handleStop = useCallback(() => {
    if (!isSseStreaming) return
    const key = activeStreamKey ?? (currentSessionId ?? '')
    const bucket = useStore.getState().sessionStreams[key]
    if (!bucket) return
    updateStream(key, { stopRequested: true })
    abort(bucket.requestKey)
  }, [isSseStreaming, activeStreamKey, currentSessionId, abort, updateStream])

  const handleRetry = useCallback(() => {
    if (isStreaming || isPreparingSend) return
    const payload = useStore.getState().lastUserPayload
    if (!payload) return
    const retrySessionId = viewSessionIdRef.current ?? null

    // 清历史错误 & 最近一条 interrupted
    const currentMessages = useStore.getState().messages
    let lastInterruptedId: string | null = null
    for (let i = currentMessages.length - 1; i >= 0; i--) {
      const m = currentMessages[i]
      if (m.role !== 'assistant') break
      if (m.interrupted) { lastInterruptedId = m.id; break }
      if (m.errorCode) continue
      break
    }

    // CONTEXT_TOO_LONG 限次：后端每次请求会自动 reactive compact 一轮，
    // 若上一次已是 retry 后又撞同码，说明压缩后仍超窗口，再 retry 无意义（按钮应隐藏，此处兜底防并发）
    const lastErrorMsg = [...currentMessages].reverse().find((m) => m.errorCode)
    if (
      lastErrorMsg?.errorCode === ERROR_CODES.CONTEXT_TOO_LONG &&
      lastErrorMsg.retriedOnce
    ) {
      return
    }
    const isRetry = Boolean(lastErrorMsg)

    for (const m of currentMessages) {
      if (m.errorCode) removeMessage(m.id)
    }
    if (lastInterruptedId) removeMessage(lastInterruptedId)

    void startSendWithResolvedTransport(
      payload.content,
      retrySessionId,
      payload.images,
      payload.imageAssetIds,
      isRetry,
      false,
      Boolean(lastInterruptedId) && !!retrySessionId,
    )
  }, [
    isPreparingSend,
    isStreaming,
    removeMessage,
    startSendWithResolvedTransport,
  ])

  // 点击用户消息的「编辑」：只把该消息回填到输入框（含图片），历史消息保持可见。
  // 正在流式输出时先停止本轮生成，再进入编辑。真正丢弃该消息及其之后的历史发生在重新发送时。
  const handleEditMessage = useCallback((message: MessageRecord) => {
    if (isPreparingSend) return
    if (isSseStreaming) handleStop()
    const liveMessages = useStore.getState().messages
    const targetIdx = liveMessages.findIndex((m) => m.id === message.id)
    if (targetIdx < 0) return

    // 目标（含）到末尾的真实 user 消息条数 = 从末尾往前数的第 N 条
    let turnsFromEnd = 0
    for (let i = targetIdx; i < liveMessages.length; i++) {
      const m = liveMessages[i]
      if (m.role === 'user' && !m.synthetic) turnsFromEnd += 1
    }
    if (turnsFromEnd < 1) return

    pendingEditTurnsRef.current = turnsFromEnd
    inputBarRef.current?.prefill({
      text: message.content,
      attachments: message.imageAttachments,
    })
  }, [isPreparingSend, isSseStreaming, handleStop])

  function handleSelectSession(sessionId: string) {
    suppressCurrentSessionRestoreRef.current = false
    viewSessionIdRef.current = sessionId
    pendingEditTurnsRef.current = null
    closeHistoryImmediately()
    ttsPlayer.stop()
    navigate(`/chat/${sessionId}`, { replace: true })
  }

  function handleNewChat() {
    suppressCurrentSessionRestoreRef.current = true
    viewSessionIdRef.current = null
    pendingEditTurnsRef.current = null
    closeHistoryImmediately()
    // 新建会话时直接回到 /chat；这里仍需立即停掉旧会话朗读，避免残留
    ttsPlayer.stop()
    clearWelcomePlaybackTimers()
    shouldInjectFirstActivationRef.current = false
    setShowFirstActivationWelcome(false)
    setFirstActivationWelcomeText('')
    setIsFirstActivationWelcomeStreaming(false)
    setFirstActivationWelcomeSessionId(null)
    // 新建会话：不 abort 原会话的 SSE，桶由它自生自灭；视图切到空白
    setMessages([])
    setFeedbackMap({})
    setFavoriteMap({})
    setSessionId(null)
    setCurrentSession(null)
    setActiveStreamKey(null)
    clearApprovals()
    clearScheduleConfirmations()
    clearMedicalDocumentSaveSuggestions()
    navigate('/chat', { replace: true })
  }

  const handleDeleteSession = useCallback(async (sessionId: string) => {
    try {
      await api.delete(`/sessions/${sessionId}`)
      removeSessionFromStore(sessionId)
      if (sessionId === currentSessionId) {
        handleNewChat()
      }
    } catch (err) {
      console.error('Failed to delete session:', err)
    }
  }, [currentSessionId, removeSessionFromStore])

  function handleViewMedicalRecord() {
    closeHistoryImmediately()
    const sid = routeSessionId ?? viewSessionIdRef.current ?? null
    const params = new URLSearchParams({ mode: 'edit', returnToSettings: '1' })
    if (sid) params.set('returnSessionId', sid)
    navigate(`/profile?${params.toString()}`)
  }

  const {
    guard: guardHealthConsent,
    hasConsent: hasHealthProfileConsent,
    dialogProps: healthConsentDialogProps,
  } = useHealthProfileConsent()

  useEffect(() => {
    const approvalsRequiringConsent = pendingApprovals.filter((item) => item.requiresHealthProfileConsent)
    if (!currentSessionId || approvalsRequiringConsent.length === 0 || hasHealthProfileConsent) return

    guardHealthConsent(
      () => {},
      () => {
        const latestFields = [
          ...new Set(
            useStore.getState().pendingApprovals
              .filter((item) => item.requiresHealthProfileConsent)
              .map((item) => item.field),
          ),
        ]
        dropApprovalsRequiringHealthProfileConsent()
        if (latestFields.length === 0) return
        void api.post('/medical/profile/authorization-reject', {
          sessionId: currentSessionId,
          fields: latestFields,
        }).catch((err) => {
          console.error('Failed to queue authorization rejected reminder:', err)
        })
      },
    )
  }, [
    currentSessionId,
    dropApprovalsRequiringHealthProfileConsent,
    guardHealthConsent,
    hasHealthProfileConsent,
    pendingApprovals,
  ])

  function handleViewMedicalDocuments() {
    closeHistoryImmediately()
    const sid = routeSessionId ?? viewSessionIdRef.current ?? null
    const params = new URLSearchParams({ returnToSettings: '1' })
    if (sid) params.set('returnSessionId', sid)
    const target = `/medical-records?${params.toString()}`
    guardHealthConsent(
      () => navigate(target),
    )
  }

  function handleViewMaterials() {
    closeHistoryImmediately()
    const sid = routeSessionId ?? viewSessionIdRef.current ?? null
    const params = new URLSearchParams({ returnToSettings: '1' })
    if (sid) params.set('returnSessionId', sid)
    navigate(`/materials?${params.toString()}`)
  }

  function handleViewCheckIns() {
    if (!showCheckInRecordsEntry) return
    closeHistoryImmediately()
    const sid = routeSessionId ?? viewSessionIdRef.current ?? null
    const params = new URLSearchParams({ returnToSettings: '1' })
    if (sid) params.set('returnSessionId', sid)
    navigate(`/check-ins?${params.toString()}`)
  }

  function handleViewScheduledTasks() {
    if (!showScheduledTaskEntry) return
    closeHistoryImmediately()
    const sid = routeSessionId ?? viewSessionIdRef.current ?? null
    const params = new URLSearchParams({ returnToSettings: '1' })
    if (sid) params.set('returnSessionId', sid)
    navigate(`/scheduled-tasks?${params.toString()}`)
  }

  function handleViewDoctor() {
    if (!showMyDoctorEntry) return
    closeHistoryImmediately()
    const sid = routeSessionId ?? viewSessionIdRef.current ?? null
    const params = new URLSearchParams({ returnToSettings: '1' })
    if (sid) params.set('returnSessionId', sid)
    navigate(`/my-doctor?${params.toString()}`)
  }

  function handleViewHealthEducation() {
    if (!showHealthEducationPlaza) return
    const sid = routeSessionId ?? viewSessionIdRef.current ?? null
    const params = new URLSearchParams()
    if (sid) params.set('returnSessionId', sid)
    navigate(`/health-education${params.toString() ? `?${params.toString()}` : ''}`)
  }

  function handleViewMaterialsAdmin() {
    if (!showMaterialsAdminEntry) return
    closeHistoryImmediately()
    navigate('/materials-admin')
  }

  function handleToggleTTS() {
    if (!showTtsControl) return
    if (ttsEnabled) {
      setTtsEnabled(false)
      ttsPlayer.stop()
      return
    }
    ttsPlayer.primeAudioUnlock()
    setTtsEnabled(true)
    // 若当前视图正在流式回答中，补一次 startStream
    const key = activeStreamKey ?? currentSessionId ?? ''
    const bucket = useStore.getState().sessionStreams[key]
    if (bucket?.isStreaming && bucket.processTimeline.isAnswering) {
      ttsPlayer.startStream(key).then(() => {
        const already = bucket.answerText || ''
        if (already) ttsPlayer.pushDelta(already, key)
      }).catch(() => { /* player 里已 console */ })
    }
  }

  const handleHeaderTap = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement | null
    if (target?.closest('button,a,input,textarea,select,[role="button"]')) return
    messageListRef.current?.scrollToTop()
  }, [])

  const drawerActive = showHistory && !isHistoryClosing

  return (
    <div style={styles.container}>
      {showHistory && (
        <HistoryPanel
          currentSessionId={currentSessionId}
          onSelectSession={handleSelectSession}
          onViewMedicalRecord={handleViewMedicalRecord}
	          onViewMedicalDocuments={handleViewMedicalDocuments}
          onViewMaterials={handleViewMaterials}
          onViewCheckIns={handleViewCheckIns}
          onViewScheduledTasks={handleViewScheduledTasks}
	          onViewDoctor={handleViewDoctor}
          onViewMaterialsAdmin={handleViewMaterialsAdmin}
          onOpenNativeDebug={showNativeDebugEntry ? handleOpenNativeDebug : undefined}
          onClose={closeHistory}
          onDeleteSession={handleDeleteSession}
          showDoctorEntry={showMyDoctorEntry}
          showCheckInEntry={showCheckInRecordsEntry}
          showScheduledTaskEntry={showScheduledTaskEntry}
          showMaterialsAdminEntry={showMaterialsAdminEntry}
          showLlmContextDashboardEntry={showLlmContextDashboard}
          onOpenDebug={() => { closeHistoryImmediately(); setShowDebug(true) }}
          closing={isHistoryClosing}
        />
      )}

      <div
        style={{
          ...styles.chatSurface,
          ...(drawerActive ? styles.chatSurfaceDrawerOpen : {}),
        }}
      >
      <div style={styles.header} onClick={handleHeaderTap}>
        <button
          style={styles.headerBtnLeft}
          onClick={() => openHistory()}
          title="对话记录"
        >
          <svg width="20" height="20" style={headerIconSvgStyle} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="3" y1="12" x2="21" y2="12" />
            <line x1="3" y1="6" x2="21" y2="6" />
            <line x1="3" y1="18" x2="21" y2="18" />
          </svg>
        </button>

        <div style={styles.headerRight}>
          {showHealthEducationPlaza && (
            <button
              style={styles.educationHeaderBtn}
              onClick={handleViewHealthEducation}
              title="医生说广场"
            >
              医生说
            </button>
          )}
          {showTtsControl && (
            <button
              style={{
                ...styles.headerBtnRight,
                ...(ttsEnabled ? { color: 'var(--color-brand)' } : {}),
              }}
              onClick={handleToggleTTS}
              title={ttsEnabled ? '关闭语音播报' : '开启语音播报'}
            >
              {ttsEnabled ? (
                ttsPhase === 'playing' ? (
                  <svg width="18" height="18" style={headerIconSvgStyle} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                    <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                    <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                  </svg>
                ) : (
                  <svg width="18" height="18" style={headerIconSvgStyle} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                    <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                  </svg>
                )
              ) : (
                <svg width="18" height="18" style={headerIconSvgStyle} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                  <line x1="23" y1="9" x2="17" y2="15" />
                  <line x1="17" y1="9" x2="23" y2="15" />
                </svg>
              )}
            </button>
          )}
          {showNewChatHeaderButton && (
            <button
              style={styles.newChatHeaderBtn}
              onClick={handleNewChat}
              title="新对话"
            >
              <img src={newChatIconUrl} alt="" aria-hidden="true" width={20} height={20} style={styles.newChatHeaderIcon} draggable={false} />
            </button>
          )}
        </div>
      </div>
      {sessionNotFound ? (
        <div style={styles.notFoundWrap}>
          <p style={styles.notFoundTitle}>对话不存在或无权访问</p>
          <p style={styles.notFoundHint}>该链接可能已被删除，或属于其他账号</p>
          <button style={styles.notFoundBtn} onClick={handleNewChat}>
            开启新对话
          </button>
        </div>
      ) : (
        <>
          <MessageList
            ref={messageListRef}
            messages={messages}
            isStreaming={isStreaming}
            isCompacting={isCompacting}
            processTimeline={processTimeline}
            answerText={answerText}
            streamingToolCalls={streamingToolCalls}
            responseStartTime={responseStartTime}
            onSuggestionClick={(text, interaction) => handleSend(text, undefined, undefined, undefined, interaction)}
            onAskUserQuestionSubmit={(content) => handleSend(content)}
            onTodoFeedbackSubmit={(content) => handleSend(content)}
            sessionId={currentSessionId}
            feedbackMap={feedbackMap}
            favoriteMap={favoriteMap}
            processDurationMap={processDurationMap}
            onRetry={handleRetry}
            onEditMessage={handleEditMessage}
            onFavoriteChange={setFavorite}
            hasHealthProfileConsent={hasHealthProfileConsent}
            onRequireHealthProfileConsent={guardHealthConsent}
            focusMessageId={focusMessageId}
            firstActivationWelcome={showFirstActivationWelcome
              ? {
                  content: firstActivationWelcomeText,
                  streaming: isFirstActivationWelcomeStreaming,
                }
              : null}
          />
          <InputBar
            ref={inputBarRef}
            onSend={handleSend}
            disabled={isPreparingSend || isSyncPending}
            isStreaming={isSseStreaming}
            onStop={handleStop}
          />
        </>
      )}

      </div>
      {drawerActive && (
        <button
          type="button"
          aria-label="关闭对话记录"
          style={styles.drawerDismissLayer}
          onTouchStart={(event) => {
            event.preventDefault()
            closeHistory()
          }}
          onClick={(event) => {
            event.preventDefault()
            closeHistory()
          }}
        />
      )}
      {showLlmContextDashboard && showDebug && (
        <DebugPanel
          sessionId={currentSessionId}
          onClose={() => setShowDebug(false)}
        />
      )}
      <HealthProfileConsentDialog {...healthConsentDialogProps} />
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    position: 'relative',
    height: '100%',
    background: 'var(--color-shell-bg)',
    overflow: 'hidden',
  },
  chatSurface: {
    position: 'absolute' as const,
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    height: '100%',
    background:
      'linear-gradient(180deg, rgba(255,255,255,0.78) 0%, rgba(255,249,244,0.96) 42%, rgba(255,246,239,0.98) 100%), radial-gradient(ellipse at 22% 28%, rgba(255, 121, 54, 0.10), transparent 34%), radial-gradient(ellipse at 100% 18%, rgba(255, 176, 122, 0.18), transparent 38%)',
    backdropFilter: 'blur(12px) saturate(1.03)',
    WebkitBackdropFilter: 'blur(12px) saturate(1.03)',
    overflow: 'hidden',
    zIndex: 40,
    transform: 'translate3d(0, 0, 0) scale(1)',
    transformOrigin: 'left center',
    borderRadius: 0,
    boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.58)',
    transition: `transform ${DRAWER_ANIM_MS}ms cubic-bezier(0.22, 1, 0.36, 1), border-radius ${DRAWER_ANIM_MS}ms cubic-bezier(0.22, 1, 0.36, 1), filter ${DRAWER_ANIM_MS}ms cubic-bezier(0.22, 1, 0.36, 1)`,
    willChange: 'transform, border-radius, filter',
  },
  chatSurfaceDrawerOpen: {
    transform: 'translate3d(var(--chat-drawer-offset, 326px), 0, 0) scale(0.995)',
    borderRadius: 42,
    boxShadow: '-28px 0 70px rgba(74, 63, 58, 0.20), -8px 0 24px rgba(212, 135, 108, 0.10), 0 0 0 1px rgba(255,255,255,0.62), inset 1px 0 0 rgba(255,255,255,0.76)',
    filter: 'saturate(0.98) brightness(1.01)',
  },
  drawerDismissLayer: {
    position: 'absolute' as const,
    top: 0,
    right: 0,
    bottom: 0,
    left: 'var(--chat-drawer-offset, 326px)',
    zIndex: 80,
    border: 'none',
    padding: 0,
    margin: 0,
    borderRadius: 0,
    background: 'transparent',
    cursor: 'pointer',
    touchAction: 'manipulation',
    WebkitTapHighlightColor: 'transparent',
  },
  notFoundWrap: {
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    padding: 24,
    textAlign: 'center',
  },
  notFoundTitle: {
    fontSize: 16,
    fontWeight: 500,
    color: 'var(--color-text)',
    margin: 0,
  },
  notFoundHint: {
    fontSize: 13,
    color: 'var(--color-text-muted)',
    margin: '0 0 16px',
  },
  notFoundBtn: {
    padding: '10px 20px',
    borderRadius: 12,
    background: 'var(--color-brand)',
    color: '#fff',
    fontSize: 14,
    fontWeight: 500,
    border: 'none',
    cursor: 'pointer',
  },
  header: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) auto minmax(0, 1fr)',
    alignItems: 'center',
    height: 'calc(var(--header-height, 76px) + var(--safe-area-top))',
    padding: '0 var(--chat-header-side-padding, 16px)',
    paddingLeft: 'calc(var(--chat-header-side-padding, 16px) + var(--safe-area-left))',
    paddingRight: 'calc(var(--chat-header-side-padding, 16px) + var(--safe-area-right))',
    paddingTop: 'calc(var(--chat-header-padding-top, 16px) + var(--safe-area-top))',
    background: 'linear-gradient(to bottom, rgba(255, 249, 244, 0.88) 0%, rgba(255, 249, 244, 0.32) 62%, transparent 100%)',
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 20,
    paddingBottom: 'var(--chat-header-padding-bottom, 12px)',
  },
  headerBtnLeft: {
    width: 'var(--chat-header-button-size, 40px)',
    height: 'var(--chat-header-button-size, 40px)',
    borderRadius: 'var(--chat-header-button-radius, 14px)',
    background: 'rgba(255, 255, 255, 0.92)',
    backdropFilter: 'blur(16px)',
    WebkitBackdropFilter: 'blur(16px)',
    color: '#1F1C19',
    border: '1px solid rgba(255,255,255,0.76)',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    boxShadow: '0 12px 26px rgba(74, 52, 39, 0.08), inset 0 1px 0 rgba(255,255,255,0.88)',
    transition: 'transform 0.2s',
    flexShrink: 0,
    justifySelf: 'start',
  },
  newChatHeaderBtn: {
    width: 'var(--chat-header-button-size, 40px)',
    height: 'var(--chat-header-button-size, 40px)',
    borderRadius: 'var(--chat-header-button-radius, 14px)',
    background: 'rgba(255, 255, 255, 0.92)',
    backdropFilter: 'blur(16px)',
    WebkitBackdropFilter: 'blur(16px)',
    color: '#1F1C19',
    border: '1px solid rgba(255,255,255,0.76)',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    boxShadow: '0 12px 26px rgba(74, 52, 39, 0.08), inset 0 1px 0 rgba(255,255,255,0.88)',
    transition: 'transform 0.2s',
    animation: 'scaleIn 0.25s ease',
    flexShrink: 0,
  },
  newChatHeaderIcon: {
    width: 'var(--chat-header-icon-size, 20px)',
    height: 'var(--chat-header-icon-size, 20px)',
    display: 'block',
  },
  headerRight: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    gridColumn: 3,
    justifySelf: 'end',
  },
  educationHeaderBtn: {
    height: 'var(--chat-header-button-size, 40px)',
    minWidth: 'var(--chat-education-button-min-width, 104px)',
    borderRadius: 999,
    background: 'rgba(255, 255, 255, 0.78)',
    backdropFilter: 'blur(16px)',
    WebkitBackdropFilter: 'blur(16px)',
    color: 'var(--color-primary)',
    border: '1px solid rgba(255, 218, 196, 0.62)',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    boxShadow: '0 12px 26px rgba(74, 52, 39, 0.07), inset 0 1px 0 rgba(255,255,255,0.86)',
    fontSize: 'var(--chat-education-button-font-size, 16px)',
    fontWeight: 800,
    padding: '0 var(--chat-education-button-padding-x, 16px)',
    flexShrink: 0,
  },
  headerBtnRight: {
    width: 'var(--chat-header-button-size, 40px)',
    height: 'var(--chat-header-button-size, 40px)',
    borderRadius: 'var(--chat-header-button-radius, 14px)',
    background: 'rgba(255, 255, 255, 0.92)',
    backdropFilter: 'blur(16px)',
    WebkitBackdropFilter: 'blur(16px)',
    color: '#1F1C19',
    border: '1px solid rgba(255,255,255,0.76)',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    boxShadow: '0 12px 26px rgba(74, 52, 39, 0.08), inset 0 1px 0 rgba(255,255,255,0.88)',
    transition: 'color 0.2s',
    flexShrink: 0,
  },
}
