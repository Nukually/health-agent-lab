import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import type { SessionListItem } from '@health-agent/shared'
import { useStore } from '../../stores/index.js'

const defaultFemaleAvatarUrl = new URL('../../assets/icons/default-avatar.svg', import.meta.url).href
const defaultMaleAvatarUrl = new URL('../../assets/icons/default-avatar.svg', import.meta.url).href
const SESSION_LIST_REVALIDATE_MS = 15_000

interface Props {
  currentSessionId: string | null
  onSelectSession: (sessionId: string) => void
  onViewMedicalRecord: () => void
  onViewMedicalDocuments: () => void
  onViewMaterials: () => void
  onViewCheckIns: () => void
  onViewScheduledTasks: () => void
  onViewDoctor: () => void
  onViewMaterialsAdmin?: () => void
  onOpenNativeDebug?: () => void
  onClose: () => void
  onDeleteSession: (sessionId: string) => void
  showDoctorEntry?: boolean
  showCheckInEntry?: boolean
  showScheduledTaskEntry?: boolean
  showMaterialsAdminEntry?: boolean
  showLlmContextDashboardEntry?: boolean
  onOpenDebug?: () => void
  closing?: boolean
}

interface SidebarUserLike {
  nickname?: string | null
  gender?: string | null
}

function toDateKey(d: Date): string {
  const m = d.getMonth() + 1
  const day = d.getDate()
  return `${d.getFullYear()}/${m < 10 ? '0' + m : m}/${day < 10 ? '0' + day : day}`
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

export function formatSidebarSessionTimestamp(updatedAt: string, now = new Date()): string {
  const date = new Date(updatedAt)
  const today = toDateKey(now)
  const yesterday = toDateKey(new Date(now.getTime() - 86400000))
  const key = toDateKey(date)

  if (key === today) return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
  if (key === yesterday) return '昨天'
  return `${pad2(date.getMonth() + 1)}/${pad2(date.getDate())}`
}

export function getSidebarUserDisplayName(user: SidebarUserLike | null): string {
  const nickname = user?.nickname?.trim()
  return nickname || 'Health Agent Lab用户'
}

export function getSidebarDisplayUser(
  user: SidebarUserLike | null,
  userProfile: SidebarUserLike | null,
): SidebarUserLike | null {
  const profileNickname = userProfile?.nickname?.trim()
  const profileGender = userProfile?.gender
  if (!profileNickname && !profileGender) return user
  return {
    ...user,
    ...(profileNickname ? { nickname: profileNickname } : {}),
    ...(profileGender ? { gender: profileGender } : {}),
  }
}

export function getSidebarDefaultAvatarIconName(gender?: string | null): string {
  return gender === '男' ? 'default-avatar-male' : 'default-avatar-female'
}

function getSidebarDefaultAvatarIconUrl(gender?: string | null): string {
  return getSidebarDefaultAvatarIconName(gender) === 'default-avatar-male'
    ? defaultMaleAvatarUrl
    : defaultFemaleAvatarUrl
}

function ChevronIcon({ color = 'currentColor', size = 18 }: { color?: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  )
}

function TrashIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  )
}

function ProfileAvatar({ src, gender }: { src?: string | null; gender?: string | null }) {
  if (src) {
    return <img src={src} alt="头像" style={styles.avatarImage} />
  }

  return <img src={getSidebarDefaultAvatarIconUrl(gender)} alt="默认头像" style={styles.avatarImage} />
}

function FolderIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H10l2 2.5h6.5A2.5 2.5 0 0 1 21 10v7.5A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5Z" />
    </svg>
  )
}

function BellIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" />
      <path d="M10 21h4" />
    </svg>
  )
}

function CalendarIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="4" y="5" width="16" height="15" rx="2" />
      <path d="M8 3v4" />
      <path d="M16 3v4" />
      <path d="M4 10h16" />
      <path d="m9 15 2 2 4-4" />
    </svg>
  )
}

function StarIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m12 3 2.9 5.9 6.5.9-4.7 4.6 1.1 6.4L12 17.8l-5.8 3 1.1-6.4-4.7-4.6 6.5-.9Z" />
    </svg>
  )
}

function DoctorIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="7" r="3" />
      <path d="M6.5 20a5.5 5.5 0 0 1 11 0" />
      <path d="M12 14v4" />
      <path d="M10 16h4" />
    </svg>
  )
}

export default function HistoryPanel({
  currentSessionId,
  onSelectSession,
  onViewMedicalRecord,
  onViewMedicalDocuments,
  onViewMaterials,
  onViewCheckIns,
  onViewScheduledTasks,
  onViewDoctor,
  onViewMaterialsAdmin,
  onOpenNativeDebug,
  onClose,
  onDeleteSession,
  showDoctorEntry = true,
  showCheckInEntry = true,
  showScheduledTaskEntry = true,
  showMaterialsAdminEntry,
  showLlmContextDashboardEntry,
  onOpenDebug,
  closing = false,
}: Props) {
  const sessions = useStore((s) => s.sessions)
  const sessionsLoaded = useStore((s) => s.sessionsLoaded)
  const loadingSessions = useStore((s) => s.loadingSessions)
  const loadingMoreSessions = useStore((s) => s.loadingMoreSessions)
  const sessionsHasMore = useStore((s) => s.sessionsHasMore)
  const authEpoch = useStore((s) => s.authEpoch)
  const user = useStore((s) => s.user)
  const userProfile = useStore((s) => s.userProfile)
  const loadSessions = useStore((s) => s.loadSessions)
  const loadMoreSessions = useStore((s) => s.loadMoreSessions)
  const removeSession = useStore((s) => s.removeSession)

  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)

  const ANIM_MS = 420
  const requestClose = () => onClose()

  useEffect(() => {
    // 微信 WebView 会复用同一页内存/GET 结果；侧栏每次打开都强制校验当前账号的真实会话列表。
    loadSessions(true)
  }, [loadSessions, authEpoch])

  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return undefined

    const refreshSessions = () => {
      if (document.visibilityState === 'hidden') return
      void loadSessions(true)
    }
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') refreshSessions()
    }
    const handleFocus = () => refreshSessions()
    const interval = window.setInterval(refreshSessions, SESSION_LIST_REVALIDATE_MS)

    document.addEventListener('visibilitychange', handleVisibilityChange)
    window.addEventListener('focus', handleFocus)

    return () => {
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      window.removeEventListener('focus', handleFocus)
    }
  }, [loadSessions, authEpoch])

  const showInitialLoading = loadingSessions && !sessionsLoaded
  const displayUser = getSidebarDisplayUser(user, userProfile)

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    if (!sessionsHasMore || loadingMoreSessions || loadingSessions) return
    const el = e.currentTarget
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 100) {
      loadMoreSessions()
    }
  }

  const renderCommonItem = (
    key: string,
    label: string,
    icon: React.ReactNode,
    onClick: () => void,
  ) => (
    <button key={key} style={styles.commonItem} onClick={onClick}>
      <span style={styles.commonIcon}>{icon}</span>
      <span style={styles.commonText}>{label}</span>
      <ChevronIcon color="var(--color-text-muted)" />
    </button>
  )

  const commonItems = [
    renderCommonItem('medical-documents', '健康档案', <FolderIcon />, onViewMedicalDocuments),
    showScheduledTaskEntry ? renderCommonItem('scheduled-tasks', '提醒', <BellIcon />, onViewScheduledTasks) : null,
    showCheckInEntry ? renderCommonItem('check-ins', '打卡记录', <CalendarIcon />, onViewCheckIns) : null,
    showDoctorEntry ? renderCommonItem('my-doctor', '我的医生', <DoctorIcon />, onViewDoctor) : null,
    renderCommonItem('materials', '收藏', <StarIcon />, onViewMaterials),
  ].filter(Boolean)

  const renderSession = (s: SessionListItem) => {
    const isActive = s.id === currentSessionId
    return (
      <div
        key={s.id}
        style={{
          ...styles.sessionItem,
          ...(isActive ? styles.sessionItemActive : {}),
        }}
      >
        <button
          type="button"
          style={styles.sessionItemContent}
          onClick={() => onSelectSession(s.id)}
        >
          <span style={styles.sessionTitle}>{s.title || '未命名对话'}</span>
          <span style={styles.sessionMeta}>{s.messageCount} 条消息</span>
        </button>
        <div style={styles.sessionTrailing}>
          <span style={styles.sessionTime}>{formatSidebarSessionTimestamp(s.updatedAt)}</span>
          <button
            style={styles.deleteBtn}
            onClick={(e) => {
              e.stopPropagation()
              setConfirmDeleteId(s.id)
            }}
            title="删除对话"
            aria-label="删除对话"
          >
            <TrashIcon />
          </button>
        </div>
      </div>
    )
  }

  return (
    <div
      style={{
        ...styles.overlay,
        animation: closing
          ? `cxDrawerBackdropOut ${ANIM_MS}ms cubic-bezier(0.32, 0.72, 0, 1) forwards`
          : `cxDrawerBackdropIn ${ANIM_MS}ms cubic-bezier(0.22, 1, 0.36, 1)`,
      }}
      onClick={requestClose}
    >
      <div
        style={{
          ...styles.panel,
          animation: closing
            ? `cxDrawerPanelOut ${ANIM_MS}ms cubic-bezier(0.32, 0.72, 0, 1) forwards`
            : `cxDrawerPanelIn ${ANIM_MS}ms cubic-bezier(0.22, 1, 0.36, 1)`,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={styles.header}>
          <h2 style={styles.headerTitle}>Health Agent Lab</h2>
          <button style={styles.closeBtn} onClick={requestClose} aria-label="关闭侧边栏">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <button style={styles.profileCard} onClick={onViewMedicalRecord}>
          <ProfileAvatar src={user?.avatarUrl} gender={displayUser?.gender} />
          <span style={styles.profileName}>{getSidebarUserDisplayName(displayUser)}</span>
          <ChevronIcon color="var(--color-text-muted)" size={22} />
        </button>

        <nav style={styles.commonCard}>{commonItems}</nav>

        {(showMaterialsAdminEntry || onOpenNativeDebug || showLlmContextDashboardEntry) && (
          <div style={styles.utilityRow}>
            {showMaterialsAdminEntry && onViewMaterialsAdmin && (
              <button style={styles.utilityBtn} onClick={onViewMaterialsAdmin}>素材上传台</button>
            )}
            {onOpenNativeDebug && (
              <button style={styles.utilityBtn} onClick={onOpenNativeDebug}>原生调试</button>
            )}
            {showLlmContextDashboardEntry && onOpenDebug && (
              <button style={styles.utilityBtn} onClick={onOpenDebug}>LLM Context</button>
            )}
          </div>
        )}

        <div style={{ ...styles.sectionLabel, ...styles.recentLabel }}>最近对话</div>
        <div style={styles.list} ref={listRef} onScroll={handleScroll}>
          {showInitialLoading && <p style={styles.empty}>加载中...</p>}
          {!showInitialLoading && sessions.length === 0 && <p style={styles.empty}>暂无对话记录</p>}
          {!showInitialLoading && sessions.map(renderSession)}
          {!showInitialLoading && sessions.length > 0 && (
            loadingMoreSessions ? (
              <p style={styles.footerHint}>加载更多…</p>
            ) : !sessionsHasMore ? (
              <p style={styles.footerHint}>没有更多了</p>
            ) : null
          )}
        </div>

        {confirmDeleteId && createPortal(
          <div style={styles.confirmOverlay} onClick={() => setConfirmDeleteId(null)}>
            <div style={styles.confirmDialog} onClick={(e) => e.stopPropagation()}>
              <p style={styles.confirmText}>确定要删除这个对话吗？删除后无法恢复。</p>
              <div style={styles.confirmButtons}>
                <button style={styles.confirmCancel} onClick={() => setConfirmDeleteId(null)}>取消</button>
                <button style={styles.confirmDelete} onClick={() => {
                  onDeleteSession(confirmDeleteId)
                  removeSession(confirmDeleteId)
                  setConfirmDeleteId(null)
                }}>删除</button>
              </div>
            </div>
          </div>,
          document.body,
        )}

        <div style={styles.footerSpacer} />
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    background: 'var(--color-bg)',
    zIndex: 20,
    display: 'flex',
    pointerEvents: 'none',
  },
  panel: {
    position: 'relative' as const,
    width: '86%',
    maxWidth: 348,
    height: '100%',
    background: 'rgba(255, 252, 248, 0.94)',
    backdropFilter: 'blur(18px) saturate(1.06)',
    WebkitBackdropFilter: 'blur(18px) saturate(1.06)',
    display: 'flex',
    flexDirection: 'column',
    boxShadow: 'none',
    pointerEvents: 'auto',
    willChange: 'transform, opacity, filter',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '24px 28px 10px',
    paddingTop: 'calc(24px + var(--safe-area-top))',
    flexShrink: 0,
  },
  headerTitle: {
    fontSize: 24,
    fontWeight: 400,
    fontFamily: 'var(--font-brand)',
    color: 'var(--color-brand)',
    margin: 0,
  },
  closeBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    background: 'transparent',
    border: 'none',
    color: '#6F6A66',
    cursor: 'pointer',
    padding: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  profileCard: {
    display: 'grid',
    gridTemplateColumns: '64px 1fr 24px',
    alignItems: 'center',
    gap: 14,
    margin: '12px 28px 14px',
    padding: 0,
    border: 'none',
    background: 'transparent',
    textAlign: 'left' as const,
    cursor: 'pointer',
    color: 'var(--color-text)',
  },
  avatarImage: {
    width: 64,
    height: 64,
    borderRadius: '50%',
    objectFit: 'cover' as const,
    background: '#F7D7C9',
    boxShadow: '0 8px 20px rgba(188, 116, 88, 0.12)',
  },
  profileName: {
    fontSize: 20,
    fontWeight: 700,
    color: 'var(--color-text)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  sectionLabel: {
    fontSize: 16,
    fontWeight: 700,
    color: 'var(--color-text)',
    padding: '0 28px 12px',
    flexShrink: 0,
  },
  commonCard: {
    margin: '0 28px',
    padding: '8px 0',
    borderRadius: 18,
    background: 'rgba(255, 255, 255, 0.86)',
    boxShadow: '0 8px 28px rgba(188, 116, 88, 0.08), inset 0 0 0 1px rgba(216, 180, 160, 0.12)',
    flexShrink: 0,
  },
  commonItem: {
    display: 'grid',
    gridTemplateColumns: '38px 1fr 20px',
    alignItems: 'center',
    gap: 12,
    width: '100%',
    minHeight: 46,
    padding: '0 18px',
    border: 'none',
    background: 'transparent',
    color: 'var(--color-text)',
    fontSize: 16,
    fontWeight: 600,
    cursor: 'pointer',
    textAlign: 'left' as const,
  },
  commonIcon: {
    color: 'var(--color-brand)',
    width: 34,
    height: 34,
    borderRadius: 17,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'rgba(255, 247, 242, 0.9)',
  },
  commonText: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  utilityRow: {
    display: 'flex',
    flexWrap: 'wrap' as const,
    gap: 8,
    margin: '12px 28px 0',
    flexShrink: 0,
  },
  utilityBtn: {
    border: 'none',
    borderRadius: 999,
    background: 'rgba(255, 255, 255, 0.78)',
    color: 'var(--color-text-muted)',
    padding: '6px 10px',
    fontSize: 12,
    cursor: 'pointer',
  },
  recentLabel: {
    paddingTop: 12,
  },
  list: {
    flex: 1,
    overflowY: 'auto',
    padding: '0 28px 8px',
  },
  empty: {
    textAlign: 'center',
    color: 'var(--color-text-muted)',
    fontSize: 14,
    padding: '28px 0',
  },
  footerHint: {
    textAlign: 'center',
    color: 'var(--color-text-muted)',
    fontSize: 12,
    padding: '14px 0 18px',
    opacity: 0.6,
    margin: 0,
  },
  sessionItem: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) 58px',
    alignItems: 'center',
    gap: 8,
    minHeight: 68,
    padding: '8px 10px 8px 16px',
    borderRadius: 0,
    borderLeft: '3px solid transparent',
    background: 'rgba(255, 255, 255, 0.76)',
    boxShadow: 'inset 0 -1px 0 rgba(210, 188, 176, 0.18)',
  },
  sessionItemContent: {
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'flex-start',
    minWidth: 0,
    border: 'none',
    background: 'transparent',
    padding: 0,
    cursor: 'pointer',
    textAlign: 'left' as const,
  },
  sessionItemActive: {
    borderLeftColor: 'var(--color-primary)',
    background: 'rgba(255, 247, 242, 0.92)',
  },
  sessionTitle: {
    maxWidth: '100%',
    fontSize: 16,
    fontWeight: 600,
    color: 'var(--color-text)',
    lineHeight: 1.35,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  sessionMeta: {
    fontSize: 13,
    color: 'var(--color-text-muted)',
    marginTop: 6,
  },
  sessionTrailing: {
    display: 'grid',
    gridTemplateColumns: '1fr 24px',
    alignItems: 'center',
    gap: 4,
  },
  sessionTime: {
    fontSize: 13,
    color: 'var(--color-text-muted)',
    textAlign: 'right' as const,
    whiteSpace: 'nowrap',
  },
  deleteBtn: {
    width: 28,
    height: 28,
    borderRadius: 8,
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: 'var(--color-text-muted)',
    opacity: 0.72,
  },
  footerSpacer: {
    height: 'calc(12px + var(--safe-area-bottom))',
    flexShrink: 0,
  },
  confirmOverlay: {
    position: 'fixed' as const,
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    background: 'rgba(0,0,0,0.4)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
    padding: 24,
    pointerEvents: 'auto',
  },
  confirmDialog: {
    background: 'var(--color-bg)',
    borderRadius: 16,
    padding: '24px 20px 20px',
    width: '100%',
    maxWidth: 280,
    boxShadow: '0 8px 32px rgba(0,0,0,0.12)',
  },
  confirmText: {
    fontSize: 14,
    lineHeight: 1.6,
    color: 'var(--color-text)',
    margin: '0 0 20px',
    textAlign: 'center' as const,
  },
  confirmButtons: {
    display: 'flex',
    gap: 12,
  },
  confirmCancel: {
    flex: 1,
    padding: '10px 0',
    borderRadius: 10,
    border: '1px solid var(--color-border)',
    background: 'transparent',
    color: 'var(--color-text)',
    fontSize: 14,
    fontWeight: 500,
    cursor: 'pointer',
  },
  confirmDelete: {
    flex: 1,
    padding: '10px 0',
    borderRadius: 10,
    border: 'none',
    background: 'var(--color-error)',
    color: '#fff',
    fontSize: 14,
    fontWeight: 500,
    cursor: 'pointer',
  },
}
