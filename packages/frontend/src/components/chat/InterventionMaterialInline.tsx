import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import {
  parseInterventionMaterialToolOutput,
  type ApiResponse,
  type InterventionMaterialEngagementRecord,
  type InterventionMaterialInteractionResponse,
  type InterventionMaterialInteractionSource,
  type InterventionMaterialProgressSnapshot,
  type InterventionMaterialRuntimeDetailResponse,
  type InterventionMaterialToolOutput,
  type MedicalRiskResourceTodoContext,
  type TodoStartResponse,
} from '@health-agent/shared'
import { api } from '../../services/api.js'
import { useStore } from '../../stores/index.js'
import ImageLightbox from '../ImageLightbox.js'
import { ttsPlayer } from '../../hooks/useTTSPlayer.js'
import { setInterventionFollowAudioActive } from '../../lib/interventionFollowAudio.js'
import DiscomfortFeedbackBar from './DiscomfortFeedbackBar.js'
import TodoFeedbackBar from './TodoFeedbackBar.js'

type PracticeMode = 'overview' | 'follow' | 'completed'
type ProgressState = InterventionMaterialProgressSnapshot | InterventionMaterialEngagementRecord | null | undefined
type InterventionMaterialInlineSource = InterventionMaterialInteractionSource | 'shared_view'

function isTodoContextClosed(context: MedicalRiskResourceTodoContext): boolean {
  return context.status === 'completed' || context.status === 'not_practiced'
}

interface Props {
  output?: unknown
  sessionId: string | null
  toolCallId: string | null
  loading?: boolean
  source?: InterventionMaterialInlineSource
  initialSaved?: boolean
  initialSavedEngagement?: InterventionMaterialEngagementRecord | null
  onSaved?: (engagement: InterventionMaterialEngagementRecord) => void
  onUnsaved?: (engagementId: string) => void
  todoContext?: MedicalRiskResourceTodoContext | null
  onTodoFeedbackSubmit?: (content: string) => void
}

function GeneratingSpinner() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="rgba(212, 135, 108, 0.18)" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 1-9 9" stroke="#D4876C" strokeWidth="3" strokeLinecap="round">
        <animateTransform
          attributeName="transform"
          attributeType="XML"
          type="rotate"
          from="0 12 12"
          to="360 12 12"
          dur="1s"
          repeatCount="indefinite"
        />
      </path>
    </svg>
  )
}

function FavoriteIcon({ active }: { active: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill={active ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M19 21l-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
    </svg>
  )
}

function formatDuration(totalSec: number): string {
  if (totalSec < 60) return `${totalSec} 秒`
  const minutes = Math.floor(totalSec / 60)
  const seconds = totalSec % 60
  return seconds > 0 ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分钟`
}

function clampStepIndex(detail: InterventionMaterialToolOutput | null, index: number): number {
  if (!detail || detail.stepsMeta.length === 0) return 0
  return Math.max(0, Math.min(index, detail.stepsMeta.length - 1))
}

function isExpiredSignedUrl(url: string): boolean {
  if (!url) return false
  try {
    const parsed = new URL(url, 'https://cx.local')
    const expires = Number(parsed.searchParams.get('Expires'))
    return Number.isFinite(expires) && expires * 1000 <= Date.now() + 30_000
  } catch {
    return false
  }
}

function usableImageUrl(url: string | undefined, failedUrls: Set<string>): string {
  if (!url || failedUrls.has(url) || isExpiredSignedUrl(url)) return ''
  return url
}

export default function InterventionMaterialInline({
  output,
  sessionId,
  toolCallId,
  loading = false,
  source = 'chat_inline',
  initialSaved = false,
  initialSavedEngagement = null,
  onSaved,
  onUnsaved,
  todoContext = null,
  onTodoFeedbackSubmit,
}: Props) {
  const parsed = useMemo(() => parseInterventionMaterialToolOutput(output), [output])
  const [detail, setDetail] = useState<InterventionMaterialToolOutput | null>(parsed)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [playbackError, setPlaybackError] = useState<string | null>(null)
  const [mode, setMode] = useState<PracticeMode>('overview')
  const [currentStepIdx, setCurrentStepIdx] = useState(0)
  const [remainingSec, setRemainingSec] = useState(parsed?.stepsMeta[0]?.durationSec ?? 0)
  const [completedStepCount, setCompletedStepCount] = useState(0)
  const [followElapsedSec, setFollowElapsedSec] = useState(0)
  const [hiddenPaused, setHiddenPaused] = useState(false)
  const [lightboxImages, setLightboxImages] = useState<string[] | null>(null)
  const [lightboxIndex, setLightboxIndex] = useState(0)
  const [savedEngagement, setSavedEngagement] = useState<InterventionMaterialEngagementRecord | null>(initialSavedEngagement)
  const [favoriteRemoved, setFavoriteRemoved] = useState(false)
  const [savingMaterial, setSavingMaterial] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [feedbackEngagementId, setFeedbackEngagementId] = useState<string | null>(initialSavedEngagement?.id ?? null)
  const [preFeedbackVisible, setPreFeedbackVisible] = useState(false)
  const [postFeedbackVisible, setPostFeedbackVisible] = useState(false)
  const [failedImageUrls, setFailedImageUrls] = useState<Set<string>>(() => new Set())
  const [detailRefreshNonce, setDetailRefreshNonce] = useState(0)

  const detailRef = useRef<InterventionMaterialToolOutput | null>(parsed)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const tickerRef = useRef<number | null>(null)
  const stepEndAtRef = useRef<number | null>(null)
  const remainingMsRef = useRef((parsed?.stepsMeta[0]?.durationSec ?? 0) * 1000)
  const currentStepIdxRef = useRef(0)
  const activeFollowStartedAtRef = useRef<number | null>(null)
  const totalFollowMsRef = useRef(0)
  const completedStepCountRef = useRef(0)
  const modeRef = useRef<PracticeMode>('overview')
  const viewTrackedRef = useRef(false)
  const hiddenPausedRef = useRef(false)
  const lastProgressKeyRef = useRef<string | null>(null)
  const hasFollowActivityRef = useRef(false)
  const todoStartReportedRef = useRef(false)
  const returnOverviewTrackedRef = useRef(false)
  const stepTimerDoneRef = useRef(false)
  const stepAudioDoneRef = useRef(true)
  const stepAdvanceScheduledRef = useRef(false)
  const stepPlaybackTokenRef = useRef(0)
  const imageRefreshAttemptsRef = useRef(0)
  const advanceToNextStepRef = useRef<() => void>(() => {})
  const resetKeyRef = useRef<string | null>(null)
  const detailFetchKeyRef = useRef<string | null>(null)

  const isSharedView = source === 'shared_view'
  const isInteractive = !isSharedView && !!sessionId && !!toolCallId
  const activeDetail = detail ?? parsed
  const favoriteEngagement = savedEngagement?.savedAt
    ? savedEngagement
    : initialSavedEngagement?.savedAt
      ? initialSavedEngagement
      : null
  const isSaved = !favoriteRemoved && (initialSaved || !!favoriteEngagement)
  const favoriteEngagementId = isSaved ? favoriteEngagement?.id ?? null : null
  const favoriteDisabled = !isInteractive || loadingDetail || savingMaterial || (isSaved && !favoriteEngagementId)
  const activeStep = activeDetail?.stepsMeta[currentStepIdx] ?? null
  const feedbackSource: InterventionMaterialInteractionSource = source === 'materials' ? 'materials' : 'chat_inline'
  const sharedPreFeedbackScore = isSharedView ? activeDetail?.discomfortFeedback?.preScore ?? null : null
  const sharedPostFeedbackScore = isSharedView ? activeDetail?.discomfortFeedback?.postScore ?? null : null
  const editablePreFeedbackScore = !isSharedView ? activeDetail?.discomfortFeedback?.preScore ?? null : null
  const editablePostFeedbackScore = !isSharedView ? activeDetail?.discomfortFeedback?.postScore ?? null : null
  const progressText = activeDetail
    ? `${Math.min(completedStepCount, activeDetail.stepsMeta.length)}/${activeDetail.stepsMeta.length}`
    : '0/0'

  useEffect(() => {
    todoStartReportedRef.current = false
  }, [todoContext?.todoId])

  const reportTodoStart = useCallback(() => {
    if (!sessionId || !todoContext?.scheduledMessageId || isTodoContextClosed(todoContext) || todoStartReportedRef.current) return
    todoStartReportedRef.current = true
    api.post<ApiResponse<TodoStartResponse>>(
      `/todos/items/${encodeURIComponent(todoContext.todoId)}/start`,
      {
        sessionId,
        planId: todoContext.planId,
      },
    ).catch(() => {
      todoStartReportedRef.current = false
    })
  }, [sessionId, todoContext])

  const openLightbox = useCallback((images: string[], index = 0) => {
    if (!images[index]) return
    setLightboxImages(images)
    setLightboxIndex(index)
  }, [])

  const handleImageError = useCallback((url: string) => {
    if (!url) return
    setFailedImageUrls((prev) => {
      if (prev.has(url)) return prev
      const next = new Set(prev)
      next.add(url)
      return next
    })

    if (!isInteractive || loadingDetail || imageRefreshAttemptsRef.current >= 2) return
    imageRefreshAttemptsRef.current += 1
    detailFetchKeyRef.current = null
    setLoadError(null)
    setDetailRefreshNonce((value) => value + 1)
  }, [isInteractive, loadingDetail])

  const clearTicker = useCallback(() => {
    if (tickerRef.current !== null) {
      window.clearInterval(tickerRef.current)
      tickerRef.current = null
    }
  }, [])

  const getCurrentTotalFollowSec = useCallback(() => {
    let totalMs = totalFollowMsRef.current
    if (activeFollowStartedAtRef.current !== null) {
      totalMs += Math.max(0, Date.now() - activeFollowStartedAtRef.current)
    }
    return Math.max(0, Math.floor(totalMs / 1000))
  }, [])

  const syncStepState = useCallback((stepIdx: number, durationSec: number) => {
    currentStepIdxRef.current = stepIdx
    setCurrentStepIdx(stepIdx)
    remainingMsRef.current = durationSec * 1000
    setRemainingSec(durationSec)
  }, [])

  const applyProgressState = useCallback((progress: ProgressState, nextDetail: InterventionMaterialToolOutput | null) => {
    if (!progress) return
    // 远端 detail/progress 可能在用户点“开始跟练”之后才返回；此时不能覆盖本地正在播放的步骤，
    // 否则 Android/iOS 原生壳里会表现为卡片跳回总览、音频被中断。
    if (modeRef.current === 'follow') return

    const totalStepCount = Math.max(
      nextDetail?.stepsMeta.length ?? 0,
      progress.totalStepCount ?? 0,
    )
    const safeCompletedStepCount = Math.max(
      0,
      Math.min(progress.completedStepCount ?? 0, totalStepCount),
    )
    const safeTotalFollowSec = Math.max(0, Math.floor(progress.totalFollowSec ?? 0))
    const hasActivity = !!progress.followStartedAt || safeTotalFollowSec > 0 || safeCompletedStepCount > 0
    const isCompleted = !!progress.followCompletedAt
      && totalStepCount > 0
      && safeCompletedStepCount >= totalStepCount

    totalFollowMsRef.current = safeTotalFollowSec * 1000
    activeFollowStartedAtRef.current = null
    completedStepCountRef.current = safeCompletedStepCount
    hasFollowActivityRef.current = hasActivity
    modeRef.current = isCompleted ? 'completed' : 'overview'

    setCompletedStepCount(safeCompletedStepCount)
    setFollowElapsedSec(safeTotalFollowSec)
    setMode(isCompleted ? 'completed' : 'overview')
    setPreFeedbackVisible(hasActivity)
    setPostFeedbackVisible(isCompleted)

    if (!nextDetail) return

    const nextStepIdx = progress.lastStepIndex
      ? progress.lastStepIndex - 1
      : safeCompletedStepCount
    const safeStepIdx = clampStepIndex(nextDetail, nextStepIdx)
    const nextDurationSec = isCompleted
      ? 0
      : nextDetail.stepsMeta[safeStepIdx]?.durationSec ?? 0
    syncStepState(safeStepIdx, nextDurationSec)
  }, [syncStepState])

  const pauseActiveFollowClock = useCallback(() => {
    if (stepEndAtRef.current !== null) {
      remainingMsRef.current = Math.max(0, stepEndAtRef.current - Date.now())
    }
    stepEndAtRef.current = null
    clearTicker()
    if (activeFollowStartedAtRef.current !== null) {
      totalFollowMsRef.current += Math.max(0, Date.now() - activeFollowStartedAtRef.current)
      activeFollowStartedAtRef.current = null
    }
    setFollowElapsedSec(getCurrentTotalFollowSec())
  }, [clearTicker, getCurrentTotalFollowSec])

  const stopAudio = useCallback((reset = false) => {
    const audio = audioRef.current
    if (!audio) return
    stepPlaybackTokenRef.current += 1
    audio.onended = null
    audio.onerror = null
    audio.pause()
    if (reset) {
      try {
        audio.currentTime = 0
      } catch {
        // ignore seek failures
      }
    }
  }, [])

  function resetStepCompletionState(stepIdx: number) {
    const nextDetail = detailRef.current
    const hasAudio = !!nextDetail?.currentSignedUrls.stepAudioUrls[stepIdx]
    stepTimerDoneRef.current = false
    stepAudioDoneRef.current = !hasAudio
    stepAdvanceScheduledRef.current = false
  }

  function scheduleAdvanceIfStepDone() {
    if (modeRef.current !== 'follow') return
    if (stepAdvanceScheduledRef.current) return
    if (!stepTimerDoneRef.current || !stepAudioDoneRef.current) return

    stepAdvanceScheduledRef.current = true
    clearTicker()
    window.setTimeout(() => {
      if (modeRef.current !== 'follow') return
      if (!stepTimerDoneRef.current || !stepAudioDoneRef.current) return
      advanceToNextStepRef.current()
    }, 0)
  }

  const playStepAudio = useCallback((stepIdx: number, restart: boolean) => {
    const nextDetail = detailRef.current
    const audio = audioRef.current
    if (!nextDetail || !audio) return

    const url = nextDetail.currentSignedUrls.stepAudioUrls[stepIdx]
    if (!url) {
      stepAudioDoneRef.current = true
      scheduleAdvanceIfStepDone()
      return
    }

    setPlaybackError(null)
    stepAudioDoneRef.current = false
    const playbackToken = stepPlaybackTokenRef.current + 1
    stepPlaybackTokenRef.current = playbackToken
    audio.onended = () => {
      if (stepPlaybackTokenRef.current !== playbackToken) return
      stepAudioDoneRef.current = true
      scheduleAdvanceIfStepDone()
    }
    audio.onerror = () => {
      if (stepPlaybackTokenRef.current !== playbackToken) return
      stepAudioDoneRef.current = true
      setPlaybackError('语音播放异常，可点“重播本步”或“下一步”继续。')
      scheduleAdvanceIfStepDone()
    }
    if (audio.src !== url) {
      audio.src = url
    }
    if (restart) {
      try {
        audio.currentTime = 0
      } catch {
        // ignore seek failures
      }
    }

    const playPromise = audio.play()
    if (playPromise && typeof playPromise.catch === 'function') {
      playPromise.catch(() => {
        if (stepPlaybackTokenRef.current !== playbackToken) return
        stepAudioDoneRef.current = true
        setPlaybackError('语音未能自动播放，可点“重播本步”再试一次。')
        scheduleAdvanceIfStepDone()
      })
    }
  }, [])

  const postInteraction = useCallback((event: 'view' | 'follow_start' | 'progress' | 'follow_complete' | 'follow_return_overview', overrides: {
    totalFollowSec?: number
    materialDurationSec?: number
    completedStepCount?: number
    totalStepCount?: number
    lastStepIndex?: number | null
  } = {}): Promise<InterventionMaterialInteractionResponse | null> => {
    const nextDetail = detailRef.current
    if (!sessionId || !toolCallId || !nextDetail) return Promise.resolve(null)

    const payload = {
      sessionId,
      toolCallId,
      event,
      source: feedbackSource,
      totalFollowSec: overrides.totalFollowSec ?? getCurrentTotalFollowSec(),
      materialDurationSec: overrides.materialDurationSec ?? nextDetail.overview.totalDurationSec,
      completedStepCount: overrides.completedStepCount ?? completedStepCountRef.current,
      totalStepCount: overrides.totalStepCount ?? nextDetail.stepsMeta.length,
      lastStepIndex: overrides.lastStepIndex
        ?? nextDetail.stepsMeta[currentStepIdxRef.current]?.stepIndex
        ?? null,
    }

    if (event === 'progress') {
      const dedupeKey = JSON.stringify(payload)
      if (lastProgressKeyRef.current === dedupeKey) return Promise.resolve(null)
      lastProgressKeyRef.current = dedupeKey
    }

    return api.post<ApiResponse<InterventionMaterialInteractionResponse>>(
      '/intervention-material-runtime/interactions',
      payload,
    )
      .then((res) => {
        if (res.data?.engagement) {
          setFeedbackEngagementId(res.data.engagement.id)
        }
        if (res.data?.engagement.savedAt) {
          setSavedEngagement(res.data.engagement)
        }
        const assistantMessage = res.data?.assistantMessage
        if (assistantMessage) {
          const state = useStore.getState()
          const exists = state.messages.some((message) => message.id === assistantMessage.id)
          const hasLaterVisibleMessage = state.messages.some((message) =>
            Date.parse(message.createdAt) > Date.parse(assistantMessage.createdAt)
          )
          if (!exists && !hasLaterVisibleMessage && state.currentSessionId === sessionId) {
            state.addMessage(assistantMessage)
          }
        }
        return res.data ?? null
      })
      .catch(() => null)
  }, [feedbackSource, getCurrentTotalFollowSec, sessionId, toolCallId])

  const postReturnOverviewIfNeeded = useCallback((nextDetail: InterventionMaterialToolOutput) => {
    if (!hasFollowActivityRef.current || returnOverviewTrackedRef.current) return
    returnOverviewTrackedRef.current = true
    postInteraction('follow_return_overview', {
      totalFollowSec: getCurrentTotalFollowSec(),
      materialDurationSec: nextDetail.overview.totalDurationSec,
      completedStepCount: completedStepCountRef.current,
      totalStepCount: nextDetail.stepsMeta.length,
      lastStepIndex: nextDetail.stepsMeta[currentStepIdxRef.current]?.stepIndex ?? null,
    })
  }, [getCurrentTotalFollowSec, postInteraction])

  const handleToggleFavorite = useCallback(async () => {
    const nextDetail = detailRef.current
    if (!sessionId || !toolCallId || !nextDetail || savingMaterial) return
    if (isSaved && !favoriteEngagementId) return

    setSavingMaterial(true)
    setSaveError(null)
    try {
      if (isSaved && favoriteEngagementId) {
        await api.delete(`/intervention-material-runtime/saved/${favoriteEngagementId}?sessionId=${encodeURIComponent(sessionId)}`)
        setFavoriteRemoved(true)
        setSavedEngagement(null)
        onUnsaved?.(favoriteEngagementId)
        return
      }

      const res = await api.post<ApiResponse<InterventionMaterialInteractionResponse>>(
        '/intervention-material-runtime/interactions',
        {
          sessionId,
          toolCallId,
          event: 'save',
          source: feedbackSource,
          totalFollowSec: getCurrentTotalFollowSec(),
          completedStepCount: completedStepCountRef.current,
          totalStepCount: nextDetail.stepsMeta.length,
          lastStepIndex: nextDetail.stepsMeta[currentStepIdxRef.current]?.stepIndex ?? null,
        },
      )
      if (!res.data?.engagement) throw new Error('收藏失败')
      setFavoriteRemoved(false)
      setSavedEngagement(res.data.engagement)
      onSaved?.(res.data.engagement)
    } catch (err: any) {
      setSaveError(err.message || (isSaved ? '取消收藏失败，请稍后重试' : '收藏失败，请稍后重试'))
    } finally {
      setSavingMaterial(false)
    }
  }, [favoriteEngagementId, feedbackSource, getCurrentTotalFollowSec, isSaved, onSaved, onUnsaved, savingMaterial, sessionId, toolCallId])

  const finishFollow = useCallback(() => {
    const nextDetail = detailRef.current
    if (!nextDetail) return

    pauseActiveFollowClock()
    stopAudio(true)
    setInterventionFollowAudioActive(false)
    completedStepCountRef.current = nextDetail.stepsMeta.length
    setCompletedStepCount(nextDetail.stepsMeta.length)
    setRemainingSec(0)
    modeRef.current = 'completed'
    setMode('completed')
    setPostFeedbackVisible(true)
    hiddenPausedRef.current = false
    setHiddenPaused(false)
    postReturnOverviewIfNeeded(nextDetail)
  }, [pauseActiveFollowClock, postReturnOverviewIfNeeded, stopAudio])

  const advanceToNextStep = useCallback(() => {
    const nextDetail = detailRef.current
    if (!nextDetail) return

    const nextCompleted = Math.max(completedStepCountRef.current, currentStepIdxRef.current + 1)
    completedStepCountRef.current = nextCompleted
    setCompletedStepCount(nextCompleted)

    const nextStepIdx = currentStepIdxRef.current + 1
    if (nextStepIdx >= nextDetail.stepsMeta.length) {
      finishFollow()
      return
    }

    const nextStep = nextDetail.stepsMeta[nextStepIdx]
    resetStepCompletionState(nextStepIdx)
    syncStepState(nextStepIdx, nextStep.durationSec)
    stepEndAtRef.current = Date.now() + remainingMsRef.current
    startTicker()
    playStepAudio(nextStepIdx, true)
    postInteraction('progress', {
      totalFollowSec: getCurrentTotalFollowSec(),
      completedStepCount: nextCompleted,
      totalStepCount: nextDetail.stepsMeta.length,
      lastStepIndex: nextStep.stepIndex,
    })
  }, [finishFollow, getCurrentTotalFollowSec, playStepAudio, postInteraction, startTicker, syncStepState])
  advanceToNextStepRef.current = advanceToNextStep

  function startTicker() {
    clearTicker()
    tickerRef.current = window.setInterval(() => {
      const endAt = stepEndAtRef.current
      if (modeRef.current !== 'follow' || endAt === null) return

      const remainingMs = Math.max(0, endAt - Date.now())
      remainingMsRef.current = remainingMs
      const nextRemainingSec = Math.max(0, Math.ceil(remainingMs / 1000))
      setRemainingSec((prev) => (prev === nextRemainingSec ? prev : nextRemainingSec))
      setFollowElapsedSec((prev) => {
        const next = getCurrentTotalFollowSec()
        return prev === next ? prev : next
      })

      if (remainingMs <= 0) {
        stepTimerDoneRef.current = true
        const audio = audioRef.current
        if (!audio || audio.ended || audio.error || (audio.paused && !audio.currentSrc)) {
          stepAudioDoneRef.current = true
        }
        clearTicker()
        scheduleAdvanceIfStepDone()
      }
    }, 250)
  }

  const resumeCurrentStep = useCallback(() => {
    if (modeRef.current !== 'follow') return
    if (remainingMsRef.current <= 0) {
      stepTimerDoneRef.current = true
      scheduleAdvanceIfStepDone()
      return
    }
    if (activeFollowStartedAtRef.current === null) {
      activeFollowStartedAtRef.current = Date.now()
    }
    stepEndAtRef.current = Date.now() + remainingMsRef.current
    startTicker()
    playStepAudio(currentStepIdxRef.current, false)
    setHiddenPaused(false)
  }, [advanceToNextStep, playStepAudio, startTicker])

  const startFollowAt = useCallback((stepIdx: number, opts: { resetAttempt?: boolean } = {}) => {
    const nextDetail = detailRef.current
    if (!nextDetail) return

    const safeIndex = clampStepIndex(nextDetail, stepIdx)
    const step = nextDetail.stepsMeta[safeIndex]
    if (!step) return

    hasFollowActivityRef.current = true
    reportTodoStart()
    setPreFeedbackVisible(true)
    lastProgressKeyRef.current = null
    if (opts.resetAttempt) {
      completedStepCountRef.current = 0
      setCompletedStepCount(0)
    }

    // 跟练语音开始前，先停止聊天正文的 TTS，避免双音轨同时播放
    ttsPlayer.stop()
    setInterventionFollowAudioActive(true)

    resetStepCompletionState(safeIndex)
    syncStepState(safeIndex, step.durationSec)
    modeRef.current = 'follow'
    setMode('follow')
    hiddenPausedRef.current = false
    setHiddenPaused(false)
    if (activeFollowStartedAtRef.current === null) {
      activeFollowStartedAtRef.current = Date.now()
    }
    stepEndAtRef.current = Date.now() + remainingMsRef.current
    startTicker()
    playStepAudio(safeIndex, true)
    postInteraction('follow_start', {
      totalFollowSec: getCurrentTotalFollowSec(),
      completedStepCount: completedStepCountRef.current,
      totalStepCount: nextDetail.stepsMeta.length,
      lastStepIndex: step.stepIndex,
    })
  }, [getCurrentTotalFollowSec, playStepAudio, postInteraction, reportTodoStart, startTicker, syncStepState])

  const goToOverview = useCallback(() => {
    const nextDetail = detailRef.current
    if (!nextDetail) return

    pauseActiveFollowClock()
    stopAudio(false)
    setInterventionFollowAudioActive(false)
    modeRef.current = 'overview'
    setMode('overview')
    hiddenPausedRef.current = false
    setHiddenPaused(false)
    if (hasFollowActivityRef.current) {
      setPostFeedbackVisible(true)
      postReturnOverviewIfNeeded(nextDetail)
    }
  }, [pauseActiveFollowClock, postReturnOverviewIfNeeded, stopAudio])

  useEffect(() => {
    const audio = new Audio()
    audio.preload = 'auto'
    audio.setAttribute('playsinline', 'true')
    audio.setAttribute('webkit-playsinline', 'true')
    audioRef.current = audio

    return () => {
      if (modeRef.current === 'follow' && hasFollowActivityRef.current) {
        pauseActiveFollowClock()
        postInteraction('progress', { totalFollowSec: getCurrentTotalFollowSec() })
      }
      setInterventionFollowAudioActive(false)
      clearTicker()
      audio.onended = null
      audio.onerror = null
      audio.pause()
      audio.src = ''
      audioRef.current = null
    }
  }, [clearTicker, getCurrentTotalFollowSec, pauseActiveFollowClock, postInteraction])

  useEffect(() => {
    const resetKey = parsed
      ? `${toolCallId ?? 'no-tool'}:${parsed.materialId}:${parsed.version}`
      : `${toolCallId ?? 'no-tool'}:empty`
    if (resetKeyRef.current === resetKey) {
      if (parsed && !detailRef.current) {
        detailRef.current = parsed
        setDetail(parsed)
      }
      return
    }
    resetKeyRef.current = resetKey

    detailRef.current = parsed
    setDetail(parsed)
    setLoadError(null)
    setPlaybackError(null)
    setSaveError(null)
    setSavedEngagement(initialSavedEngagement)
    setFeedbackEngagementId(initialSavedEngagement?.id ?? null)
    setFavoriteRemoved(false)
    setFailedImageUrls(new Set())
    imageRefreshAttemptsRef.current = 0
    clearTicker()
    stopAudio(true)
    totalFollowMsRef.current = 0
    activeFollowStartedAtRef.current = null
    completedStepCountRef.current = 0
    hasFollowActivityRef.current = false
    returnOverviewTrackedRef.current = false
    setPreFeedbackVisible(false)
    setPostFeedbackVisible(false)
    hiddenPausedRef.current = false
    lastProgressKeyRef.current = null
    viewTrackedRef.current = false
    stepTimerDoneRef.current = false
    stepAudioDoneRef.current = true
    stepAdvanceScheduledRef.current = false
    stepPlaybackTokenRef.current += 1
    modeRef.current = 'overview'
    setInterventionFollowAudioActive(false)
    setMode('overview')
    setCompletedStepCount(0)
    setFollowElapsedSec(0)
    setHiddenPaused(false)
    const firstDuration = parsed?.stepsMeta[0]?.durationSec ?? 0
    syncStepState(0, firstDuration)
    applyProgressState(parsed?.progress, parsed)
    stepEndAtRef.current = null
  }, [applyProgressState, clearTicker, initialSavedEngagement, parsed, stopAudio, syncStepState, toolCallId])

  useEffect(() => {
    if (!parsed || !sessionId || !toolCallId || loading || isSharedView) {
      setLoadingDetail(false)
      return
    }

    const fetchKey = `${sessionId}:${toolCallId}:${parsed.materialId}:${parsed.version}`
      + `:${detailRefreshNonce}`
    if (detailFetchKeyRef.current === fetchKey) return
    detailFetchKeyRef.current = fetchKey

    let cancelled = false
    let settled = false
    setLoadingDetail(true)

    api.get<ApiResponse<InterventionMaterialRuntimeDetailResponse>>(
      `/intervention-material-runtime/detail?sessionId=${encodeURIComponent(sessionId)}&toolCallId=${encodeURIComponent(toolCallId)}`,
    )
      .then((res) => {
        if (cancelled || !res.data?.detail) return
        const nextDetail = {
          ...res.data.detail,
          discomfortFeedback: res.data.detail.discomfortFeedback
            ?? detailRef.current?.discomfortFeedback
            ?? parsed.discomfortFeedback
            ?? null,
        }
        detailRef.current = nextDetail
        setDetail(nextDetail)
        setFailedImageUrls(new Set())
        imageRefreshAttemptsRef.current = 0
        setSavedEngagement(res.data.savedEngagement ?? null)
        if (modeRef.current !== 'follow') {
          applyProgressState(
            res.data.engagement ?? res.data.savedEngagement ?? res.data.detail.progress,
            nextDetail,
          )
        }
      })
      .catch((err: Error) => {
        if (cancelled) return
        detailFetchKeyRef.current = null
        setLoadError(err.message || '素材加载失败')
      })
      .finally(() => {
        settled = true
        if (!cancelled) setLoadingDetail(false)
      })

    return () => {
      cancelled = true
      if (!settled && detailFetchKeyRef.current === fetchKey) {
        detailFetchKeyRef.current = null
      }
    }
  }, [applyProgressState, detailRefreshNonce, isSharedView, loading, parsed, sessionId, toolCallId])

  useEffect(() => {
    if (!activeDetail || !isInteractive || loading || viewTrackedRef.current) return
    viewTrackedRef.current = true
    postInteraction('view')
  }, [activeDetail, isInteractive, loading, postInteraction])

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden) {
        if (modeRef.current === 'follow') {
          hiddenPausedRef.current = true
          setHiddenPaused(true)
          pauseActiveFollowClock()
          stopAudio(false)
          if (hasFollowActivityRef.current) {
            postInteraction('progress', { totalFollowSec: getCurrentTotalFollowSec() })
          }
        }
        return
      }

      if (hiddenPausedRef.current && modeRef.current === 'follow') {
        hiddenPausedRef.current = false
        resumeCurrentStep()
      }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange)
  }, [getCurrentTotalFollowSec, pauseActiveFollowClock, postInteraction, resumeCurrentStep, stopAudio])

  if (loading) {
    return (
      <div style={styles.wrapper}>
        <div style={styles.loadingCard}>
          <div style={styles.loadingHeader}>
            <GeneratingSpinner />
            <div style={styles.loadingCopy}>
              <div style={styles.loadingTitle}>方案生成中...</div>
              <div style={styles.loadingText}>正在整理总览、跟练步骤和语音引导</div>
            </div>
          </div>
          <div style={styles.loadingBars}>
            <div style={{ ...styles.loadingBar, width: '82%' }} />
            <div style={{ ...styles.loadingBar, width: '64%' }} />
            <div style={{ ...styles.loadingBar, width: '70%' }} />
          </div>
        </div>
      </div>
    )
  }

  if (!activeDetail) return null

  const canFollow = isInteractive
  const overviewButtonLabel = mode === 'completed'
    ? '再跟练一次'
    : hasFollowActivityRef.current
      ? '继续跟练'
      : '开始跟练'
  const overviewImageUrl = usableImageUrl(activeDetail.currentSignedUrls.overviewImageUrl, failedImageUrls)
  const stepImageUrls = activeDetail.currentSignedUrls.stepImageUrls.map((url) => usableImageUrl(url, failedImageUrls))
  const stepImageUrl = stepImageUrls[currentStepIdx] ?? ''

  return (
    <div style={styles.wrapper}>
      <div style={styles.card}>
        <div style={styles.headerRow}>
          <div>
            <div style={styles.title}>{activeDetail.actionName}</div>
            <div style={styles.subtitle}>{activeDetail.sideEffect} · {activeDetail.scene}</div>
          </div>
          <div style={styles.metricBadge}>{activeDetail.stepsMeta.length} 步</div>
        </div>

        {(mode === 'overview' || mode === 'completed') && (
          <>
            <div style={styles.imageFrame}>
              {overviewImageUrl ? (
                <img
                  src={overviewImageUrl}
                  alt={activeDetail.actionName}
                  style={styles.clickableImage}
                  onClick={() => openLightbox([overviewImageUrl])}
                  onError={() => handleImageError(overviewImageUrl)}
                />
              ) : (
                <div style={styles.imageFallback}>总览图加载中</div>
              )}
            </div>

            <div style={styles.metaGrid}>
              <div style={styles.metaItem}>
                <span style={styles.metaLabel}>总时长</span>
                <strong style={styles.metaValue}>{formatDuration(activeDetail.overview.totalDurationSec)}</strong>
              </div>
              <div style={styles.metaItem}>
                <span style={styles.metaLabel}>当前进度</span>
                <strong style={styles.metaValue}>{progressText}</strong>
              </div>
              <div style={styles.metaItem}>
                <span style={styles.metaLabel}>跟练时长</span>
                <strong style={styles.metaValue}>{formatDuration(followElapsedSec)}</strong>
              </div>
            </div>

            {activeDetail.overview.prepareItems.length > 0 && (
              <section style={styles.section}>
                <div style={styles.sectionTitle}>开始前可准备</div>
                <div style={styles.chipWrap}>
                  {activeDetail.overview.prepareItems.map((item) => (
                    <span key={item} style={styles.chip}>{item}</span>
                  ))}
                </div>
              </section>
            )}

            {activeDetail.overview.precheckQuestion && (
              <section style={styles.section}>
                <div style={styles.sectionTitle}>开始前先确认</div>
                <div style={styles.bodyText}>{activeDetail.overview.precheckQuestion}</div>
              </section>
            )}

            {activeDetail.overview.safetyNote && (
              <section style={styles.section}>
                <div style={styles.sectionTitle}>安全提示</div>
                <div style={styles.bodyText}>{activeDetail.overview.safetyNote}</div>
              </section>
            )}

            {(activeDetail.overview.effectiveRule || activeDetail.overview.feedbackQuestion) && (
              <section style={styles.section}>
                <div style={styles.sectionTitle}>做完后留意一下</div>
                {activeDetail.overview.effectiveRule && (
                  <div style={styles.bodyText}>{activeDetail.overview.effectiveRule}</div>
                )}
                {activeDetail.overview.feedbackQuestion && (
                  <div style={styles.infoText}>{activeDetail.overview.feedbackQuestion}</div>
                )}
              </section>
            )}

            {(activeDetail.overview.redFlags.length > 0 || activeDetail.overview.fallbackAction) && (
              <section style={styles.section}>
                <div style={styles.sectionTitle}>出现以下情况先停下</div>
                {activeDetail.overview.redFlags.length > 0 && (
                  <ul style={styles.list}>
                    {activeDetail.overview.redFlags.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                )}
                {activeDetail.overview.fallbackAction && (
                  <div style={styles.warningText}>{activeDetail.overview.fallbackAction}</div>
                )}
              </section>
            )}

            {mode === 'completed' && (
              <div style={styles.successBanner}>
                已完成本轮跟练，可按需要再来一遍。
              </div>
            )}

            <div style={styles.cardActionRow}>
              <div style={styles.buttonRow}>
                <button
                  type="button"
                  style={{ ...styles.primaryButton, ...(canFollow ? {} : styles.disabledButton) }}
                  disabled={!canFollow}
                  onClick={() => startFollowAt(mode === 'completed' ? 0 : currentStepIdx, { resetAttempt: mode === 'completed' || currentStepIdx === 0 })}
                >
                  {canFollow ? overviewButtonLabel : '仅原会话内可跟练'}
                </button>
              </div>
              <div style={styles.favoriteButtonSlot}>
                {isSaved ? (
                  <button
                    type="button"
                    style={{ ...styles.favoriteSecondaryButton, ...(favoriteDisabled ? styles.disabledButton : {}) }}
                    disabled={favoriteDisabled}
                    onClick={handleToggleFavorite}
                  >
                    <FavoriteIcon active />
                    <span>{savingMaterial ? '取消中...' : '取消收藏'}</span>
                  </button>
                ) : loadingDetail ? (
                  <button type="button" style={{ ...styles.favoritePrimaryButton, ...styles.disabledButton }} disabled>
                    请稍候...
                  </button>
                ) : (
                  <button
                    type="button"
                    style={{ ...styles.favoritePrimaryButton, ...(favoriteDisabled ? styles.disabledButton : {}) }}
                    disabled={favoriteDisabled}
                    onClick={handleToggleFavorite}
                  >
                    <FavoriteIcon active={false} />
                    <span>{savingMaterial ? '收藏中...' : '收藏'}</span>
                  </button>
                )}
              </div>
            </div>
            {saveError && <div style={styles.errorText}>{saveError}</div>}
          </>
        )}

        {mode === 'follow' && activeStep && (
          <>
            <div style={styles.stepImageFrame}>
              {stepImageUrl ? (
                <img
                  src={stepImageUrl}
                  alt={`步骤 ${activeStep.stepIndex}`}
                  style={styles.stepImage}
                  onClick={() => openLightbox(stepImageUrls, currentStepIdx)}
                  onError={() => handleImageError(stepImageUrl)}
                />
              ) : (
                <div style={styles.imageFallback}>步骤图加载中</div>
              )}
            </div>

            <div style={styles.followHeader}>
              <div>
                <div style={styles.stepLabel}>步骤 {activeStep.stepIndex} / {activeDetail.stepsMeta.length}</div>
                <div style={styles.stepText}>{activeStep.displayText}</div>
              </div>
              <div style={styles.countdownBadge}>{remainingSec}s</div>
            </div>

            <div style={styles.progressTrack}>
              <div
                style={{
                  ...styles.progressFill,
                  width: `${((currentStepIdx + 1) / activeDetail.stepsMeta.length) * 100}%`,
                }}
              />
            </div>

            <div style={styles.followMeta}>已完成 {progressText} · 已跟练 {formatDuration(followElapsedSec)}</div>
            {hiddenPaused && <div style={styles.infoText}>页面切到后台后已自动暂停，回到当前页会继续播放。</div>}
            {playbackError && <div style={styles.errorText}>{playbackError}</div>}

            <div style={styles.buttonRow}>
              <button
                type="button"
                style={{ ...styles.secondaryButton, ...(currentStepIdx === 0 ? styles.disabledButton : {}) }}
                disabled={currentStepIdx === 0}
                onClick={() => {
                  const prevIdx = Math.max(0, currentStepIdxRef.current - 1)
                  const prevStep = activeDetail.stepsMeta[prevIdx]
                  resetStepCompletionState(prevIdx)
                  syncStepState(prevIdx, prevStep.durationSec)
                  stepEndAtRef.current = Date.now() + remainingMsRef.current
                  startTicker()
                  playStepAudio(prevIdx, true)
                  postInteraction('progress', {
                    totalFollowSec: getCurrentTotalFollowSec(),
                    lastStepIndex: prevStep.stepIndex,
                  })
                }}
              >
                上一步
              </button>
              <button
                type="button"
                style={styles.secondaryButton}
                onClick={() => {
                  resetStepCompletionState(currentStepIdxRef.current)
                  syncStepState(currentStepIdxRef.current, activeStep.durationSec)
                  stepEndAtRef.current = Date.now() + remainingMsRef.current
                  startTicker()
                  playStepAudio(currentStepIdxRef.current, true)
                }}
              >
                重播本步
              </button>
              <button
                type="button"
                style={{
                  ...styles.secondaryButton,
                  ...(currentStepIdx >= activeDetail.stepsMeta.length - 1 ? styles.disabledButton : {}),
                }}
                disabled={currentStepIdx >= activeDetail.stepsMeta.length - 1}
                onClick={advanceToNextStep}
              >
                下一步
              </button>
              <button
                type="button"
                style={styles.secondaryButton}
                onClick={goToOverview}
              >
                返回总览
              </button>
            </div>
          </>
        )}

        {(loadingDetail || loadError || !canFollow) && (
          <div style={styles.footnote}>
            {loadingDetail
              ? '正在同步该方案的最新素材链接...'
              : loadError
                ? `素材刷新失败：${loadError}`
                : '分享页或脱离原会话时，仅展示静态摘要，不提供跟练交互。'}
          </div>
        )}

      </div>

      {!todoContext && (
        <DiscomfortFeedbackBar
          visible={isSharedView ? sharedPreFeedbackScore !== null : (preFeedbackVisible || editablePreFeedbackScore !== null) && isInteractive}
          sessionId={sessionId}
          resourceKind="intervention_material"
          resourceId={activeDetail.code}
          resourceTitle={activeDetail.actionName}
          resourceContext={`${activeDetail.sideEffect} · ${activeDetail.scene}`}
          toolCallId={toolCallId}
          engagementId={feedbackEngagementId}
          timing="pre"
          source={feedbackSource}
          totalFollowSec={followElapsedSec}
          materialDurationSec={activeDetail.overview.totalDurationSec}
          readOnly={isSharedView}
          readOnlyScore={sharedPreFeedbackScore}
          initialScore={editablePreFeedbackScore}
        />
      )}

      {!todoContext && (
        <DiscomfortFeedbackBar
          visible={isSharedView ? sharedPostFeedbackScore !== null : (postFeedbackVisible || editablePostFeedbackScore !== null) && isInteractive}
          sessionId={sessionId}
          resourceKind="intervention_material"
          resourceId={activeDetail.code}
          resourceTitle={activeDetail.actionName}
          resourceContext={`${activeDetail.sideEffect} · ${activeDetail.scene}`}
          toolCallId={toolCallId}
          engagementId={feedbackEngagementId}
          timing="post"
          source={feedbackSource}
          totalFollowSec={followElapsedSec}
          materialDurationSec={activeDetail.overview.totalDurationSec}
          readOnly={isSharedView}
          readOnlyScore={sharedPostFeedbackScore}
          initialScore={editablePostFeedbackScore}
        />
      )}

      <TodoFeedbackBar
        visible={Boolean(todoContext) && (postFeedbackVisible || mode === 'completed' || (todoContext ? isTodoContextClosed(todoContext) : false))}
        sessionId={sessionId}
        todoContext={todoContext}
        onSubmitted={onTodoFeedbackSubmit}
      />

      {lightboxImages && (
        <ImageLightbox
          images={lightboxImages}
          initialIndex={lightboxIndex}
          onClose={() => setLightboxImages(null)}
        />
      )}
    </div>
  )
}

const styles: Record<string, CSSProperties> = {
  wrapper: {
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    margin: '12px 0 16px',
  },
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    padding: 14,
    borderRadius: 18,
    border: '1px solid rgba(212, 135, 108, 0.16)',
    background: 'linear-gradient(180deg, rgba(255,255,255,0.98) 0%, rgba(255,247,244,0.96) 100%)',
    boxShadow: '0 10px 24px rgba(212, 135, 108, 0.08)',
  },
  loadingCard: {
    display: 'flex',
    flexDirection: 'column',
    gap: 14,
    padding: 16,
    borderRadius: 18,
    border: '1px solid rgba(212, 135, 108, 0.16)',
    background: 'linear-gradient(180deg, rgba(255,255,255,0.98) 0%, rgba(255,247,244,0.96) 100%)',
    boxShadow: '0 10px 24px rgba(212, 135, 108, 0.08)',
  },
  loadingHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
  },
  loadingCopy: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  loadingTitle: {
    fontSize: 16,
    fontWeight: 700,
    color: '#8D4F38',
  },
  loadingText: {
    fontSize: 13,
    color: 'var(--color-text-muted)',
  },
  loadingBars: {
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  loadingBar: {
    height: 10,
    borderRadius: 999,
    background: 'linear-gradient(90deg, rgba(212, 135, 108, 0.10) 0%, rgba(212, 135, 108, 0.22) 50%, rgba(212, 135, 108, 0.10) 100%)',
  },
  headerRow: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
  },
  title: {
    fontSize: 'calc(var(--font-size-chat) + 3px)',
    fontWeight: 700,
    color: '#7F4734',
    lineHeight: 1.4,
    marginTop: 2,
  },
  subtitle: {
    fontSize: 'var(--font-size-chat)',
    color: 'var(--color-text-muted)',
    marginTop: 4,
    lineHeight: 1.5,
  },
  metricBadge: {
    flexShrink: 0,
    minWidth: 56,
    padding: '8px 10px',
    borderRadius: 12,
    background: 'rgba(212, 135, 108, 0.1)',
    color: '#A95B3E',
    fontSize: 12,
    fontWeight: 700,
    textAlign: 'center',
  },
  imageFrame: {
    position: 'relative',
    width: '100%',
    overflow: 'hidden',
    borderRadius: 16,
    aspectRatio: '16 / 9',
    background: 'rgba(212, 135, 108, 0.08)',
  },
  stepImageFrame: {
    position: 'relative',
    width: '100%',
    overflow: 'hidden',
    borderRadius: 16,
    aspectRatio: '3 / 4',
    background: '#f5ecdd',
  },
  image: {
    width: '100%',
    height: '100%',
    objectFit: 'cover',
    display: 'block',
  },
  clickableImage: {
    width: '100%',
    height: '100%',
    objectFit: 'cover',
    display: 'block',
    cursor: 'zoom-in',
  },
  stepImage: {
    width: '100%',
    height: '100%',
    objectFit: 'contain',
    display: 'block',
    cursor: 'zoom-in',
  },
  imageFallback: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
    height: '100%',
    fontSize: 13,
    color: 'var(--color-text-muted)',
  },
  metaGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
    gap: 10,
  },
  metaItem: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    padding: 12,
    borderRadius: 14,
    background: 'rgba(255,255,255,0.78)',
    border: '1px solid rgba(212, 135, 108, 0.08)',
  },
  metaLabel: {
    fontSize: 12,
    color: 'var(--color-text-muted)',
  },
  metaValue: {
    fontSize: 'var(--font-size-chat)',
    color: '#7F4734',
  },
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  sectionTitle: {
    fontSize: 'calc(var(--font-size-chat) - 1px)',
    fontWeight: 700,
    color: '#7F4734',
  },
  chipWrap: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 8,
  },
  chip: {
    padding: '8px 10px',
    borderRadius: 999,
    background: 'rgba(212, 135, 108, 0.1)',
    color: '#A95B3E',
    fontSize: 'calc(var(--font-size-chat) - 2px)',
    fontWeight: 600,
  },
  bodyText: {
    fontSize: 'var(--font-size-chat)',
    lineHeight: 1.6,
    color: '#5D4A43',
  },
  list: {
    margin: 0,
    paddingLeft: 18,
    color: '#5D4A43',
    fontSize: 'var(--font-size-chat)',
    lineHeight: 1.7,
  },
  warningText: {
    fontSize: 'var(--font-size-chat)',
    lineHeight: 1.6,
    color: '#B04D3A',
  },
  successBanner: {
    padding: '12px 14px',
    borderRadius: 14,
    background: 'rgba(43, 122, 70, 0.08)',
    color: '#2B7A46',
    fontSize: 'var(--font-size-chat)',
    fontWeight: 600,
  },
  followHeader: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
  },
  stepLabel: {
    fontSize: 12,
    fontWeight: 700,
    color: '#B36A4E',
  },
  stepText: {
    marginTop: 6,
    fontSize: 'var(--font-size-chat)',
    fontWeight: 600,
    lineHeight: 1.6,
    color: '#5D4A43',
  },
  countdownBadge: {
    flexShrink: 0,
    minWidth: 64,
    padding: '10px 12px',
    borderRadius: 14,
    background: '#A95B3E',
    color: '#fff',
    fontSize: 16,
    fontWeight: 700,
    textAlign: 'center',
  },
  progressTrack: {
    width: '100%',
    height: 8,
    borderRadius: 999,
    background: 'rgba(212, 135, 108, 0.12)',
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: 999,
    background: 'linear-gradient(90deg, #D4876C 0%, #E8A07B 100%)',
    transition: 'width 180ms ease',
  },
  followMeta: {
    fontSize: 13,
    color: 'var(--color-text-muted)',
  },
  infoText: {
    fontSize: 12,
    color: '#A95B3E',
  },
  errorText: {
    fontSize: 12,
    color: '#D94841',
  },
  buttonRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 10,
  },
  cardActionRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    flexWrap: 'wrap',
  },
  favoriteButtonSlot: {
    display: 'flex',
    alignItems: 'center',
    marginLeft: 'auto',
  },
  primaryButton: {
    minHeight: 44,
    padding: '12px 16px',
    border: 'none',
    borderRadius: 14,
    background: 'linear-gradient(135deg, #D4876C 0%, #E8A07B 100%)',
    color: '#fff',
    fontSize: 14,
    fontWeight: 700,
    cursor: 'pointer',
  },
  secondaryButton: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    minHeight: 32,
    padding: '6px 12px',
    borderRadius: 10,
    border: '1px solid rgba(212, 135, 108, 0.2)',
    background: 'rgba(255,255,255,0.8)',
    color: '#A95B3E',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
  },
  favoritePrimaryButton: {
    border: 'none',
    borderRadius: 12,
    minWidth: 88,
    minHeight: 44,
    padding: '12px 16px',
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
    padding: '12px 16px',
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
  disabledButton: {
    opacity: 0.55,
    cursor: 'not-allowed',
  },
  footnote: {
    fontSize: 12,
    color: 'var(--color-text-muted)',
    lineHeight: 1.6,
  },
}
