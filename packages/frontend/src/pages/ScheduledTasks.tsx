import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import type {
  ApiResponse,
  ScheduledTaskListResponse,
  ScheduledTaskManageItem,
  ScheduledTaskMutationResponse,
  ScheduledTaskUpdateRequest,
} from '@health-agent/shared'
import { api } from '../services/api.js'
import { syncPendingScheduledTaskCalendars } from '../lib/scheduledTaskCalendarSync.js'
import TrainingCalendar from '../components/scheduled/TrainingCalendar.js'

type ScheduledTab = 'normal' | 'training'

type EditDraft = {
  taskName: string
  message: string
  scheduleType: 'once' | 'cron'
  dueDateLocal: string
  dueTimeLocal: string
  cronExpression: string
  timezone: string
  repeatMode: RepeatMode
  appNotify: boolean
  calendarSync: boolean
}

type RepeatMode = 'none' | 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'custom'

const DEFAULT_TIMEZONE = 'Asia/Shanghai'

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

function formatTimelineTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '--:--'
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function dateKeyOf(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function dateLabelOf(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const today = new Date()
  const tomorrow = new Date(Date.now() + 86_400_000)
  const key = dateKeyOf(value)
  if (key === dateKeyOf(today.toISOString())) return '今天'
  if (key === dateKeyOf(tomorrow.toISOString())) return '明天'
  return `${date.getMonth() + 1}月${date.getDate()}日`
}

function toLocalDateTimeParts(value: string): { date: string; time: string } {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return { date: '', time: '' }
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  const valueText = local.toISOString()
  return { date: valueText.slice(0, 10), time: valueText.slice(11, 16) }
}

function localDateTimeToIso(date: string, time: string): string | null {
  if (!date || !time) return null
  const parsed = new Date(`${date}T${time}:00`)
  if (Number.isNaN(parsed.getTime())) return null
  return parsed.toISOString()
}

function purposeLabel(value: ScheduledTaskManageItem['purpose']): string {
  switch (value) {
    case 'intervention_completion_reminder': return '跟练提醒'
    case 'medication_reminder': return '用药提醒'
    case 'review_reminder': return '复查提醒'
    default: return '自定义提醒'
  }
}

function normalizeCronExpression(value: string): string {
  return value.trim().replace(/\s+/g, ' ')
}

function splitCronExpression(value: string): {
  second: string
  minute: string
  hour: string
  dayOfMonth: string
  month: string
  dayOfWeek: string
  year: string
} | null {
  const parts = normalizeCronExpression(value).split(' ').filter(Boolean)
  if (parts.length === 5) {
    const [minute, hour, dayOfMonth, month, dayOfWeek] = parts
    return { second: '0', minute, hour, dayOfMonth, month, dayOfWeek, year: '*' }
  }
  if (parts.length === 6) {
    const [second, minute, hour, dayOfMonth, month, dayOfWeek] = parts
    return { second, minute, hour, dayOfMonth, month, dayOfWeek, year: '*' }
  }
  if (parts.length === 7) {
    const [second, minute, hour, dayOfMonth, month, dayOfWeek, year] = parts
    return { second, minute, hour, dayOfMonth, month, dayOfWeek, year }
  }
  return null
}

function parseCronNumber(value: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(value)) return null
  const numberValue = Number(value)
  if (!Number.isInteger(numberValue) || numberValue < min || numberValue > max) return null
  return numberValue
}

function parseCronStep(value: string): number | null {
  const match = value.match(/^\*\/(\d+)$/)
  if (!match) return null
  const step = Number(match[1])
  return Number.isInteger(step) && step > 0 ? step : null
}

function parseCronWeekdays(value: string): string[] | null {
  if (value === '*') return []
  const dayMap: Record<string, string> = {
    SUN: '周日',
    MON: '周一',
    TUE: '周二',
    WED: '周三',
    THU: '周四',
    FRI: '周五',
    SAT: '周六',
  }
  const result: string[] = []
  for (const part of value.split(',')) {
    const normalized = part.trim().toUpperCase()
    if (!normalized) return null
    const numericDay = parseCronNumber(normalized, 0, 7)
    const label = dayMap[normalized] ?? (numericDay == null
      ? null
      : ['周日', '周一', '周二', '周三', '周四', '周五', '周六', '周日'][numericDay])
    if (!label) return null
    if (!result.includes(label)) result.push(label)
  }
  return result
}

function cronExpressionLabel(expression: string): string {
  const parts = splitCronExpression(expression)
  if (!parts || parts.second !== '0') return '自定义周期'

  const minute = parseCronNumber(parts.minute, 0, 59)
  const hour = parseCronNumber(parts.hour, 0, 23)
  const time = minute != null && hour != null ? `${pad(hour)}:${pad(minute)}` : ''
  const timeSuffix = time ? ` ${time}` : ''
  const dayOfMonth = parseCronNumber(parts.dayOfMonth, 1, 31)
  const month = parseCronNumber(parts.month, 1, 12)
  const year = parseCronNumber(parts.year, 1970, 2099)
  const weekdays = parseCronWeekdays(parts.dayOfWeek)

  if (parts.dayOfMonth === '*' && parts.month === '*' && parts.year === '*') {
    if (weekdays && weekdays.length > 0 && time) return `每${weekdays.join('、')}${timeSuffix}`
    if (parts.dayOfWeek === '*' && time) return `每天${timeSuffix}`
  }

  if (dayOfMonth != null && parts.month === '*' && parts.dayOfWeek === '*' && parts.year === '*' && time) {
    return `每月${dayOfMonth}日${timeSuffix}`
  }
  if (dayOfMonth != null && month != null && parts.dayOfWeek === '*' && parts.year === '*' && time) {
    return `每年${month}月${dayOfMonth}日${timeSuffix}`
  }
  if (dayOfMonth != null && month != null && year != null && parts.dayOfWeek === '*') {
    const hourStep = parseCronStep(parts.hour)
    if (hourStep != null && minute != null) return `${year}年${month}月${dayOfMonth}日每${hourStep}小时`
    if (time) return `${year}年${month}月${dayOfMonth}日${timeSuffix}`
  }

  const hourStep = parseCronStep(parts.hour)
  if (parts.dayOfMonth === '*' && parts.month === '*' && parts.dayOfWeek === '*' && parts.year === '*' && hourStep != null) {
    return `每${hourStep}小时`
  }

  return '自定义周期'
}

function repeatModeFromCronExpression(expression: string | null | undefined): RepeatMode {
  if (!expression) return 'custom'
  const parts = splitCronExpression(expression)
  if (!parts || parts.second !== '0') return 'custom'
  const minute = parseCronNumber(parts.minute, 0, 59)
  const hour = parseCronNumber(parts.hour, 0, 23)
  if (minute == null || hour == null) return 'custom'
  if (parts.dayOfMonth === '*' && parts.month === '*' && parts.dayOfWeek === '*' && parts.year === '*') return 'daily'
  if (parts.dayOfMonth === '*' && parts.month === '*' && parts.dayOfWeek !== '*' && parts.year === '*') return 'weekly'
  if (parseCronNumber(parts.dayOfMonth, 1, 31) != null && parts.month === '*' && parts.dayOfWeek === '*' && parts.year === '*') return 'monthly'
  if (
    parseCronNumber(parts.dayOfMonth, 1, 31) != null
    && parseCronStep(parts.month) === 3
    && parts.dayOfWeek === '*'
    && parts.year === '*'
  ) return 'quarterly'
  return 'custom'
}

function cronExpressionFromDraft(draft: EditDraft): string | null {
  const hour = draft.dueTimeLocal ? parseCronNumber(draft.dueTimeLocal.slice(0, 2), 0, 23) : null
  const minute = draft.dueTimeLocal ? parseCronNumber(draft.dueTimeLocal.slice(3, 5), 0, 59) : null
  if (hour == null || minute == null) return null
  const date = draft.dueDateLocal ? new Date(`${draft.dueDateLocal}T00:00:00`) : null
  const dayOfMonth = date && !Number.isNaN(date.getTime()) ? date.getDate() : 1
  const dayOfWeek = date && !Number.isNaN(date.getTime()) ? date.getDay() : '*'

  switch (draft.repeatMode) {
    case 'daily':
      return `${minute} ${hour} * * *`
    case 'weekly':
      return `${minute} ${hour} * * ${dayOfWeek}`
    case 'monthly':
      return `${minute} ${hour} ${dayOfMonth} * *`
    case 'quarterly':
      return `${minute} ${hour} ${dayOfMonth} */3 *`
    case 'custom':
      return normalizeCronExpression(draft.cronExpression)
    default:
      return null
  }
}

function scheduleTextOf(item: ScheduledTaskManageItem): string {
  if (item.scheduleType === 'cron') {
    return item.cronExpression ? cronExpressionLabel(item.cronExpression) : '周期性提醒'
  }
  return `${dateLabelOf(item.dueAt)} ${formatTimelineTime(item.dueAt)}`
}

function scheduleTypeLabel(item: ScheduledTaskManageItem): string {
  return item.scheduleType === 'cron' ? '周期性提醒' : '时间提醒'
}

function notifyTextOf(item: ScheduledTaskManageItem): string {
  const parts = []
  if (item.appNotifyEnabled) parts.push('App内提醒 + 推送')
  if (item.calendarSyncEnabled) parts.push('同步到系统日历')
  return parts.length > 0 ? parts.join(' · ') : '未开启通知'
}

function purposeIcon(value: ScheduledTaskManageItem['purpose']) {
  if (value === 'medication_reminder') {
    return (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="m10.5 20.5 10-10a4.95 4.95 0 1 0-7-7l-10 10a4.95 4.95 0 1 0 7 7Z" />
        <path d="m8.5 8.5 7 7" />
      </svg>
    )
  }
  if (value === 'review_reminder') {
    return (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M8 2v4" />
        <path d="M16 2v4" />
        <rect x="3" y="4" width="18" height="18" rx="2" />
        <path d="M3 10h18" />
        <path d="m9 16 2 2 4-4" />
      </svg>
    )
  }
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
      <path d="M10 9H8" />
      <path d="M16 13H8" />
      <path d="M16 17H8" />
    </svg>
  )
}

function draftFromItem(item: ScheduledTaskManageItem): EditDraft {
  const due = toLocalDateTimeParts(item.dueAt)
  return {
    taskName: item.taskName,
    message: item.message,
    scheduleType: item.scheduleType,
    dueDateLocal: due.date,
    dueTimeLocal: due.time,
    cronExpression: item.cronExpression || '0 9 * * *',
    timezone: item.timezone || DEFAULT_TIMEZONE,
    repeatMode: item.scheduleType === 'cron' ? repeatModeFromCronExpression(item.cronExpression) : 'none',
    appNotify: item.appNotifyEnabled,
    calendarSync: item.calendarSyncEnabled,
  }
}

function emptyData(): ScheduledTaskListResponse {
  return { periodic: [], timeline: [] }
}

export default function ScheduledTasks() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { taskId: routeTaskId } = useParams<{ taskId?: string }>()
  const returnSessionId = searchParams.get('returnSessionId')
  const shouldReturnToSettings = searchParams.get('returnToSettings') === '1' || !!returnSessionId

  const focusPlanId = searchParams.get('planId')
  const [tab, setTab] = useState<ScheduledTab>(
    searchParams.get('tab') === 'training' || !!focusPlanId ? 'training' : 'normal',
  )

  const [data, setData] = useState<ScheduledTaskListResponse>(() => emptyData())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draft, setDraft] = useState<EditDraft | null>(null)
  const [savingId, setSavingId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const allItems = useMemo(() => [...data.periodic, ...data.timeline], [data.periodic, data.timeline])
  const timelineGroups = useMemo(() => {
    const groups: Array<{ date: string; dateLabel: string; items: ScheduledTaskManageItem[] }> = []
    for (const item of data.timeline) {
      const date = dateKeyOf(item.dueAt)
      const existing = groups.find((group) => group.date === date)
      if (existing) existing.items.push(item)
      else groups.push({ date, dateLabel: dateLabelOf(item.dueAt), items: [item] })
    }
    return groups
  }, [data.timeline])

  async function loadTasks() {
    setLoading(true)
    setError(null)
    try {
      const response = await api.get<ApiResponse<ScheduledTaskListResponse>>('/scheduled-tasks')
      setData(response.data ?? emptyData())
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载提醒失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadTasks()
  }, [])

  // URL 带 :taskId（结果卡深链）时，数据加载完成后自动打开该提醒详情；
  // 只应用一次，避免用户返回列表后又被拉回详情。命中不到则停留列表。
  const appliedRouteTaskIdRef = useRef<string | null>(null)
  useEffect(() => {
    if (!routeTaskId || loading) return
    if (appliedRouteTaskIdRef.current === routeTaskId) return
    if (allItems.some((item) => item.id === routeTaskId)) {
      appliedRouteTaskIdRef.current = routeTaskId
      setSelectedId(routeTaskId)
      setEditingId(null)
    }
  }, [routeTaskId, loading, allItems])

  function handleBack() {
    const target = returnSessionId ? `/chat/${returnSessionId}` : '/chat'
    const state = shouldReturnToSettings ? { openSidebar: true } : undefined
    navigate(target, { state })
  }

  function startEdit(item: ScheduledTaskManageItem) {
    setEditingId(item.id)
    setSelectedId(null)
    setDraft(draftFromItem(item))
    setError(null)
  }

  function cancelEdit() {
    setEditingId(null)
    setDraft(null)
  }

  async function saveEdit(item: ScheduledTaskManageItem) {
    if (!draft) return
    const payload: ScheduledTaskUpdateRequest = {
      taskName: draft.taskName.trim(),
      timezone: draft.timezone.trim() || DEFAULT_TIMEZONE,
      appNotifyEnabled: draft.appNotify,
      calendarSyncEnabled: draft.calendarSync,
    }
    const message = draft.message.trim()
    if (message) payload.message = message
    if (!payload.taskName) {
      setError('提醒标题不能为空')
      return
    }
    if (draft.repeatMode !== 'none') {
      payload.scheduleType = 'cron'
      payload.cronExpression = cronExpressionFromDraft(draft)
      if (!payload.cronExpression) {
        setError('周期提醒需要选择有效时间')
        return
      }
    } else {
      payload.scheduleType = 'once'
      const dueAt = localDateTimeToIso(draft.dueDateLocal, draft.dueTimeLocal)
      if (!dueAt) {
        setError('请选择有效的提醒日期和时间')
        return
      }
      payload.dueAt = dueAt
      payload.cronExpression = null
    }

    setSavingId(item.id)
    setError(null)
    try {
      await api.put<ApiResponse<ScheduledTaskMutationResponse>>(`/scheduled-tasks/${item.id}`, payload)
      cancelEdit()
      await loadTasks()
      void syncPendingScheduledTaskCalendars().catch(() => undefined)
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存提醒失败')
    } finally {
      setSavingId(null)
    }
  }

  async function deleteTask(item: ScheduledTaskManageItem) {
    setDeletingId(item.id)
    setError(null)
    try {
      await api.delete<ApiResponse<ScheduledTaskMutationResponse>>(`/scheduled-tasks/${item.id}`)
      setSelectedId(null)
      await loadTasks()
      void syncPendingScheduledTaskCalendars().catch(() => undefined)
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除提醒失败')
    } finally {
      setDeletingId(null)
    }
  }

  function updateDraft<K extends keyof EditDraft>(key: K, value: EditDraft[K]) {
    setDraft((prev) => prev ? { ...prev, [key]: value } : prev)
  }

  function renderItem(item: ScheduledTaskManageItem) {
    return (
      <button key={item.id} type="button" style={{ ...styles.card, ...styles.cardButton }} onClick={() => setSelectedId(item.id)}>
        <div style={styles.itemBody}>
          <div style={styles.iconCircle}>{purposeIcon(item.purpose)}</div>
          <div style={styles.cardTitleWrap}>
            <div style={styles.cardHeader}>
              <div style={styles.cardTitle}>{item.taskName}</div>
            </div>
            <div style={styles.timeLine}>{formatTimelineTime(item.dueAt)}</div>
            <div style={styles.notifyLine}>
              <span style={styles.notifyIcon}>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" />
                  <path d="M13.73 21a2 2 0 0 1-3.46 0" />
                </svg>
              </span>
              <span>
                {item.scheduleType === 'cron' && item.cronExpression
                  ? <><span style={styles.repeatText}>周期性 · </span>{cronExpressionLabel(item.cronExpression)}</>
                  : `${purposeLabel(item.purpose)} · App内提醒`}
              </span>
            </div>
          </div>
        </div>
      </button>
    )
  }

  function renderSection(title: string, hint: string, items: ScheduledTaskManageItem[]) {
    if (items.length === 0) return null
    return (
      <section style={styles.section}>
        <div style={styles.sectionHeader}>
          <span style={{ ...styles.sectionIcon, ...styles.sectionIconTeal }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
              <path d="M21 3v5h-5" />
              <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
              <path d="M8 16H3v5" />
            </svg>
          </span>
          <span style={styles.sectionTitle}>{title}</span>
          <span style={styles.sectionHint}>{hint}</span>
        </div>
        <div style={styles.cardList}>{items.map((item) => renderItem(item))}</div>
      </section>
    )
  }

  function renderTimelineSection(
    title: string,
    hint: string,
    groups: Array<{ date: string; dateLabel: string; items: ScheduledTaskManageItem[] }>,
  ) {
    if (groups.length === 0) return null
    return (
      <section style={styles.section}>
        <div style={styles.sectionHeader}>
          <span style={{ ...styles.sectionIcon, ...styles.sectionIconBrand }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="4" width="18" height="18" rx="2" />
              <path d="M16 2v4" />
              <path d="M8 2v4" />
              <path d="M3 10h18" />
            </svg>
          </span>
          <span style={styles.sectionTitle}>{title}</span>
          <span style={styles.sectionHint}>{hint}</span>
        </div>
        <div style={styles.timelineList}>
          <div style={styles.timelineLine} aria-hidden="true" />
          {groups.map((group) => (
            <div key={group.date} style={styles.timelineGroup}>
              <div style={styles.timelineDateHeader}>
                <div style={styles.timelineDateDotWrap}>
                  <span style={styles.timelineDot} />
                </div>
                <span style={styles.timelineGroupLabel}>{group.dateLabel}</span>
              </div>
              <div style={styles.timelineGroupItems}>
                {group.items.map((item) => (
                  <div key={item.id} style={styles.timelineEntry}>
                    {renderItem(item)}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>
    )
  }

  function renderToggleRow(params: {
    icon: ReactNode
    label: string
    checked: boolean
    onChange: () => void
  }) {
    return (
      <div style={styles.toggleRow}>
        <div style={styles.toggleRowLeft}>
          {params.icon}
          <span style={styles.toggleLabel}>{params.label}</span>
        </div>
        <button
          type="button"
          onClick={params.onChange}
          style={{ ...styles.toggleSwitch, ...(params.checked ? styles.toggleSwitchOn : {}) }}
          aria-pressed={params.checked}
        >
          <span style={{ ...styles.toggleKnob, transform: params.checked ? 'translateX(22px)' : 'translateX(2px)' }} />
        </button>
      </div>
    )
  }

  function renderDetailRow(label: string, value: ReactNode) {
    return (
      <div style={styles.detailRow}>
        <div style={styles.detailLabel}>{label}</div>
        <div style={styles.detailValue}>{value}</div>
      </div>
    )
  }

  const editingItem = editingId ? allItems.find((item) => item.id === editingId) : null
  if (editingItem && draft) {
    const typeOptions: Array<{ value: ScheduledTaskManageItem['purpose']; label: string }> = [
      { value: 'medication_reminder', label: '用药提醒' },
      { value: 'review_reminder', label: '检查提醒' },
      { value: 'custom', label: '报告提醒' },
    ]
    const activeType = editingItem.purpose === 'intervention_completion_reminder' ? 'custom' : editingItem.purpose

    return (
      <div style={styles.container}>
        <div style={styles.topBar}>
          <button style={styles.backBtn} onClick={cancelEdit} aria-label="返回">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
          <h1 style={styles.title}>编辑提醒</h1>
          <div style={styles.topBarSpacer} />
        </div>

        <div style={styles.scrollArea}>
          <div style={styles.formContent}>
            {error && <div style={styles.error}>{error}</div>}

            <div style={styles.formBlock}>
              <label style={styles.formLabel}>提醒标题</label>
              <input
                type="text"
                style={styles.formInput}
                value={draft.taskName}
                onChange={(event) => updateDraft('taskName', event.target.value)}
                placeholder="例如：他莫西芬用药提醒"
                maxLength={120}
              />
            </div>

            <div style={styles.formBlock}>
              <label style={styles.formLabel}>提醒类型</label>
              <div style={styles.typeGrid}>
                {typeOptions.map((option) => {
                  const active = option.value === activeType
                  return (
                    <button
                      key={option.value}
                      type="button"
                      style={{ ...styles.typeBtn, ...(active ? styles.typeBtnActive : {}) }}
                      aria-pressed={active}
                    >
                      {option.label}
                    </button>
                  )
                })}
              </div>
            </div>

            <div style={styles.formBlock}>
              <label style={styles.formLabel}>提醒时间</label>
              <div style={styles.inputIconWrap}>
                <span style={styles.inputIcon}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10" />
                    <polyline points="12 6 12 12 16 14" />
                  </svg>
                </span>
                <input
                  type="time"
                  style={{ ...styles.formInput, ...styles.formInputWithIcon }}
                  value={draft.dueTimeLocal}
                  onChange={(event) => updateDraft('dueTimeLocal', event.target.value)}
                />
              </div>
            </div>

            <div style={styles.formBlock}>
              <label style={styles.formLabel}>提醒日期</label>
              <div style={styles.inputIconWrap}>
                <span style={styles.inputIcon}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="4" width="18" height="18" rx="2" />
                    <path d="M16 2v4" />
                    <path d="M8 2v4" />
                    <path d="M3 10h18" />
                  </svg>
                </span>
                <input
                  type="date"
                  style={{ ...styles.formInput, ...styles.formInputWithIcon }}
                  value={draft.dueDateLocal}
                  onChange={(event) => updateDraft('dueDateLocal', event.target.value)}
                />
              </div>
            </div>

            <div style={styles.formBlock}>
              <label style={styles.formLabel}>重复</label>
              <div style={styles.inputIconWrap}>
                <span style={styles.inputIcon}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
                    <path d="M21 3v5h-5" />
                    <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
                    <path d="M8 16H3v5" />
                  </svg>
                </span>
                <select
                  style={{ ...styles.formInput, ...styles.formInputWithIcon, ...styles.formSelect }}
                  value={draft.repeatMode}
                  onChange={(event) => {
                    const repeatMode = event.target.value as RepeatMode
                    setDraft((prev) => prev ? {
                      ...prev,
                      repeatMode,
                      scheduleType: repeatMode === 'none' ? 'once' : 'cron',
                    } : prev)
                  }}
                >
                  <option value="none">不重复</option>
                  <option value="daily">每天</option>
                  <option value="weekly">每周</option>
                  <option value="monthly">每月</option>
                  <option value="quarterly">每3个月</option>
                  <option value="custom">自定义</option>
                </select>
              </div>
              {draft.repeatMode === 'custom' && (
                <input
                  style={{ ...styles.formInput, marginTop: 10 }}
                  value={draft.cronExpression}
                  onChange={(event) => updateDraft('cronExpression', event.target.value)}
                  placeholder="例如：0 9 * * *"
                />
              )}
            </div>

            <div style={styles.formBlock}>
              <label style={{ ...styles.formLabel, marginBottom: 10 }}>通知方式</label>
              <div style={styles.toggleList}>
                {renderToggleRow({
                  icon: (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={styles.toggleIcon}>
                      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" />
                      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
                    </svg>
                  ),
                  label: 'App内提醒 + 推送',
                  checked: draft.appNotify,
                  onChange: () => updateDraft('appNotify', !draft.appNotify),
                })}
                {renderToggleRow({
                  icon: (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={styles.toggleIcon}>
                      <rect x="3" y="4" width="18" height="18" rx="2" />
                      <path d="M16 2v4" />
                      <path d="M8 2v4" />
                      <path d="M3 10h18" />
                    </svg>
                  ),
                  label: '同步到系统日历',
                  checked: draft.calendarSync,
                  onChange: () => updateDraft('calendarSync', !draft.calendarSync),
                })}
              </div>
            </div>

            <button
              type="button"
              style={styles.fullWidthSaveBtn}
              onClick={() => saveEdit(editingItem)}
              disabled={savingId === editingItem.id}
            >
              {savingId === editingItem.id ? '保存中…' : '保存修改'}
            </button>
          </div>
        </div>
      </div>
    )
  }

  const selectedItem = selectedId ? allItems.find((item) => item.id === selectedId) : null
  if (selectedItem) {
    return (
      <div style={styles.container}>
        <div style={styles.topBar}>
          <button style={styles.backBtn} onClick={() => setSelectedId(null)} aria-label="返回">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
          <h1 style={styles.title}>提醒详情</h1>
          <div style={styles.topBarSpacer} />
        </div>

        <div style={styles.scrollArea}>
          <div style={styles.detailContent}>
            {error && <div style={styles.error}>{error}</div>}

            <div style={styles.detailCard}>
              {renderDetailRow('提醒标题', selectedItem.taskName)}
              {renderDetailRow('提醒类型', purposeLabel(selectedItem.purpose))}
              {renderDetailRow('提醒方式', scheduleTypeLabel(selectedItem))}
              {renderDetailRow('提醒时间', `${dateLabelOf(selectedItem.dueAt)} ${formatTimelineTime(selectedItem.dueAt)}`)}
              {renderDetailRow('重复', selectedItem.scheduleType === 'cron' ? scheduleTextOf(selectedItem) : '不重复')}
              {renderDetailRow('通知方式', notifyTextOf(selectedItem))}
              {renderDetailRow('时区', selectedItem.timezone || DEFAULT_TIMEZONE)}
              {renderDetailRow('提醒内容', selectedItem.message)}
            </div>
          </div>
        </div>

        <div style={styles.detailBottomBar}>
          <button type="button" style={styles.detailActionBtn} onClick={() => startEdit(selectedItem)}>
            <span style={styles.detailActionIcon}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 20h9" />
                <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
              </svg>
            </span>
            <span>编辑</span>
          </button>
          <button
            type="button"
            style={{ ...styles.detailActionBtn, ...styles.detailDeleteBtn }}
            onClick={() => deleteTask(selectedItem)}
            disabled={deletingId === selectedItem.id}
          >
            <span style={styles.detailActionIcon}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              </svg>
            </span>
            <span>{deletingId === selectedItem.id ? '删除中…' : '删除'}</span>
          </button>
        </div>
      </div>
    )
  }

  return (
    <div style={styles.container}>
      <div style={styles.topBar}>
        <button style={styles.backBtn} onClick={handleBack} aria-label="返回">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <h1 style={styles.title}>我的提醒</h1>
        <button style={styles.refreshBtn} onClick={() => loadTasks()} disabled={loading} aria-label="刷新">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 12a9 9 0 0 0-15-6.7L3 8" />
            <path d="M3 3v5h5" />
            <path d="M3 12a9 9 0 0 0 15 6.7l3-2.7" />
            <path d="M21 21v-5h-5" />
          </svg>
        </button>
      </div>

      <div style={styles.divider} />

      <div style={styles.tabBar}>
        <button
          type="button"
          style={{ ...styles.tabBtn, ...(tab === 'normal' ? styles.tabBtnActive : null) }}
          onClick={() => setTab('normal')}
        >
          普通提醒
        </button>
        <button
          type="button"
          style={{ ...styles.tabBtn, ...(tab === 'training' ? styles.tabBtnActive : null) }}
          onClick={() => setTab('training')}
        >
          跟练计划
        </button>
      </div>

      <div style={styles.scrollArea}>
        {tab === 'training' ? (
          <TrainingCalendar focusPlanId={focusPlanId} />
        ) : (
          <div style={styles.content}>
            {error && <div style={styles.error}>{error}</div>}
            {loading ? (
              <div style={styles.loading}>加载中…</div>
            ) : (
              <>
                {renderSection('周期性提醒', '每天、每周等重复提醒', data.periodic)}
                {renderTimelineSection('时间线', `非周期提醒 · ${data.timeline.length} 条`, timelineGroups)}
                {allItems.length === 0 && (
                  <div style={styles.emptyState}>
                    <div style={styles.emptyIcon}>
                      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" />
                        <path d="M13.73 21a2 2 0 0 1-3.46 0" />
                      </svg>
                    </div>
                    <div style={styles.emptyTitle}>暂无提醒</div>
                    <div style={styles.emptyDesc}>在对话中告诉 AI 助理即可创建</div>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    height: '100%',
    background: 'var(--color-bg)',
    display: 'flex',
    flexDirection: 'column',
  },
  topBar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '12px 16px',
    paddingTop: 'calc(12px + var(--safe-area-top))',
    background: 'var(--color-bg)',
    flexShrink: 0,
    borderBottom: '1px solid var(--color-border)',
  },
  backBtn: {
    width: 40,
    height: 40,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: 'none',
    background: 'transparent',
    color: 'var(--color-text)',
    cursor: 'pointer',
    padding: 0,
  },
  title: {
    fontSize: 17,
    fontWeight: 700,
    color: 'var(--color-text)',
    margin: 0,
    letterSpacing: 0.5,
  },
  refreshBtn: {
    width: 40,
    height: 40,
    borderRadius: 10,
    border: 'none',
    background: 'transparent',
    color: 'var(--color-text-secondary)',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    transition: 'background 0.15s, transform 0.15s',
  },
  topBarSpacer: {
    width: 40,
    height: 40,
    flexShrink: 0,
  },
  divider: {
    display: 'none',
    height: 0,
    flexShrink: 0,
    opacity: 0.6,
  },
  tabBar: {
    display: 'flex',
    gap: 6,
    padding: '4px 16px 10px',
    flexShrink: 0,
    background: 'var(--color-bg)',
  },
  tabBtn: {
    flex: 1,
    border: 'none',
    borderRadius: 12,
    background: 'transparent',
    color: 'var(--color-text-secondary)',
    fontSize: 14.5,
    fontWeight: 700,
    padding: '9px 0',
    cursor: 'pointer',
    WebkitTapHighlightColor: 'transparent',
    transition: 'background 0.15s, color 0.15s',
  },
  tabBtnActive: {
    background: 'var(--color-primary)',
    color: '#fff',
  },
  scrollArea: {
    flex: 1,
    overflowY: 'auto',
    padding: '0 16px calc(24px + var(--safe-area-bottom))',
    background: 'var(--color-bg)',
  },
  content: {
    maxWidth: 760,
    margin: '0 auto',
  },
  formContent: {
    maxWidth: 760,
    margin: '0 auto',
    paddingBottom: 24,
  },
  detailContent: {
    maxWidth: 760,
    margin: '0 auto',
    paddingBottom: 24,
  },
  detailCard: {
    marginTop: 20,
    borderRadius: 16,
    border: '1px solid var(--color-border)',
    background: '#fff',
    padding: '4px 16px',
    boxShadow: '0 1px 2px rgba(0,0,0,0.04)',
  },
  detailRow: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 16,
    padding: '14px 0',
    borderBottom: '1px solid var(--color-border)',
  },
  detailLabel: {
    flexShrink: 0,
    fontSize: 13,
    color: 'var(--color-text-muted)',
  },
  detailValue: {
    minWidth: 0,
    textAlign: 'right',
    fontSize: 14,
    fontWeight: 600,
    color: 'var(--color-text)',
    lineHeight: 1.45,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
  detailBottomBar: {
    flexShrink: 0,
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: 12,
    padding: '12px 16px calc(12px + var(--safe-area-bottom))',
    borderTop: '1px solid var(--color-border)',
    background: 'var(--color-bg)',
  },
  detailActionBtn: {
    border: '1px solid var(--color-border)',
    borderRadius: 14,
    background: '#fff',
    color: 'var(--color-primary)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    padding: '12px 10px',
    fontSize: 14,
    fontWeight: 700,
    cursor: 'pointer',
  },
  detailDeleteBtn: {
    color: 'var(--color-error)',
  },
  detailActionIcon: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  formBlock: {
    marginTop: 20,
  },
  formLabel: {
    display: 'block',
    marginBottom: 6,
    fontSize: 13,
    fontWeight: 600,
    color: 'var(--color-text-secondary)',
  },
  formInput: {
    width: '100%',
    boxSizing: 'border-box',
    border: '1px solid var(--color-border)',
    borderRadius: 12,
    background: '#fff',
    color: 'var(--color-text)',
    fontSize: 15,
    padding: '12px 16px',
    outline: 'none',
    transition: 'border-color 0.15s, box-shadow 0.15s',
  },
  inputIconWrap: {
    position: 'relative',
  },
  inputIcon: {
    position: 'absolute',
    left: 14,
    top: '50%',
    transform: 'translateY(-50%)',
    color: 'var(--color-text-muted)',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    pointerEvents: 'none',
  },
  formInputWithIcon: {
    paddingLeft: 40,
  },
  formSelect: {
    appearance: 'none',
    WebkitAppearance: 'none',
  },
  typeGrid: {
    display: 'flex',
    gap: 8,
  },
  typeBtn: {
    flex: 1,
    border: '1px solid var(--color-border)',
    borderRadius: 12,
    background: '#fff',
    color: 'var(--color-text-secondary)',
    fontSize: 14,
    fontWeight: 600,
    padding: '10px 8px',
    cursor: 'default',
  },
  typeBtnActive: {
    borderColor: 'var(--color-primary)',
    background: 'var(--color-primary)',
    color: '#fff',
    boxShadow: '0 1px 2px rgba(74,63,58,0.08)',
  },
  toggleList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  toggleRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    border: '1px solid var(--color-border)',
    borderRadius: 12,
    background: '#fff',
    padding: '12px 16px',
  },
  toggleRowLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    minWidth: 0,
  },
  toggleIcon: {
    color: 'var(--color-text-muted)',
    flexShrink: 0,
  },
  toggleLabel: {
    fontSize: 14,
    color: 'var(--color-text)',
  },
  toggleSwitch: {
    width: 44,
    height: 24,
    border: 'none',
    borderRadius: 999,
    background: 'var(--color-border)',
    position: 'relative',
    padding: 0,
    cursor: 'pointer',
    transition: 'background 0.15s',
    flexShrink: 0,
  },
  toggleSwitchOn: {
    background: 'var(--color-primary)',
  },
  toggleKnob: {
    position: 'absolute',
    top: 2,
    left: 0,
    width: 20,
    height: 20,
    borderRadius: '50%',
    background: '#fff',
    boxShadow: '0 1px 2px rgba(0,0,0,0.12)',
    transition: 'transform 0.15s',
  },
  fullWidthSaveBtn: {
    width: '100%',
    border: 'none',
    borderRadius: 12,
    background: 'var(--color-primary)',
    color: '#fff',
    fontSize: 16,
    fontWeight: 700,
    padding: '14px 16px',
    marginTop: 32,
    cursor: 'pointer',
    boxShadow: '0 1px 2px rgba(74,63,58,0.08)',
  },
  summaryCard: {
    borderRadius: 22,
    background: 'linear-gradient(135deg, rgba(255,245,238,0.96), rgba(255,255,255,0.86))',
    border: '1px solid rgba(212,135,108,0.18)',
    padding: 18,
    marginBottom: 18,
    boxShadow: '0 8px 24px rgba(92, 62, 48, 0.06)',
  },
  summaryTitle: {
    fontSize: 18,
    fontWeight: 700,
    color: 'var(--color-text)',
    marginBottom: 6,
  },
  summaryText: {
    fontSize: 13,
    lineHeight: 1.6,
    color: 'var(--color-text-muted)',
  },
  summaryCount: {
    display: 'inline-flex',
    marginTop: 12,
    padding: '5px 10px',
    borderRadius: 999,
    background: 'rgba(212,135,108,0.13)',
    color: 'var(--color-primary)',
    fontSize: 12,
    fontWeight: 700,
  },
  section: {
    marginTop: 16,
  },
  sectionHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
    padding: '0 0 12px',
  },
  sectionIcon: {
    width: 16,
    height: 16,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  sectionIconTeal: {
    color: 'var(--color-primary-dark)',
  },
  sectionIconBrand: {
    color: 'var(--color-primary)',
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: 700,
    color: 'var(--color-text-secondary)',
    letterSpacing: 0.4,
  },
  sectionHint: {
    fontSize: 12,
    color: 'var(--color-text-muted)',
  },
  cardList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  timelineList: {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
    paddingBottom: 4,
  },
  timelineItem: {
    display: 'grid',
    gridTemplateColumns: '58px 20px minmax(0, 1fr)',
    columnGap: 8,
    alignItems: 'stretch',
    minHeight: 92,
  },
  timelineTime: {
    paddingTop: 9,
    textAlign: 'right',
    color: 'var(--color-text-muted)',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-end',
    gap: 2,
  },
  timelineDate: {
    fontSize: 12,
    fontWeight: 700,
    color: 'var(--color-text)',
  },
  timelineClock: {
    fontSize: 12,
    fontWeight: 600,
    color: 'var(--color-primary)',
  },
  timelineRail: {
    position: 'relative',
    display: 'flex',
    justifyContent: 'center',
  },
  timelineLine: {
    position: 'absolute',
    left: 18,
    top: 8,
    bottom: 8,
    width: 2,
    borderRadius: 999,
    background: 'var(--color-border)',
  },
  timelineGroup: {
    position: 'relative',
  },
  timelineDateHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    marginBottom: 8,
  },
  timelineDateDotWrap: {
    width: 38,
    display: 'flex',
    justifyContent: 'center',
    position: 'relative',
    zIndex: 1,
  },
  timelineDot: {
    position: 'relative',
    zIndex: 1,
    width: 12,
    height: 12,
    borderRadius: '50%',
    background: 'var(--color-primary)',
    border: '2px solid var(--color-bg)',
    boxShadow: '0 1px 2px rgba(0,0,0,0.06)',
  },
  timelineGroupLabel: {
    fontSize: 13,
    fontWeight: 700,
    color: 'var(--color-primary)',
  },
  timelineGroupItems: {
    marginLeft: 38,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  timelineEntry: {
    minWidth: 0,
  },
  card: {
    borderRadius: 12,
    background: '#fff',
    border: '1px solid var(--color-border)',
    padding: 14,
    boxShadow: '0 1px 2px rgba(0,0,0,0.05)',
  },
  cardButton: {
    width: '100%',
    display: 'block',
    textAlign: 'left',
    cursor: 'pointer',
    font: 'inherit',
    color: 'inherit',
  },
  cardHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: 12,
  },
  itemBody: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 12,
  },
  iconCircle: {
    width: 36,
    height: 36,
    borderRadius: '50%',
    background: 'var(--color-primary-bg)',
    color: 'var(--color-primary)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  cardTitleWrap: {
    flex: 1,
    minWidth: 0,
  },
  cardTitle: {
    fontSize: 14,
    fontWeight: 700,
    color: 'var(--color-text)',
    lineHeight: 1.25,
    wordBreak: 'break-word',
  },
  badgeRow: {
    display: 'flex',
    gap: 6,
    flexWrap: 'wrap',
    marginTop: 7,
  },
  badge: {
    padding: '2px 7px',
    borderRadius: 999,
    background: 'var(--color-primary-bg)',
    color: 'var(--color-primary)',
    fontSize: 11,
    fontWeight: 600,
  },
  cardActions: {
    display: 'flex',
    gap: 6,
    flexShrink: 0,
  },
  iconBtn: {
    width: 30,
    height: 30,
    borderRadius: 10,
    border: 'none',
    background: 'transparent',
    color: 'var(--color-primary)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
  },
  deleteIconBtn: {
    color: 'var(--color-primary)',
  },
  timeLine: {
    marginTop: 2,
    fontSize: 12,
    color: 'var(--color-primary)',
    fontWeight: 600,
  },
  notifyLine: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    marginTop: 3,
    fontSize: 11,
    color: 'var(--color-text-muted)',
    lineHeight: 1.35,
    wordBreak: 'break-word',
  },
  notifyIcon: {
    color: 'var(--color-text-muted)',
    flexShrink: 0,
  },
  repeatText: {
    color: 'var(--color-primary-dark)',
    fontWeight: 700,
  },
  subLine: {
    marginTop: 5,
    fontSize: 12,
    color: 'var(--color-text-muted)',
    wordBreak: 'break-all',
  },
  message: {
    marginTop: 9,
    fontSize: 11,
    lineHeight: 1.6,
    color: 'var(--color-text-muted)',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
  actionBar: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    alignItems: 'center',
    marginTop: 10,
    paddingTop: 10,
    borderTop: '1px solid var(--color-border)',
  },
  textActionBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    border: 'none',
    background: 'transparent',
    color: 'var(--color-primary)',
    fontSize: 12,
    fontWeight: 500,
    cursor: 'pointer',
    padding: '2px 4px',
  },
  emptyCard: {
    borderRadius: 12,
    border: '1px dashed var(--color-border)',
    padding: '22px 14px',
    textAlign: 'center',
    color: 'var(--color-text-muted)',
    fontSize: 14,
    background: 'var(--color-primary-bg)',
  },
  emptyState: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '64px 0',
    color: 'var(--color-text-muted)',
  },
  emptyIcon: {
    color: 'var(--color-text-muted)',
    opacity: 0.55,
    marginBottom: 12,
  },
  emptyTitle: {
    fontSize: 14,
    color: 'var(--color-text-muted)',
  },
  emptyDesc: {
    fontSize: 12,
    color: 'var(--color-text-muted)',
    marginTop: 4,
  },
  loading: {
    padding: 36,
    textAlign: 'center',
    color: 'var(--color-text-muted)',
  },
  error: {
    borderRadius: 14,
    background: 'rgba(214, 82, 82, 0.1)',
    color: 'var(--color-error)',
    padding: '10px 12px',
    fontSize: 13,
    marginBottom: 12,
  },
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  fieldLabel: {
    fontSize: 12,
    fontWeight: 700,
    color: 'var(--color-text-muted)',
    marginTop: 4,
  },
  input: {
    width: '100%',
    boxSizing: 'border-box',
    border: '1px solid var(--color-border)',
    borderRadius: 12,
    background: 'var(--color-bg)',
    color: 'var(--color-text)',
    fontSize: 14,
    padding: '10px 12px',
    outline: 'none',
  },
  textarea: {
    minHeight: 82,
    resize: 'vertical',
    lineHeight: 1.5,
  },
  segmented: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: 8,
    margin: '4px 0',
  },
  segmentBtn: {
    border: '1px solid var(--color-border)',
    background: 'var(--color-bg)',
    color: 'var(--color-text-muted)',
    borderRadius: 12,
    padding: '9px 10px',
    fontSize: 14,
    cursor: 'pointer',
  },
  segmentBtnActive: {
    background: 'var(--color-primary-bg)',
    borderColor: 'var(--color-primary)',
    color: 'var(--color-primary)',
    fontWeight: 700,
  },
  helpText: {
    fontSize: 12,
    color: 'var(--color-text-muted)',
    lineHeight: 1.5,
  },
  actions: {
    display: 'flex',
    gap: 10,
    marginTop: 8,
  },
  secondaryBtn: {
    flex: 1,
    border: '1px solid var(--color-border)',
    background: 'transparent',
    color: 'var(--color-text)',
    borderRadius: 12,
    padding: '10px 12px',
    fontWeight: 600,
    cursor: 'pointer',
  },
  primaryBtn: {
    flex: 1,
    border: 'none',
    background: 'var(--color-primary)',
    color: '#fff',
    borderRadius: 12,
    padding: '10px 12px',
    fontWeight: 700,
    cursor: 'pointer',
  },
}
