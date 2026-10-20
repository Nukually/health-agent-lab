/**
 * AgreementModal — 协议全文展示弹窗（只读）
 *
 * 登录页点击《用户协议》/《隐私政策》链接时调用。内容由调用方注入 HTML。
 */

interface Props {
  open: boolean
  title: string
  htmlContent: string
  onClose: () => void
  primaryLabel?: string
  onPrimary?: () => void
}

export default function AgreementModal({ open, title, htmlContent, onClose, primaryLabel, onPrimary }: Props) {
  if (!open) return null

  const label = primaryLabel ?? '我已阅读'
  const handlePrimary = onPrimary ?? onClose

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={styles.dialog} onClick={(e) => e.stopPropagation()}>
        <div style={styles.header}>
          <h3 style={styles.title}>{title}</h3>
          <button style={styles.closeBtn} onClick={onClose} aria-label="关闭">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className="agreement-content" style={styles.content} dangerouslySetInnerHTML={{ __html: htmlContent }} />
        <button style={styles.okBtn} onClick={handlePrimary}>{label}</button>
      </div>
    </div>
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
    zIndex: 1100,
    padding: 16,
  },
  dialog: {
    background: 'var(--color-bg)',
    borderRadius: 16,
    width: '100%',
    maxWidth: 480,
    maxHeight: '85vh',
    display: 'flex',
    flexDirection: 'column',
    boxShadow: '0 12px 40px rgba(0,0,0,0.18)',
    overflow: 'hidden',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '16px 20px',
    borderBottom: '1px solid var(--color-border)',
    flexShrink: 0,
  },
  title: {
    fontSize: 16,
    fontWeight: 600,
    color: 'var(--color-text)',
    margin: 0,
  },
  closeBtn: {
    background: 'none',
    border: 'none',
    color: 'var(--color-text-muted)',
    cursor: 'pointer',
    padding: 4,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  content: {
    flex: 1,
    overflowY: 'auto',
    padding: '16px 20px',
    fontSize: 14,
    lineHeight: 1.75,
    color: 'var(--color-text)',
  },
  okBtn: {
    margin: 16,
    height: 44,
    borderRadius: 10,
    border: 'none',
    background: 'var(--color-primary)',
    color: '#fff',
    fontSize: 15,
    fontWeight: 600,
    cursor: 'pointer',
    flexShrink: 0,
  },
}
