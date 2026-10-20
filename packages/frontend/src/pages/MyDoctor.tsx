import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { api } from '../services/api.js'
import type { ApiResponse, BoundDoctor, MyDoctorResponse, UnbindDoctorResponse } from '@health-agent/shared'

export const MY_DOCTOR_PULL_REFRESH_THRESHOLD_PX = 64
export const MY_DOCTOR_REFRESH_MIN_VISIBLE_MS = 600
export const MY_DOCTOR_REFRESH_SUCCESS_VISIBLE_MS = 500
export const MY_DOCTOR_REFRESH_ERROR_VISIBLE_MS = 800
export const MY_DOCTOR_REFRESH_COLLAPSE_TRANSITION_MS = 260
const MY_DOCTOR_PULL_REFRESH_MAX_DISTANCE_PX = 86
const MY_DOCTOR_PULL_REFRESH_RESISTANCE = 0.45

type RefreshFeedback = 'idle' | 'success' | 'error'
type BusyAction = 'request-unbind' | 'confirm-unbind' | 'reject-unbind' | 'cancel-unbind'

export function getMyDoctorPullRefreshState(input: {
  startY: number | null
  currentY: number
  scrollTop: number
  refreshing: boolean
}): { distance: number; ready: boolean } {
  if (input.refreshing || input.startY === null || input.scrollTop > 0) {
    return { distance: 0, ready: false }
  }
  const rawDistance = Math.max(0, input.currentY - input.startY)
  const distance = Math.min(
    MY_DOCTOR_PULL_REFRESH_MAX_DISTANCE_PX,
    Math.round(rawDistance * MY_DOCTOR_PULL_REFRESH_RESISTANCE),
  )
  return {
    distance,
    ready: distance >= MY_DOCTOR_PULL_REFRESH_THRESHOLD_PX,
  }
}

export function getMyDoctorRefreshMinimumWaitMs(startedAtMs: number, completedAtMs: number): number {
  return Math.max(0, MY_DOCTOR_REFRESH_MIN_VISIBLE_MS - Math.max(0, completedAtMs - startedAtMs))
}

export function markMyDoctorMounted(mountedRef: { current: boolean }): () => void {
  mountedRef.current = true
  return () => {
    mountedRef.current = false
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

function initialsFor(name: string | null | undefined): string {
  const trimmed = name?.trim()
  return trimmed ? Array.from(trimmed).slice(-2).join('') : '医生'
}

function getStatusText(binding: BoundDoctor): string {
  if (binding.status === 'pending_confirmation') return '等待医生确认'
  if (binding.status === 'rejected') return '绑定未通过'
  if (binding.status === 'pending_unbind' && binding.unbindRequestedBy === 'doctor') return '待确认解绑'
  if (binding.status === 'pending_unbind') return '解绑申请中'
  return '已绑定'
}

function getStatusStyle(binding: BoundDoctor): React.CSSProperties {
  if (binding.status === 'confirmed') return styles.statusPillConfirmed
  if (binding.status === 'rejected') return styles.statusPillRejected
  return styles.statusPillPending
}

export default function MyDoctor() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const returnSessionId = searchParams.get('returnSessionId')
  const shouldReturnToSettings = searchParams.get('returnToSettings') === '1' || !!returnSessionId
  const returnToChatPath = returnSessionId ? `/chat/${returnSessionId}` : '/chat'
  const returnToSettingsState = shouldReturnToSettings ? { openSidebar: true } : undefined

  const [bindings, setBindings] = useState<BoundDoctor[]>([])
  const [loading, setLoading] = useState(true)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshFeedback, setRefreshFeedback] = useState<RefreshFeedback>('idle')
  const [pullDistance, setPullDistance] = useState(0)
  const [pullReady, setPullReady] = useState(false)
  const [error, setError] = useState('')
  const contentRef = useRef<HTMLElement | null>(null)
  const mountedRef = useRef(true)
  const pullStartYRef = useRef<number | null>(null)

  useEffect(() => markMyDoctorMounted(mountedRef), [])

  const loadDoctor = useCallback(async (mode: 'initial' | 'refresh' = 'refresh'): Promise<boolean> => {
    if (mode === 'initial') setLoading(true)
    else setRefreshing(true)
    setError('')
    try {
      const res = await api.get<ApiResponse<MyDoctorResponse>>('/doctor/me')
      if (!mountedRef.current) return false
      setBindings(res.data?.bindings ?? (res.data?.binding ? [res.data.binding] : []))
      return true
    } catch (err: any) {
      if (!mountedRef.current) return false
      setError(err.message || '加载医生信息失败')
      return false
    } finally {
      if (mountedRef.current) {
        if (mode === 'initial') setLoading(false)
        else setRefreshing(false)
      }
    }
  }, [])

  useEffect(() => {
    void loadDoctor('initial')
  }, [loadDoctor])

  function goBack() {
    navigate(returnToChatPath, { state: returnToSettingsState })
  }

  function handlePullStart(event: React.TouchEvent<HTMLElement>) {
    if (refreshing) return
    const scrollTop = contentRef.current?.scrollTop ?? 0
    if (scrollTop > 0) return
    pullStartYRef.current = event.touches[0]?.clientY ?? null
  }

  function handlePullMove(event: React.TouchEvent<HTMLElement>) {
    const currentY = event.touches[0]?.clientY
    if (currentY === undefined) return
    const state = getMyDoctorPullRefreshState({
      startY: pullStartYRef.current,
      currentY,
      scrollTop: contentRef.current?.scrollTop ?? 0,
      refreshing,
    })
    setPullDistance(state.distance)
    setPullReady(state.ready)
  }

  async function finishPullRefresh() {
    const shouldRefresh = pullReady && !refreshing
    pullStartYRef.current = null
    setPullReady(false)
    if (!shouldRefresh) {
      setPullDistance(0)
      return
    }
    setPullDistance(36)
    const startedAt = Date.now()
    const ok = await loadDoctor('refresh')
    await wait(getMyDoctorRefreshMinimumWaitMs(startedAt, Date.now()))
    if (!mountedRef.current) return
    setRefreshFeedback(ok ? 'success' : 'error')
    await wait(ok ? MY_DOCTOR_REFRESH_SUCCESS_VISIBLE_MS : MY_DOCTOR_REFRESH_ERROR_VISIBLE_MS)
    if (!mountedRef.current) return
    setRefreshFeedback('idle')
    setPullDistance(0)
  }

  async function mutateBinding(binding: BoundDoctor, action: BusyAction) {
    if (busyKey) return
    setBusyKey(`${binding.bindingId}:${action}`)
    setError('')
    try {
      let res: ApiResponse<UnbindDoctorResponse>
      if (action === 'request-unbind') {
        res = await api.delete<ApiResponse<UnbindDoctorResponse>>(`/doctor/bindings/${binding.bindingId}`)
      } else if (action === 'confirm-unbind') {
        res = await api.post<ApiResponse<UnbindDoctorResponse>>(`/doctor/bindings/${binding.bindingId}/unbind-confirm`, {})
      } else if (action === 'reject-unbind') {
        res = await api.post<ApiResponse<UnbindDoctorResponse>>(`/doctor/bindings/${binding.bindingId}/unbind-reject`, {})
      } else {
        res = await api.post<ApiResponse<UnbindDoctorResponse>>(`/doctor/bindings/${binding.bindingId}/unbind-cancel`, {})
      }
      setBindings(res.data?.bindings ?? (res.data?.binding ? [res.data.binding] : []))
    } catch (err: any) {
      setError(err.message || '操作失败，请稍后再试')
    } finally {
      setBusyKey(null)
    }
  }

  return (
    <div style={styles.page}>
      <div style={styles.nav}>
        <button style={styles.backBtn} onClick={goBack} aria-label="返回">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        <h1 style={styles.title}>我的医生</h1>
        <div style={styles.navSpacer} />
      </div>

      <main
        ref={contentRef}
        style={styles.content}
        onTouchStart={handlePullStart}
        onTouchMove={handlePullMove}
        onTouchEnd={() => { void finishPullRefresh() }}
        onTouchCancel={() => {
          pullStartYRef.current = null
          setPullReady(false)
          setPullDistance(0)
        }}
      >
        <div
          style={{
            ...styles.pullRefreshIndicator,
            height: refreshing || refreshFeedback !== 'idle' ? 36 : pullDistance,
            opacity: refreshing || refreshFeedback !== 'idle' || pullDistance > 0 ? 1 : 0,
          }}
        >
          {refreshing
            ? '刷新中...'
            : refreshFeedback === 'success'
              ? '已更新'
              : refreshFeedback === 'error'
                ? '刷新失败，请重试'
                : pullReady ? '松开刷新' : '下拉刷新'}
        </div>
        {loading ? (
          <p style={styles.stateText}>加载中...</p>
        ) : bindings.length > 0 ? (
          <div style={styles.doctorList}>
            {bindings.map((binding) => (
              <DoctorCard
                key={binding.bindingId}
                binding={binding}
                busyKey={busyKey}
                onAction={mutateBinding}
              />
            ))}
          </div>
        ) : (
          <section style={styles.emptyState}>
            <div style={styles.emptyIcon}>
              <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                <path d="M16 21v-2a4 4 0 0 0-8 0v2" />
                <circle cx="12" cy="7" r="4" />
                <path d="M4 4l16 16" />
              </svg>
            </div>
            <p style={styles.emptyTitle}>暂未绑定医生</p>
          </section>
        )}

        {error && <p style={styles.errorText}>{error}</p>}
      </main>
    </div>
  )
}

function DoctorCard({
  binding,
  busyKey,
  onAction,
}: {
  binding: BoundDoctor
  busyKey: string | null
  onAction: (binding: BoundDoctor, action: BusyAction) => void
}) {
  const actionKey = (action: BusyAction) => `${binding.bindingId}:${action}`
  const authorizedAt = formatDateTime(binding.confirmedAt ?? binding.createdAt)
  const meta = [binding.doctor.hospital, binding.doctor.department, binding.doctor.title].filter(Boolean).join(' · ') || '医生信息待完善'

  return (
    <section style={styles.doctorPanel}>
      <div style={styles.doctorTop}>
        <div style={styles.avatarWrap}>
          {binding.doctor.avatarUrl ? (
            <img src={binding.doctor.avatarUrl} alt="" style={styles.avatarImg} />
          ) : (
            <span style={styles.avatarText}>{initialsFor(binding.doctor.name)}</span>
          )}
        </div>
        <div style={styles.doctorText}>
          <div style={styles.nameRow}>
            <h2 style={styles.doctorName}>{binding.doctor.name}</h2>
            <span style={{ ...styles.statusPill, ...getStatusStyle(binding) }}>{getStatusText(binding)}</span>
          </div>
          <p style={styles.doctorMeta}>{meta}</p>
        </div>
      </div>
      <div style={styles.detailList}>
        <InfoRow label="医生姓名" value={binding.doctor.name} />
        <InfoRow label="职务" value={binding.doctor.title || '未填写'} />
        <InfoRow label="医院名" value={binding.doctor.hospital || '未填写'} />
        <InfoRow label="科室" value={binding.doctor.department || '未填写'} />
        <InfoRow label="授权时间" value={authorizedAt} />
        <div style={styles.infoRow}>
          <span style={styles.infoLabel}>可查看内容</span>
          <div style={styles.scopeList}>
            {['个人信息', '健康档案', '病例文档'].map((item) => (
              <span key={item} style={styles.scopePill}>{item}</span>
            ))}
          </div>
        </div>
      </div>
      <p style={styles.authNotice}>{getNoticeText(binding)}</p>
      {renderBindingActions(binding, busyKey, actionKey, onAction)}
    </section>
  )
}

function getNoticeText(binding: BoundDoctor): string {
  if (binding.status === 'pending_confirmation') return '已提交绑定申请，医生确认后即可查看您的授权健康档案。'
  if (binding.status === 'rejected') return '医生暂未接受本次绑定申请，如需再次绑定请重新扫码。'
  if (binding.status === 'pending_unbind' && binding.unbindRequestedBy === 'doctor') return '医生已发起解除绑定，您同意后该医生将无法继续查看您的健康档案。'
  if (binding.status === 'pending_unbind') return '您已发起解除绑定，等待医生确认后该医生将无法继续查看您的健康档案。'
  return '医生仅可在授权有效期内查看您的健康档案，解除绑定后将无法继续访问。'
}

function renderBindingActions(
  binding: BoundDoctor,
  busyKey: string | null,
  actionKey: (action: BusyAction) => string,
  onAction: (binding: BoundDoctor, action: BusyAction) => void,
) {
  if (binding.status === 'pending_confirmation' || binding.status === 'rejected') return null
  if (binding.status === 'pending_unbind' && binding.unbindRequestedBy === 'doctor') {
    return (
      <div style={styles.pendingUnbindActions}>
        <button
          style={{ ...styles.unbindBtn, ...styles.pendingUnbindBtn }}
          onClick={() => onAction(binding, 'confirm-unbind')}
          disabled={busyKey === actionKey('confirm-unbind')}
        >
          {busyKey === actionKey('confirm-unbind') ? '处理中...' : '同意解绑'}
        </button>
        <button
          style={styles.cancelUnbindBtn}
          onClick={() => onAction(binding, 'reject-unbind')}
          disabled={busyKey === actionKey('reject-unbind')}
        >
          {busyKey === actionKey('reject-unbind') ? '处理中...' : '拒绝'}
        </button>
      </div>
    )
  }
  if (binding.status === 'pending_unbind') {
    return (
      <div style={styles.pendingUnbindActions}>
        <button style={{ ...styles.unbindBtn, ...styles.unbindBtnDisabled, ...styles.pendingUnbindBtn }} disabled>
          申请中
        </button>
        <button
          style={styles.cancelUnbindBtn}
          onClick={() => onAction(binding, 'cancel-unbind')}
          disabled={busyKey === actionKey('cancel-unbind')}
        >
          {busyKey === actionKey('cancel-unbind') ? '取消中...' : '取消申请'}
        </button>
      </div>
    )
  }
  return (
    <button
      style={styles.unbindBtn}
      onClick={() => onAction(binding, 'request-unbind')}
      disabled={busyKey === actionKey('request-unbind')}
    >
      {busyKey === actionKey('request-unbind') ? '发起中...' : '申请解绑'}
    </button>
  )
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={styles.infoRow}>
      <span style={styles.infoLabel}>{label}</span>
      <span style={styles.infoValue}>{value}</span>
    </div>
  )
}

function formatDateTime(value: string | null): string {
  if (!value) return '未确认'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date)
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    height: '100%',
    background: 'var(--color-bg)',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  nav: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 'calc(14px + var(--safe-area-top)) 18px 12px',
    borderBottom: '1px solid rgba(0,0,0,0.06)',
    flexShrink: 0,
  },
  backBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    border: 'none',
    background: 'transparent',
    color: 'var(--color-text)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
    cursor: 'pointer',
  },
  title: {
    fontSize: 18,
    fontWeight: 700,
    color: 'var(--color-text)',
    margin: 0,
  },
  navSpacer: {
    width: 38,
  },
  content: {
    flex: 1,
    overflowY: 'auto',
    padding: '24px 20px calc(24px + var(--safe-area-bottom))',
    overscrollBehaviorY: 'contain',
    WebkitOverflowScrolling: 'touch',
  },
  pullRefreshIndicator: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    color: 'var(--color-text-muted)',
    fontSize: 13,
    transition: `height ${MY_DOCTOR_REFRESH_COLLAPSE_TRANSITION_MS}ms ease, opacity ${MY_DOCTOR_REFRESH_COLLAPSE_TRANSITION_MS}ms ease`,
  },
  doctorList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 14,
  },
  doctorPanel: {
    borderRadius: 8,
    background: 'rgba(255,255,255,0.72)',
    border: '1px solid rgba(0,0,0,0.06)',
    padding: 18,
    boxShadow: '0 10px 28px rgba(32, 24, 20, 0.06)',
  },
  doctorTop: {
    display: 'flex',
    alignItems: 'center',
    gap: 14,
  },
  avatarWrap: {
    width: 62,
    height: 62,
    borderRadius: '50%',
    background: 'linear-gradient(135deg, #f6a66a 0%, #e76f51 100%)',
    color: '#fff',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    flexShrink: 0,
  },
  avatarImg: {
    width: '100%',
    height: '100%',
    objectFit: 'cover',
  },
  avatarText: {
    fontSize: 17,
    fontWeight: 700,
  },
  doctorText: {
    minWidth: 0,
    flex: 1,
  },
  nameRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
  },
  doctorName: {
    fontSize: 20,
    lineHeight: 1.25,
    fontWeight: 700,
    color: 'var(--color-text)',
    margin: 0,
  },
  statusPill: {
    borderRadius: 999,
    fontSize: 12,
    fontWeight: 700,
    padding: '4px 8px',
  },
  statusPillConfirmed: {
    background: 'rgba(49, 151, 102, 0.12)',
    color: '#2f855a',
  },
  statusPillPending: {
    background: 'rgba(212, 135, 108, 0.14)',
    color: '#b65f42',
  },
  statusPillRejected: {
    background: 'rgba(0,0,0,0.06)',
    color: 'var(--color-text-muted)',
  },
  doctorMeta: {
    fontSize: 14,
    lineHeight: 1.5,
    color: 'var(--color-text-muted)',
    margin: '7px 0 0',
  },
  detailList: {
    marginTop: 18,
    paddingTop: 14,
    borderTop: '1px solid rgba(0,0,0,0.06)',
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  },
  infoRow: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 16,
  },
  infoLabel: {
    fontSize: 13,
    lineHeight: 1.5,
    color: 'var(--color-text-muted)',
    flexShrink: 0,
  },
  infoValue: {
    fontSize: 14,
    lineHeight: 1.5,
    color: 'var(--color-text)',
    fontWeight: 600,
    textAlign: 'right',
    wordBreak: 'break-word',
  },
  scopeList: {
    display: 'flex',
    justifyContent: 'flex-end',
    flexWrap: 'wrap',
    gap: 6,
    minWidth: 0,
  },
  scopePill: {
    borderRadius: 999,
    background: 'rgba(49, 151, 102, 0.1)',
    color: '#2f855a',
    fontSize: 12,
    lineHeight: 1.4,
    fontWeight: 700,
    padding: '4px 8px',
  },
  authNotice: {
    margin: '16px 0 0',
    padding: '10px 12px',
    borderRadius: 8,
    background: 'rgba(0,0,0,0.035)',
    color: 'var(--color-text-muted)',
    fontSize: 13,
    lineHeight: 1.6,
  },
  unbindBtn: {
    width: '100%',
    height: 44,
    borderRadius: 8,
    border: '1px solid rgba(231, 111, 81, 0.28)',
    background: 'rgba(231, 111, 81, 0.08)',
    color: '#c05621',
    fontSize: 15,
    fontWeight: 700,
    marginTop: 18,
    cursor: 'pointer',
  },
  unbindBtnDisabled: {
    opacity: 0.65,
    cursor: 'not-allowed',
  },
  pendingUnbindActions: {
    display: 'grid',
    gridTemplateColumns: '1fr auto',
    alignItems: 'center',
    gap: 10,
    marginTop: 18,
  },
  pendingUnbindBtn: {
    marginTop: 0,
  },
  cancelUnbindBtn: {
    height: 36,
    borderRadius: 8,
    border: '1px solid rgba(0,0,0,0.08)',
    background: 'rgba(255,255,255,0.72)',
    color: 'var(--color-text-muted)',
    fontSize: 13,
    fontWeight: 700,
    padding: '0 12px',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  emptyState: {
    minHeight: 280,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    color: 'var(--color-text-muted)',
  },
  emptyIcon: {
    width: 72,
    height: 72,
    borderRadius: '50%',
    background: 'rgba(0,0,0,0.04)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  emptyTitle: {
    fontSize: 16,
    fontWeight: 600,
    color: 'var(--color-text)',
    margin: 0,
  },
  stateText: {
    textAlign: 'center',
    color: 'var(--color-text-muted)',
    fontSize: 14,
    paddingTop: 80,
  },
  errorText: {
    color: '#c05621',
    fontSize: 13,
    lineHeight: 1.5,
    margin: '16px 0 0',
  },
}
