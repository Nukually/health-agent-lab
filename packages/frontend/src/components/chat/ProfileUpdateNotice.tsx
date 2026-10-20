/**
 * ProfileUpdateNotice — 个人信息 3 字段（nickname/birthday/gender）由工具自动落库后，
 * 在聊天流中插入的轻量只读提示条。无按钮、无 API 调用、无二次授权。
 */

import type { ProfileAutoUpdatedPayload } from '@health-agent/shared'
import { useStore } from '../../stores/index.js'

interface Props {
  payload: ProfileAutoUpdatedPayload
}

export default function ProfileUpdateNotice({ payload }: Props) {
  const dismiss = useStore((s) => s.dismissProfileNotice)

  return (
    <div style={styles.card}>
      <span style={styles.check} aria-hidden>✓</span>
      <span style={styles.text}>
        已为您更新「{payload.fieldLabel}」：
        <span style={styles.value}>{payload.proposedLabel}</span>
      </span>
      <button
        style={styles.close}
        onClick={() => dismiss(payload.noticeId)}
        aria-label="关闭"
      >
        ×
      </button>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  card: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '8px 12px',
    margin: '6px 16px 6px 54px',
    background: 'rgba(255, 255, 255, 0.55)',
    backdropFilter: 'blur(20px) saturate(160%)',
    WebkitBackdropFilter: 'blur(20px) saturate(160%)',
    border: '1px solid rgba(255, 255, 255, 0.6)',
    borderRadius: 12,
    boxShadow: '0 4px 14px rgba(212, 135, 108, 0.08), 0 1px 3px rgba(0, 0, 0, 0.03)',
    fontSize: 13,
    color: 'var(--color-text)',
    animation: 'fadeIn 0.25s ease',
  },
  check: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 18,
    height: 18,
    borderRadius: '50%',
    background: 'var(--color-brand, #D4876C)',
    color: '#fff',
    fontSize: 12,
    fontWeight: 700,
    flexShrink: 0,
  },
  text: {
    flex: 1,
    lineHeight: 1.4,
  },
  value: {
    color: 'var(--color-brand, #D4876C)',
    fontWeight: 500,
  },
  close: {
    border: 'none',
    background: 'transparent',
    color: 'var(--color-text-muted)',
    fontSize: 16,
    lineHeight: 1,
    cursor: 'pointer',
    padding: '0 2px',
    flexShrink: 0,
  },
}
