/**
 * TodosInline —— 跟练任务（todos 工具）结果卡片
 *
 * 把 todos 工具输出的阶段性跟练计划渲染成基本信息卡片：
 * 任务名、状态、目标症状、周期、提醒安排。
 */

import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type {
  TodoPlanStatus,
  TodoToolPlanOutput,
  TodoToolPlanSummary,
  TodoToolTodoSummary,
} from '@health-agent/shared'

const SCHEDULE_PREVIEW_COUNT = 3

function asTodoOutput(value: unknown): TodoToolPlanOutput | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (record.kind !== 'todos') return null
  if (!record.plan || typeof record.plan !== 'object') return null
  return value as TodoToolPlanOutput
}

type StatusTone = 'active' | 'done' | 'stopped'

function resolveStatus(
  status: TodoPlanStatus,
): { text: string; tone: StatusTone } {
  if (status === 'stopped') return { text: '已停止', tone: 'stopped' }
  if (status === 'completed') return { text: '已完成', tone: 'done' }
  if (status === 'in_progress') return { text: '进行中', tone: 'active' }
  return { text: '已安排', tone: 'active' }
}

function formatDate(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!m) return date
  return `${Number(m[2])}月${Number(m[3])}日`
}

function isTodoClosed(todo: TodoToolTodoSummary): boolean {
  return todo.status === 'completed' || todo.status === 'not_practiced'
}

function ScheduleRow({ todo }: { todo: TodoToolTodoSummary }) {
  const skipped = todo.status === 'not_practiced'
  const closed = isTodoClosed(todo)
  return (
    <div style={styles.scheduleRow}>
      <span style={{ ...styles.scheduleDot, ...(closed ? styles.scheduleDotDone : null) }}>
        {closed ? (skipped ? '-' : '✓') : ''}
      </span>
      <span style={styles.scheduleTime}>{formatDate(todo.date)} {todo.time}</span>
      {todo.showPrompt && <span style={styles.schedulePrompt}>{skipped ? '未跟练' : todo.showPrompt}</span>}
    </div>
  )
}

function PlanCard({ plan, onOpen }: { plan: TodoToolPlanSummary; onOpen?: () => void }) {
  const status = resolveStatus(plan.status)
  const todos = plan.todos ?? []
  const doneCount = todos.filter((todo) => todo.status === 'completed').length
  const metaParts = [
    plan.courseDays ? `${plan.courseDays} 天周期` : null,
    todos.length > 0 ? `共 ${todos.length} 次提醒` : null,
    todos.length > 0 ? `已完成 ${doneCount}/${todos.length}` : null,
  ].filter(Boolean) as string[]

  const clickable = !!onOpen
  return (
    <div
      style={{ ...styles.card, ...(clickable ? styles.cardClickable : null) }}
      onClick={onOpen}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={clickable ? (e) => { if (e.key === 'Enter') onOpen?.() } : undefined}
    >
      <div style={styles.header}>
        <span style={styles.kicker}>跟练计划</span>
        <span style={{ ...styles.badge, ...statusBadgeStyle(status.tone) }}>{status.text}</span>
      </div>
      <div style={styles.title}>{plan.title}</div>
      {plan.targetSideEffect && <div style={styles.subtitle}>目标 · {plan.targetSideEffect}</div>}
      {metaParts.length > 0 && <div style={styles.meta}>{metaParts.join(' · ')}</div>}
      {todos.length > 0 && <ScheduleList todos={todos} />}
      {clickable && <div style={styles.openHint}>查看日历并跟练 ›</div>}
    </div>
  )
}

function ScheduleList({ todos }: { todos: TodoToolTodoSummary[] }) {
  const [expanded, setExpanded] = useState(false)
  const hasMore = todos.length > SCHEDULE_PREVIEW_COUNT
  const visible = expanded ? todos : todos.slice(0, SCHEDULE_PREVIEW_COUNT)

  return (
    <div style={styles.scheduleList}>
      {visible.map((todo) => (
        <ScheduleRow key={todo.id} todo={todo} />
      ))}
      {hasMore && (
        <button type="button" style={styles.moreButton} onClick={(e) => { e.stopPropagation(); setExpanded((value) => !value) }}>
          {expanded ? '收起' : `查看全部 ${todos.length} 次提醒`}
          <span style={{ ...styles.moreChevron, ...(expanded ? styles.moreChevronUp : null) }}>⌄</span>
        </button>
      )}
    </div>
  )
}

function statusBadgeStyle(tone: StatusTone): React.CSSProperties {
  if (tone === 'done') return { background: 'rgba(120, 165, 120, 0.16)', color: '#5C8A5C' }
  if (tone === 'stopped') return { background: 'rgba(150, 150, 150, 0.16)', color: '#8A8A8A' }
  return { background: 'rgba(184, 112, 90, 0.14)', color: '#B8705A' }
}

export default function TodosInline({
  output,
  loading = false,
  disableNavigation = false,
}: {
  output?: unknown
  loading?: boolean
  disableNavigation?: boolean
}) {
  const navigate = useNavigate()
  if (loading) return null
  const parsed = asTodoOutput(output)
  if (!parsed) return null
  const planId = parsed.plan.id
  const onOpen = disableNavigation || !planId
    ? undefined
    : () => navigate(`/scheduled-tasks?tab=training&planId=${encodeURIComponent(planId)}`)
  return (
    <div style={styles.wrap}>
      <PlanCard plan={parsed.plan} onOpen={onOpen} />
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  wrap: {
    margin: '8px 0 4px',
  },
  card: {
    borderRadius: 14,
    border: '1px solid rgba(218, 184, 166, 0.48)',
    background: 'rgba(255, 248, 242, 0.82)',
    padding: '14px 14px 12px',
  },
  cardClickable: {
    cursor: 'pointer',
    WebkitTapHighlightColor: 'transparent',
  },
  openHint: {
    marginTop: 10,
    paddingTop: 10,
    borderTop: '1px solid rgba(218, 184, 166, 0.32)',
    fontSize: 12.5,
    fontWeight: 700,
    color: '#B8705A',
    textAlign: 'right',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    marginBottom: 6,
  },
  kicker: {
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: '0.04em',
    color: '#B8705A',
  },
  badge: {
    flexShrink: 0,
    fontSize: 11,
    fontWeight: 700,
    lineHeight: '16px',
    padding: '2px 8px',
    borderRadius: 9,
  },
  title: {
    fontSize: 15,
    lineHeight: '22px',
    fontWeight: 700,
    color: 'var(--color-text)',
    wordBreak: 'break-word',
  },
  subtitle: {
    marginTop: 3,
    fontSize: 13,
    lineHeight: '19px',
    color: 'var(--color-text-secondary)',
    wordBreak: 'break-word',
  },
  meta: {
    marginTop: 6,
    fontSize: 12,
    lineHeight: '18px',
    color: 'var(--color-text-muted)',
  },
  scheduleList: {
    marginTop: 10,
    display: 'flex',
    flexDirection: 'column',
    gap: 7,
    paddingTop: 10,
    borderTop: '1px solid rgba(218, 184, 166, 0.32)',
  },
  scheduleRow: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 8,
    fontSize: 12.5,
    lineHeight: '18px',
    color: 'var(--color-text-secondary)',
    minWidth: 0,
  },
  scheduleDot: {
    flexShrink: 0,
    width: 14,
    height: 14,
    borderRadius: 7,
    border: '1px solid rgba(184, 112, 90, 0.42)',
    background: '#fff',
    color: '#5C8A5C',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 9,
    fontWeight: 800,
    alignSelf: 'center',
  },
  scheduleDotDone: {
    borderColor: 'rgba(120, 165, 120, 0.5)',
    background: 'rgba(120, 165, 120, 0.14)',
  },
  scheduleTime: {
    flexShrink: 0,
    fontWeight: 600,
    color: 'var(--color-text)',
  },
  schedulePrompt: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  moreButton: {
    marginTop: 2,
    alignSelf: 'flex-start',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 3,
    border: 'none',
    background: 'transparent',
    padding: 0,
    color: '#A88476',
    fontSize: 12.5,
    fontWeight: 700,
    cursor: 'pointer',
    WebkitTapHighlightColor: 'transparent',
  },
  moreChevron: {
    fontSize: 12,
    lineHeight: 1,
    transition: 'transform 0.15s',
  },
  moreChevronUp: {
    transform: 'rotate(180deg)',
  },
}
