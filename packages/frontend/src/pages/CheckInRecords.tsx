import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import type {
  ApiResponse,
  CheckInFieldDefinition,
  CheckInPrimitiveValue,
  CheckInRecord,
  CheckInSchemaListResponse,
  CheckInSchemaRecord,
  CheckInValueWithMeta,
} from '@health-agent/shared'
import { api } from '../services/api.js'
import CheckInEditableForm from '../lib/a2ui/EditableForm.js'
import {
  calendarRecordMarker,
  dayKeyOf,
  monthKeyOf,
  resolveCalendarMonth,
  resolveSelectedCalendarDay,
  resolveSelectedDayForMonth,
  shiftCalendarMonth,
} from '../lib/checkInCalendar.js'
import {
  listAllCheckInRecords,
  updateCheckInRecord as updateCheckInRecordApi,
} from '../services/checkInApi.js'
import {
  applyUpdatedCheckInRecord,
  createCheckInRecordEditState,
  getCheckInRecordEditableFormProps,
  type CheckInRecordEditState,
} from './checkInRecordFormView.js'

const CHART_COLORS = ['#b8705a', '#4d8f79', '#7c6f64', '#c58a37', '#6f86a6', '#9b6b8d']

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

export function formatRecordDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function formatShortDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())}`
}

function primitiveValue(value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value) && 'value' in value) {
    return (value as CheckInValueWithMeta).value
  }
  return value
}

function numericValue(value: unknown): number | null {
  const raw = primitiveValue(value)
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (typeof raw === 'string' && raw.trim()) {
    const parsed = Number(raw.trim())
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function fieldsForTrend(schema: CheckInSchemaRecord | null): CheckInFieldDefinition[] {
  return schema?.a2uiSchema.fields.filter((field) => field.type === 'number') ?? []
}

export function shouldShowCalendarTrend(records: CheckInRecord[], fields: CheckInFieldDefinition[]): boolean {
  if (fields.length === 0) return false
  return records.some((record) => fields.some((field) => numericValue(record.valuesJson[field.key]) !== null))
}

function TrendChart({
  records,
  fields,
}: {
  records: CheckInRecord[]
  fields: CheckInFieldDefinition[]
}) {
  const chronological = [...records].reverse()
  const values = fields.flatMap((field) =>
    chronological
      .map((record) => numericValue(record.valuesJson[field.key]))
      .filter((value): value is number => value !== null),
  )

  if (fields.length === 0 || values.length === 0) {
    return <div style={styles.empty}>这个分类还没有可绘制的数值记录</div>
  }

  const minTime = chronological[0] ? new Date(chronological[0].recordedAt).getTime() : 0
  const maxTime = chronological[chronological.length - 1] ? new Date(chronological[chronological.length - 1].recordedAt).getTime() : minTime
  const rawMin = Math.min(...values)
  const rawMax = Math.max(...values)
  const padding = rawMin === rawMax ? Math.max(1, Math.abs(rawMin) * 0.2) : (rawMax - rawMin) * 0.12
  const minValue = rawMin - padding
  const maxValue = rawMax + padding
  const width = 360
  const height = 190
  const left = 38
  const right = 16
  const top = 20
  const bottom = 42
  const plotWidth = width - left - right
  const plotHeight = height - top - bottom
  const xOf = (record: CheckInRecord) => {
    const t = new Date(record.recordedAt).getTime()
    if (maxTime === minTime) return left + plotWidth / 2
    return left + ((t - minTime) / (maxTime - minTime)) * plotWidth
  }
  const yOf = (value: number) => top + ((maxValue - value) / (maxValue - minValue)) * plotHeight

  return (
    <div style={styles.trendPanel}>
      <div style={styles.panelHeader}>
        <strong>趋势图</strong>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} style={styles.chart}>
        <line x1={left} y1={top + plotHeight} x2={width - right} y2={top + plotHeight} stroke="#e6d6cf" />
        <line x1={left} y1={top} x2={left} y2={top + plotHeight} stroke="#e6d6cf" />
        <text x="4" y={top + 4} fontSize="10" fill="#998c86">{rawMax.toFixed(1)}</text>
        <text x="4" y={top + plotHeight} fontSize="10" fill="#998c86">{rawMin.toFixed(1)}</text>
        {fields.map((field, fieldIndex) => {
          const points = chronological
            .map((record) => {
              const value = numericValue(record.valuesJson[field.key])
              if (value === null) return null
              return { x: xOf(record), y: yOf(value), value }
            })
            .filter((point): point is { x: number; y: number; value: number } => !!point)
          const color = CHART_COLORS[fieldIndex % CHART_COLORS.length]
          if (!points.length) return null
          const polyline = points.map((point) => `${point.x},${point.y}`).join(' ')
          return (
            <g key={field.key}>
              {points.length > 1 && <polyline points={polyline} fill="none" stroke={color} strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />}
              {points.map((point, index) => (
                <circle key={`${field.key}-${index}`} cx={point.x} cy={point.y} r="4" fill={color} />
              ))}
            </g>
          )
        })}
        {chronological[0] && <text x={left} y={height - 14} fontSize="10" fill="#998c86">{formatShortDate(chronological[0].recordedAt)}</text>}
        {chronological[chronological.length - 1] && (
          <text x={width - 86} y={height - 14} fontSize="10" fill="#998c86">{formatShortDate(chronological[chronological.length - 1].recordedAt)}</text>
        )}
      </svg>
      <div style={styles.legend}>
        {fields.map((field, index) => (
          <span key={field.key} style={styles.legendItem}>
            <i style={{ ...styles.legendDot, background: CHART_COLORS[index % CHART_COLORS.length] }} />
            {field.label}{field.unit ? `(${field.unit})` : ''}
          </span>
        ))}
      </div>
    </div>
  )
}

function CalendarBoard({
  records,
  selectedDay,
  visibleMonth,
  onSelectDay,
  onChangeMonth,
}: {
  records: CheckInRecord[]
  selectedDay: string
  visibleMonth: string
  onSelectDay: (day: string) => void
  onChangeMonth: (monthKey: string) => void
}) {
  const anchor = /^\d{4}-\d{2}$/.test(visibleMonth) ? new Date(`${visibleMonth}-01T00:00:00`) : new Date()
  const year = anchor.getFullYear()
  const month = anchor.getMonth()
  const first = new Date(year, month, 1)
  const startOffset = (first.getDay() + 6) % 7
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const todayKey = dayKeyOf(new Date())
  const counts = new Map<string, number>()
  for (const record of records) {
    const key = dayKeyOf(record.recordedAt)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const cells = [
    ...Array.from({ length: startOffset }, (_, index) => ({ key: `blank-${index}`, day: 0, dateKey: '' })),
    ...Array.from({ length: daysInMonth }, (_, index) => {
      const day = index + 1
      const dateKey = `${year}-${pad(month + 1)}-${pad(day)}`
      return { key: dateKey, day, dateKey }
    }),
  ]

  return (
    <div style={styles.calendarPanel}>
      <div style={styles.panelHeader}>
        <strong>{year} 年 {month + 1} 月</strong>
        <div style={styles.monthControls}>
          <button
            type="button"
            style={styles.monthBtn}
            onClick={() => onChangeMonth(shiftCalendarMonth(`${year}-${pad(month + 1)}`, -1))}
            aria-label="查看上个月"
            title="查看上个月"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
          <button
            type="button"
            style={styles.monthBtn}
            onClick={() => onChangeMonth(resolveCalendarMonth('', todayKey))}
            aria-label="回到今天所在月份"
            title="回到今天所在月份"
          >
            今
          </button>
          <button
            type="button"
            style={styles.monthBtn}
            onClick={() => onChangeMonth(shiftCalendarMonth(`${year}-${pad(month + 1)}`, 1))}
            aria-label="查看下个月"
            title="查看下个月"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>
        </div>
      </div>
      <div style={styles.weekRow}>
        {['一', '二', '三', '四', '五', '六', '日'].map((day) => <span key={day}>{day}</span>)}
      </div>
      <div style={styles.calendarGrid}>
        {cells.map((cell) => {
          if (!cell.dateKey) return <div key={cell.key} />
          const count = counts.get(cell.dateKey) ?? 0
          const marker = calendarRecordMarker(count)
          const selected = cell.dateKey === selectedDay
          const isToday = cell.dateKey === todayKey
          return (
            <button
              key={cell.key}
              style={{
                ...styles.dayCell,
                ...(count ? styles.dayCellHasRecord : {}),
                ...(isToday ? styles.dayCellToday : {}),
                ...(selected ? styles.dayCellSelected : {}),
              }}
              onClick={() => onSelectDay(cell.dateKey)}
            >
              <span>{cell.day}</span>
              {marker && <strong style={styles.dayMarker}>{marker}</strong>}
            </button>
          )
        })}
      </div>
    </div>
  )
}

export default function CheckInRecords() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const returnSessionId = searchParams.get('returnSessionId')
  const returnToChatPath = returnSessionId ? `/chat/${returnSessionId}` : '/chat'
  const shouldReturnToSettings = searchParams.get('returnToSettings') === '1' || !!returnSessionId
  const returnToSettingsState = useMemo(
    () => (shouldReturnToSettings ? { openSidebar: true } : undefined),
    [shouldReturnToSettings],
  )
  const [records, setRecords] = useState<CheckInRecord[]>([])
  const [schemas, setSchemas] = useState<CheckInSchemaListResponse['schemas']>([])
  const [selectedCategory, setSelectedCategory] = useState<string>('')
  const [selectedDay, setSelectedDay] = useState<string>('')
  const [calendarMonth, setCalendarMonth] = useState<string>(() => monthKeyOf(new Date()))
  const [loading, setLoading] = useState(true)
  const [editState, setEditState] = useState<CheckInRecordEditState | null>(null)
  const [savingRecordId, setSavingRecordId] = useState<string | null>(null)
  const [editError, setEditError] = useState<string | null>(null)

  const selectedSchema = useMemo(
    () => schemas.find((schema) => schema.categoryKey === selectedCategory) ?? null,
    [schemas, selectedCategory],
  )
  const trendFields = useMemo(() => fieldsForTrend(selectedSchema), [selectedSchema])
  const showCalendarTrend = useMemo(
    () => shouldShowCalendarTrend(records, trendFields),
    [records, trendFields],
  )
  const dayRecords = useMemo(
    () => records.filter((record) => dayKeyOf(record.recordedAt) === selectedDay),
    [records, selectedDay],
  )

  useEffect(() => {
    void loadSchemas()
  }, [])

  useEffect(() => {
    if (!selectedCategory) {
      setRecords([])
      setLoading(false)
      return
    }
    setRecords([])
    setSelectedDay('')
    setCalendarMonth(monthKeyOf(new Date()))
    void loadRecords(selectedCategory)
  }, [selectedCategory])

  async function loadSchemas() {
    setLoading(true)
    try {
      const res = await api.get<ApiResponse<CheckInSchemaListResponse>>('/check-ins/schemas')
      const nextSchemas = res.data?.schemas ?? []
      setSchemas(nextSchemas)
      setSelectedCategory((current) => current || nextSchemas[0]?.categoryKey || '')
    } catch {
      setSchemas([])
      setSelectedCategory('')
    } finally {
      setLoading(false)
    }
  }

  async function loadRecords(categoryKey: string) {
    setLoading(true)
    try {
      const nextRecords = await listAllCheckInRecords({ categoryKey })
      const todayKey = dayKeyOf(new Date())
      const nextSelectedDay = resolveSelectedCalendarDay(
        '',
        nextRecords.map((record) => dayKeyOf(record.recordedAt)),
        todayKey,
      )
      setRecords(nextRecords)
      setSelectedDay(nextSelectedDay)
      setCalendarMonth(resolveCalendarMonth(nextSelectedDay, todayKey))
    } catch {
      setRecords([])
      const todayKey = dayKeyOf(new Date())
      setSelectedDay(todayKey)
      setCalendarMonth(resolveCalendarMonth(todayKey, todayKey))
    } finally {
      setLoading(false)
    }
  }

  function handleSelectDay(day: string) {
    setSelectedDay(day)
    setCalendarMonth(resolveCalendarMonth(day, dayKeyOf(new Date())))
  }

  function handleChangeMonth(monthKey: string) {
    const recordDays = records.map((record) => dayKeyOf(record.recordedAt))
    setCalendarMonth(monthKey)
    setSelectedDay((current) => resolveSelectedDayForMonth(monthKey, current, recordDays))
  }

  async function handleDelete(record: CheckInRecord) {
    if (!confirm('确定删除这条打卡记录？')) return
    await api.delete(`/check-ins/records/${record.id}`).catch(() => undefined)
    setRecords((items) => items.filter((item) => item.id !== record.id))
    if (editState?.recordId === record.id) {
      setEditState(null)
      setEditError(null)
    }
  }

  function handleStartEdit(record: CheckInRecord) {
    setEditState(createCheckInRecordEditState(record))
    setEditError(null)
  }

  function handleEditValue(record: CheckInRecord, key: string, value: CheckInPrimitiveValue) {
    setEditState((current) => {
      if (!current || current.recordId !== record.id) return current
      return { ...current, values: { ...current.values, [key]: value } }
    })
  }

  function handleEditNote(record: CheckInRecord, note: string) {
    setEditState((current) => {
      if (!current || current.recordId !== record.id) return current
      return { ...current, note }
    })
  }

  async function handleSaveEdit(record: CheckInRecord) {
    if (!editState || editState.recordId !== record.id) return
    setSavingRecordId(record.id)
    setEditError(null)
    try {
      const updated = await updateCheckInRecordApi(record.id, {
        values: editState.values,
        note: editState.note,
        tags: editState.tags,
      })
      setRecords((items) => applyUpdatedCheckInRecord(items, updated))
      setEditState(null)
    } catch (err: any) {
      setEditError(err?.message || '保存失败,请稍后再试')
    } finally {
      setSavingRecordId(null)
    }
  }

  function handleCancelEdit() {
    setEditState(null)
    setEditError(null)
  }

  return (
    <div style={styles.container}>
      <div style={styles.scrollArea}>
        <div style={styles.nav}>
          <button
            style={styles.backBtn}
            onClick={() => navigate(returnToChatPath, { state: returnToSettingsState })}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
            <span>返回</span>
          </button>
        </div>

        <div style={styles.content}>
          <h1 style={styles.title}>打卡记录</h1>

          {schemas.length > 0 && (
            <div style={styles.filterRow}>
              {schemas.map((schema) => (
                <button
                  key={schema.id}
                  style={{ ...styles.filterChip, ...(selectedCategory === schema.categoryKey ? styles.filterChipActive : {}) }}
                  onClick={() => setSelectedCategory(schema.categoryKey)}
                >
                  {schema.categoryName}
                </button>
              ))}
            </div>
          )}

          {loading ? (
            <div style={styles.empty}>加载中...</div>
          ) : !selectedSchema ? (
            <div style={styles.empty}>暂无打卡分类</div>
          ) : (
            <div style={styles.dashboard}>
              <section style={styles.categoryHeader}>
                <div>
                  <h2 style={styles.categoryTitle}>{selectedSchema.categoryName}</h2>
                </div>
              </section>

              {selectedSchema.displayMode === 'quantitative' ? (
                <>
                  <TrendChart records={records} fields={trendFields} />
                  <RecordSection
                    title="最近记录"
                    records={records}
                    onDelete={handleDelete}
                    editState={editState}
                    savingRecordId={savingRecordId}
                    editError={editError}
                    onStartEdit={handleStartEdit}
                    onEditValue={handleEditValue}
                    onEditNote={handleEditNote}
                    onSaveEdit={handleSaveEdit}
                    onCancelEdit={handleCancelEdit}
                  />
                </>
              ) : (
                <>
                  {showCalendarTrend ? <TrendChart records={records} fields={trendFields} /> : null}
                  <CalendarBoard
                    records={records}
                    selectedDay={selectedDay}
                    visibleMonth={calendarMonth}
                    onSelectDay={handleSelectDay}
                    onChangeMonth={handleChangeMonth}
                  />
                  <RecordSection
                    title={selectedDay ? `${selectedDay} 的记录` : '当天记录'}
                    records={dayRecords}
                    emptyText="这一天暂无记录"
                    onDelete={handleDelete}
                    editState={editState}
                    savingRecordId={savingRecordId}
                    editError={editError}
                    onStartEdit={handleStartEdit}
                    onEditValue={handleEditValue}
                    onEditNote={handleEditNote}
                    onSaveEdit={handleSaveEdit}
                    onCancelEdit={handleCancelEdit}
                  />
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function RecordSection({
  title,
  records,
  emptyText = '暂无记录',
  onDelete,
  editState,
  savingRecordId,
  editError,
  onStartEdit,
  onEditValue,
  onEditNote,
  onSaveEdit,
  onCancelEdit,
}: {
  title: string
  records: CheckInRecord[]
  emptyText?: string
  onDelete: (record: CheckInRecord) => void
  editState: CheckInRecordEditState | null
  savingRecordId: string | null
  editError: string | null
  onStartEdit: (record: CheckInRecord) => void
  onEditValue: (record: CheckInRecord, key: string, value: CheckInPrimitiveValue) => void
  onEditNote: (record: CheckInRecord, note: string) => void
  onSaveEdit: (record: CheckInRecord) => void
  onCancelEdit: () => void
}) {
  return (
    <section style={styles.recordSection}>
      <h3 style={styles.sectionTitle}>{title}</h3>
      {records.length === 0 ? (
        <div style={styles.empty}>{emptyText}</div>
      ) : (
        <div style={styles.detailList}>
          {records.map((record) => {
            const isEditing = editState?.recordId === record.id
            const isSaving = savingRecordId === record.id
            const baseFormProps = getCheckInRecordEditableFormProps(record)
            const formProps = isEditing
              ? {
                  ...baseFormProps,
                  values: editState.values,
                  note: editState.note,
                  tags: editState.tags,
                  statusLabel: '编辑中',
                  readOnly: false,
                }
              : baseFormProps
            return (
              <article key={record.id} style={styles.detailItem}>
                <div style={styles.detailItemHeader}>
                  <span style={styles.recordTime}>{formatRecordDate(record.recordedAt)}</span>
                  <div style={styles.headerActions}>
                    {!isEditing ? (
                      <button style={styles.iconBtn} onClick={() => onStartEdit(record)} title="编辑">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M12 20h9" />
                          <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
                        </svg>
                      </button>
                    ) : null}
                    <button style={styles.iconBtn} onClick={() => onDelete(record)} title="删除" disabled={isSaving}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M3 6h18" />
                        <path d="M8 6V4h8v2" />
                        <path d="M19 6l-1 14H6L5 6" />
                      </svg>
                    </button>
                  </div>
                </div>
                <CheckInEditableForm
                  {...formProps}
                  submitLabel="保存修改"
                  submitting={isSaving}
                  errorMessage={isEditing ? editError : null}
                  onCancel={isEditing ? onCancelEdit : undefined}
                  onChangeValue={(key, value) => onEditValue(record, key, value)}
                  onChangeNote={(note) => onEditNote(record, note)}
                  onSubmit={() => onSaveEdit(record)}
                />
              </article>
            )
          })}
        </div>
      )}
    </section>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    height: '100%',
    background: 'var(--color-bg)',
    overflow: 'hidden',
  },
  scrollArea: {
    height: '100%',
    overflowY: 'auto',
    WebkitOverflowScrolling: 'touch',
  },
  nav: {
    position: 'sticky',
    top: 0,
    zIndex: 2,
    display: 'flex',
    alignItems: 'center',
    padding: 'calc(var(--safe-area-top) + 10px) 16px 10px',
    background: 'rgba(255, 250, 246, 0.94)',
    backdropFilter: 'blur(12px)',
  },
  backBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    border: 'none',
    background: 'transparent',
    color: 'var(--color-primary-dark)',
    fontSize: 15,
    fontWeight: 700,
    padding: '8px 4px',
  },
  content: {
    padding: '18px 20px calc(var(--safe-area-bottom) + 28px)',
  },
  title: {
    margin: 0,
    fontSize: 28,
    lineHeight: '36px',
    color: 'var(--color-text)',
    letterSpacing: 0,
  },
  subtitle: {
    margin: '8px 0 18px',
    color: 'var(--color-text-muted)',
    fontSize: 14,
    lineHeight: '22px',
  },
  filterRow: {
    display: 'flex',
    gap: 8,
    overflowX: 'auto',
    paddingBottom: 12,
    margin: '12px 0 4px',
  },
  filterChip: {
    flexShrink: 0,
    border: '1px solid rgba(184, 112, 90, 0.18)',
    background: '#fff',
    borderRadius: 999,
    padding: '8px 12px',
    color: 'var(--color-text)',
    fontSize: 13,
  },
  filterChipActive: {
    background: 'var(--color-primary)',
    color: '#fff',
    borderColor: 'var(--color-primary)',
  },
  dashboard: {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  },
  categoryHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  categoryTitle: {
    margin: 0,
    color: 'var(--color-text)',
    fontSize: 20,
    lineHeight: '28px',
    letterSpacing: 0,
  },
  categoryMeta: {
    margin: '4px 0 0',
    color: 'var(--color-text-muted)',
    fontSize: 13,
    lineHeight: '20px',
  },
  trendPanel: {
    borderRadius: 8,
    background: '#fff',
    border: '1px solid rgba(184, 112, 90, 0.14)',
    padding: 12,
  },
  panelHeader: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
    marginBottom: 10,
    color: 'var(--color-text)',
  },
  monthControls: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
  },
  monthBtn: {
    width: 30,
    height: 30,
    borderRadius: 8,
    border: '1px solid rgba(184, 112, 90, 0.16)',
    background: 'rgba(255, 250, 246, 0.86)',
    color: 'var(--color-primary-dark)',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 13,
    fontWeight: 800,
    padding: 0,
  },
  chart: {
    width: '100%',
    height: 190,
    borderRadius: 8,
    background: 'rgba(255, 250, 246, 0.86)',
  },
  legend: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '6px 12px',
    marginTop: 8,
    color: 'var(--color-text)',
    fontSize: 12,
    lineHeight: '18px',
  },
  legendItem: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
  },
  legendDot: {
    display: 'inline-block',
    width: 8,
    height: 8,
    borderRadius: 999,
  },
  calendarPanel: {
    borderRadius: 8,
    background: '#fff',
    border: '1px solid rgba(184, 112, 90, 0.14)',
    padding: 12,
  },
  weekRow: {
    display: 'grid',
    gridTemplateColumns: 'repeat(7, minmax(0, 1fr))',
    gap: 6,
    marginBottom: 6,
    color: 'var(--color-text-muted)',
    fontSize: 12,
    textAlign: 'center',
  },
  calendarGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(7, minmax(0, 1fr))',
    gap: 6,
  },
  dayCell: {
    minHeight: 46,
    borderRadius: 8,
    border: '1px solid rgba(184, 112, 90, 0.10)',
    background: 'rgba(255, 250, 246, 0.68)',
    color: 'var(--color-text)',
    fontSize: 13,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
  },
  dayCellHasRecord: {
    background: '#fff',
  },
  dayMarker: {
    minWidth: 16,
    height: 16,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 999,
    background: 'rgba(77, 143, 121, 0.12)',
    color: '#1d7b52',
    fontSize: 11,
    lineHeight: '16px',
    fontWeight: 800,
  },
  dayCellToday: {
    borderColor: 'rgba(184, 112, 90, 0.45)',
    boxShadow: 'inset 0 0 0 1px rgba(184, 112, 90, 0.28)',
  },
  dayCellSelected: {
    border: '2px solid var(--color-primary)',
    background: 'rgba(184, 112, 90, 0.10)',
  },
  recordSection: {
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  sectionTitle: {
    margin: '4px 0 0',
    color: 'var(--color-text)',
    fontSize: 16,
    lineHeight: '22px',
    letterSpacing: 0,
  },
  detailList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  },
  detailItem: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  detailItemHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  recordTime: {
    color: 'var(--color-text-muted)',
    fontSize: 12,
    lineHeight: '18px',
  },
  headerActions: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 2,
  },
  iconBtn: {
    width: 32,
    height: 32,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: 'none',
    background: 'transparent',
    color: 'var(--color-text-muted)',
    flexShrink: 0,
  },
  empty: {
    borderRadius: 8,
    background: '#fff',
    border: '1px solid rgba(184, 112, 90, 0.12)',
    padding: 22,
    textAlign: 'center',
    color: 'var(--color-text-muted)',
    fontSize: 14,
    lineHeight: '22px',
  },
}
