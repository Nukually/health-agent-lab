import { useState, type CSSProperties } from 'react'
import type {
  ApiResponse,
  MedicalDocumentSaveJobStatus,
  MedicalDocumentSaveSuggestionPayload,
} from '@health-agent/shared'
import { api } from '../../services/api.js'
import { useStore } from '../../stores/index.js'

interface Props {
  payload: MedicalDocumentSaveSuggestionPayload
  onRequireHealthProfileConsent: (onAgree: () => void, onReject?: () => void) => void
}

export default function MedicalDocumentSaveSuggestionCard({
  payload,
  onRequireHealthProfileConsent,
}: Props) {
  const dismiss = useStore((s) => s.dismissMedicalDocumentSaveSuggestion)
  const markInteracted = useStore((s) => s.markMedicalDocumentSaveSuggestionInteracted)
  const markMessageImagesPrivacyProtected = useStore((s) => s.markMessageImagesPrivacyProtected)
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)

  function completeSave() {
    markMessageImagesPrivacyProtected(payload.sourceMessageId)
    setStatus('saved')
    window.setTimeout(() => dismiss(payload.suggestionId), 1500)
  }

  async function waitForJob(jobStatus: MedicalDocumentSaveJobStatus) {
    let current = jobStatus
    for (let i = 0; i < 20; i += 1) {
      if (current.status === 'completed') {
        completeSave()
        return
      }
      if (current.status === 'failed') {
        setStatus('error')
        setError(current.error || '保存失败，请稍后重试')
        return
      }
      await new Promise((resolve) => window.setTimeout(resolve, 1500))
      const res = await api.get<ApiResponse<MedicalDocumentSaveJobStatus>>(
        `/medical/documents/save-jobs/${current.jobId}`,
      )
      if (res.data) current = res.data
    }

    setStatus('error')
    setError('保存仍在处理中，请稍后到健康档案查看')
  }

  async function startSave() {
    setStatus('saving')
    setError(null)
    try {
      const res = await api.post<ApiResponse<MedicalDocumentSaveJobStatus>>(
        '/medical/documents/save-from-chat-image',
        {
          sessionId: payload.sessionId,
          sourceMessageId: payload.sourceMessageId,
          toolCallId: payload.toolCallId,
          documentHash: payload.documentHash,
        },
      )
      if (res.data) {
        await waitForJob(res.data)
      } else {
        completeSave()
      }
    } catch (err: any) {
      setStatus('error')
      setError(err.message || '保存失败，请稍后重试')
      console.error('Failed to save chat image as medical document:', err)
    }
  }

  function handleSaveClick() {
    if (status === 'saving' || status === 'saved') return
    markInteracted(payload.suggestionId)
    onRequireHealthProfileConsent(
      () => { void startSave() },
      () => dismiss(payload.suggestionId),
    )
  }

  const title = status === 'saved' ? '已保存到健康档案' : '要保存这次图片吗？'
  const primaryText = {
    idle: '保存',
    saving: '保存中...',
    saved: '已保存',
    error: '重新保存',
  }[status]

  return (
    <div style={styles.wrap}>
      <div style={styles.iconBox} aria-hidden="true">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="9" y1="13" x2="15" y2="13" />
          <line x1="9" y1="17" x2="13" y2="17" />
        </svg>
      </div>
      <div style={styles.body}>
        <div style={styles.title}>{title}</div>
        {error && <div style={styles.errorText}>{error}</div>}
        <div style={styles.actions}>
          <button
            type="button"
            style={{
              ...styles.primaryBtn,
              ...(status === 'saving' || status === 'saved' ? styles.disabledBtn : {}),
            }}
            onClick={handleSaveClick}
            disabled={status === 'saving' || status === 'saved'}
          >
            {primaryText}
          </button>
          {status !== 'saved' && (
            <button
              type="button"
              style={{
                ...styles.secondaryBtn,
                ...(status === 'saving' ? styles.disabledBtn : {}),
              }}
              onClick={() => dismiss(payload.suggestionId)}
              disabled={status === 'saving'}
            >
              暂不保存
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

const styles: Record<string, CSSProperties> = {
  wrap: {
    display: 'flex',
    gap: 10,
    maxWidth: 520,
    margin: '8px 16px 10px 54px',
    padding: 12,
    borderRadius: 8,
    border: '1px solid rgba(61, 143, 124, 0.18)',
    background: 'rgba(255, 255, 255, 0.82)',
    boxShadow: '0 8px 22px rgba(57, 70, 80, 0.08)',
  },
  iconBox: {
    width: 32,
    height: 32,
    borderRadius: 8,
    color: '#3D8F7C',
    background: 'rgba(61, 143, 124, 0.10)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  body: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    fontSize: 14,
    lineHeight: 1.35,
    fontWeight: 700,
    color: 'var(--color-text)',
  },
  actions: {
    display: 'flex',
    gap: 8,
    marginTop: 10,
    flexWrap: 'wrap',
  },
  errorText: {
    marginTop: 6,
    fontSize: 12,
    lineHeight: 1.4,
    color: 'var(--color-error)',
  },
  primaryBtn: {
    height: 30,
    padding: '0 13px',
    borderRadius: 8,
    border: 'none',
    background: 'var(--color-brand)',
    color: '#fff',
    fontSize: 13,
    fontWeight: 700,
    cursor: 'pointer',
  },
  disabledBtn: {
    opacity: 0.65,
    cursor: 'not-allowed',
  },
  secondaryBtn: {
    height: 30,
    padding: '0 12px',
    borderRadius: 8,
    border: '1px solid var(--color-border)',
    background: 'transparent',
    color: 'var(--color-text-secondary)',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
  },
}
