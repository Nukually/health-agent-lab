import { useEffect, useMemo, useRef, useState } from 'react'
import {
  parseCommunicationCardToolOutput,
  type ApiResponse,
  type CommunicationCardDraft,
  type CommunicationCardRecord,
} from '@health-agent/shared'
import { api } from '../../services/api.js'
import CommunicationCardPanel from '../communication/CommunicationCardPanel.js'

interface Props {
  output?: unknown
  sessionId: string | null
  toolCallId: string | null
  loading?: boolean
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

function outputSignature(output: unknown): string {
  if (typeof output === 'string') return output
  try {
    return JSON.stringify(output) ?? ''
  } catch {
    return String(output ?? '')
  }
}

function draftKey(draft: CommunicationCardDraft): string {
  return [
    draft.title,
    draft.cardDate,
    draft.visitPurpose,
    draft.currentSituation ?? '',
    draft.informationForDoctor ?? '',
    draft.questionsForDoctor ?? '',
  ].join('\u0001')
}

export default function CommunicationCardInline({ output, sessionId, toolCallId, loading = false }: Props) {
  const rawOutputSignature = outputSignature(output)
  const parsed = useMemo(() => parseCommunicationCardToolOutput(output), [rawOutputSignature])
  const parsedKey = parsed ? `${parsed.templateVersion}\u0001${draftKey(parsed.draft)}` : ''
  const [draft, setDraft] = useState<CommunicationCardDraft | null>(parsed?.draft ?? null)
  const [saving, setSaving] = useState(false)
  const [loadingSavedState, setLoadingSavedState] = useState(false)
  const [savedCard, setSavedCard] = useState<CommunicationCardRecord | null>(null)
  const [error, setError] = useState<string | null>(null)
  const activeCardKeyRef = useRef<string>(parsedKey)
  const lookupSeqRef = useRef(0)

  useEffect(() => {
    if (!parsed) {
      setDraft(null)
      setSavedCard(null)
      setError(null)
      activeCardKeyRef.current = ''
      return
    }

    if (activeCardKeyRef.current === parsedKey) return
    activeCardKeyRef.current = parsedKey
    setDraft(parsed.draft)
    setSavedCard(null)
    setError(null)
  }, [parsed, parsedKey])

  useEffect(() => {
    if (!parsed || !sessionId || !toolCallId) {
      setLoadingSavedState(false)
      return
    }

    let cancelled = false
    const lookupSeq = ++lookupSeqRef.current
    const lookupKey = parsedKey
    setLoadingSavedState(true)

    api.get<ApiResponse<CommunicationCardRecord | null>>(
      `/medical/communication-cards/lookup?sessionId=${encodeURIComponent(sessionId)}&toolCallId=${encodeURIComponent(toolCallId)}&title=${encodeURIComponent(parsed.draft.title)}&cardDate=${encodeURIComponent(parsed.draft.cardDate)}`,
    )
      .then((res) => {
        if (cancelled || lookupSeqRef.current !== lookupSeq || activeCardKeyRef.current !== lookupKey) return
        const found = res.data ?? null
        setSavedCard(found)
        setDraft(found?.contentJson.draft ?? parsed.draft)
      })
      .catch(() => {
        if (cancelled || lookupSeqRef.current !== lookupSeq || activeCardKeyRef.current !== lookupKey) return
        setSavedCard(null)
        setDraft(parsed.draft)
      })
      .finally(() => {
        if (!cancelled && lookupSeqRef.current === lookupSeq && activeCardKeyRef.current === lookupKey) {
          setLoadingSavedState(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [parsed, parsedKey, sessionId, toolCallId])

  if (loading) {
    return (
      <div style={styles.wrapper}>
        <div style={styles.loadingCard}>
          <div style={styles.loadingHeader}>
            <GeneratingSpinner />
            <div style={styles.loadingCopy}>
              <div style={styles.loadingTitle}>就诊卡片生成中...</div>
              <div style={styles.loadingText}>正在整理病情概要、就诊重点和待沟通事项</div>
            </div>
          </div>
          <div style={styles.loadingBars}>
            <div style={{ ...styles.loadingBar, width: '78%' }} />
            <div style={{ ...styles.loadingBar, width: '60%' }} />
            <div style={{ ...styles.loadingBar, width: '72%' }} />
          </div>
        </div>
      </div>
    )
  }

  if (!parsed || !draft) return null
  const originalDraft = parsed.draft

  async function handleToggleFavorite() {
    if (saving || loadingSavedState) return
    const actionKey = parsedKey
    // 用户手动收藏/取消收藏后，旧的 lookup 响应不能再覆盖按钮状态，
    // 否则移动端重渲染时会在“请稍候”和“取消收藏”之间闪动。
    lookupSeqRef.current += 1
    setSaving(true)
    setLoadingSavedState(false)
    setError(null)
    try {
      if (savedCard) {
        await api.delete(`/medical/communication-cards/${savedCard.id}${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''}`)
        if (activeCardKeyRef.current !== actionKey) return
        setSavedCard(null)
        return
      }

      const res = await api.post<ApiResponse<CommunicationCardRecord>>(
        '/medical/communication-cards',
        {
          draft,
          originalDraft,
          sourceSessionId: sessionId ?? undefined,
          sourceToolCallId: toolCallId ?? undefined,
        },
      )
      if (!res.data) throw new Error('收藏失败')
      if (activeCardKeyRef.current !== actionKey) return
      setDraft(res.data.contentJson.draft)
      setSavedCard(res.data)
    } catch (err: any) {
      setError(err.message || (savedCard ? '取消收藏失败，请稍后重试' : '收藏失败，请稍后重试'))
    } finally {
      setSaving(false)
    }
  }

  const favoriteFooter = (
    <>
      <div style={styles.footer}>
        {savedCard ? (
          <button
            style={{ ...styles.secondaryBtn, ...(saving ? styles.disabledBtn : {}) }}
            onClick={handleToggleFavorite}
            disabled={saving}
          >
            <FavoriteIcon active />
            <span>{saving ? '取消中...' : '取消收藏'}</span>
          </button>
        ) : loadingSavedState ? (
          <button style={{ ...styles.primaryBtn, ...styles.disabledBtn }} disabled>
            请稍候...
          </button>
        ) : (
          <button
            style={{ ...styles.primaryBtn, ...(saving ? styles.disabledBtn : {}) }}
            onClick={handleToggleFavorite}
            disabled={saving}
          >
            <FavoriteIcon active={false} />
            <span>{saving ? '收藏中...' : '收藏'}</span>
          </button>
        )}
      </div>

      {error && <div style={styles.error}>{error}</div>}
    </>
  )

  return (
    <div style={styles.wrapper}>
      <CommunicationCardPanel
        draft={draft}
        editable={false}
        footer={favoriteFooter}
      />
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  wrapper: {
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    margin: '10px 0 14px',
  },
  footer: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 10,
    flexWrap: 'wrap',
  },
  primaryBtn: {
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
  secondaryBtn: {
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
  disabledBtn: {
    opacity: 0.6,
    cursor: 'not-allowed',
  },
  error: {
    fontSize: 12,
    color: '#E54848',
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
    fontSize: 14,
    fontWeight: 600,
    color: '#A95B3E',
  },
  loadingText: {
    fontSize: 12,
    color: 'var(--color-text-muted)',
  },
  loadingBars: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  loadingBar: {
    height: 10,
    borderRadius: 999,
    background: 'linear-gradient(90deg, rgba(212, 135, 108, 0.10) 0%, rgba(212, 135, 108, 0.22) 50%, rgba(212, 135, 108, 0.10) 100%)',
  },
}
