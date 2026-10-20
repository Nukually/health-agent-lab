/**
 * HealthProfileConsentDialog — 健康档案二次授权弹窗
 *
 * 用户首次触发"收集/更新健康档案"行为（填完信息、侧边栏进入、ApprovalCard 同意）前展示。
 * 样式与 ClearMedicalDataDialog 对齐；zIndex 1000，与 AgreementModal(1100) 错开。
 */

import { createPortal } from 'react-dom'
import { HEALTH_PROFILE_CONSENT_HTML } from '../../assets/agreements/healthProfileConsent.js'

interface Props {
  open: boolean
  loading?: boolean
  error?: string | null
  onAgree: () => void
  onReject: () => void
}

export default function HealthProfileConsentDialog({
  open,
  loading,
  error,
  onAgree,
  onReject,
}: Props) {
  if (!open) return null

  // Portal 到 body：避免被含 backdrop-filter/transform 的父级（如 ApprovalCard）
  // 创建新的 containing block，导致 position: fixed 相对卡片而非视口定位。
  return createPortal(
    <div style={styles.overlay} onClick={onReject}>
      <div style={styles.dialog} onClick={(e) => e.stopPropagation()}>
        <h3 style={styles.title}>健康档案授权</h3>
        <div className="agreement-content" style={styles.content} dangerouslySetInnerHTML={{ __html: HEALTH_PROFILE_CONSENT_HTML }} />
        {error && <p style={styles.error}>{error}</p>}
        <div style={styles.buttons}>
          <button style={styles.cancelBtn} onClick={onReject} disabled={loading}>
            不同意
          </button>
          <button
            style={{ ...styles.primaryBtn, opacity: loading ? 0.5 : 1 }}
            onClick={onAgree}
            disabled={loading}
          >
            {loading ? '提交中…' : '同意'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    background: 'rgba(0,0,0,0.45)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
    padding: 16,
  },
  dialog: {
    background: 'var(--color-bg)',
    borderRadius: 14,
    width: '100%',
    maxWidth: 420,
    maxHeight: '78vh',
    display: 'flex',
    flexDirection: 'column' as const,
    padding: '16px 16px 12px',
    gap: 10,
    boxShadow: '0 12px 40px rgba(0,0,0,0.18)',
  },
  title: {
    fontSize: 16,
    fontWeight: 600,
    margin: 0,
    color: 'var(--color-text)',
    flexShrink: 0,
  },
  content: {
    flex: 1,
    overflowY: 'auto',
    fontSize: 14,
    lineHeight: 1.75,
    color: 'var(--color-text)',
    paddingRight: 4,
  },
  error: {
    margin: 0,
    fontSize: 12,
    lineHeight: 1.5,
    color: 'var(--color-error)',
  },
  buttons: {
    display: 'flex',
    gap: 8,
    flexShrink: 0,
  },
  cancelBtn: {
    flex: 1,
    height: 40,
    borderRadius: 10,
    border: '1px solid var(--color-border)',
    background: 'var(--color-surface)',
    color: 'var(--color-text)',
    fontSize: 14,
    cursor: 'pointer',
  },
  primaryBtn: {
    flex: 1,
    height: 40,
    borderRadius: 10,
    border: 'none',
    background: 'var(--color-primary)',
    color: '#fff',
    fontSize: 14,
    fontWeight: 600,
    cursor: 'pointer',
  },
}
