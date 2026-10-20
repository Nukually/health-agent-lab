/**
 * CompactionIndicator — 上下文压缩视觉指示器
 *
 * 当后端执行对话压缩时展示，温暖的轨道动画 + shimmer 光效。
 */

export default function CompactionIndicator() {
  return (
    <div style={styles.row}>
      <div style={styles.avatar}>HA</div>
      <div style={styles.bubble}>
        <div className="compaction-orbs">
          <span /><span /><span /><span />
        </div>
        <div style={styles.textBlock}>
          <span style={styles.primaryText}>
            为了我们能继续聊天，我正在整理对话上下文，请耐心等待～
          </span>
          <span style={styles.secondaryText}>
            整理好就马上继续回答你 🧡
          </span>
        </div>
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  row: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 10,
    padding: '6px 16px',
    animation: 'fadeIn 0.3s ease',
  },
  avatar: {
    flexShrink: 0,
    width: 28,
    height: 28,
    borderRadius: 8,
    background: 'var(--color-avatar-bg)',
    color: 'var(--color-primary)',
    fontSize: 13,
    fontWeight: 600,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
  },
  bubble: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 10,
    padding: '10px 16px',
    borderRadius: 16,
    borderTopLeftRadius: 4,
    background: 'var(--color-primary-bg)',
    backgroundImage: 'linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.5) 50%, transparent 100%)',
    backgroundSize: '200% 100%',
    animation: 'compaction-shimmer 2.5s ease-in-out infinite',
    maxWidth: '100%',
  },
  textBlock: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    minWidth: 0,
    flex: 1,
  },
  primaryText: {
    fontSize: 14,
    color: 'var(--color-primary-dark)',
    fontWeight: 500,
    lineHeight: 1.5,
    whiteSpace: 'normal',
    wordBreak: 'break-word',
  },
  secondaryText: {
    fontSize: 13,
    color: 'var(--color-text-secondary)',
    lineHeight: 1.45,
    whiteSpace: 'normal',
    wordBreak: 'break-word',
  },
}
