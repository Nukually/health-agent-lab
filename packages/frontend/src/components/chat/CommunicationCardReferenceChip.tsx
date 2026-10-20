import { useState } from 'react'
import type {
  ApiResponse,
  CommunicationCardRecord,
  SyntheticCommunicationCardPreview,
} from '@health-agent/shared'
import { api } from '../../services/api.js'
import CommunicationCardPanel from '../communication/CommunicationCardPanel.js'

interface Props {
  card: SyntheticCommunicationCardPreview
}

export default function CommunicationCardReferenceChip({ card }: Props) {
  const [loading, setLoading] = useState(false)
  const [record, setRecord] = useState<CommunicationCardRecord | null>(null)
  const [open, setOpen] = useState(false)

  const label = card.shortId ? `沟通卡 #${card.shortId}` : (card.title || '沟通卡片')

  async function handleOpen() {
    if (!card.cardId) return

    if (record) {
      setOpen(true)
      return
    }

    setLoading(true)
    try {
      const res = await api.get<ApiResponse<CommunicationCardRecord>>(`/medical/communication-cards/${card.cardId}`)
      if (res.data) {
        setRecord(res.data)
        setOpen(true)
      }
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <button
        type="button"
        style={styles.chip}
        onClick={handleOpen}
        disabled={loading || !card.cardId}
        title={card.title || label}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="8" y1="13" x2="16" y2="13" />
          <line x1="8" y1="17" x2="14" y2="17" />
        </svg>
        <span>{loading ? '加载中...' : label}</span>
      </button>

      {open && record && (
        <div style={styles.overlay} onClick={() => setOpen(false)}>
          <div style={styles.modal} onClick={(event) => event.stopPropagation()}>
            <div style={styles.header}>
              <div>
                <div style={styles.title}>{record.title}</div>
                <div style={styles.meta}>{record.cardDate}</div>
              </div>
              <button type="button" style={styles.closeBtn} onClick={() => setOpen(false)} aria-label="关闭">
                ×
              </button>
            </div>
            <div style={styles.body}>
              <CommunicationCardPanel draft={record.contentJson.draft} />
            </div>
          </div>
        </div>
      )}
    </>
  )
}

const styles: Record<string, React.CSSProperties> = {
  chip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '7px 12px',
    borderRadius: 999,
    border: '1px solid rgba(171, 160, 150, 0.28)',
    background: 'rgba(255,255,255,0.7)',
    color: 'var(--color-text-muted)',
    fontSize: 13,
    lineHeight: 1,
    cursor: 'pointer',
    boxShadow: '0 2px 8px rgba(0, 0, 0, 0.03)',
  },
  overlay: {
    position: 'fixed',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 1000,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 'max(18px, env(safe-area-inset-top)) max(28px, env(safe-area-inset-right)) max(18px, env(safe-area-inset-bottom)) max(28px, env(safe-area-inset-left))',
    background: 'rgba(48, 39, 34, 0.34)',
    backdropFilter: 'blur(4px)',
    WebkitBackdropFilter: 'blur(4px)',
  },
  modal: {
    width: 'min(520px, calc(100vw - 56px - env(safe-area-inset-left) - env(safe-area-inset-right)))',
    maxHeight: 'min(660px, calc(72dvh - env(safe-area-inset-top) - env(safe-area-inset-bottom)))',
    display: 'flex',
    flexDirection: 'column',
    borderRadius: 20,
    background: 'var(--color-bg)',
    boxShadow: '0 18px 48px rgba(0, 0, 0, 0.22)',
    overflow: 'hidden',
    minHeight: 0,
  },
  header: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
    padding: '14px 16px 10px',
    borderBottom: '1px solid rgba(212, 135, 108, 0.12)',
  },
  title: {
    fontSize: 16,
    fontWeight: 700,
    color: 'var(--color-text)',
    lineHeight: 1.4,
  },
  meta: {
    marginTop: 4,
    fontSize: 12,
    color: 'var(--color-text-muted)',
  },
  closeBtn: {
    flexShrink: 0,
    width: 30,
    height: 30,
    borderRadius: 999,
    border: 'none',
    background: 'rgba(0,0,0,0.04)',
    color: 'var(--color-text-muted)',
    fontSize: 24,
    lineHeight: '28px',
    cursor: 'pointer',
  },
  body: {
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
    WebkitOverflowScrolling: 'touch',
    overscrollBehavior: 'contain',
    padding: 12,
  },
}
