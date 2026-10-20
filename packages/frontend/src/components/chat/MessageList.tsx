import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, type Ref } from 'react'
import { useStickToBottom } from 'use-stick-to-bottom'
import { ERROR_CODES, type MessageRecord, type ApiResponse } from '@health-agent/shared'
import type { ProcessTimeline } from '../../stores/slices/chat.js'
import type { NativeBridgeEvent } from '../../lib/nativeBridge.js'
import { useStore } from '../../stores/index.js'
import { api } from '../../services/api.js'
import MessageBubble from './MessageBubble.js'
import AssistantMessage, { collectMedicalLiteratureSources, collectMedicalRiskResources } from './AssistantMessage.js'
import CompactionIndicator from './CompactionIndicator.js'
import WelcomeMessage, { AppInstallCtaBanner } from './WelcomeMessage.js'
import type { RecommendedQuestionInteraction } from '@health-agent/shared'
import ErrorMessage from './ErrorMessage.js'
import ApprovalCard from './ApprovalCard.js'
import ScheduleConfirmCard from './ScheduleConfirmCard.js'
import ProfileUpdateNotice from './ProfileUpdateNotice.js'
import FirstActivationWelcome from './FirstActivationWelcome.js'
import MedicalDocumentSaveSuggestionCard from './MedicalDocumentSaveSuggestionCard.js'
import { scrollElementToTop } from '../../utils/scroll.js'

const IOS_TOP_TAP_ZONE_PX = 64

const isHarmonyMobile = () => {
  if (typeof navigator === 'undefined') return false
  return /HarmonyOS|OpenHarmony|ArkWeb/i.test(navigator.userAgent)
}

const isIosNativeShell = () => {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') return false
  return /iPhone|iPad|iPod/i.test(navigator.userAgent) || window.__CXNativeBridge__?.info?.platform === 'ios'
}

const isInteractiveTarget = (target: EventTarget | null) => {
  if (!(target instanceof Element)) return false
  return Boolean(target.closest('button, a, input, textarea, select, [role="button"], [contenteditable="true"]'))
}

function scrollMessageIntoView(root: HTMLElement, target: HTMLElement): void {
  const rootRect = root.getBoundingClientRect()
  const targetRect = target.getBoundingClientRect()
  const relativeTop = targetRect.top - rootRect.top
  const centerOffset = Math.max((root.clientHeight - targetRect.height) / 2, 24)
  const nextTop = Math.max(0, root.scrollTop + relativeTop - centerOffset)
  root.scrollTo({ top: nextTop, behavior: 'auto' })
}

const STREAMING_MESSAGE_RENDER_KEY = 'assistant-streaming-current'

export interface MessageListHandle {
  scrollToTop: () => void
}

interface Props {
  ref?: Ref<MessageListHandle>
  messages: MessageRecord[]
  isStreaming: boolean
  isCompacting: boolean
  processTimeline: ProcessTimeline
  answerText: string
  streamingToolCalls: MessageRecord['toolCalls']
  responseStartTime: number | null
  onSuggestionClick: (text: string, interaction: RecommendedQuestionInteraction) => void
  onAskUserQuestionSubmit?: (content: string) => void
  onTodoFeedbackSubmit?: (content: string) => void
  sessionId: string | null
  feedbackMap: Record<string, 'like' | 'dislike'>
  favoriteMap: Record<string, true>
  processDurationMap: Record<string, number>
  onRetry?: () => void
  onEditMessage?: (message: MessageRecord) => void
  onFavoriteChange?: (messageId: string, saved: boolean) => void
  hasHealthProfileConsent?: boolean
  onRequireHealthProfileConsent: (onAgree: () => void, onReject?: () => void) => void
  focusMessageId?: string | null
  firstActivationWelcome?: {
    content: string
    streaming: boolean
  } | null
}

export default function MessageList({
  ref,
  messages,
  isStreaming,
  isCompacting,
  processTimeline,
  answerText,
  streamingToolCalls,
  onSuggestionClick,
  onAskUserQuestionSubmit,
  onTodoFeedbackSubmit,
  sessionId,
  feedbackMap,
  favoriteMap,
  processDurationMap,
  responseStartTime,
  onRetry,
  onEditMessage,
  onFavoriteChange,
  hasHealthProfileConsent = false,
  onRequireHealthProfileConsent,
  focusMessageId = null,
  firstActivationWelcome = null,
}: Props) {
  const { scrollRef, contentRef, isAtBottom, scrollToBottom } = useStickToBottom({
    resize: 'smooth',
    initial: 'instant',
  })
  const hasFocusMessageTarget = Boolean(focusMessageId)

  useImperativeHandle(ref, () => ({
    scrollToTop: () => scrollElementToTop(scrollRef.current),
  }), [scrollRef])

  const medicalRiskResources = useMemo(() => {
    const toolCalls = messages.flatMap((message) => message.toolCalls ?? [])
    if (isStreaming && streamingToolCalls?.length) {
      toolCalls.push(...streamingToolCalls)
    }
    return collectMedicalRiskResources(toolCalls)
  }, [isStreaming, messages, streamingToolCalls])
  const medicalLiteratureSources = useMemo(() => {
    const toolCalls = messages.flatMap((message) => message.toolCalls ?? [])
    if (isStreaming && streamingToolCalls?.length) {
      toolCalls.push(...streamingToolCalls)
    }
    return collectMedicalLiteratureSources(toolCalls)
  }, [isStreaming, messages, streamingToolCalls])

  // 新一轮发送/重试启动瞬间强制回底，重置 use-stick-to-bottom 的 escape lock，
  // 否则上一轮结束时若用户轻微上滑（偏离底部 >70px），后续流式输出将不再自动跟随
  const prevStreamingRef = useRef(false)
  useEffect(() => {
    if (isStreaming && !prevStreamingRef.current) {
      scrollToBottom()
    }
    prevStreamingRef.current = isStreaming
  }, [isStreaming, scrollToBottom])

  useEffect(() => {
    if (!hasFocusMessageTarget || !focusMessageId) return
    let cancelled = false
    let frameId: number | null = null
    const timerIds: number[] = []
    const targetMessageId = focusMessageId

    // 普通进入会话由 use-stick-to-bottom 的 initial 行为保持“最新消息在底部”；
    // 带 focusMessageId 的入口只接管初始定位，避免破坏后续发送消息时的贴底跟随。
    const focusTarget = () => {
      if (cancelled) return
      const root = scrollRef.current
      if (!root) return
      const target = root.querySelector(`[data-message-id="${targetMessageId}"]`) as HTMLElement | null
      if (!target) return
      scrollMessageIntoView(root, target)
    }

    frameId = requestAnimationFrame(focusTarget)
    for (const delay of [60, 180, 360, 700]) {
      timerIds.push(window.setTimeout(focusTarget, delay))
    }

    return () => {
      cancelled = true
      if (frameId !== null) cancelAnimationFrame(frameId)
      for (const timerId of timerIds) window.clearTimeout(timerId)
    }
  }, [hasFocusMessageTarget, focusMessageId, messages, scrollRef])

  useEffect(() => {
    const scrollToTop = () => {
      scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
    }

    function handleNativeEvent(event: Event) {
      const detail = (event as CustomEvent<NativeBridgeEvent>).detail
      if (detail?.module !== 'ui' || detail.event !== 'statusBarTap') return
      scrollToTop()
    }

    function handleTouchEnd(event: TouchEvent) {
      if (!isIosNativeShell() || isInteractiveTarget(event.target)) return
      const touch = event.changedTouches[0]
      if (!touch || touch.clientY > IOS_TOP_TAP_ZONE_PX) return
      scrollToTop()
    }

    window.addEventListener('cx-native-event', handleNativeEvent)
    window.addEventListener('touchend', handleTouchEnd, { passive: true })
    return () => {
      window.removeEventListener('cx-native-event', handleNativeEvent)
      window.removeEventListener('touchend', handleTouchEnd)
    }
  }, [scrollRef])

  const hasMoreMessages = useStore((s) => s.hasMoreMessages)
  const oldestMessageCursor = useStore((s) => s.oldestMessageCursor)
  const isLoadingOlder = useStore((s) => s.isLoadingOlder)
  const prependMessages = useStore((s) => s.prependMessages)
  const setHasMoreMessages = useStore((s) => s.setHasMoreMessages)
  const setOldestMessageCursor = useStore((s) => s.setOldestMessageCursor)
  const setLoadingOlder = useStore((s) => s.setLoadingOlder)

  const topSentinelRef = useRef<HTMLDivElement>(null)
  const loadingGuardRef = useRef(false)

  const loadOlder = useCallback(async () => {
    if (!sessionId || !oldestMessageCursor || loadingGuardRef.current) return
    loadingGuardRef.current = true
    setLoadingOlder(true)
    const scrollEl = scrollRef.current
    const prevHeight = scrollEl?.scrollHeight ?? 0
    const prevTop = scrollEl?.scrollTop ?? 0
    try {
      const res = await api.get<ApiResponse<{
        messages: MessageRecord[]
        hasMore: boolean
        oldestCreatedAt: string | null
      }>>(
        `/sessions/${sessionId}?before=${encodeURIComponent(oldestMessageCursor)}&limit=30`,
      )
      if (res.data) {
        const older = res.data.messages ?? []
        if (older.length > 0) prependMessages(older)
        setHasMoreMessages(res.data.hasMore)
        setOldestMessageCursor(res.data.oldestCreatedAt)
        // 保持视觉锚点：新消息从顶部插入后，把 scrollTop 补偿 scrollHeight 增量，避免内容跳动
        requestAnimationFrame(() => {
          const el = scrollRef.current
          if (el) el.scrollTop = el.scrollHeight - prevHeight + prevTop
        })
      }
    } catch {
      /* 静默失败，用户可继续滚动重试 */
    } finally {
      loadingGuardRef.current = false
      setLoadingOlder(false)
    }
  }, [
    sessionId,
    oldestMessageCursor,
    scrollRef,
    prependMessages,
    setHasMoreMessages,
    setOldestMessageCursor,
    setLoadingOlder,
  ])

  useEffect(() => {
    if (!hasMoreMessages) return
    const sentinel = topSentinelRef.current
    const root = scrollRef.current
    if (!sentinel || !root) return
    if (typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void loadOlder()
      },
      { root, rootMargin: '200px 0px 0px 0px', threshold: 0 },
    )
    io.observe(sentinel)
    return () => io.disconnect()
  }, [hasMoreMessages, loadOlder, scrollRef])

  const hasVisibleFirstActivationWelcome = Boolean(
    firstActivationWelcome && (
      firstActivationWelcome.streaming ||
      firstActivationWelcome.content.trim().length > 0
    ),
  )
  const showDefaultWelcome = !hasVisibleFirstActivationWelcome && messages.length === 0 && !isStreaming
  const isDefaultWelcomeOnly = showDefaultWelcome

  const scrollBtnStyle = isHarmonyMobile()
    ? { ...styles.scrollBtn, bottom: 'calc(var(--input-bar-height, 80px) + var(--input-bar-floating-lift, var(--input-bar-lift, 32px)) + 24px)' }
    : styles.scrollBtn
  // 滑动消息区域时收起键盘，让顶栏重新出现（移动端体验）
  const handleTouchMove = useCallback(() => {
    const active = document.activeElement as HTMLElement | null
    if (active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT')) {
      active.blur()
    }
  }, [])

  const containerStyle = isDefaultWelcomeOnly
    ? { ...styles.container, ...styles.welcomeContainer }
    : styles.container
  const contentStyle = isDefaultWelcomeOnly
    ? { ...styles.content, ...styles.welcomeContent }
    : styles.content
  const wrapperStyle = isDefaultWelcomeOnly
    ? { ...styles.wrapper, ...styles.welcomeWrapper }
    : styles.wrapper

  return (
    <div style={wrapperStyle}>
      <div ref={scrollRef} style={containerStyle} onTouchMove={handleTouchMove}>
        <div ref={contentRef} style={contentStyle}>
          <div ref={topSentinelRef} style={{ height: isDefaultWelcomeOnly ? 0 : 1 }} />
          {isLoadingOlder && (
            <div style={styles.topLoader} aria-label="加载更早消息中">
              <span style={styles.spinner} />
            </div>
          )}

          {hasVisibleFirstActivationWelcome && firstActivationWelcome && (
            <>
              <AppInstallCtaBanner containerStyle={styles.firstActivationAppInstallCta} />
              <div style={styles.firstActivationWelcome}>
                <div style={styles.firstActivationAvatar}>HA</div>
                <div style={styles.firstActivationContent}>
                  <FirstActivationWelcome
                    content={firstActivationWelcome.content}
                    streaming={firstActivationWelcome.streaming}
                  />
                </div>
              </div>
            </>
          )}

          {showDefaultWelcome && (
            <WelcomeMessage onSuggestionClick={onSuggestionClick} sessionId={sessionId} />
          )}

          {(() => {
            let activeSyntheticDocs: NonNullable<MessageRecord['syntheticDocs']> | undefined
            let activeSyntheticCommunicationCards: NonNullable<MessageRecord['syntheticCommunicationCards']> | undefined
            const hasNewerRealUserAfterIndex: boolean[] = new Array(messages.length)
            let seenNewerRealUser = false

            for (let i = messages.length - 1; i >= 0; i--) {
              const msg = messages[i]
              hasNewerRealUserAfterIndex[i] = seenNewerRealUser
              if (msg.role === 'user' && !msg.synthetic) {
                seenNewerRealUser = true
              }
            }

            const renderedMessages = messages.map((msg, idx) => {
              if (msg.errorCode) {
                // CONTEXT_TOO_LONG 压缩后仍失败：禁掉 retry 按钮，避免无意义循环
                const canRetry = !(msg.errorCode === ERROR_CODES.CONTEXT_TOO_LONG && msg.retriedOnce)
                return (
                  <div key={msg.id} data-message-id={msg.id}>
                    <ErrorMessage errorCode={msg.errorCode} onRetry={onRetry} canRetry={canRetry} />
                  </div>
                )
              }
              // 合成 user 消息（saved_content 读取的病历原图 / 沟通卡片引用）不渲染气泡
              if (msg.role === 'user' && msg.synthetic) {
                if (msg.syntheticDocs?.length) {
                  activeSyntheticDocs = [...(activeSyntheticDocs ?? []), ...msg.syntheticDocs]
                }
                if (msg.syntheticCommunicationCards?.length) {
                  activeSyntheticCommunicationCards = [
                    ...(activeSyntheticCommunicationCards ?? []),
                    ...msg.syntheticCommunicationCards,
                  ]
                }
                return null
              }
              // 只给最新一条被中断的消息挂重试入口，历史气泡保留只读语义
              const isLatestInterrupted = msg.role === 'assistant' && msg.interrupted && idx === messages.length - 1
              if (msg.role === 'user') {
                activeSyntheticDocs = undefined
                activeSyntheticCommunicationCards = undefined
                return (
                  <div key={msg.id} data-message-id={msg.id}>
                    <MessageBubble
                      message={msg}
                      onEditMessage={onEditMessage}
                    />
                  </div>
                )
              }
              const hasNewerRealUserMessage = hasNewerRealUserAfterIndex[idx] ?? false
              const nextMsg = messages[idx + 1]
              const askUserQuestionAnswerText =
                nextMsg?.role === 'user' && !nextMsg.synthetic ? nextMsg.content : undefined
              return (
                <div
                  key={isLatestInterrupted ? STREAMING_MESSAGE_RENDER_KEY : msg.id}
                  data-message-id={msg.id}
                  style={focusMessageId === msg.id ? styles.focusedMessage : undefined}
                >
                  <AssistantMessage
                    message={msg}
                    sessionId={sessionId}
                    askUserQuestionAnswerText={askUserQuestionAnswerText}
                    feedback={feedbackMap[msg.id] ?? null}
                    isFavorited={favoriteMap[msg.id] === true}
                    processDurationMs={msg.processDurationMs ?? processDurationMap[msg.id]}
                    onRetry={isLatestInterrupted ? onRetry : undefined}
                    referenceDocs={activeSyntheticDocs}
                    referenceCommunicationCards={activeSyntheticCommunicationCards}
                    medicalRiskResources={medicalRiskResources}
                    medicalLiteratureSources={medicalLiteratureSources}
                    supersedeCheckInDrafts={hasNewerRealUserMessage}
                    hideAskUserQuestion={hasNewerRealUserMessage}
                    onAskUserQuestionSubmit={onAskUserQuestionSubmit}
                    onTodoFeedbackSubmit={onTodoFeedbackSubmit}
                    onFavoriteChange={onFavoriteChange}
                  />
                </div>
              )
            })

            return (
              <>
                {renderedMessages}

                {/* Streaming state */}
                {isStreaming && (
                  isCompacting ? (
                    <CompactionIndicator />
                  ) : (
                    <div key={STREAMING_MESSAGE_RENDER_KEY} data-message-id="streaming">
                      <AssistantMessage
                        isStreaming
                        timeline={processTimeline}
                        answerText={answerText}
                        toolCalls={streamingToolCalls}
                        sessionId={sessionId}
                        timestamp={responseStartTime}
                        referenceDocs={activeSyntheticDocs}
                        referenceCommunicationCards={activeSyntheticCommunicationCards}
                        medicalRiskResources={medicalRiskResources}
                        medicalLiteratureSources={medicalLiteratureSources}
                        onAskUserQuestionSubmit={onAskUserQuestionSubmit}
                        onTodoFeedbackSubmit={onTodoFeedbackSubmit}
                      />
                    </div>
                  )
                )}
              </>
            )
          })()}

          <ProfileNotices />
          <MedicalDocumentSaveSuggestions onRequireHealthProfileConsent={onRequireHealthProfileConsent} />
          <ApprovalCards hasHealthProfileConsent={hasHealthProfileConsent} />
          <ScheduleConfirmCards />

          <div style={{ height: isDefaultWelcomeOnly ? 0 : 8 }} />
        </div>
      </div>

      {/* Scroll-to-bottom FAB */}
      {!isDefaultWelcomeOnly && !isAtBottom && (
        <button
          style={scrollBtnStyle}
          onClick={() => scrollToBottom()}
          aria-label="滚动到底部"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
      )}
    </div>
  )
}

function ApprovalCards({ hasHealthProfileConsent }: { hasHealthProfileConsent: boolean }) {
  const pendingApprovals = useStore((s) => s.pendingApprovals)
  if (pendingApprovals.length === 0) return null
  const head = pendingApprovals.find(
    (item) => !item.requiresHealthProfileConsent || hasHealthProfileConsent,
  )
  if (!head) return null
  return <ApprovalCard key={head.approvalId} payload={head} />
}

function ScheduleConfirmCards() {
  const pending = useStore((s) => s.pendingScheduleConfirmations)
  const messages = useStore((s) => s.messages)
  if (pending.length === 0) return null
  // 已被时间线节点内联渲染的确认卡（其所属消息在已加载窗口内）不在底部重复展示；
  // 仅为 messageId 缺失或所属消息已翻页移出窗口的边缘情况保留底部兜底。
  const inViewMessageIds = new Set(messages.map((m) => m.id))
  const head = pending.find((c) => c.messageId == null || !inViewMessageIds.has(c.messageId))
  if (!head) return null
  return <ScheduleConfirmCard key={head.confirmationId} payload={head} />
}

function ProfileNotices() {
  const notices = useStore((s) => s.profileNotices)
  if (notices.length === 0) return null
  return (
    <>
      {notices.map((n) => (
        <ProfileUpdateNotice key={n.noticeId} payload={n} />
      ))}
    </>
  )
}

function MedicalDocumentSaveSuggestions({
  onRequireHealthProfileConsent,
}: {
  onRequireHealthProfileConsent: (onAgree: () => void, onReject?: () => void) => void
}) {
  const suggestions = useStore((s) => s.medicalDocumentSaveSuggestions)
  if (suggestions.length === 0) return null
  return (
    <>
      {suggestions.map((payload) => (
        <MedicalDocumentSaveSuggestionCard
          key={payload.suggestionId}
          payload={payload}
          onRequireHealthProfileConsent={onRequireHealthProfileConsent}
        />
      ))}
    </>
  )
}

const styles: Record<string, React.CSSProperties> = {
  wrapper: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 'calc(var(--keyboard-offset, 0px) + var(--native-keyboard-offset, 0px))',
    overflow: 'hidden',
    transition: 'bottom 0.2s ease',
  },
  welcomeWrapper: {
    top: 'calc(var(--header-height, 76px) + var(--safe-area-top))',
    bottom: 'calc(var(--input-bar-height, 80px) + var(--input-bar-floating-lift, var(--input-bar-lift, 32px)) + var(--keyboard-offset, 0px) + var(--native-keyboard-offset, 0px))',
  },
  container: {
    height: '100%',
    overflowY: 'auto',
    overscrollBehavior: 'contain',
    WebkitOverflowScrolling: 'touch',
  },
  welcomeContainer: {
    overflowY: 'auto',
    WebkitOverflowScrolling: 'touch',
  },
  content: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    paddingTop: 'calc(var(--header-height) + var(--safe-area-top) + 8px)',
    paddingBottom: 'calc(var(--input-bar-height, 80px) + var(--input-bar-floating-lift, var(--input-bar-lift, 32px)))',
  },
  welcomeContent: {
    height: '100%',
    minHeight: 0,
    gap: 0,
    paddingTop: 0,
    paddingBottom: 0,
  },
  firstActivationWelcome: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 'var(--chat-row-gap, 10px)',
    padding: '24px var(--chat-content-padding-right, var(--chat-horizontal-padding, 16px)) 8px var(--chat-content-padding-left, var(--chat-horizontal-padding, 16px))',
  },
  firstActivationAvatar: {
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
    marginTop: 4,
  },
  firstActivationContent: {
    flex: 1,
    minWidth: 0,
  },
  firstActivationAppInstallCta: {
    display: 'flex',
    justifyContent: 'center',
    padding: '16px var(--chat-horizontal-padding, 16px) 0',
  },
  topLoader: {
    display: 'flex',
    justifyContent: 'center',
    padding: '8px 0',
  },
  spinner: {
    width: 16,
    height: 16,
    borderRadius: '50%',
    border: '2px solid var(--color-border)',
    borderTopColor: 'var(--color-text-secondary)',
    animation: 'spin 0.8s linear infinite',
  },
  scrollBtn: {
    position: 'absolute',
    bottom: 'calc(var(--input-bar-height, 80px) + var(--input-bar-floating-lift, var(--input-bar-lift, 32px)) + 8px)',
    right: 'var(--chat-scroll-button-right, 16px)',
    width: 36,
    height: 36,
    borderRadius: '50%',
    background: 'var(--color-bg)',
    border: '1px solid var(--color-border)',
    boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: 'var(--color-text-secondary)',
    zIndex: 21,
    transition: 'bottom 0.2s ease',
    animation: 'fadeIn 0.2s ease',
  },
  focusedMessage: {
    borderRadius: 14,
    background: 'rgba(250, 238, 229, 0.58)',
    boxShadow: '0 0 0 1px rgba(212, 135, 108, 0.18)',
    scrollMarginBlock: '120px',
    transition: 'background 0.2s ease, box-shadow 0.2s ease',
  },
}
