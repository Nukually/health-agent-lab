import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type SyntheticEvent } from 'react'
import type {
  ApiResponse,
  InternalVideoInteractionEvent,
  InternalVideoStopReason,
  MedicalRiskInternalVideoResource,
} from '@health-agent/shared'
import { api } from '../../services/api.js'
import DiscomfortFeedbackBar from './DiscomfortFeedbackBar.js'

interface Props {
  resource: MedicalRiskInternalVideoResource
  sessionId: string | null
  toolCallId: string | null
  source?: 'chat_inline' | 'materials' | 'shared_view'
}

interface PlaybackUrls {
  videoUrl: string
  posterUrl: string
}

function formatDuration(totalSec: number): string {
  if (!Number.isFinite(totalSec) || totalSec <= 0) return '未知'
  if (totalSec < 60) return `${Math.round(totalSec)} 秒`
  const minutes = Math.floor(totalSec / 60)
  const seconds = Math.round(totalSec % 60)
  return seconds > 0 ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分钟`
}

export default function InternalVideoInline({
  resource,
  sessionId,
  toolCallId,
  source = 'chat_inline',
}: Props) {
  const isSharedView = source === 'shared_view'
  const canReport = !!sessionId && !!toolCallId && !isSharedView
  const videoRef = useRef<HTMLVideoElement | null>(null)

  const [urls, setUrls] = useState<PlaybackUrls>({ videoUrl: resource.videoUrl, posterUrl: resource.posterUrl })
  const [preFeedbackVisible, setPreFeedbackVisible] = useState(false)
  const [postFeedbackVisible, setPostFeedbackVisible] = useState(false)

  // 精确打点：用 currentTime 增量累计真实观看时长，避免拖动跳转被计入
  const watchedMsRef = useRef(0)
  const lastTimeRef = useRef(0)
  const playStartedRef = useRef(false)
  const lastReportedSecRef = useRef(0)

  const focusText = useMemo(() => {
    const parts = [...(resource.tags?.bodyParts ?? []), ...(resource.tags?.triggerScenes ?? [])]
    return Array.from(new Set(parts)).slice(0, 4).join(' · ')
  }, [resource.tags])

  const sharedPostScore = isSharedView ? resource.discomfortFeedback?.postScore ?? null : null
  const editablePreScore = !isSharedView ? resource.discomfortFeedback?.preScore ?? null : null
  const editablePostScore = !isSharedView ? resource.discomfortFeedback?.postScore ?? null : null

  // 刷新签名 URL，避免历史消息里过期的签名导致黑屏（分享页无鉴权，直接用渲染时的签名）
  useEffect(() => {
    setUrls({ videoUrl: resource.videoUrl, posterUrl: resource.posterUrl })
    if (isSharedView) return
    let cancelled = false
    api.get<ApiResponse<PlaybackUrls & { videoId: string }>>(
      `/internal-videos/playback?videoId=${encodeURIComponent(resource.videoId)}`,
    )
      .then((res) => {
        if (cancelled || !res.data?.videoUrl) return
        setUrls({ videoUrl: res.data.videoUrl, posterUrl: res.data.posterUrl })
      })
      .catch(() => { /* 保留渲染时的签名 URL */ })
    return () => { cancelled = true }
  }, [isSharedView, resource.posterUrl, resource.videoId, resource.videoUrl])

  const reportInteraction = useCallback((
    event: InternalVideoInteractionEvent,
    endReason: InternalVideoStopReason | null = null,
  ) => {
    if (!canReport) return
    const video = videoRef.current
    api.post<ApiResponse<unknown>>('/internal-videos/interactions', {
      sessionId,
      toolCallId,
      resourceId: resource.id,
      videoId: resource.videoId,
      videoVersion: resource.version,
      event,
      positionSec: Math.max(0, Math.floor(video?.currentTime ?? 0)),
      watchedSec: Math.max(0, Math.floor(watchedMsRef.current / 1000)),
      durationSec: resource.durationSec,
      endReason,
    }).catch(() => { /* 打点失败静默 */ })
  }, [canReport, resource.durationSec, resource.id, resource.version, resource.videoId, sessionId, toolCallId])

  const handlePlay = useCallback(() => {
    lastTimeRef.current = videoRef.current?.currentTime ?? 0
    if (!playStartedRef.current) {
      playStartedRef.current = true
      if (!isSharedView) setPreFeedbackVisible(true)
    }
    reportInteraction('play_start')
  }, [isSharedView, reportInteraction])

  const handleTimeUpdate = useCallback((event: SyntheticEvent<HTMLVideoElement>) => {
    const video = event.currentTarget
    const current = video.currentTime
    const delta = current - lastTimeRef.current
    lastTimeRef.current = current
    // 仅累计正常播放的连续增量（拖动/快进的大跳变不计入观看时长）
    if (delta > 0 && delta <= 1.5 && !video.paused) {
      watchedMsRef.current += delta * 1000
    }
    const watchedSec = Math.floor(watchedMsRef.current / 1000)
    if (watchedSec - lastReportedSecRef.current >= 5) {
      lastReportedSecRef.current = watchedSec
      reportInteraction('progress')
    }
  }, [reportInteraction])

  const handlePause = useCallback(() => {
    const video = videoRef.current
    // 播放结束触发的 pause 交给 onEnded 处理
    if (video && video.ended) return
    reportInteraction('pause', 'pause')
    // 点暂停就出追问
    if (!isSharedView) setPostFeedbackVisible(true)
  }, [isSharedView, reportInteraction])

  const handleEnded = useCallback(() => {
    reportInteraction('ended', 'ended')
    if (!isSharedView) setPostFeedbackVisible(true)
  }, [isSharedView, reportInteraction])

  const handleSeeking = useCallback(() => {
    // 拖动后重置基准，避免把跳转差值算进观看时长
    lastTimeRef.current = videoRef.current?.currentTime ?? 0
  }, [])

  useEffect(() => {
    const persistOnHide = () => {
      const video = videoRef.current
      if (video && !video.paused && !video.ended) {
        reportInteraction('pause', 'pagehide')
      }
    }
    window.addEventListener('pagehide', persistOnHide)
    return () => {
      window.removeEventListener('pagehide', persistOnHide)
      const video = videoRef.current
      if (video && !video.paused && !video.ended) {
        reportInteraction('pause', 'unmount')
      }
    }
  }, [reportInteraction])

  return (
    <div style={styles.card}>
      <div style={styles.titleRow}>
        <div style={styles.title}>{resource.title}</div>
        <span style={styles.duration}>{formatDuration(resource.durationSec)}</span>
      </div>
      {focusText && <div style={styles.focus}>{focusText}</div>}
      <div style={styles.videoFrame}>
        <video
          ref={videoRef}
          style={styles.video}
          src={urls.videoUrl}
          poster={urls.posterUrl}
          controls
          playsInline
          preload="metadata"
          onPlay={handlePlay}
          onTimeUpdate={handleTimeUpdate}
          onPause={handlePause}
          onEnded={handleEnded}
          onSeeking={handleSeeking}
        />
      </div>
      {resource.description && <div style={styles.description}>{resource.description}</div>}
      {isSharedView ? (
        sharedPostScore !== null && (
          <DiscomfortFeedbackBar
            visible
            sessionId={null}
            resourceKind="internal_video"
            resourceId={resource.id}
            resourceTitle={resource.title}
            timing="post"
            readOnly
            readOnlyScore={sharedPostScore}
          />
        )
      ) : (
        <>
          <DiscomfortFeedbackBar
            visible={preFeedbackVisible}
            sessionId={sessionId}
            resourceKind="internal_video"
            resourceId={resource.id}
            resourceTitle={resource.title}
            timing="pre"
            source={source === 'materials' ? 'materials' : 'chat_inline'}
            initialScore={editablePreScore}
          />
          <DiscomfortFeedbackBar
            visible={postFeedbackVisible}
            sessionId={sessionId}
            resourceKind="internal_video"
            resourceId={resource.id}
            resourceTitle={resource.title}
            timing="post"
            source={source === 'materials' ? 'materials' : 'chat_inline'}
            initialScore={editablePostScore}
          />
        </>
      )}
    </div>
  )
}

const styles: Record<string, CSSProperties> = {
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    padding: 12,
    borderRadius: 12,
    border: '1px solid rgba(212, 135, 108, 0.18)',
    background: '#FFF8F4',
    boxShadow: '0 6px 16px rgba(120, 72, 48, 0.07)',
  },
  titleRow: {
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 10,
  },
  duration: {
    flexShrink: 0,
    fontSize: 12,
    fontWeight: 600,
    color: '#A95B3E',
  },
  title: {
    flex: 1,
    minWidth: 0,
    fontSize: 15,
    fontWeight: 700,
    lineHeight: 1.4,
    color: '#6F4535',
  },
  focus: {
    fontSize: 12,
    color: '#9A7566',
  },
  videoFrame: {
    width: '100%',
    borderRadius: 10,
    overflow: 'hidden',
    background: '#000',
  },
  video: {
    width: '100%',
    aspectRatio: '16 / 9',
    display: 'block',
    objectFit: 'contain',
    background: '#000',
  },
  description: {
    fontSize: 13,
    lineHeight: 1.5,
    color: '#7A5A4C',
  },
}
