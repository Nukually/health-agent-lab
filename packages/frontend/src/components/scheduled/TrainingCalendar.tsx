/**
 * TrainingCalendar —— 「我的提醒」跟练计划 Tab 的月历视图
 *
 * 拉取 /todos/plans，把所有跟练计划的每日事项按日期聚合成苹果日历风格的月历：
 * - 有跟练的日子在日号下方标点，按当天完成情况着色（全完成=成功色实心，部分=主色，未完成=描边）
 * - 选中某天，下方列出当天事项卡（时间、计划、状态），点卡片打开 TrainingItemSheet 内嵌播放并记录
 * - 跟练完成后 todo 状态变 completed，关闭浮窗刷新即可看到 ✅
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ApiResponse, TodoPlanListResponse, TodoToolPlanSummary, TodoToolTodoSummary } from '@health-agent/shared'
import { api } from '../../services/api.js'
import TrainingItemSheet from './TrainingItemSheet.js'

interface Props {
  focusPlanId?: string | null
}

interface DayItem {
  planId: string
  planTitle: string
  sourceType: TodoToolPlanSummary['sourceType']
  targetSideEffect?: string | null
  todo: TodoToolTodoSummary
}

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日']

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

function todayKey(): string {
  const d = new Date()
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

function ymd(year: number, month: number, day: number): string {
  return `${year}-${pad2(month)}-${pad2(day)}`
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate()
}

/** 当月 1 号是周几（0=周一 … 6=周日）。 */
function firstWeekdayMon(year: number, month: number): number {
  const jsDay = new Date(year, month - 1, 1).getDay()
  return (jsDay + 6) % 7
}

function sourceLabel(sourceType: TodoToolPlanSummary['sourceType']): string {
  if (sourceType === 'intervention') return '跟练动作'
  if (sourceType === 'video_resource') return '视频'
  return '自定义'
}

type ItemTone = 'done' | 'skipped' | 'active' | 'pending'

function itemTone(status: TodoToolTodoSummary['status']): ItemTone {
  if (status === 'completed') return 'done'
  if (status === 'not_practiced') return 'skipped'
  if (status === 'started') return 'active'
  return 'pending'
}

function statusText(status: TodoToolTodoSummary['status']): string {
  if (status === 'completed') return '已完成'
  if (status === 'not_practiced') return '未跟练'
  if (status === 'started') return '进行中'
  return '待跟练'
}

export default function TrainingCalendar({ focusPlanId }: Props) {
  const [plans, setPlans] = useState<TodoToolPlanSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const now = useMemo(() => new Date(), [])
  const [viewYear, setViewYear] = useState(now.getFullYear())
  const [viewMonth, setViewMonth] = useState(now.getMonth() + 1)
  const [selectedDate, setSelectedDate] = useState<string>(todayKey())
  const [activeTodo, setActiveTodo] = useState<{ todo: TodoToolTodoSummary; planTitle: string } | null>(null)
  const [sheetOpen, setSheetOpen] = useState(false)

  const loadPlans = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await api.get<ApiResponse<TodoPlanListResponse>>('/todos/plans')
      setPlans(res.data?.plans ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载跟练计划失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadPlans()
  }, [loadPlans])

  // dateKey -> 当天事项
  const itemsByDate = useMemo(() => {
    const map = new Map<string, DayItem[]>()
    for (const plan of plans) {
      for (const todo of plan.todos ?? []) {
        const list = map.get(todo.date) ?? []
        list.push({
          planId: plan.id,
          planTitle: plan.title,
          sourceType: plan.sourceType,
          targetSideEffect: plan.targetSideEffect,
          todo,
        })
        map.set(todo.date, list)
      }
    }
    for (const list of map.values()) {
      list.sort((a, b) => a.todo.time.localeCompare(b.todo.time))
    }
    return map
  }, [plans])

  // 初次加载/聚焦：把视图定位到聚焦计划的首个未完成日，否则默认定位到当天。
  // 用 ref 保证同一 focus 目标只定位一次，避免完成跟练后刷新 plans 把用户浏览的月份拉回今天。
  const positionedForRef = useRef<string | null>(null)
  useEffect(() => {
    if (loading) return
    const positionKey = focusPlanId ?? '__default__'
    if (positionedForRef.current === positionKey) return
    positionedForRef.current = positionKey
    let target: string | null = null
    if (focusPlanId) {
      const plan = plans.find((item) => item.id === focusPlanId)
      const todos = (plan?.todos ?? []).slice().sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`))
      target = (todos.find((t) => t.status !== 'completed' && t.status !== 'not_practiced') ?? todos[0])?.date ?? null
    }
    if (!target) {
      // 默认定位到当天，不再跳到首个有跟练的日子；用户可手动翻月查看。
      target = todayKey()
    }
    if (target) {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(target)
      if (m) {
        setViewYear(Number(m[1]))
        setViewMonth(Number(m[2]))
        setSelectedDate(target)
      }
    }
    // 仅在 plans 首次就绪或聚焦计划变化时定位
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, focusPlanId, plans])

  function shiftMonth(delta: number) {
    let y = viewYear
    let m = viewMonth + delta
    if (m < 1) { m = 12; y -= 1 }
    if (m > 12) { m = 1; y += 1 }
    setViewYear(y)
    setViewMonth(m)
    // 切月后清空选中（下方列表随之消失）；切回当前月则自动回到当天。
    const today = todayKey()
    if (y === Number(today.slice(0, 4)) && m === Number(today.slice(5, 7))) {
      setSelectedDate(today)
    } else {
      setSelectedDate('')
    }
  }

  function openItem(item: DayItem) {
    setActiveTodo({ todo: item.todo, planTitle: item.planTitle })
    setSheetOpen(true)
  }

  const cells = useMemo(() => {
    const lead = firstWeekdayMon(viewYear, viewMonth)
    const total = daysInMonth(viewYear, viewMonth)
    const rows = Math.ceil((lead + total) / 7)
    const out: Array<{ day: number; key: string } | null> = []
    for (let i = 0; i < rows * 7; i += 1) {
      const dayNum = i - lead + 1
      if (dayNum < 1 || dayNum > total) out.push(null)
      else out.push({ day: dayNum, key: ymd(viewYear, viewMonth, dayNum) })
    }
    return out
  }, [viewYear, viewMonth])

  const today = todayKey()
  const selectedItems = selectedDate ? itemsByDate.get(selectedDate) ?? [] : []
  const monthPrefix = `${viewYear}-${String(viewMonth).padStart(2, '0')}`
  const monthHasItems = Array.from(itemsByDate.keys()).some((k) => k.startsWith(monthPrefix))

  function dayMarker(key: string) {
    const items = itemsByDate.get(key)
    if (!items || items.length === 0) return null
    const total = items.length
    const done = items.filter((i) => i.todo.status === 'completed').length
    let bg = 'transparent'
    let border = '1.5px solid var(--color-primary)'
    if (done === total) { bg = 'var(--color-success)'; border = 'none' }
    else if (done > 0) { bg = 'var(--color-primary)'; border = 'none' }
    return <span style={{ ...styles.dayDot, background: bg, border }} />
  }

  return (
    <div style={styles.wrap}>
      {error && <div style={styles.error}>{error}</div>}

      <div style={styles.calendarCard}>
        <div style={styles.monthBar}>
          <button type="button" style={styles.navBtn} onClick={() => shiftMonth(-1)} aria-label="上个月">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
          <span style={styles.monthLabel}>{viewYear} 年 {viewMonth} 月</span>
          <button type="button" style={styles.navBtn} onClick={() => shiftMonth(1)} aria-label="下个月">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>
        </div>

        <div style={styles.weekRow}>
          {WEEKDAYS.map((w) => (
            <div key={w} style={styles.weekCell}>{w}</div>
          ))}
        </div>

        <div style={styles.grid}>
          {cells.map((cell, idx) => {
            if (!cell) return <div key={`b-${idx}`} style={styles.dayCell} />
            const isToday = cell.key === today
            const isSelected = cell.key === selectedDate
            const hasItems = itemsByDate.has(cell.key)
            return (
              <button
                key={cell.key}
                type="button"
                style={{
                  ...styles.dayCell,
                  ...styles.dayBtn,
                  ...(isSelected ? styles.daySelected : null),
                }}
                onClick={() => setSelectedDate(cell.key)}
              >
                <span style={{
                  ...styles.dayNum,
                  ...(isToday && !isSelected ? styles.dayToday : null),
                  ...(isSelected ? styles.dayNumSelected : null),
                  ...(!hasItems && !isSelected ? styles.dayNumMuted : null),
                }}>
                  {cell.day}
                </span>
                {!isSelected && dayMarker(cell.key)}
              </button>
            )
          })}
        </div>
      </div>

      {selectedDate && (
        <div style={styles.listHeader}>
          <span style={styles.listDate}>{Number(selectedDate.slice(5, 7))}月{Number(selectedDate.slice(8, 10))}日</span>
          <span style={styles.listCount}>{selectedItems.length > 0 ? `${selectedItems.length} 项跟练` : '没有安排'}</span>
        </div>
      )}

      {loading ? (
        <div style={styles.hint}>加载中…</div>
      ) : plans.length === 0 ? (
        <div style={styles.empty}>
          <div style={styles.emptyTitle}>还没有跟练计划</div>
          <div style={styles.emptyDesc}>在对话里让 AI 助理安排跟练，计划会出现在这里。</div>
        </div>
      ) : !monthHasItems ? (
        <div style={styles.hint}>本月没有跟练安排。</div>
      ) : !selectedDate ? (
        <div style={styles.hint}>选择日期查看当天的跟练安排。</div>
      ) : selectedItems.length === 0 ? (
        <div style={styles.hint}>这一天没有跟练安排。</div>
      ) : (
        <div style={styles.itemList}>
          {selectedItems.map((item) => {
            const tone = itemTone(item.todo.status)
            return (
              <button
                key={item.todo.id}
                type="button"
                style={styles.itemCard}
                onClick={() => openItem(item)}
              >
                <div style={styles.itemTime}>{item.todo.time}</div>
                <div style={styles.itemBody}>
                  <div style={styles.itemTitle}>{item.planTitle}</div>
                  <div style={styles.itemMeta}>
                    <span style={styles.itemTag}>{sourceLabel(item.sourceType)}</span>
                    {item.todo.showPrompt && <span style={styles.itemPrompt}>{item.todo.showPrompt}</span>}
                  </div>
                </div>
                <span style={{ ...styles.statusChip, ...statusChipStyle(tone) }}>
                  {tone === 'done' && (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  )}
                  {statusText(item.todo.status)}
                </span>
              </button>
            )
          })}
        </div>
      )}

      <TrainingItemSheet
        open={sheetOpen}
        planTitle={activeTodo?.planTitle ?? ''}
        todo={activeTodo?.todo ?? null}
        onClose={() => {
          setSheetOpen(false)
          void loadPlans()
        }}
        onCompleted={() => {
          void loadPlans()
        }}
      />
    </div>
  )
}

function statusChipStyle(tone: ItemTone): React.CSSProperties {
  if (tone === 'done') return { background: 'rgba(109, 171, 142, 0.16)', color: 'var(--color-success)' }
  if (tone === 'skipped') return { background: 'rgba(150, 150, 150, 0.14)', color: 'var(--color-text-muted)' }
  if (tone === 'active') return { background: 'rgba(212, 135, 108, 0.16)', color: 'var(--color-primary-dark)' }
  return { background: 'rgba(212, 135, 108, 0.10)', color: 'var(--color-primary)' }
}

const styles: Record<string, React.CSSProperties> = {
  wrap: {
    display: 'flex',
    flexDirection: 'column',
    gap: 14,
    maxWidth: 760,
    margin: '0 auto',
    padding: '14px 0 8px',
  },
  error: {
    fontSize: 13,
    color: '#B04D3A',
    background: 'rgba(217, 139, 139, 0.12)',
    borderRadius: 10,
    padding: '8px 12px',
  },
  calendarCard: {
    background: '#fff',
    borderRadius: 18,
    border: '1px solid var(--color-border)',
    padding: '12px 12px 14px',
    boxShadow: '0 6px 20px rgba(120, 72, 48, 0.05)',
  },
  monthBar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '2px 6px 10px',
  },
  monthLabel: {
    fontSize: 16,
    fontWeight: 700,
    color: 'var(--color-text)',
    letterSpacing: '0.01em',
  },
  navBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    border: 'none',
    background: 'var(--color-primary-bg)',
    color: 'var(--color-primary-dark)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    padding: 0,
    WebkitTapHighlightColor: 'transparent',
  },
  weekRow: {
    display: 'grid',
    gridTemplateColumns: 'repeat(7, 1fr)',
    marginBottom: 2,
  },
  weekCell: {
    textAlign: 'center',
    fontSize: 11,
    fontWeight: 600,
    color: 'var(--color-text-muted)',
    paddingBottom: 4,
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(7, 1fr)',
    rowGap: 2,
  },
  dayCell: {
    aspectRatio: '1 / 1',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
  },
  dayBtn: {
    border: 'none',
    background: 'transparent',
    borderRadius: 12,
    cursor: 'pointer',
    padding: 0,
    WebkitTapHighlightColor: 'transparent',
  },
  daySelected: {
    background: 'var(--color-primary)',
  },
  dayNum: {
    fontSize: 15,
    fontWeight: 600,
    color: 'var(--color-text)',
    lineHeight: 1,
    width: 30,
    height: 30,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 15,
  },
  dayNumMuted: {
    color: 'var(--color-text-muted)',
    fontWeight: 500,
  },
  dayToday: {
    color: 'var(--color-primary-dark)',
    fontWeight: 800,
  },
  dayNumSelected: {
    color: '#fff',
    fontWeight: 800,
  },
  dayDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    boxSizing: 'border-box',
  },
  listHeader: {
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    padding: '0 4px',
  },
  listDate: {
    fontSize: 16,
    fontWeight: 700,
    color: 'var(--color-text)',
  },
  listCount: {
    fontSize: 12.5,
    color: 'var(--color-text-muted)',
  },
  itemList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  itemCard: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    width: '100%',
    textAlign: 'left',
    background: '#fff',
    border: '1px solid var(--color-border)',
    borderRadius: 14,
    padding: '12px 14px',
    cursor: 'pointer',
    WebkitTapHighlightColor: 'transparent',
  },
  itemTime: {
    flexShrink: 0,
    fontSize: 15,
    fontWeight: 800,
    color: 'var(--color-primary-dark)',
    fontVariantNumeric: 'tabular-nums',
    width: 46,
  },
  itemBody: {
    flex: 1,
    minWidth: 0,
  },
  itemTitle: {
    fontSize: 14.5,
    fontWeight: 700,
    color: 'var(--color-text)',
    lineHeight: 1.35,
    wordBreak: 'break-word',
  },
  itemMeta: {
    marginTop: 4,
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    minWidth: 0,
  },
  itemTag: {
    flexShrink: 0,
    fontSize: 11,
    fontWeight: 700,
    color: 'var(--color-primary)',
    background: 'var(--color-primary-bg)',
    borderRadius: 6,
    padding: '1px 6px',
  },
  itemPrompt: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: 12.5,
    color: 'var(--color-text-secondary)',
  },
  statusChip: {
    flexShrink: 0,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 3,
    fontSize: 11.5,
    fontWeight: 700,
    borderRadius: 9,
    padding: '4px 9px',
  },
  hint: {
    padding: '28px 8px',
    textAlign: 'center',
    fontSize: 13.5,
    color: 'var(--color-text-secondary)',
  },
  empty: {
    padding: '40px 16px',
    textAlign: 'center',
  },
  emptyTitle: {
    fontSize: 15,
    fontWeight: 700,
    color: 'var(--color-text)',
  },
  emptyDesc: {
    marginTop: 6,
    fontSize: 13,
    lineHeight: 1.6,
    color: 'var(--color-text-secondary)',
  },
}
