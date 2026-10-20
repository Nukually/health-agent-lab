import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ChangeEvent } from 'react'
import type { ApiResponse, MedicalRiskResourceTodoContext, MedicalRiskVideoResource, TodoStartResponse } from '@health-agent/shared'
import { reportAnalyticsEvent } from '../../services/analytics.js'
import { api } from '../../services/api.js'
import {
  type VideoResourceFollowTrigger,
  type SavedVideoResourceFollowSession,
  ensureVideoResourceFavoriteSnapshot,
  findVideoResourceFavorite,
  getVideoResourceFavoriteId,
  hasVideoResourceFavorite,
  removeVideoResourceFavorite,
  saveVideoResourceFavorite,
} from '../../lib/videoResourceFavorites.js'
import { buildClientEnvironmentHint } from '../../utils/clientEnvironment.js'
import { ttsPlayer } from '../../hooks/useTTSPlayer.js'
import { setVideoResourcePlaybackActive } from '../../lib/interventionFollowAudio.js'
import DiscomfortFeedbackBar from './DiscomfortFeedbackBar.js'
import TodoFeedbackBar from './TodoFeedbackBar.js'
import {
  getMobilePracticeFeedbackDelayMs,
  shouldShowVideoPracticeFeedback,
  type VideoPracticeFeedbackState,
} from './videoPracticeFeedback.js'

interface Props {
  resource: MedicalRiskVideoResource
  sessionId: string | null
  source?: 'chat_inline' | 'materials' | 'shared_view'
  sharedToken?: string | null
  initialFollowedSec?: number
  initialSaved?: boolean
  onFavoriteChange?: (saved: boolean) => void
  onTodoFeedbackSubmit?: (content: string) => void
}

type PlaybackEndReason = 'pause' | 'pagehide' | 'unmount' | 'ended' | 'iframe_retap' | 'visibility_hidden' | 'fullscreen_exit' | 'midpoint_feedback'
type FollowMode = 'idle' | 'following' | 'paused'
type MobileEstimateStartSignal = 'iframe_click' | 'fullscreen_enter'
type TodoFeedbackState = VideoPracticeFeedbackState

type BiliIframePlayer = {
  getCurrentTime?: () => number
  getDuration?: () => number
  isPaused?: () => boolean
}

function isTodoContextClosed(context: MedicalRiskResourceTodoContext): boolean {
  return context.status === 'completed' || context.status === 'not_practiced'
}

interface ActivePlaybackSession {
  id: string
  index: number
  startedAtMs: number
  startedAtIso: string
  startFollowedMs: number
  startFollowedSec: number
  startPlayheadSec: number
  trigger: SavedVideoResourceFollowSession['trigger']
}

function FavoriteIcon({ active }: { active: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill={active ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M19 21l-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
    </svg>
  )
}

function FullscreenIcon({ active }: { active: boolean }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {active ? (
        <>
          <path d="M8 3v5H3" />
          <path d="M16 3v5h5" />
          <path d="M8 21v-5H3" />
          <path d="M16 21v-5h5" />
        </>
      ) : (
        <>
          <path d="M3 9V3h6" />
          <path d="M21 9V3h-6" />
          <path d="M3 15v6h6" />
          <path d="M21 15v6h-6" />
        </>
      )}
    </svg>
  )
}

function formatDuration(totalSec: number): string {
  if (!Number.isFinite(totalSec) || totalSec <= 0) return '未知'
  if (totalSec < 60) return `${totalSec} 秒`
  const minutes = Math.floor(totalSec / 60)
  const seconds = totalSec % 60
  return seconds > 0 ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分钟`
}

function formatRecordedDuration(totalSec: number): string {
  if (!Number.isFinite(totalSec) || totalSec <= 0) return '0 秒'
  return formatDuration(totalSec)
}

function clampSeconds(value: number, durationSec: number): number {
  const normalized = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
  return durationSec > 0 ? Math.min(normalized, durationSec) : normalized
}

function clampPlayerSeconds(value: number, durationSec: number): number {
  const normalized = Number.isFinite(value) ? Math.max(0, value) : 0
  return durationSec > 0 ? Math.min(normalized, durationSec) : normalized
}

function getIframeStartSeconds(value: number, durationSec: number): number {
  const normalized = clampSeconds(value, durationSec)
  return durationSec > 0 && normalized >= durationSec ? 0 : normalized
}

function shouldUseMobileBiliPlayer(): boolean {
  if (typeof window === 'undefined') return false
  const env = buildClientEnvironmentHint()
  const ua = env.userAgent ?? ''
  const hasCoarsePointer = window.matchMedia?.('(pointer: coarse)').matches ?? false
  const hasMobileViewport = window.matchMedia?.('(max-width: 767px)').matches ?? false
  return env.platform === 'ios'
    || env.platform === 'android'
    || env.platform === 'harmony'
    || (hasCoarsePointer && hasMobileViewport)
    || /MicroMessenger|Feishu|Lark/i.test(ua)
}

function readBiliIframePlayer(): BiliIframePlayer | null {
  if (typeof window === 'undefined') return null
  const player = (window as Window & { player?: unknown }).player
  if (!player || typeof player !== 'object') return null
  const typedPlayer = player as BiliIframePlayer
  if (typeof typedPlayer.getCurrentTime !== 'function' || typeof typedPlayer.isPaused !== 'function') {
    return null
  }
  return typedPlayer
}

function resetParentBiliPlayer() {
  if (typeof window === 'undefined') return
  ;(window as Window & { player?: unknown }).player = undefined
}

function getFullscreenElement(): Element | null {
  if (typeof document === 'undefined') return null
  const doc = document as Document & { webkitFullscreenElement?: Element | null }
  return document.fullscreenElement ?? doc.webkitFullscreenElement ?? null
}

export default function VideoResourceInline({
  resource,
  sessionId,
  source = 'chat_inline',
  sharedToken,
  initialFollowedSec = 0,
  initialSaved,
  onFavoriteChange,
  onTodoFeedbackSubmit,
}: Props) {
  const todoContext = resource.todoContext ?? null
  const favoriteKey = getVideoResourceFavoriteId(resource)
  const initialFavorite = findVideoResourceFavorite(resource)
  const initialFollowedSecValue = Math.max(
    0,
    Math.floor(Math.max(initialFollowedSec, initialFavorite?.followedSec ?? 0)),
  )
  const initialPlayheadSecValue = clampSeconds(
    initialFavorite?.playheadSec ?? initialFavorite?.followedSec ?? initialFollowedSecValue,
    resource.durationSec,
  )
  const initialIframeStartSecValue = getIframeStartSeconds(initialPlayheadSecValue, resource.durationSec)
  const initialFollowCountValue = Math.max(0, initialFavorite?.followCount ?? initialFavorite?.followSessions.length ?? 0)
  const initialFollowSessionsValue = initialFavorite?.followSessions ?? []
  const [followedSec, setFollowedSec] = useState(() => initialFollowedSecValue)
  const [playheadSec, setPlayheadSec] = useState(() => initialPlayheadSecValue)
  const [saved, setSaved] = useState(() => initialSaved ?? hasVideoResourceFavorite(resource))
  const [iframeStartSec, setIframeStartSec] = useState(() => initialIframeStartSecValue)
  const [mode, setMode] = useState<FollowMode>('idle')
  const [controlledPlayerActive, setControlledPlayerActive] = useState(false)
  const [controlledAutoplayNonce, setControlledAutoplayNonce] = useState(0)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [preFeedbackVisible, setPreFeedbackVisible] = useState(false)
  const [postFeedbackVisible, setPostFeedbackVisible] = useState(false)
  const [todoFeedbackState, setTodoFeedbackState] = useState<TodoFeedbackState>('hidden')
  const cardRef = useRef<HTMLDivElement | null>(null)
  const videoFrameRef = useRef<HTMLDivElement | null>(null)
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const [videoFrameHeight, setVideoFrameHeight] = useState<number | null>(null)
  const [fullscreenVideoFrameSize, setFullscreenVideoFrameSize] = useState<{ width: number; height: number } | null>(null)
  const followedMsRef = useRef(initialFollowedSecValue * 1000)
  const playheadSecRef = useRef(initialPlayheadSecValue)
  const controlledTickerRef = useRef<number | null>(null)
  const controlledLastTickMsRef = useRef<number | null>(null)
  const estimatedTickerRef = useRef<number | null>(null)
  const estimatedLastTickMsRef = useRef<number | null>(null)
  const mobilePracticeFeedbackTimerRef = useRef<number | null>(null)
  const playerRef = useRef<BiliIframePlayer | null>(null)
  const playerPollRef = useRef<number | null>(null)
  const lastObservedPlayheadRef = useRef<number | null>(null)
  const ignorePausedStartAfterReloadRef = useRef(false)
  const iframeClickCountRef = useRef(0)
  const lastIframeClickMsRef = useRef(0)
  const lastFullscreenActiveRef = useRef(false)
  const lastPersistedSecRef = useRef(initialFollowedSecValue)
  const lastProgressEventSecRef = useRef(initialFollowedSecValue)
  const followCountRef = useRef(initialFollowCountValue)
  const followSessionsRef = useRef<SavedVideoResourceFollowSession[]>(initialFollowSessionsValue)
  const activePlaybackSessionRef = useRef<ActivePlaybackSession | null>(null)
  const estimatedPlaybackActiveRef = useRef(false)
  const modeRef = useRef<FollowMode>('idle')
  const savedRef = useRef(saved)
  const resourceRef = useRef(resource)
  const postFeedbackShownRef = useRef(false)
  const todoStartReportedRef = useRef(false)
  const useMobileBiliPlayer = useMemo(() => shouldUseMobileBiliPlayer(), [])
  const useControlledWebPlayer = !useMobileBiliPlayer
  const useMobileFullscreenFallback = useMemo(() => {
    const env = buildClientEnvironmentHint()
    return env.platform === 'android' || env.platform === 'harmony'
  }, [])
  const showFullscreenButton = useControlledWebPlayer || useMobileFullscreenFallback
  const analyticsEndpointPath = useMemo(
    () => (source === 'shared_view' && sharedToken ? `/shared/${sharedToken}/analytics/events` : undefined),
    [sharedToken, source],
  )
  const reactPlaybackOwnerId = useId()
  const playbackOwnerId = `video-resource:${reactPlaybackOwnerId}`

  const embedUrl = useMemo(() => {
    if (resource.providerVideoId) {
      const params = new URLSearchParams({
        bvid: resource.providerVideoId,
        autoplay: useControlledWebPlayer && controlledAutoplayNonce > 0 ? '1' : '0',
        high_quality: '1',
        danmaku: '0',
      })
      params.set('page', '1')
      if (iframeStartSec > 0) {
        params.set('t', String(iframeStartSec))
      }
      if (useControlledWebPlayer && controlledAutoplayNonce > 0) {
        params.set('_t', String(controlledAutoplayNonce))
      }
      return `https://player.bilibili.com/player.html?${params.toString()}`
    }
    return resource.url
  }, [
    controlledAutoplayNonce,
    iframeStartSec,
    resource.providerVideoId,
    resource.url,
    useControlledWebPlayer,
  ])

  const playheadPercent = resource.durationSec > 0
    ? Math.min(100, Math.round((playheadSec / resource.durationSec) * 100))
    : null
  const followPercent = resource.durationSec > 0
    ? Math.min(100, Math.round((followedSec / resource.durationSec) * 100))
    : null
  const rangeMax = resource.durationSec > 0 ? resource.durationSec : Math.max(playheadSec, 1)
  const rangeValue = Math.min(playheadSec, rangeMax)
  const hasResumeState = followedSec > 0 || playheadSec > 0
  const isAtEnd = resource.durationSec > 0 && playheadSec >= resource.durationSec
  const practiceFeedbackVisible = shouldShowVideoPracticeFeedback({
    source,
    hasTodoContext: Boolean(todoContext),
    isTodoContextClosed: todoContext ? isTodoContextClosed(todoContext) : false,
    isAtEnd,
    feedbackState: todoFeedbackState,
  })
  const isSharedView = source === 'shared_view'
  const feedbackSource = source === 'materials' ? 'materials' : 'chat_inline'
  const feedbackResourceId = resource.providerVideoId ?? resource.id
  const sharedPreFeedbackScore = isSharedView ? resource.discomfortFeedback?.preScore ?? null : null
  const sharedPostFeedbackScore = isSharedView ? resource.discomfortFeedback?.postScore ?? null : null
  const editablePreFeedbackScore = !isSharedView ? resource.discomfortFeedback?.preScore ?? null : null
  const editablePostFeedbackScore = !isSharedView ? resource.discomfortFeedback?.postScore ?? null : null
  const getCurrentFollowedSec = useCallback(() => {
    return Math.max(0, Math.floor(followedMsRef.current / 1000))
  }, [])

  const getCurrentPlayheadSec = useCallback(() => {
    return clampSeconds(playheadSecRef.current, resourceRef.current.durationSec)
  }, [])

  const revealPostFeedbackIfNeeded = useCallback((nextPlayheadSec: number) => {
    if (source === 'shared_view' || postFeedbackShownRef.current) return
    if (resourceRef.current.todoContext) return
    const durationSec = Math.max(0, Math.floor(resourceRef.current.durationSec))
    if (durationSec <= 0) return
    if (nextPlayheadSec < durationSec * 0.75) return
    postFeedbackShownRef.current = true
    setPostFeedbackVisible(true)
  }, [source])

  const revealPracticeFeedback = useCallback((nextState: Exclude<TodoFeedbackState, 'hidden'>) => {
    if (source === 'shared_view') return
    setTodoFeedbackState((prev) => (prev === 'completed' ? prev : nextState))
  }, [source])

  useEffect(() => {
    todoStartReportedRef.current = false
  }, [todoContext?.todoId])

  const reportTodoStart = useCallback(() => {
    const context = resourceRef.current.todoContext
    if (!sessionId || !context?.scheduledMessageId || isTodoContextClosed(context) || todoStartReportedRef.current) return
    todoStartReportedRef.current = true
    api.post<ApiResponse<TodoStartResponse>>(
      `/todos/items/${encodeURIComponent(context.todoId)}/start`,
      {
        sessionId,
        planId: context.planId,
      },
    ).catch(() => {
      todoStartReportedRef.current = false
    })
  }, [sessionId])

  const persistFavoriteProgress = useCallback((
    followSeconds: number,
    playheadSeconds: number,
    options: {
      completed?: boolean
      followCount?: number
      followSessions?: SavedVideoResourceFollowSession[]
    } = {},
  ) => {
    const resourceSnapshot = resourceRef.current
    const normalizedFollowSec = Math.max(0, Math.floor(followSeconds))
    if (!savedRef.current && !hasVideoResourceFavorite(resourceSnapshot)) {
      lastPersistedSecRef.current = normalizedFollowSec
      return
    }
    saveVideoResourceFavorite(resourceSnapshot, {
      followedSec: normalizedFollowSec,
      playheadSec: clampSeconds(playheadSeconds, resourceSnapshot.durationSec),
      completedAt: options.completed ? new Date().toISOString() : undefined,
      followCount: options.followCount,
      followSessions: options.followSessions,
    })
    lastPersistedSecRef.current = normalizedFollowSec
  }, [])

  const reportProgress = useCallback((
    eventName: 'video_resource_follow_started' | 'video_resource_follow_progress' | 'video_resource_follow_session_ended',
    seconds: number,
    options: {
      dedupeKey?: string
      startedAt?: string
      endedAt?: string
      durationMs?: number
      playheadSec?: number
      properties?: Record<string, unknown>
    } = {},
  ) => {
    const resourceSnapshot = resourceRef.current
    const currentPlayheadSec = options.playheadSec ?? getCurrentPlayheadSec()
    const followPercent = resourceSnapshot.durationSec > 0
      ? Math.min(100, Math.round((seconds / resourceSnapshot.durationSec) * 100))
      : null
    const playheadPercent = resourceSnapshot.durationSec > 0
      ? Math.min(100, Math.round((currentPlayheadSec / resourceSnapshot.durationSec) * 100))
      : null
    reportAnalyticsEvent(eventName, {
      sessionId,
      entityType: 'video_resource',
      entityId: resourceSnapshot.providerVideoId ?? resourceSnapshot.url,
      dedupeKey: options.dedupeKey,
      startedAt: options.startedAt,
      endedAt: options.endedAt,
      durationMs: options.durationMs,
      endpointPath: analyticsEndpointPath,
      properties: {
        providerVideoId: resourceSnapshot.providerVideoId,
        url: resourceSnapshot.url,
        source,
        resourceId: resourceSnapshot.id,
        videoDurationSec: resourceSnapshot.durationSec,
        followedSec: seconds,
        playheadSec: currentPlayheadSec,
        followPercent,
        playheadPercent,
        interactionModel: useControlledWebPlayer ? 'controlled_web_player' : 'mobile_iframe_player',
        clockSource: useControlledWebPlayer ? 'client_elapsed_timer' : 'bilibili_player',
        ...options.properties,
      },
    })
  }, [analyticsEndpointPath, getCurrentPlayheadSec, sessionId, source, useControlledWebPlayer])

  const clearControlledTicker = useCallback(() => {
    if (controlledTickerRef.current !== null) {
      window.clearInterval(controlledTickerRef.current)
      controlledTickerRef.current = null
    }
  }, [])

  const clearEstimatedTicker = useCallback(() => {
    if (estimatedTickerRef.current !== null) {
      window.clearInterval(estimatedTickerRef.current)
      estimatedTickerRef.current = null
    }
  }, [])

  const clearMobilePracticeFeedbackTimer = useCallback(() => {
    if (mobilePracticeFeedbackTimerRef.current !== null) {
      window.clearTimeout(mobilePracticeFeedbackTimerRef.current)
      mobilePracticeFeedbackTimerRef.current = null
    }
  }, [])

  const finishPlaybackSession = useCallback((
    reason: PlaybackEndReason,
    seconds = getCurrentFollowedSec(),
    endPlayheadSec = getCurrentPlayheadSec(),
  ) => {
    const activeSession = activePlaybackSessionRef.current
    if (!activeSession) return

    const wasEstimated = estimatedPlaybackActiveRef.current
    const endedAtMs = Date.now()
    const durationMs = Math.max(0, Math.round(followedMsRef.current - activeSession.startFollowedMs))
    const durationSec = Math.floor(durationMs / 1000)
    const endedAtIso = new Date(endedAtMs).toISOString()
    const normalizedFollowSec = Math.max(0, Math.floor(seconds))
    const normalizedPlayheadSec = clampSeconds(endPlayheadSec, resourceRef.current.durationSec)
    const nextSession: SavedVideoResourceFollowSession = {
      index: activeSession.index,
      startedAt: activeSession.startedAtIso,
      endedAt: endedAtIso,
      durationSec,
      startPlayheadSec: activeSession.startPlayheadSec,
      endPlayheadSec: normalizedPlayheadSec,
      trigger: activeSession.trigger,
    }
    followSessionsRef.current = [...followSessionsRef.current, nextSession].slice(-20)
    activePlaybackSessionRef.current = null
    setVideoResourcePlaybackActive(playbackOwnerId, false)

    persistFavoriteProgress(normalizedFollowSec, normalizedPlayheadSec, {
      completed: reason === 'ended',
      followCount: followCountRef.current,
      followSessions: followSessionsRef.current,
    })
    reportProgress('video_resource_follow_session_ended', normalizedFollowSec, {
      dedupeKey: activeSession.id,
      startedAt: activeSession.startedAtIso,
      endedAt: endedAtIso,
      durationMs,
      playheadSec: normalizedPlayheadSec,
      properties: {
        followAttemptId: activeSession.id,
        followAttemptIndex: activeSession.index,
        followTrigger: activeSession.trigger,
        followCount: followCountRef.current,
        attemptDurationSec: durationSec,
        attemptStartFollowedSec: activeSession.startFollowedSec,
        attemptStartPlayheadSec: activeSession.startPlayheadSec,
        attemptEndPlayheadSec: normalizedPlayheadSec,
        totalFollowedSec: normalizedFollowSec,
        endReason: reason,
        playbackState: reason === 'ended' ? 'ended' : wasEstimated ? 'paused_estimated' : 'paused',
        ...(wasEstimated
          ? {
              trackingPrecision: 'estimated_elapsed',
              clockSource: 'client_elapsed_timer',
              estimateConfidence: 'low',
            }
          : {}),
      },
    })
    if (wasEstimated) {
      clearEstimatedTicker()
      estimatedLastTickMsRef.current = null
      estimatedPlaybackActiveRef.current = false
    }
    if (reason === 'ended') {
      revealPracticeFeedback('completed')
      resetParentBiliPlayer()
    } else if (reason === 'pause' || reason === 'iframe_retap' || reason === 'fullscreen_exit' || reason === 'midpoint_feedback') {
      revealPracticeFeedback('paused')
    }
  }, [
    clearEstimatedTicker,
    getCurrentFollowedSec,
    getCurrentPlayheadSec,
    persistFavoriteProgress,
    reportProgress,
    playbackOwnerId,
    revealPracticeFeedback,
  ])

  const startPlaybackSession = useCallback((startSec: number) => {
    if (activePlaybackSessionRef.current) return
    if (source !== 'shared_view') setPreFeedbackVisible(true)
    reportTodoStart()
    setVideoResourcePlaybackActive(playbackOwnerId, true)
    ttsPlayer.stop()
    const seekSec = clampSeconds(startSec, resourceRef.current.durationSec)
    const startedAtMs = Date.now()
    const startedAtIso = new Date(startedAtMs).toISOString()
    const startFollowedSec = getCurrentFollowedSec()
    const nextFollowCount = followCountRef.current + 1
    const followAttemptId = `${resourceRef.current.providerVideoId ?? favoriteKey.slice(0, 80)}:${startedAtMs}:${nextFollowCount}`
    const trigger: SavedVideoResourceFollowSession['trigger'] = startFollowedSec > 0 && seekSec <= 0
      ? 'restart'
      : startFollowedSec > 0 || seekSec > 0
        ? 'continue'
        : 'start'

    followCountRef.current = nextFollowCount
    activePlaybackSessionRef.current = {
      id: followAttemptId,
      index: nextFollowCount,
      startedAtMs,
      startedAtIso,
      startFollowedMs: followedMsRef.current,
      startFollowedSec,
      startPlayheadSec: seekSec,
      trigger,
    }
    playheadSecRef.current = seekSec
    setPlayheadSec(seekSec)
    persistFavoriteProgress(startFollowedSec, seekSec, {
      followCount: followCountRef.current,
      followSessions: followSessionsRef.current,
    })
    reportProgress('video_resource_follow_started', startFollowedSec, {
      dedupeKey: followAttemptId,
      startedAt: startedAtIso,
      playheadSec: seekSec,
      properties: {
        followAttemptId,
        followAttemptIndex: nextFollowCount,
        followTrigger: trigger,
        followCount: nextFollowCount,
        attemptStartPlayheadSec: seekSec,
        totalFollowedSecBeforeAttempt: startFollowedSec,
      },
    })
  }, [favoriteKey, getCurrentFollowedSec, persistFavoriteProgress, reportProgress, playbackOwnerId, reportTodoStart, source])

  const tickEstimatedPlayback = useCallback((tickAtMs = Date.now()) => {
    if (!estimatedPlaybackActiveRef.current || !activePlaybackSessionRef.current) return
    const lastTickMs = estimatedLastTickMsRef.current ?? tickAtMs
    const deltaMs = Math.min(Math.max(0, tickAtMs - lastTickMs), 3000)
    estimatedLastTickMsRef.current = tickAtMs
    if (deltaMs <= 0) return

    const durationSec = resourceRef.current.durationSec
    const remainingMs = durationSec > 0
      ? Math.max(0, Math.round((durationSec - playheadSecRef.current) * 1000))
      : deltaMs
    const appliedMs = durationSec > 0 ? Math.min(deltaMs, remainingMs) : deltaMs

    followedMsRef.current += appliedMs
    playheadSecRef.current = clampPlayerSeconds(
      playheadSecRef.current + appliedMs / 1000,
      durationSec,
    )
    const nextFollowedSec = getCurrentFollowedSec()
    const nextPlayheadSec = clampSeconds(playheadSecRef.current, durationSec)
    setFollowedSec((prev) => (prev === nextFollowedSec ? prev : nextFollowedSec))
    setPlayheadSec((prev) => (prev === nextPlayheadSec ? prev : nextPlayheadSec))
    revealPostFeedbackIfNeeded(nextPlayheadSec)

    if (nextFollowedSec - lastPersistedSecRef.current >= 3) {
      persistFavoriteProgress(nextFollowedSec, nextPlayheadSec)
    }
    if (nextFollowedSec - lastProgressEventSecRef.current >= 5) {
      lastProgressEventSecRef.current = nextFollowedSec
      reportProgress('video_resource_follow_progress', nextFollowedSec, {
        playheadSec: nextPlayheadSec,
        properties: {
          playbackState: 'playing_estimated',
          trackingPrecision: 'estimated_elapsed',
          clockSource: 'client_elapsed_timer',
          estimateConfidence: 'low',
        },
      })
    }

  }, [
    getCurrentFollowedSec,
    persistFavoriteProgress,
    reportProgress,
    revealPostFeedbackIfNeeded,
  ])

  const finishEstimatedPlaybackSession = useCallback((reason: PlaybackEndReason) => {
    if (!estimatedPlaybackActiveRef.current) return
    tickEstimatedPlayback()
    clearEstimatedTicker()
    clearMobilePracticeFeedbackTimer()
    estimatedLastTickMsRef.current = null
    modeRef.current = 'paused'
    setMode('paused')
    const seconds = getCurrentFollowedSec()
    const nextPlayheadSec = getCurrentPlayheadSec()
    if (activePlaybackSessionRef.current) {
      finishPlaybackSession(reason, seconds, nextPlayheadSec)
    }
    estimatedPlaybackActiveRef.current = false
  }, [
    clearMobilePracticeFeedbackTimer,
    clearEstimatedTicker,
    finishPlaybackSession,
    getCurrentFollowedSec,
    getCurrentPlayheadSec,
    tickEstimatedPlayback,
  ])

  const startEstimatedPlaybackSession = useCallback((
    signal: MobileEstimateStartSignal,
    startedAtMs = Date.now(),
    iframeClickIndex?: number,
  ) => {
    if (useControlledWebPlayer || activePlaybackSessionRef.current) return
    if (source !== 'shared_view') setPreFeedbackVisible(true)
    reportTodoStart()
    setVideoResourcePlaybackActive(playbackOwnerId, true)
    ttsPlayer.stop()

    const startedAtIso = new Date(startedAtMs).toISOString()
    const seekSec = getCurrentPlayheadSec()
    const startFollowedSec = getCurrentFollowedSec()
    const nextFollowCount = followCountRef.current + 1
    const followAttemptId = `${resourceRef.current.providerVideoId ?? favoriteKey.slice(0, 80)}:mobile-estimate:${startedAtMs}:${nextFollowCount}`
    const trigger: SavedVideoResourceFollowSession['trigger'] = startFollowedSec > 0 || seekSec > 0 ? 'continue' : 'start'

    followCountRef.current = nextFollowCount
    activePlaybackSessionRef.current = {
      id: followAttemptId,
      index: nextFollowCount,
      startedAtMs,
      startedAtIso,
      startFollowedMs: followedMsRef.current,
      startFollowedSec,
      startPlayheadSec: seekSec,
      trigger,
    }
    estimatedPlaybackActiveRef.current = true
    estimatedLastTickMsRef.current = startedAtMs
    modeRef.current = 'following'
    setMode('following')
    persistFavoriteProgress(startFollowedSec, seekSec, {
      followCount: followCountRef.current,
      followSessions: followSessionsRef.current,
    })
    clearEstimatedTicker()
    clearMobilePracticeFeedbackTimer()
    estimatedTickerRef.current = window.setInterval(() => tickEstimatedPlayback(), 1000)
    const feedbackDelayMs = getMobilePracticeFeedbackDelayMs(resourceRef.current.durationSec, seekSec)
    if (feedbackDelayMs !== null) {
      mobilePracticeFeedbackTimerRef.current = window.setTimeout(() => {
        mobilePracticeFeedbackTimerRef.current = null
        if (!estimatedPlaybackActiveRef.current) return
        finishEstimatedPlaybackSession('midpoint_feedback')
      }, feedbackDelayMs)
    }
    reportProgress('video_resource_follow_started', startFollowedSec, {
      dedupeKey: followAttemptId,
      startedAt: startedAtIso,
      playheadSec: seekSec,
      properties: {
        followAttemptId,
        followAttemptIndex: nextFollowCount,
        followTrigger: trigger,
        followCount: nextFollowCount,
        attemptStartPlayheadSec: seekSec,
        totalFollowedSecBeforeAttempt: startFollowedSec,
        iframeClickIndex,
        playbackState: 'playing_estimated',
        estimateStartSignal: signal,
        trackingPrecision: 'estimated_elapsed',
        clockSource: 'client_elapsed_timer',
        estimateConfidence: 'low',
      },
    })
  }, [
    clearMobilePracticeFeedbackTimer,
    clearEstimatedTicker,
    favoriteKey,
    finishEstimatedPlaybackSession,
    getCurrentFollowedSec,
    getCurrentPlayheadSec,
    persistFavoriteProgress,
    reportProgress,
    tickEstimatedPlayback,
    useControlledWebPlayer,
    playbackOwnerId,
    reportTodoStart,
    source,
  ])

  const reportPlaybackControlTap = useCallback((clickIndex: number, clickedAtMs: number) => {
    const resourceSnapshot = resourceRef.current
    const activeSession = activePlaybackSessionRef.current
    const estimatedActive = estimatedPlaybackActiveRef.current
    reportAnalyticsEvent('video_resource_playback_control_tapped', {
      sessionId,
      entityType: 'video_resource',
      entityId: resourceSnapshot.providerVideoId ?? resourceSnapshot.url,
      dedupeKey: `${resourceSnapshot.providerVideoId ?? favoriteKey.slice(0, 80)}:control:${clickedAtMs}:${clickIndex}`,
      startedAt: new Date(clickedAtMs).toISOString(),
      durationMs: activeSession ? Math.max(0, clickedAtMs - activeSession.startedAtMs) : null,
      endpointPath: analyticsEndpointPath,
      properties: {
        providerVideoId: resourceSnapshot.providerVideoId,
        url: resourceSnapshot.url,
        source,
        resourceId: resourceSnapshot.id,
        videoDurationSec: resourceSnapshot.durationSec,
        followedSec: getCurrentFollowedSec(),
        playheadSec: getCurrentPlayheadSec(),
        iframeClickIndex: clickIndex,
        interactionModel: 'mobile_iframe_player',
        clockSource: estimatedActive ? 'client_elapsed_timer' : 'iframe_interaction',
        trackingPrecision: estimatedActive ? 'estimated_elapsed' : 'click_only',
        estimateConfidence: estimatedActive ? 'low' : null,
        playbackState: estimatedActive ? 'pause_inferred' : 'play_intent',
      },
    })
  }, [analyticsEndpointPath, favoriteKey, getCurrentFollowedSec, getCurrentPlayheadSec, sessionId, source])

  const reportIframePlaybackClick = useCallback(() => {
    const now = Date.now()
    if (now - lastIframeClickMsRef.current < 800) return
    lastIframeClickMsRef.current = now
    iframeClickCountRef.current += 1
    const clickIndex = iframeClickCountRef.current
    const wasEstimatedActive = estimatedPlaybackActiveRef.current

    reportPlaybackControlTap(clickIndex, now)
    if (wasEstimatedActive) {
      finishEstimatedPlaybackSession('iframe_retap')
      return
    }
    startEstimatedPlaybackSession('iframe_click', now, clickIndex)
  }, [
    finishEstimatedPlaybackSession,
    reportPlaybackControlTap,
    startEstimatedPlaybackSession,
  ])

  const reportFullscreenChange = useCallback((active: boolean, target: 'card' | 'iframe' | 'unknown') => {
    const changedAtMs = Date.now()
    const resourceSnapshot = resourceRef.current
    const activeSession = activePlaybackSessionRef.current
    const estimatedActive = estimatedPlaybackActiveRef.current
    reportAnalyticsEvent('video_resource_fullscreen_changed', {
      sessionId,
      entityType: 'video_resource',
      entityId: resourceSnapshot.providerVideoId ?? resourceSnapshot.url,
      dedupeKey: `${resourceSnapshot.providerVideoId ?? favoriteKey.slice(0, 80)}:fullscreen:${active ? 'enter' : 'exit'}:${changedAtMs}`,
      startedAt: new Date(changedAtMs).toISOString(),
      durationMs: !active && activeSession ? Math.max(0, changedAtMs - activeSession.startedAtMs) : null,
      endpointPath: analyticsEndpointPath,
      properties: {
        providerVideoId: resourceSnapshot.providerVideoId,
        url: resourceSnapshot.url,
        source,
        resourceId: resourceSnapshot.id,
        videoDurationSec: resourceSnapshot.durationSec,
        followedSec: getCurrentFollowedSec(),
        playheadSec: getCurrentPlayheadSec(),
        interactionModel: useControlledWebPlayer ? 'controlled_web_player' : 'mobile_iframe_player',
        clockSource: estimatedActive ? 'client_elapsed_timer' : useControlledWebPlayer ? 'client_elapsed_timer' : 'iframe_interaction',
        trackingPrecision: estimatedActive ? 'estimated_elapsed' : useControlledWebPlayer ? 'controlled' : 'fullscreen_signal',
        estimateConfidence: estimatedActive ? 'low' : null,
        fullscreenState: active ? 'entered' : 'exited',
        fullscreenTarget: target,
        playbackState: active
          ? (estimatedActive ? 'playing_estimated' : 'fullscreen_entered')
          : (estimatedActive ? 'fullscreen_exit_inferred_pause' : 'fullscreen_exited'),
      },
    })
  }, [
    analyticsEndpointPath,
    favoriteKey,
    getCurrentFollowedSec,
    getCurrentPlayheadSec,
    sessionId,
    source,
    useControlledWebPlayer,
  ])

  const pollBiliPlayer = useCallback(() => {
    if (useControlledWebPlayer) return

    const player = readBiliIframePlayer()
    if (!player) return

    if (playerRef.current && playerRef.current !== player) {
      finishPlaybackSession('pause')
      lastObservedPlayheadRef.current = null
    }
    playerRef.current = player

    const durationSec = resourceRef.current.durationSec
    const currentTime = clampPlayerSeconds(player.getCurrentTime?.() ?? playheadSecRef.current, durationSec)
    const currentPlayheadSec = clampSeconds(currentTime, durationSec)
    const paused = player.isPaused?.() ?? true

    if (!paused) {
      ignorePausedStartAfterReloadRef.current = false
      if (estimatedPlaybackActiveRef.current) {
        clearEstimatedTicker()
        estimatedLastTickMsRef.current = null
        estimatedPlaybackActiveRef.current = false
      }
    }
    if (paused && ignorePausedStartAfterReloadRef.current && currentPlayheadSec <= 0 && !activePlaybackSessionRef.current) {
      lastObservedPlayheadRef.current = currentTime
      return
    }

    if (!paused && !activePlaybackSessionRef.current) {
      startPlaybackSession(currentTime)
      lastObservedPlayheadRef.current = currentTime
    }

    if (!paused) {
      const previousTime = lastObservedPlayheadRef.current
      if (previousTime !== null) {
        const deltaSec = currentTime - previousTime
        if (deltaSec > 0 && deltaSec <= 5) {
          followedMsRef.current += Math.round(deltaSec * 1000)
        }
      }
    }

    lastObservedPlayheadRef.current = currentTime
    playheadSecRef.current = currentPlayheadSec
    const nextFollowedSec = getCurrentFollowedSec()
    setFollowedSec((prev) => (prev === nextFollowedSec ? prev : nextFollowedSec))
    setPlayheadSec((prev) => (prev === currentPlayheadSec ? prev : currentPlayheadSec))
    revealPostFeedbackIfNeeded(currentPlayheadSec)

    if (nextFollowedSec - lastPersistedSecRef.current >= 3) {
      persistFavoriteProgress(nextFollowedSec, currentPlayheadSec)
    }
    if (nextFollowedSec - lastProgressEventSecRef.current >= 5) {
      lastProgressEventSecRef.current = nextFollowedSec
      reportProgress('video_resource_follow_progress', nextFollowedSec, { playheadSec: currentPlayheadSec })
    }

    if (durationSec > 0 && currentPlayheadSec >= durationSec && activePlaybackSessionRef.current) {
      finishPlaybackSession('ended', nextFollowedSec, durationSec)
      return
    }
    if (paused && activePlaybackSessionRef.current) {
      finishPlaybackSession('pause', nextFollowedSec, currentPlayheadSec)
    }
  }, [clearEstimatedTicker, finishPlaybackSession, getCurrentFollowedSec, persistFavoriteProgress, reportProgress, revealPostFeedbackIfNeeded, startPlaybackSession, useControlledWebPlayer])

  const tickControlledPlayback = useCallback(() => {
    if (controlledLastTickMsRef.current === null) return
    const now = Date.now()
    const deltaMs = Math.max(0, now - controlledLastTickMsRef.current)
    controlledLastTickMsRef.current = now

    const durationSec = resourceRef.current.durationSec
    const remainingMs = durationSec > 0
      ? Math.max(0, Math.round((durationSec - playheadSecRef.current) * 1000))
      : deltaMs
    const appliedMs = durationSec > 0 ? Math.min(deltaMs, remainingMs) : deltaMs

    followedMsRef.current += appliedMs
    playheadSecRef.current = clampPlayerSeconds(
      playheadSecRef.current + appliedMs / 1000,
      durationSec,
    )
    const nextFollowedSec = getCurrentFollowedSec()
    const nextPlayheadSec = clampSeconds(playheadSecRef.current, durationSec)
    setFollowedSec((prev) => (prev === nextFollowedSec ? prev : nextFollowedSec))
    setPlayheadSec((prev) => (prev === nextPlayheadSec ? prev : nextPlayheadSec))
    revealPostFeedbackIfNeeded(nextPlayheadSec)

    if (nextFollowedSec - lastPersistedSecRef.current >= 3) {
      persistFavoriteProgress(nextFollowedSec, nextPlayheadSec)
    }
    if (nextFollowedSec - lastProgressEventSecRef.current >= 5) {
      lastProgressEventSecRef.current = nextFollowedSec
      reportProgress('video_resource_follow_progress', nextFollowedSec, {
        playheadSec: nextPlayheadSec,
        properties: { interactionModel: 'controlled_web_player', clockSource: 'client_elapsed_timer' },
      })
    }

    if (durationSec > 0 && nextPlayheadSec >= durationSec && activePlaybackSessionRef.current) {
      clearControlledTicker()
      controlledLastTickMsRef.current = null
      setControlledPlayerActive(false)
      modeRef.current = 'paused'
      setMode('paused')
      lastProgressEventSecRef.current = nextFollowedSec
      reportProgress('video_resource_follow_progress', nextFollowedSec, {
        playheadSec: durationSec,
        properties: { interactionModel: 'controlled_web_player', clockSource: 'client_elapsed_timer' },
      })
      finishPlaybackSession('ended', nextFollowedSec, durationSec)
    }
  }, [
    clearControlledTicker,
    finishPlaybackSession,
    getCurrentFollowedSec,
    persistFavoriteProgress,
    reportProgress,
    revealPostFeedbackIfNeeded,
  ])

  const startControlledPlayback = useCallback((trigger: VideoResourceFollowTrigger, startSec: number) => {
    if (modeRef.current === 'following') return
    if (source !== 'shared_view') setPreFeedbackVisible(true)
    setVideoResourcePlaybackActive(playbackOwnerId, true)
    ttsPlayer.stop()
    clearControlledTicker()
    resetParentBiliPlayer()
    playerRef.current = null
    lastObservedPlayheadRef.current = null

    const durationSec = resourceRef.current.durationSec
    const seekSec = clampSeconds(startSec, durationSec)
    const iframeStart = durationSec > 0 ? Math.min(seekSec, Math.max(0, durationSec - 1)) : seekSec
    const startedAtMs = Date.now()
    const startedAtIso = new Date(startedAtMs).toISOString()
    const startFollowedSec = getCurrentFollowedSec()
    const nextFollowCount = followCountRef.current + 1
    const followAttemptId = `${resourceRef.current.providerVideoId ?? favoriteKey.slice(0, 80)}:${startedAtMs}:${nextFollowCount}`

    followCountRef.current = nextFollowCount
    activePlaybackSessionRef.current = {
      id: followAttemptId,
      index: nextFollowCount,
      startedAtMs,
      startedAtIso,
      startFollowedMs: followedMsRef.current,
      startFollowedSec,
      startPlayheadSec: seekSec,
      trigger,
    }
    playheadSecRef.current = seekSec
    controlledLastTickMsRef.current = startedAtMs
    setPlayheadSec(seekSec)
    setIframeStartSec(iframeStart)
    setControlledPlayerActive(true)
    setControlledAutoplayNonce(startedAtMs)
    modeRef.current = 'following'
    setMode('following')
    persistFavoriteProgress(startFollowedSec, seekSec, {
      followCount: followCountRef.current,
      followSessions: followSessionsRef.current,
    })
    controlledTickerRef.current = window.setInterval(tickControlledPlayback, 500)
    reportProgress('video_resource_follow_started', startFollowedSec, {
      dedupeKey: followAttemptId,
      startedAt: startedAtIso,
      playheadSec: seekSec,
      properties: {
        followAttemptId,
        followAttemptIndex: nextFollowCount,
        followTrigger: trigger,
        followCount: nextFollowCount,
        attemptStartPlayheadSec: seekSec,
        totalFollowedSecBeforeAttempt: startFollowedSec,
        interactionModel: 'controlled_web_player',
        clockSource: 'client_elapsed_timer',
      },
    })
  }, [
    clearControlledTicker,
    favoriteKey,
    getCurrentFollowedSec,
    persistFavoriteProgress,
    reportProgress,
    tickControlledPlayback,
    playbackOwnerId,
    source,
  ])

  const pauseControlledPlayback = useCallback((reason: PlaybackEndReason = 'pause') => {
    const wasFollowing = modeRef.current === 'following'
    tickControlledPlayback()
    clearControlledTicker()
    controlledLastTickMsRef.current = null
    setControlledPlayerActive(false)
    modeRef.current = 'paused'
    setMode('paused')

    const seconds = getCurrentFollowedSec()
    const nextPlayheadSec = getCurrentPlayheadSec()
    lastProgressEventSecRef.current = seconds
    persistFavoriteProgress(seconds, nextPlayheadSec)
    if (wasFollowing && activePlaybackSessionRef.current) {
      finishPlaybackSession(reason, seconds, nextPlayheadSec)
    }
    reportProgress('video_resource_follow_progress', seconds, {
      playheadSec: nextPlayheadSec,
      properties: { interactionModel: 'controlled_web_player', clockSource: 'client_elapsed_timer' },
    })
  }, [
    clearControlledTicker,
    finishPlaybackSession,
    getCurrentFollowedSec,
    getCurrentPlayheadSec,
    persistFavoriteProgress,
    reportProgress,
    tickControlledPlayback,
  ])

  function handleStartFollow() {
    const seekSec = getCurrentPlayheadSec()
    if (isAtEnd) {
      startControlledPlayback('restart', 0)
      return
    }
    startControlledPlayback(seekSec > 0 || getCurrentFollowedSec() > 0 ? 'continue' : 'start', seekSec)
  }

  function handleRestartFollow() {
    startControlledPlayback('restart', 0)
  }

  function handlePauseFollow() {
    pauseControlledPlayback('pause')
  }

  function handleProgressChange(event: ChangeEvent<HTMLInputElement>) {
    const next = clampSeconds(Number(event.currentTarget.value), resourceRef.current.durationSec)
    const wasFollowing = modeRef.current === 'following'
    if (wasFollowing) {
      pauseControlledPlayback('pause')
    }

    const currentFollowedSec = getCurrentFollowedSec()
    playheadSecRef.current = next
    setPlayheadSec(next)
    setIframeStartSec(next)
    revealPostFeedbackIfNeeded(next)
    if (next >= resourceRef.current.durationSec && resourceRef.current.durationSec > 0) {
      revealPracticeFeedback('completed')
    }
    setControlledPlayerActive(false)
    modeRef.current = next > 0 ? 'paused' : 'idle'
    setMode(modeRef.current)
    persistFavoriteProgress(currentFollowedSec, next)

    if (wasFollowing && next < resourceRef.current.durationSec) {
      startControlledPlayback('continue', next)
    }
  }

  function handleFullscreen() {
    const target = cardRef.current
    if (!target) return
    const exitDocumentFullscreen = () => {
      if (!getFullscreenElement()) return
      const exitFullscreen =
        document.exitFullscreen ??
        (document as any).webkitExitFullscreen ??
        (document as any).mozCancelFullScreen ??
        (document as any).msExitFullscreen
      if (exitFullscreen) void exitFullscreen.call(document)
    }
    const markFullscreen = (active: boolean, trackEstimatedPlayback = !useControlledWebPlayer) => {
      // mobile_css_fullscreen: Android/Harmony ArkWeb may not propagate iframe fullscreen.
      setIsFullscreen(active)
      if (lastFullscreenActiveRef.current === active) return
      lastFullscreenActiveRef.current = active
      reportFullscreenChange(active, 'card')
      if (trackEstimatedPlayback) {
        if (active) {
          startEstimatedPlaybackSession('fullscreen_enter')
        } else {
          finishEstimatedPlaybackSession('fullscreen_exit')
        }
      }
    }
    if (useControlledWebPlayer) {
      if (isFullscreen) {
        exitDocumentFullscreen()
        markFullscreen(false, false)
        return
      }
      markFullscreen(true, false)
      return
    }
    if (useMobileFullscreenFallback) {
      markFullscreen(!isFullscreen)
      return
    }
    if (isFullscreen && getFullscreenElement() !== target) {
      markFullscreen(false)
      return
    }
    if (getFullscreenElement() === target) {
      exitDocumentFullscreen()
      return
    }
    const requestFullscreen =
      target.requestFullscreen ??
      (target as any).webkitRequestFullscreen ??
      (target as any).mozRequestFullScreen ??
      (target as any).msRequestFullscreen
    if (requestFullscreen) {
      const result = requestFullscreen.call(target)
      if (result && typeof result.catch === 'function') {
        result.catch(() => markFullscreen(true))
      }
      return
    }
    markFullscreen(true)
  }

  function handleToggleFavorite() {
    const nextSaved = !saved
    const currentFollowedSec = getCurrentFollowedSec()
    const currentPlayheadSec = getCurrentPlayheadSec()
    if (nextSaved) {
      saveVideoResourceFavorite(resource, {
        followedSec: currentFollowedSec,
        playheadSec: currentPlayheadSec,
        followCount: followCountRef.current,
        followSessions: followSessionsRef.current,
      })
      reportAnalyticsEvent('video_resource_save_clicked', {
        sessionId,
        entityType: 'video_resource',
        entityId: resource.providerVideoId ?? resource.url,
        dedupeKey: sessionId
          ? `${sessionId}:${resource.id}:save`
          : `${source}:${resource.id}:${favoriteKey}:save`,
        endpointPath: analyticsEndpointPath,
        properties: {
          source,
          resourceId: resource.id,
          providerVideoId: resource.providerVideoId,
          url: resource.url,
          title: resource.title,
          sourceQuery: resource.sourceQuery,
          videoDurationSec: resource.durationSec,
          followedSec: currentFollowedSec,
          playheadSec: currentPlayheadSec,
          followCount: followCountRef.current,
          followSessionCount: followSessionsRef.current.length,
        },
      })
    } else {
      removeVideoResourceFavorite(favoriteKey)
    }
    setSaved(nextSaved)
    onFavoriteChange?.(nextSaved)
  }

  useEffect(() => {
    savedRef.current = saved
  }, [saved])

  useEffect(() => {
    modeRef.current = mode
  }, [mode])

  useEffect(() => {
    resourceRef.current = resource
    postFeedbackShownRef.current = false
    setPreFeedbackVisible(false)
    setPostFeedbackVisible(false)
    setTodoFeedbackState('hidden')
  }, [resource])

  useEffect(() => {
    const frame = videoFrameRef.current
    if (!frame) return

    let rafId: number | null = null
    const syncFrameHeight = () => {
      if (rafId !== null) window.cancelAnimationFrame(rafId)
      rafId = window.requestAnimationFrame(() => {
        rafId = null
        if (isFullscreen && useControlledWebPlayer) {
          const card = cardRef.current
          const cardRect = card?.getBoundingClientRect()
          const frameRect = frame.getBoundingClientRect()
          const cardStyle = card ? window.getComputedStyle(card) : null
          const paddingLeft = Number.parseFloat(cardStyle?.paddingLeft ?? '0') || 0
          const paddingRight = Number.parseFloat(cardStyle?.paddingRight ?? '0') || 0
          const contentWidth = Math.max(0, (cardRect?.width ?? window.innerWidth) - paddingLeft - paddingRight)
          const viewportHeight = window.visualViewport?.height ?? window.innerHeight
          const reservedBelowFrame = 180
          const maxHeight = Math.max(120, viewportHeight - frameRect.top - reservedBelowFrame)
          const nextHeight = Math.round(Math.min(contentWidth * 9 / 16, maxHeight))
          const nextWidth = Math.round(nextHeight * 16 / 9)
          if (nextWidth <= 0 || nextHeight <= 0) return
          setFullscreenVideoFrameSize((prev) => (
            prev
              && Math.abs(prev.width - nextWidth) < 1
              && Math.abs(prev.height - nextHeight) < 1
              ? prev
              : { width: nextWidth, height: nextHeight }
          ))
          return
        }

        setFullscreenVideoFrameSize(null)
        const width = frame.getBoundingClientRect().width
        const nextHeight = Math.round(width * 9 / 16)
        if (nextHeight <= 0) return
        setVideoFrameHeight((prev) => (
          prev !== null && Math.abs(prev - nextHeight) < 1 ? prev : nextHeight
        ))
      })
    }

    syncFrameHeight()
    const resizeObserver = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(syncFrameHeight)
      : null
    resizeObserver?.observe(frame)
    window.addEventListener('resize', syncFrameHeight)
    window.addEventListener('orientationchange', syncFrameHeight)
    document.addEventListener('fullscreenchange', syncFrameHeight)
    document.addEventListener('webkitfullscreenchange', syncFrameHeight)
    return () => {
      if (rafId !== null) window.cancelAnimationFrame(rafId)
      resizeObserver?.disconnect()
      window.removeEventListener('resize', syncFrameHeight)
      window.removeEventListener('orientationchange', syncFrameHeight)
      document.removeEventListener('fullscreenchange', syncFrameHeight)
      document.removeEventListener('webkitfullscreenchange', syncFrameHeight)
    }
  }, [isFullscreen, useControlledWebPlayer])

  useEffect(() => {
    if (!isFullscreen || !useControlledWebPlayer) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setIsFullscreen(false)
      if (!lastFullscreenActiveRef.current) return
      lastFullscreenActiveRef.current = false
      reportFullscreenChange(false, 'card')
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isFullscreen, reportFullscreenChange, useControlledWebPlayer])

  useEffect(() => {
    return () => {
      setVideoResourcePlaybackActive(playbackOwnerId, false)
      clearMobilePracticeFeedbackTimer()
    }
  }, [clearMobilePracticeFeedbackTimer, playbackOwnerId])

  useEffect(() => {
    if (!saved) return
    const favorite = ensureVideoResourceFavoriteSnapshot(resource)
    if (!favorite || activePlaybackSessionRef.current) return
    const nextFollowedSec = Math.max(followedMsRef.current / 1000, favorite.followedSec)
    const nextPlayheadSec = clampSeconds(favorite.playheadSec ?? favorite.followedSec, resource.durationSec)
    followedMsRef.current = nextFollowedSec * 1000
    playheadSecRef.current = nextPlayheadSec
    lastPersistedSecRef.current = nextFollowedSec
    followCountRef.current = Math.max(followCountRef.current, favorite.followCount)
    followSessionsRef.current = favorite.followSessions
    setFollowedSec(Math.floor(nextFollowedSec))
    setPlayheadSec(nextPlayheadSec)
  }, [resource, saved])

  useEffect(() => {
    const handleFullscreenChange = () => {
      const element = getFullscreenElement()
      const active = element === cardRef.current || element === iframeRef.current
      setIsFullscreen(active)
      if (lastFullscreenActiveRef.current === active) return
      lastFullscreenActiveRef.current = active
      const target = element === cardRef.current ? 'card' : element === iframeRef.current ? 'iframe' : 'unknown'
      reportFullscreenChange(active, target)
      if (!useControlledWebPlayer) {
        if (active) {
          startEstimatedPlaybackSession('fullscreen_enter')
        } else {
          finishEstimatedPlaybackSession('fullscreen_exit')
        }
      }
    }
    document.addEventListener('fullscreenchange', handleFullscreenChange)
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange)
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange)
      document.removeEventListener('webkitfullscreenchange', handleFullscreenChange)
    }
  }, [
    finishEstimatedPlaybackSession,
    reportFullscreenChange,
    startEstimatedPlaybackSession,
    useMobileFullscreenFallback,
    useControlledWebPlayer,
  ])

  useEffect(() => {
    playerPollRef.current = window.setInterval(pollBiliPlayer, 500)
    return () => {
      if (playerPollRef.current !== null) {
        window.clearInterval(playerPollRef.current)
        playerPollRef.current = null
      }
    }
  }, [pollBiliPlayer])

  useEffect(() => {
    const handleWindowBlur = () => {
      if (document.activeElement === iframeRef.current) {
        reportIframePlaybackClick()
      }
    }
    window.addEventListener('blur', handleWindowBlur)
    return () => window.removeEventListener('blur', handleWindowBlur)
  }, [reportIframePlaybackClick])

  useEffect(() => {
    const persistCurrentProgress = () => {
      if (!useControlledWebPlayer && estimatedPlaybackActiveRef.current) {
        finishEstimatedPlaybackSession('pagehide')
        return
      }
      if (useControlledWebPlayer && modeRef.current === 'following') {
        pauseControlledPlayback('pagehide')
        return
      }
      const seconds = getCurrentFollowedSec()
      const nextPlayheadSec = getCurrentPlayheadSec()
      persistFavoriteProgress(seconds, nextPlayheadSec)
      if (activePlaybackSessionRef.current) {
        finishPlaybackSession('pagehide', seconds, nextPlayheadSec)
      }
    }
    window.addEventListener('pagehide', persistCurrentProgress)
    return () => window.removeEventListener('pagehide', persistCurrentProgress)
  }, [
    finishEstimatedPlaybackSession,
    finishPlaybackSession,
    getCurrentFollowedSec,
    getCurrentPlayheadSec,
    pauseControlledPlayback,
    persistFavoriteProgress,
    useControlledWebPlayer,
  ])

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden' && estimatedPlaybackActiveRef.current) {
        finishEstimatedPlaybackSession('visibility_hidden')
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange)
  }, [finishEstimatedPlaybackSession])

  useEffect(() => {
    return () => {
      if (!useControlledWebPlayer && estimatedPlaybackActiveRef.current) {
        finishEstimatedPlaybackSession('unmount')
        return
      }
      if (useControlledWebPlayer && modeRef.current === 'following') {
        pauseControlledPlayback('unmount')
        return
      }
      const seconds = getCurrentFollowedSec()
      const nextPlayheadSec = getCurrentPlayheadSec()
      if (activePlaybackSessionRef.current) {
        finishPlaybackSession('unmount', seconds, nextPlayheadSec)
      }
    }
  }, [
    finishEstimatedPlaybackSession,
    finishPlaybackSession,
    getCurrentFollowedSec,
    getCurrentPlayheadSec,
    pauseControlledPlayback,
    useControlledWebPlayer,
  ])

  return (
    <div style={styles.wrapper}>
      <div
        ref={cardRef}
        style={{
          ...styles.card,
          ...(isFullscreen ? styles.fullscreenCard : {}),
        }}
      >
        <div style={styles.titleBlock}>
          <div style={styles.title}>{resource.title}</div>
          <div style={styles.meta}>
            视频 {formatDuration(resource.durationSec)}
            {resource.publishedAt ? ` · ${resource.publishedAt.slice(0, 10)}` : ''}
          </div>
        </div>

        <div
          ref={videoFrameRef}
          style={{
            ...styles.videoFrame,
            ...(!isFullscreen && videoFrameHeight !== null ? { height: videoFrameHeight } : {}),
            ...(isFullscreen ? styles.fullscreenVideoFrame : {}),
            ...(isFullscreen && useControlledWebPlayer && fullscreenVideoFrameSize ? fullscreenVideoFrameSize : {}),
          }}
        >
          {useControlledWebPlayer ? (
            controlledPlayerActive ? (
              <iframe
                key={controlledAutoplayNonce}
                ref={iframeRef}
                title={resource.title}
                src={embedUrl}
                allow="autoplay; fullscreen; picture-in-picture; encrypted-media"
                allowFullScreen
                style={{ ...styles.iframe, ...styles.controlledIframe }}
              />
            ) : resource.thumbnailUrl ? (
              <img src={resource.thumbnailUrl} alt="" style={styles.posterImage} />
            ) : (
              <div style={styles.posterFallback} />
            )
          ) : (
            <iframe
              ref={iframeRef}
              title={resource.title}
              src={embedUrl}
              allow="autoplay; fullscreen; picture-in-picture; encrypted-media"
              allowFullScreen
              onPointerDown={reportIframePlaybackClick}
              onFocus={reportIframePlaybackClick}
              style={styles.iframe}
            />
          )}
          {showFullscreenButton && (
            <button
              type="button"
              style={styles.fullscreenIconButton}
              onClick={handleFullscreen}
              aria-label={isFullscreen ? '退出全屏' : '全屏播放'}
              title={isFullscreen ? '退出全屏' : '全屏播放'}
            >
              <FullscreenIcon active={isFullscreen} />
            </button>
          )}
        </div>

        {useControlledWebPlayer && (
          <div style={styles.progressBlock}>
            <div style={styles.progressTrack} aria-hidden="true">
              <div
                style={{
                  ...styles.progressFill,
                  width: `${playheadPercent ?? 0}%`,
                }}
              />
              <div
                style={{
                  ...styles.progressThumb,
                  left: `${playheadPercent ?? 0}%`,
                }}
              />
            </div>
            <input
              type="range"
              min={0}
              max={rangeMax}
              step={1}
              value={rangeValue}
              onChange={handleProgressChange}
              style={styles.progressSlider}
              aria-label="调整跟练进度"
            />
            <div style={styles.progressLabels}>
              <span>{formatDuration(rangeValue)}</span>
              <span>{formatDuration(resource.durationSec)}</span>
            </div>
          </div>
        )}

        {useControlledWebPlayer && (
          <div style={styles.metaGrid}>
            <div style={styles.metaItem}>
              <span style={styles.metaLabel}>视频总时长</span>
              <strong style={styles.metaValue}>{formatDuration(resource.durationSec)}</strong>
            </div>
            <div style={styles.metaItem}>
              <span style={styles.metaLabel}>跟练时长</span>
              <strong style={styles.metaValue}>{formatDuration(followedSec)}</strong>
            </div>
            <div style={styles.metaItem}>
              <span style={styles.metaLabel}>完成比例</span>
              <strong style={styles.metaValue}>{followPercent == null ? '未知' : `${followPercent}%`}</strong>
            </div>
          </div>
        )}

        <div style={styles.cardActionRow}>
          {useControlledWebPlayer && (
            <div style={styles.buttonRow}>
              {mode === 'following' && !isAtEnd ? (
                <button type="button" style={styles.secondaryButton} onClick={handlePauseFollow}>暂停跟练</button>
              ) : isAtEnd ? (
                <button type="button" style={styles.primaryButton} onClick={handleRestartFollow}>从头开始</button>
              ) : (
                <>
                  <button type="button" style={styles.primaryButton} onClick={handleStartFollow}>
                    {hasResumeState ? '继续跟练' : '开始跟练'}
                  </button>
                  {hasResumeState && (
                    <button type="button" style={styles.secondaryButton} onClick={handleRestartFollow}>从头开始</button>
                  )}
                </>
              )}
            </div>
          )}
          <div style={styles.favoriteButtonSlot}>
            <button type="button" style={saved ? styles.favoriteSecondaryButton : styles.favoritePrimaryButton} onClick={handleToggleFavorite}>
              <FavoriteIcon active={saved} />
              <span>{saved ? '取消收藏' : '收藏'}</span>
            </button>
          </div>
        </div>
      </div>

      {!todoContext && (
        <DiscomfortFeedbackBar
          visible={isSharedView ? sharedPreFeedbackScore !== null : preFeedbackVisible || editablePreFeedbackScore !== null}
          sessionId={sessionId}
          resourceKind="video_resource"
          resourceId={feedbackResourceId}
          resourceTitle={resource.title}
          resourceContext={resource.sourceQuery}
          timing="pre"
          source={feedbackSource}
          totalFollowSec={followedSec}
          materialDurationSec={resource.durationSec}
          readOnly={isSharedView}
          readOnlyScore={sharedPreFeedbackScore}
          initialScore={editablePreFeedbackScore}
        />
      )}

      {!todoContext && (
        <DiscomfortFeedbackBar
          visible={isSharedView ? sharedPostFeedbackScore !== null : postFeedbackVisible || editablePostFeedbackScore !== null}
          sessionId={sessionId}
          resourceKind="video_resource"
          resourceId={feedbackResourceId}
          resourceTitle={resource.title}
          resourceContext={resource.sourceQuery}
          timing="post"
          source={feedbackSource}
          totalFollowSec={followedSec}
          materialDurationSec={resource.durationSec}
          readOnly={isSharedView}
          readOnlyScore={sharedPostFeedbackScore}
          initialScore={editablePostFeedbackScore}
        />
      )}

      <TodoFeedbackBar
        visible={practiceFeedbackVisible}
        sessionId={sessionId}
        todoContext={todoContext}
        practiceState={todoFeedbackState === 'paused' && !isAtEnd ? 'paused' : 'completed'}
        onSubmitted={onTodoFeedbackSubmit}
      />
    </div>
  )
}

const styles: Record<string, CSSProperties> = {
  wrapper: {
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    margin: '10px 0 14px',
  },
  card: {
    border: '1px solid rgba(212, 135, 108, 0.22)',
    borderRadius: 8,
    background: '#fff',
    padding: 12,
    boxShadow: '0 8px 22px rgba(120, 72, 48, 0.08)',
  },
  fullscreenCard: {
    position: 'fixed',
    top: 0,
    right: 'auto',
    bottom: 0,
    left: '50%',
    transform: 'translateX(-50%)',
    zIndex: 1000,
    width: 'min(100vw, 430px)',
    height: 'var(--app-height)',
    maxWidth: 'none',
    borderRadius: 0,
    overflowY: 'auto',
    padding: 'calc(16px + var(--safe-area-top)) 16px calc(16px + var(--safe-area-bottom))',
    background: '#fff',
  },
  titleBlock: {
    minWidth: 0,
    marginBottom: 10,
  },
  title: {
    fontSize: 15,
    fontWeight: 700,
    color: '#2F241F',
    lineHeight: 1.35,
    wordBreak: 'break-word',
  },
  meta: {
    fontSize: 12,
    color: '#8A7A70',
    marginTop: 4,
  },
  videoFrame: {
    position: 'relative',
    width: '100%',
    aspectRatio: '16 / 9',
    borderRadius: 8,
    overflow: 'hidden',
    background: '#1F1B18',
  },
  fullscreenVideoFrame: {
    margin: '0 auto',
    maxWidth: '100%',
  },
  iframe: {
    width: '100%',
    height: '100%',
    border: 0,
    display: 'block',
  },
  controlledIframe: {
    pointerEvents: 'none',
  },
  posterImage: {
    width: '100%',
    height: '100%',
    objectFit: 'cover',
    display: 'block',
  },
  posterFallback: {
    width: '100%',
    height: '100%',
    background: 'linear-gradient(135deg, #2F241F 0%, #6B4E43 100%)',
  },
  fullscreenIconButton: {
    position: 'absolute',
    right: 10,
    bottom: 10,
    zIndex: 2,
    width: 42,
    height: 42,
    border: '1px solid rgba(255,255,255,0.58)',
    borderRadius: 10,
    background: 'rgba(0,0,0,0.54)',
    color: '#fff',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    boxShadow: '0 4px 12px rgba(0,0,0,0.24)',
  },
  metaGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(92px, 1fr))',
    gap: 8,
    marginTop: 12,
  },
  metaItem: {
    borderRadius: 8,
    background: '#FFF7ED',
    padding: '8px 6px',
    minWidth: 0,
  },
  metaLabel: {
    display: 'block',
    fontSize: 11,
    color: '#9A6A4F',
    marginBottom: 3,
  },
  metaValue: {
    display: 'block',
    fontSize: 13,
    color: '#3F2D25',
  },
  progressBlock: {
    position: 'relative',
    marginTop: 12,
    paddingTop: 10,
  },
  progressTrack: {
    position: 'relative',
    height: 8,
    borderRadius: 999,
    background: '#F6E7DD',
    overflow: 'visible',
  },
  progressFill: {
    height: '100%',
    borderRadius: 999,
    background: '#D4876C',
  },
  progressThumb: {
    position: 'absolute',
    top: '50%',
    width: 18,
    height: 18,
    borderRadius: '50%',
    background: '#D4876C',
    border: '3px solid #fff',
    boxShadow: '0 2px 8px rgba(120, 72, 48, 0.22)',
    transform: 'translate(-50%, -50%)',
  },
  progressSlider: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: '100%',
    height: 28,
    opacity: 0,
    cursor: 'pointer',
  },
  progressLabels: {
    display: 'flex',
    justifyContent: 'space-between',
    marginTop: 2,
    fontSize: 12,
    color: '#8A7A70',
  },
  buttonRow: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 8,
  },
  cardActionRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    flexWrap: 'wrap',
    marginTop: 12,
  },
  favoriteButtonSlot: {
    display: 'flex',
    alignItems: 'center',
    marginLeft: 'auto',
  },
  favoritePrimaryButton: {
    border: 'none',
    borderRadius: 12,
    minWidth: 88,
    minHeight: 44,
    padding: '10px 14px',
    background: 'linear-gradient(135deg, #A87158 0%, #875440 100%)',
    color: '#fff',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  favoriteSecondaryButton: {
    border: '1px solid rgba(212, 135, 108, 0.2)',
    borderRadius: 12,
    minWidth: 88,
    minHeight: 44,
    padding: '10px 14px',
    background: 'rgba(255,255,255,0.7)',
    color: '#A95B3E',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  primaryButton: {
    border: 0,
    borderRadius: 8,
    minWidth: 88,
    minHeight: 44,
    background: '#D4876C',
    color: '#fff',
    padding: '9px 12px',
    fontSize: 14,
    fontWeight: 700,
  },
  secondaryButton: {
    border: '1px solid rgba(212, 135, 108, 0.32)',
    borderRadius: 8,
    minWidth: 88,
    minHeight: 44,
    background: '#fff',
    color: '#9A5B37',
    padding: '8px 11px',
    fontSize: 14,
    fontWeight: 600,
  },
}
