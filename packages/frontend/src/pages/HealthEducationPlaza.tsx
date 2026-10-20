import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { api } from '../services/api.js'
import A2uiMarkdown from '../lib/a2ui/markdown.js'
import { scrollElementToTop } from '../utils/scroll.js'
import { useStore } from '../stores/index.js'
import {
  formatHealthEducationDoctorMeta,
  getHealthEducationCardPreview,
  getHealthEducationDetailMarkdown,
  mergeHealthEducationItemForDetail,
  mergeHealthEducationItemForList,
} from './healthEducationPresentation.js'
import {
  isFeatureEnabled,
  type ApiResponse,
  type HealthEducationInteractionResponse,
  type HealthEducationItemWithStats,
  type HealthEducationListResponse,
  type HealthEducationScope,
  type HealthEducationViewResponse,
} from '@health-agent/shared'

type Reaction = 'like' | 'dislike'
type ScopeOption = [HealthEducationScope, string]

function formatDateTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value.slice(0, 16)
  const now = new Date()
  const sameYear = date.getFullYear() === now.getFullYear()
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    ...(sameYear ? {} : { year: 'numeric' }),
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

function doctorMeta(item: HealthEducationItemWithStats): string {
  return [formatHealthEducationDoctorMeta(item.doctor), formatDateTime(item.publishedAt)].filter(Boolean).join(' · ')
}

function listDoctorMeta(item: HealthEducationItemWithStats): string {
  return formatHealthEducationDoctorMeta(item.doctor)
}

function avatarText(name: string): string {
  return Array.from(name).slice(-2).join('')
}

function createViewId(itemId: string): string {
  const random = Math.random().toString(36).slice(2, 10)
  return `health-education-view:${itemId}:${Date.now()}:${random}`
}

function ContentBlocks({ content, compact = false }: { content: string; compact?: boolean }) {
  return (
    <div
      className={`markdown-body cx-education-markdown${compact ? ' cx-education-markdown-compact' : ''}`}
      style={compact ? styles.compactContent : styles.richContent}
    >
      <A2uiMarkdown content={content} />
    </div>
  )
}

function ListCardPreview({ item }: { item: HealthEducationItemWithStats }) {
  const preview = getHealthEducationCardPreview(item)
  return (
    <>
      {preview.previewText && <p style={styles.previewText}>{preview.previewText}</p>}
      {preview.thumbnailUrl && (
        <img
          src={preview.thumbnailUrl}
          alt=""
          style={preview.thumbnailVariant === 'poster' ? styles.posterThumb : styles.bubbleThumb}
          loading="lazy"
        />
      )}
    </>
  )
}

function Icon({ type, filled }: { type: 'like' | 'dislike' | 'favorite'; filled: boolean }) {
  const stroke = type === 'dislike'
    ? filled ? '#6B7280' : 'currentColor'
    : filled ? '#D4876C' : 'currentColor'
  const fill = filled ? stroke : 'none'
  if (type === 'favorite') {
    return (
      <svg width="18" height="18" viewBox="0 0 24 24" fill={fill} stroke={stroke} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M19 21l-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
      </svg>
    )
  }
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill={fill}
      stroke={stroke}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={type === 'dislike' ? { transform: 'rotate(180deg)' } : undefined}
    >
      <path d="M7 10v11" />
      <path d="M15 5.4 14 10h5.2a2 2 0 0 1 1.9 2.6l-2 6A2 2 0 0 1 17.2 20H9a2 2 0 0 1-2-2v-7.4a2 2 0 0 1 .6-1.4l5.7-5.7a1.4 1.4 0 0 1 2.4 1.3z" />
    </svg>
  )
}

export default function HealthEducationPlaza() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const returnSessionId = searchParams.get('returnSessionId')
  const returnToChatPath = returnSessionId ? `/chat/${returnSessionId}` : '/chat'
  const featureSnapshot = useStore((s) => s.features)
  const showMyDoctorScope = isFeatureEnabled(featureSnapshot, 'myDoctorEntry')
  const [scope, setScope] = useState<HealthEducationScope>('all')
  const effectiveScope: HealthEducationScope = showMyDoctorScope ? scope : 'all'
  const [items, setItems] = useState<HealthEducationItemWithStats[]>([])
  const [boundDoctorIds, setBoundDoctorIds] = useState<string[]>([])
  const [nextCursor, setNextCursor] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [detailLoading, setDetailLoading] = useState(false)
  const [error, setError] = useState('')
  const [selectedItem, setSelectedItem] = useState<HealthEducationItemWithStats | null>(null)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [popKey, setPopKey] = useState<string | null>(null)
  const [toast, setToast] = useState('')
  const [scopeMenuOpen, setScopeMenuOpen] = useState(false)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const scopeMenuRef = useRef<HTMLDivElement | null>(null)
  const scrollTopBeforeDetail = useRef(0)

  useEffect(() => {
    if (!showMyDoctorScope && scope === 'my_doctor') {
      setScope('all')
    }
  }, [scope, showMyDoctorScope])

  useEffect(() => {
    void loadItems(effectiveScope, null, false)
  }, [effectiveScope])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(''), 2000)
    return () => window.clearTimeout(timer)
  }, [toast])

  useEffect(() => {
    if (!scopeMenuOpen) return
    function handlePointerDown(event: PointerEvent) {
      if (!scopeMenuRef.current?.contains(event.target as Node)) {
        setScopeMenuOpen(false)
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setScopeMenuOpen(false)
    }
    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [scopeMenuOpen])

  const emptyText = useMemo(() => {
    if (effectiveScope === 'my_doctor' && boundDoctorIds.length === 0) return '暂无内容'
    return effectiveScope === 'my_doctor' ? '你的医生暂未发布医生说内容' : '暂无医生说内容'
  }, [boundDoctorIds.length, effectiveScope])

  const scopeLabel = effectiveScope === 'my_doctor' ? '我的医生' : '全部医生'
  const scopeOptions: ScopeOption[] = showMyDoctorScope
    ? [['all', '全部医生'], ['my_doctor', '我的医生']]
    : [['all', '全部医生']]

  async function loadItems(nextScope: HealthEducationScope, cursor: number | null, append: boolean) {
    if (append) setLoadingMore(true)
    else setLoading(true)
    setError('')
    try {
      const query = new URLSearchParams({ scope: nextScope, limit: '20' })
      if (cursor != null) query.set('cursor', String(cursor))
      const res = await api.get<ApiResponse<HealthEducationListResponse>>(`/health-education/items?${query.toString()}`)
      const nextItems = res.data?.items ?? []
      setItems((prev) => append ? [...prev, ...nextItems] : nextItems)
      setBoundDoctorIds(res.data?.boundDoctorIds ?? (res.data?.boundDoctorId ? [res.data.boundDoctorId] : []))
      setNextCursor(res.data?.nextCursor ?? null)
    } catch (err: any) {
      setError(err.message || '加载医生说内容失败')
    } finally {
      if (append) setLoadingMore(false)
      else setLoading(false)
    }
  }

  function updateItem(item: HealthEducationItemWithStats) {
    setItems((prev) => prev.map((candidate) => (
      candidate.id === item.id ? mergeHealthEducationItemForList(candidate, item) : candidate
    )))
    setSelectedItem((prev) => (prev?.id === item.id ? mergeHealthEducationItemForDetail(prev, item) : prev))
  }

  function updateItemViewStats(stats: HealthEducationViewResponse) {
    setItems((prev) => prev.map((candidate) => (
      candidate.id === stats.itemId
        ? { ...candidate, pvCount: stats.pvCount, uvCount: stats.uvCount }
        : candidate
    )))
    setSelectedItem((prev) => {
      if (!prev || prev.id !== stats.itemId) return prev
      return { ...prev, pvCount: stats.pvCount, uvCount: stats.uvCount }
    })
  }

  async function recordView(itemId: string) {
    try {
      const res = await api.post<ApiResponse<HealthEducationViewResponse>>(
        `/health-education/items/${itemId}/view`,
        { viewId: createViewId(itemId), source: 'plaza' },
      )
      if (res.data) updateItemViewStats(res.data)
    } catch (err) {
      console.warn('[health-education] view record failed', err)
    }
  }

  function triggerPop(key: string) {
    setPopKey(key)
    window.setTimeout(() => setPopKey((current) => (current === key ? null : current)), 150)
  }

  async function setReaction(item: HealthEducationItemWithStats, reaction: Reaction) {
    const nextReaction = item.userReaction === reaction ? null : reaction
    const key = `${item.id}:${reaction}`
    triggerPop(key)
    setBusyKey(`${item.id}:reaction`)
    setError('')
    try {
      const res = await api.post<ApiResponse<HealthEducationInteractionResponse>>(
        `/health-education/items/${item.id}/reaction`,
        { reaction: nextReaction },
      )
      if (res.data?.item) updateItem(res.data.item)
    } catch (err: any) {
      setError(err.message || '操作失败')
    } finally {
      setBusyKey(null)
    }
  }

  async function toggleFavorite(item: HealthEducationItemWithStats) {
    const nextFavorite = !item.isFavorited
    const key = `${item.id}:favorite`
    triggerPop(key)
    setBusyKey(key)
    setError('')
    try {
      const res = await api.post<ApiResponse<HealthEducationInteractionResponse>>(
        `/health-education/items/${item.id}/favorite`,
        { favorite: nextFavorite },
      )
      if (res.data?.item) updateItem(res.data.item)
      setToast(nextFavorite ? '已收藏至我的材料' : '已取消收藏')
    } catch (err: any) {
      setError(err.message || '收藏失败')
    } finally {
      setBusyKey(null)
    }
  }

  async function openDetail(item: HealthEducationItemWithStats) {
    scrollTopBeforeDetail.current = scrollRef.current?.scrollTop ?? 0
    setSelectedItem(mergeHealthEducationItemForDetail(item, { ...item, content: '', imageUrls: [], coverUrl: null }))
    setDetailLoading(true)
    setError('')
    requestAnimationFrame(() => {
      if (scrollRef.current) scrollRef.current.scrollTop = 0
    })
    try {
      const res = await api.get<ApiResponse<HealthEducationItemWithStats>>(`/health-education/items/${item.id}`)
      if (res.data) {
        updateItem(res.data)
        void recordView(res.data.id)
      }
    } catch (err: any) {
      setError(err.message || '加载医生说详情失败')
    } finally {
      setDetailLoading(false)
    }
  }

  function closeDetail() {
    setSelectedItem(null)
    requestAnimationFrame(() => {
      if (scrollRef.current) scrollRef.current.scrollTop = scrollTopBeforeDetail.current
    })
  }

  function handleTopTap() {
    scrollElementToTop(scrollRef.current)
  }

  function renderActions(item: HealthEducationItemWithStats, placement: 'bubble' | 'detail') {
    const reactionBusy = busyKey === `${item.id}:reaction`
    const favoriteBusy = busyKey === `${item.id}:favorite`
    const actionStyle = placement === 'detail' ? styles.detailActionBtn : styles.actionBtn
    return (
      <div style={placement === 'detail' ? styles.detailActionBarInner : styles.actions}>
        <button
          type="button"
          className={popKey === `${item.id}:like` ? 'cx-education-action-pop' : undefined}
          style={{
            ...actionStyle,
            ...(item.userReaction === 'like' ? styles.likeActive : {}),
          }}
          disabled={reactionBusy}
          onClick={(event) => {
            event.stopPropagation()
            void setReaction(item, 'like')
          }}
        >
          <Icon type="like" filled={item.userReaction === 'like'} />
          <span>{item.likeCount}</span>
        </button>
        <button
          type="button"
          className={popKey === `${item.id}:dislike` ? 'cx-education-action-pop' : undefined}
          style={{
            ...actionStyle,
            ...(item.userReaction === 'dislike' ? styles.dislikeActive : {}),
          }}
          disabled={reactionBusy}
          onClick={(event) => {
            event.stopPropagation()
            void setReaction(item, 'dislike')
          }}
        >
          <Icon type="dislike" filled={item.userReaction === 'dislike'} />
          <span>{item.dislikeCount}</span>
        </button>
        <button
          type="button"
          className={popKey === `${item.id}:favorite` ? 'cx-education-action-pop' : undefined}
          style={{
            ...actionStyle,
            ...(item.isFavorited ? styles.favoriteActive : {}),
          }}
          disabled={favoriteBusy}
          onClick={(event) => {
            event.stopPropagation()
            void toggleFavorite(item)
          }}
        >
          <Icon type="favorite" filled={item.isFavorited} />
          <span>{item.favoriteCount}</span>
        </button>
      </div>
    )
  }

  return (
    <div style={styles.page}>
      <button
        type="button"
        aria-label="回到顶部"
        style={styles.topTapTarget}
        onClick={handleTopTap}
      />
      <div style={styles.nav}>
        <button style={styles.backBtn} onClick={() => selectedItem ? closeDetail() : navigate(returnToChatPath)}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
          <span>{selectedItem ? '返回广场' : 'AI对话'}</span>
        </button>
      </div>

      <main ref={scrollRef} style={styles.content}>
        {selectedItem ? (
          <article style={styles.detail}>
            {detailLoading && <div style={styles.detailLoading}>加载详情中...</div>}
            {error && <div style={styles.error}>{error}</div>}
            <div style={styles.detailDoctorLine}>
              {selectedItem.doctor.avatarUrl ? (
                <img src={selectedItem.doctor.avatarUrl} alt="" style={styles.detailAvatarImage} />
              ) : (
                <div style={styles.detailAvatar}>{avatarText(selectedItem.doctor.name)}</div>
              )}
              <div style={styles.doctorText}>
                <div style={styles.doctorName}>{selectedItem.doctor.name}</div>
                <div style={styles.doctorMeta}>{doctorMeta(selectedItem)}</div>
              </div>
            </div>
            <h1 style={styles.detailTitle}>{selectedItem.title}</h1>
            <ContentBlocks content={getHealthEducationDetailMarkdown(selectedItem)} />
            <div style={styles.tags}>
              {[
                ...(selectedItem.tags ?? []),
                selectedItem.doctor.department,
                selectedItem.doctor.title,
              ].filter(Boolean).map((tag) => (
                <span key={tag} style={styles.tag}>{tag}</span>
              ))}
            </div>
            {renderActions(selectedItem, 'detail')}
          </article>
        ) : (
          <>
            <div style={styles.headerRow}>
              <div>
                <h1 style={styles.title}>医生说</h1>
                <p style={styles.subtitle}>查看医生发布的健康科普和复诊准备内容</p>
              </div>
              <div ref={scopeMenuRef} style={styles.scopeDropdown}>
                <button
                  type="button"
                  style={styles.scopeTrigger}
                  aria-haspopup="listbox"
                  aria-expanded={scopeMenuOpen}
                  onClick={() => setScopeMenuOpen((open) => !open)}
                >
                  <span>{scopeLabel}</span>
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 12 12"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    style={{
                      ...styles.scopeChevron,
                      ...(scopeMenuOpen ? styles.scopeChevronOpen : {}),
                    }}
                  >
                    <polyline points="3 4.5 6 7.5 9 4.5" />
                  </svg>
                </button>
                {scopeMenuOpen && (
                  <div style={styles.scopeMenu} role="listbox" aria-label="医生说范围">
                    {scopeOptions.map(([value, label]) => (
                      <button
                        key={value}
                        type="button"
                        role="option"
                        aria-selected={effectiveScope === value}
                        style={{
                          ...styles.scopeOption,
                          ...(effectiveScope === value ? styles.scopeOptionActive : {}),
                        }}
                        onClick={() => {
                          setScope(value)
                          setScopeMenuOpen(false)
                        }}
                      >
                        <span>{label}</span>
                        {effectiveScope === value && (
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {error && <div style={styles.error}>{error}</div>}
            {loading ? (
              <div style={styles.empty}>加载中...</div>
            ) : items.length === 0 ? (
              <div style={styles.empty}>{emptyText}</div>
            ) : (
              <div style={styles.messageList}>
                {items.map((item) => (
                  <article key={item.id} style={styles.messageItem} onClick={() => void openDetail(item)}>
                    {item.doctor.avatarUrl ? (
                      <img src={item.doctor.avatarUrl} alt="" style={styles.avatarImage} />
                    ) : (
                      <div style={styles.avatar}>{avatarText(item.doctor.name)}</div>
                    )}
                    <div style={styles.messageBody}>
                      <div style={styles.messageHeader}>
                        <span style={styles.doctorName}>{item.doctor.name}</span>
                        {listDoctorMeta(item) && <span style={styles.doctorMeta}>{listDoctorMeta(item)}</span>}
                      </div>
                      <div className="cx-education-bubble" style={styles.bubble}>
                        {boundDoctorIds.includes(item.doctor.id) && <span style={styles.myDoctorBadge}>我的医生</span>}
                        <h2 style={styles.bubbleTitle}>{item.title}</h2>
                        <ListCardPreview item={item} />
                      </div>
                      <div style={styles.messageTime}>{formatDateTime(item.publishedAt)}</div>
                      {renderActions(item, 'bubble')}
                    </div>
                  </article>
                ))}
                {nextCursor != null && (
                  <button
                    type="button"
                    style={{
                      ...styles.loadMoreBtn,
                      ...(loadingMore ? styles.loadMoreBtnDisabled : {}),
                    }}
                    disabled={loadingMore}
                    onClick={() => void loadItems(scope, nextCursor, true)}
                  >
                    {loadingMore ? '加载中...' : '加载更多'}
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </main>

      {toast && <div style={styles.toast}>{toast}</div>}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    height: '100%',
    background: 'var(--color-bg)',
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
    position: 'relative',
  },
  nav: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 20,
    padding: 'calc(14px + var(--safe-area-top)) 0 0 16px',
    pointerEvents: 'none',
  },
  topTapTarget: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 'calc(64px + var(--safe-area-top))',
    zIndex: 19,
    border: 'none',
    padding: 0,
    margin: 0,
    background: 'transparent',
    cursor: 'pointer',
    WebkitTapHighlightColor: 'transparent',
  },
  backBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    border: 'none',
    borderRadius: 999,
    background: 'rgba(255, 255, 255, 0.72)',
    backdropFilter: 'blur(12px)',
    WebkitBackdropFilter: 'blur(12px)',
    boxShadow: '0 2px 8px rgba(0, 0, 0, 0.06)',
    color: 'var(--color-text)',
    fontSize: 15,
    fontWeight: 700,
    minHeight: 40,
    padding: '0 13px 0 10px',
    cursor: 'pointer',
    pointerEvents: 'auto',
    WebkitTapHighlightColor: 'transparent',
  },
  content: {
    flex: 1,
    overflowY: 'auto',
    padding: '0 16px calc(24px + var(--safe-area-bottom))',
  },
  headerRow: {
    position: 'relative',
    paddingTop: 'calc(78px + var(--safe-area-top))',
  },
  title: {
    fontSize: 24,
    fontWeight: 700,
    color: 'var(--color-text)',
    margin: '0 0 4px',
  },
  subtitle: {
    fontSize: 14,
    color: 'var(--color-text-muted)',
    margin: '0 116px 16px 0',
    lineHeight: 1.5,
  },
  scopeDropdown: {
    position: 'sticky',
    top: 0,
    float: 'right',
    zIndex: 3,
    marginTop: -4,
  },
  scopeTrigger: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    minWidth: 94,
    border: '1px solid rgba(212, 135, 108, 0.20)',
    borderRadius: 999,
    background: 'rgba(255,255,255,0.94)',
    color: 'var(--color-primary)',
    boxShadow: '0 6px 18px rgba(80, 55, 40, 0.08)',
    padding: '8px 12px',
    backdropFilter: 'blur(12px)',
    fontSize: 12,
    fontWeight: 700,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    WebkitTapHighlightColor: 'transparent',
  },
  scopeChevron: {
    flexShrink: 0,
    transition: 'transform 160ms ease',
  },
  scopeChevronOpen: {
    transform: 'rotate(180deg)',
  },
  scopeMenu: {
    position: 'absolute',
    top: 'calc(100% + 8px)',
    right: 0,
    width: 118,
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    border: '1px solid rgba(212, 135, 108, 0.20)',
    borderRadius: 12,
    background: '#fff',
    boxShadow: '0 6px 18px rgba(80, 55, 40, 0.08)',
    padding: 4,
    backdropFilter: 'blur(12px)',
  },
  scopeOption: {
    minHeight: 34,
    border: 'none',
    borderRadius: 8,
    background: 'transparent',
    color: 'var(--color-text-secondary)',
    fontSize: 12,
    fontWeight: 700,
    padding: '8px 9px',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    whiteSpace: 'nowrap',
    textAlign: 'left',
  },
  scopeOptionActive: {
    background: 'var(--color-primary-bg)',
    color: 'var(--color-primary)',
  },
  messageList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 18,
    clear: 'both',
  },
  messageItem: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 10,
    cursor: 'pointer',
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: '50%',
    background: 'linear-gradient(135deg, #f6a66a 0%, #e76f51 100%)',
    color: '#fff',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 14,
    fontWeight: 700,
    flexShrink: 0,
  },
  avatarImage: {
    width: 44,
    height: 44,
    borderRadius: '50%',
    objectFit: 'cover',
    flexShrink: 0,
  },
  messageBody: {
    minWidth: 0,
    flex: 1,
  },
  messageHeader: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 6,
    flexWrap: 'wrap',
    marginBottom: 6,
  },
  doctorName: {
    fontSize: 14,
    fontWeight: 700,
    color: 'var(--color-text)',
  },
  doctorMeta: {
    fontSize: 12,
    color: 'var(--color-text-muted)',
    lineHeight: 1.4,
  },
  doctorText: {
    minWidth: 0,
  },
  bubble: {
    position: 'relative',
    background: 'var(--color-surface)',
    border: '1px solid rgba(0,0,0,0.04)',
    borderRadius: '0 14px 14px 14px',
    padding: 14,
    boxShadow: '0 8px 22px rgba(90, 63, 48, 0.06)',
  },
  myDoctorBadge: {
    display: 'inline-flex',
    width: 'fit-content',
    borderRadius: 999,
    background: 'rgba(49, 151, 102, 0.1)',
    color: '#2f855a',
    fontSize: 12,
    fontWeight: 700,
    padding: '4px 8px',
    marginBottom: 8,
  },
  bubbleTitle: {
    fontSize: 17,
    lineHeight: 1.35,
    color: 'var(--color-text)',
    margin: '0 0 8px',
    fontWeight: 700,
  },
  bubbleThumb: {
    width: 128,
    height: 82,
    borderRadius: 8,
    objectFit: 'cover',
    display: 'block',
    marginTop: 10,
  },
  posterThumb: {
    width: '100%',
    maxHeight: 260,
    borderRadius: 10,
    objectFit: 'contain',
    display: 'block',
    marginTop: 10,
    background: 'rgba(0,0,0,0.03)',
  },
  previewText: {
    margin: 0,
    color: 'var(--color-text-secondary)',
    fontSize: 14,
    lineHeight: 1.65,
    display: '-webkit-box',
    WebkitLineClamp: 3,
    WebkitBoxOrient: 'vertical' as const,
    overflow: 'hidden',
  },
  messageTime: {
    fontSize: 11,
    color: 'var(--color-text-muted)',
    margin: '6px 0 8px',
  },
  compactContent: {
    display: '-webkit-box',
    WebkitLineClamp: 3,
    WebkitBoxOrient: 'vertical' as const,
    overflow: 'hidden',
  },
  richContent: {
    marginTop: 14,
    fontSize: 15,
    color: 'var(--color-text)',
    lineHeight: 1.8,
  },
  actions: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    marginTop: 8,
  },
  actionBtn: {
    border: 'none',
    background: 'transparent',
    color: 'var(--color-text-muted)',
    fontSize: 12,
    fontWeight: 700,
    padding: '4px 2px',
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    WebkitTapHighlightColor: 'transparent',
  },
  likeActive: {
    color: 'var(--color-primary)',
  },
  dislikeActive: {
    color: '#6B7280',
  },
  favoriteActive: {
    color: 'var(--color-primary)',
  },
  detail: {
    maxWidth: 430,
    margin: '0 auto',
    paddingTop: 'calc(78px + var(--safe-area-top))',
  },
  detailLoading: {
    fontSize: 13,
    color: 'var(--color-text-muted)',
    marginBottom: 10,
  },
  detailDoctorLine: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    marginBottom: 16,
  },
  detailAvatar: {
    width: 44,
    height: 44,
    borderRadius: '50%',
    background: 'linear-gradient(135deg, #f6a66a 0%, #e76f51 100%)',
    color: '#fff',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 14,
    fontWeight: 700,
    flexShrink: 0,
  },
  detailAvatarImage: {
    width: 44,
    height: 44,
    borderRadius: '50%',
    objectFit: 'cover',
    flexShrink: 0,
  },
  detailTitle: {
    fontSize: 22,
    lineHeight: 1.35,
    color: 'var(--color-text)',
    margin: '0 0 14px',
  },
  tags: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 18,
  },
  tag: {
    borderRadius: 999,
    background: 'var(--color-primary-bg)',
    color: 'var(--color-primary)',
    fontSize: 12,
    fontWeight: 700,
    padding: '6px 10px',
  },
  detailActionBarInner: {
    margin: '0 0 16px',
    display: 'grid',
    gridTemplateColumns: '1fr 1fr 1fr',
    gap: 10,
  },
  detailActionBtn: {
    border: '1px solid rgba(0,0,0,0.06)',
    borderRadius: 14,
    background: '#fff',
    color: 'var(--color-text-secondary)',
    fontSize: 13,
    fontWeight: 700,
    padding: '10px 8px',
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    WebkitTapHighlightColor: 'transparent',
  },
  toast: {
    position: 'absolute',
    left: '50%',
    bottom: 'calc(84px + var(--safe-area-bottom))',
    transform: 'translateX(-50%)',
    background: 'rgba(31, 41, 55, 0.92)',
    color: '#fff',
    borderRadius: 999,
    padding: '10px 16px',
    fontSize: 13,
    zIndex: 20,
    whiteSpace: 'nowrap',
    boxShadow: '0 8px 22px rgba(0,0,0,0.18)',
  },
  empty: {
    textAlign: 'center',
    color: 'var(--color-text-muted)',
    fontSize: 14,
    padding: '56px 0',
    clear: 'both',
  },
  loadMoreBtn: {
    border: '1px solid rgba(212, 135, 108, 0.24)',
    borderRadius: 12,
    background: 'var(--color-surface)',
    color: 'var(--color-primary)',
    fontSize: 14,
    fontWeight: 700,
    padding: '11px 12px',
    cursor: 'pointer',
    margin: '4px 0 8px 54px',
  },
  loadMoreBtnDisabled: {
    opacity: 0.6,
    cursor: 'default',
  },
  error: {
    color: '#c05621',
    background: 'rgba(231, 111, 81, 0.08)',
    borderRadius: 8,
    padding: '10px 12px',
    fontSize: 13,
    marginBottom: 12,
    clear: 'both',
  },
}
