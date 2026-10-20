/**
 * MetricBadge —— 关键指标胶囊徽章（评分、检验数值、风险层级）
 *
 * status 决定颜色：normal 灰、abnormal 橙、critical 红。
 */

type Status = 'normal' | 'abnormal' | 'critical'

interface Props {
  label?: string
  value?: string
  unit?: string
  status?: Status | string
}

const palette: Record<Status, { bg: string; fg: string; labelFg: string }> = {
  normal: { bg: '#F3F4F6', fg: '#374151', labelFg: '#6B7280' },
  abnormal: { bg: '#FEF3C7', fg: '#7A3D00', labelFg: '#A66A1B' },
  critical: { bg: '#FEE2E2', fg: '#8A1F1F', labelFg: '#A83333' },
}

export default function MetricBadge({ label, value, unit, status }: Props) {
  const s: Status = status === 'abnormal' || status === 'critical' ? status : 'normal'
  const c = palette[s]
  return (
    <span
      role="status"
      aria-label={label ? `${label} ${value ?? ''}${unit ?? ''}` : undefined}
      style={{
        display: 'inline-flex',
        alignItems: 'baseline',
        gap: 6,
        padding: '4px 10px',
        borderRadius: 999,
        background: c.bg,
        color: c.fg,
        fontSize: 'calc(var(--font-size-chat) - 1px)',
        lineHeight: 1.3,
        fontWeight: 500,
      }}
    >
      {label && <span style={{ fontSize: 'calc(var(--font-size-chat) - 3px)', color: c.labelFg }}>{label}</span>}
      <span style={{ fontWeight: 700 }}>{value ?? '—'}</span>
      {unit && <span style={{ fontSize: 'calc(var(--font-size-chat) - 3px)', color: c.labelFg }}>{unit}</span>}
    </span>
  )
}
