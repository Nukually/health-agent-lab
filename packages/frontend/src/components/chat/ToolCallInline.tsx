/**
 * ToolCallInline — 内联工具调用展示
 *
 * 两种状态：
 * - executing: shimmer + bouncing dots + "工具名..."
 * - completed: ✓ + 工具名 + 耗时
 */

import { getToolUiMeta } from '@health-agent/shared'

interface Props {
  name: string
  isActive: boolean
  durationMs?: number
  output?: unknown
}

export default function ToolCallInline({ name, isActive, durationMs }: Props) {
  const meta = getToolUiMeta(name)
  const label = meta.doneLabel

  if (isActive) {
    return (
      <div style={styles.activeRow}>
        <div className="memory-orbs" style={{ width: 14, height: 14, position: 'relative' }}>
          <span /><span /><span />
        </div>
        <span style={styles.activeText}>{meta.activeLabel}</span>
      </div>
    )
  }

  return (
    <div style={styles.completedRow}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--color-success)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
        <polyline points="20 6 9 17 4 12" />
      </svg>
      <span style={styles.completedText}>
        {label}
        {durationMs != null && <span style={styles.duration}> {durationMs}ms</span>}
      </span>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  activeRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '6px 12px',
    borderRadius: 8,
    background: 'linear-gradient(135deg, #f0e6ff 0%, #e8d5f5 100%)',
    backgroundSize: '200% 100%',
    animation: 'memory-shimmer 2s ease-in-out infinite',
    marginBottom: 8,
  },
  activeText: {
    fontSize: 13,
    color: '#6b4c8a',
    fontWeight: 500,
  },
  completedRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '4px 0',
    marginBottom: 6,
    animation: 'fadeIn 0.3s ease',
  },
  completedText: {
    fontSize: 13,
    color: 'var(--color-text-muted)',
  },
  duration: {
    fontSize: 11,
    color: 'var(--color-text-muted)',
    fontWeight: 400,
  },
}
