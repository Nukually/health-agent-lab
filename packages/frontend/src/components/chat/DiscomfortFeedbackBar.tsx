import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import type {
  ApiResponse,
  InterventionDiscomfortFeedbackRequest,
  InterventionDiscomfortFeedbackResourceKind,
  InterventionDiscomfortFeedbackResponse,
  InterventionDiscomfortFeedbackTiming,
  InterventionMaterialInteractionSource,
} from '@health-agent/shared'
import { api } from '../../services/api.js'

const SCORES = Array.from({ length: 11 }, (_, index) => index)

interface Props {
  visible: boolean
  sessionId: string | null
  resourceKind: InterventionDiscomfortFeedbackResourceKind
  resourceId: string
  resourceTitle?: string | null
  resourceContext?: string | null
  toolCallId?: string | null
  engagementId?: string | null
  timing: InterventionDiscomfortFeedbackTiming
  source?: InterventionMaterialInteractionSource
  totalFollowSec?: number
  materialDurationSec?: number
  readOnly?: boolean
  readOnlyScore?: number | null
  initialScore?: number | null
}

function titleForTiming(timing: InterventionDiscomfortFeedbackTiming): string {
  return timing === 'pre' ? '跟练前不舒服的程度' : '跟练后不舒服的程度'
}

export default function DiscomfortFeedbackBar({
  visible,
  sessionId,
  resourceKind,
  resourceId,
  resourceTitle,
  resourceContext,
  toolCallId,
  engagementId,
  timing,
  source = 'chat_inline',
  totalFollowSec,
  materialDurationSec,
  readOnly = false,
  readOnlyScore = null,
  initialScore = null,
}: Props) {
  const [selectedScore, setSelectedScore] = useState<number | null>(null)
  const [savedScore, setSavedScore] = useState<number | null>(initialScore)
  const [submittingScore, setSubmittingScore] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const resetKey = useMemo(
    () => `${sessionId ?? 'no-session'}:${resourceKind}:${resourceId}:${timing}:${initialScore ?? 'none'}`,
    [initialScore, resourceId, resourceKind, sessionId, timing],
  )

  useEffect(() => {
    setSelectedScore(null)
    setSavedScore(initialScore)
    setSubmittingScore(null)
    setError(null)
  }, [initialScore, resetKey])

  if (!visible || !resourceId || (!readOnly && !sessionId)) return null

  const displayScore = readOnly ? readOnlyScore : savedScore
  const activeScore = readOnly ? readOnlyScore : (selectedScore ?? savedScore)

  function submitScore(score: number) {
    if (readOnly || !sessionId) return
    setSelectedScore(score)
    setSubmittingScore(score)
    setError(null)

    const payload: InterventionDiscomfortFeedbackRequest = {
      sessionId,
      resourceKind,
      resourceId,
      resourceTitle: resourceTitle ?? null,
      resourceContext: resourceContext ?? null,
      toolCallId: toolCallId ?? null,
      engagementId: engagementId ?? null,
      timing,
      score,
      source,
      totalFollowSec,
      materialDurationSec,
    }

    api.post<ApiResponse<InterventionDiscomfortFeedbackResponse>>(
      '/intervention-material-runtime/discomfort-feedback',
      payload,
    )
      .then((res) => {
        setSavedScore(res.data?.feedback.score ?? score)
      })
      .catch(() => {
        setError('保存失败，点数字可重试')
      })
      .finally(() => {
        setSubmittingScore(null)
      })
  }

  return (
    <div style={styles.bar}>
      <div style={styles.headerRow}>
        <div style={styles.title}>{titleForTiming(timing)}</div>
        <div style={styles.savedText}>
          {displayScore === null ? (readOnly ? '未记录' : '0-10') : `已记录 ${displayScore}/10`}
        </div>
      </div>
      <div style={styles.scoreGrid} role="group" aria-label={titleForTiming(timing)}>
        {SCORES.map((score) => {
          const active = activeScore === score
          const submitting = submittingScore === score
          return (
            <button
              key={score}
              type="button"
              aria-pressed={active}
              aria-disabled={readOnly}
              tabIndex={readOnly ? -1 : 0}
              style={{
                ...styles.scoreButton,
                ...(active ? styles.scoreButtonActive : {}),
                ...(submitting ? styles.scoreButtonSubmitting : {}),
                ...(readOnly ? styles.scoreButtonReadOnly : {}),
              }}
              onClick={readOnly ? undefined : () => submitScore(score)}
            >
              {score}
            </button>
          )
        })}
      </div>
      <div style={styles.captionRow}>
        <span>0 无不适</span>
        <span>10 很不适</span>
      </div>
      {error && <div style={styles.errorText}>{error}</div>}
    </div>
  )
}

const styles: Record<string, CSSProperties> = {
  bar: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    padding: '10px 10px 9px',
    borderRadius: 8,
    border: '1px solid rgba(212, 135, 108, 0.18)',
    background: '#FFF8F4',
    boxShadow: '0 6px 16px rgba(120, 72, 48, 0.07)',
  },
  headerRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  title: {
    minWidth: 0,
    fontSize: 13,
    fontWeight: 700,
    lineHeight: 1.35,
    color: '#6F4535',
  },
  savedText: {
    flexShrink: 0,
    fontSize: 12,
    fontWeight: 700,
    color: '#A95B3E',
  },
  scoreGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(11, minmax(0, 1fr))',
    gap: 4,
  },
  scoreButton: {
    minWidth: 0,
    aspectRatio: '1 / 1',
    border: '1px solid rgba(212, 135, 108, 0.18)',
    borderRadius: 999,
    background: '#fff',
    color: '#7A5A4C',
    fontSize: 12,
    fontWeight: 700,
    lineHeight: 1,
    cursor: 'pointer',
    transition: 'background 160ms ease, color 160ms ease, transform 160ms ease, border-color 160ms ease',
  },
  scoreButtonActive: {
    borderColor: '#D4876C',
    background: '#D4876C',
    color: '#fff',
    boxShadow: '0 4px 10px rgba(212, 135, 108, 0.22)',
  },
  scoreButtonSubmitting: {
    transform: 'scale(0.94)',
  },
  scoreButtonReadOnly: {
    cursor: 'default',
  },
  captionRow: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: 8,
    fontSize: 11,
    lineHeight: 1.35,
    color: '#9A7566',
  },
  errorText: {
    fontSize: 12,
    color: '#D94841',
  },
}
