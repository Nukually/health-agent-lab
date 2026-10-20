import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { api } from '../services/api.js'
import CommunicationCardPanel from '../components/communication/CommunicationCardPanel.js'
import InterventionMaterialInline from '../components/chat/InterventionMaterialInline.js'
import VideoResourceInline from '../components/chat/VideoResourceInline.js'
import A2uiMarkdown from '../lib/a2ui/markdown.js'
import {
  readVideoResourceFavorites,
  removeVideoResourceFavorite,
  type SavedVideoResourceFavorite,
} from '../lib/videoResourceFavorites.js'
import {
  getHealthEducationDetailMarkdown,
  healthEducationFormat,
  mergeHealthEducationItemForDetail,
  mergeHealthEducationItemForList,
} from './healthEducationPresentation.js'
import { useStore } from '../stores/index.js'
import type {
  ApiResponse,
  CommunicationCardDraft,
  CommunicationCardRecord,
  HealthEducationInteractionResponse,
  HealthEducationItemWithStats,
  HealthEducationSavedListResponse,
  MessageFavoriteListResponse,
  MessageFavoriteRecord,
  HealthEducationViewResponse,
  SavedInterventionMaterialListResponse,
  SavedInterventionMaterialRecord,
} from '@health-agent/shared'
import { isFeatureEnabled } from '@health-agent/shared'

type View = 'list' | 'communicationDetail' | 'practiceDetail' | 'educationDetail'
type MaterialTab = 'message' | 'communication' | 'practice' | 'education'
type DeleteTarget =
  | { kind: 'communication'; card: CommunicationCardRecord }
  | { kind: 'practice'; card: SavedInterventionMaterialRecord }
  | { kind: 'videoResourcePractice'; card: SavedVideoResourceFavorite }

type PracticeListItem =
  | { kind: 'practice'; savedAt: string; card: SavedInterventionMaterialRecord }
  | { kind: 'videoResourcePractice'; savedAt: string; card: SavedVideoResourceFavorite }

function formatDate(value: string | null | undefined): string {
  if (!value) return '未记录日期'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value.slice(0, 10)
  return date.toLocaleDateString('sv-SE')
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return '未知时间'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

function formatDuration(totalSec: number): string {
  if (totalSec < 60) return `${totalSec} 秒`
  const minutes = Math.floor(totalSec / 60)
  const seconds = totalSec % 60
  return seconds > 0 ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分钟`
}

function getPracticeCardTitle(card: SavedInterventionMaterialRecord): string {
  return card.detail?.actionName ?? `干预方案 ${card.engagement.materialCode}`
}

function getDeleteConfirmText(target: DeleteTarget): string {
  if (target.kind === 'communication') return '确定要取消收藏这张沟通卡吗？取消后可从对话里的卡片重新收藏。'
  return '确定要取消收藏这张跟练卡吗？取消后可从对话里的方案重新收藏。'
}

function getVideoResourceProgress(card: SavedVideoResourceFavorite): string {
  const durationSec = card.resource.durationSec
  if (!durationSec) return '未知'
  const percent = Math.min(100, Math.round((card.playheadSec / durationSec) * 100))
  return `${percent}%`
}

function firstEducationImage(card: HealthEducationItemWithStats): string | null {
  return card.imageUrls[0] ?? card.coverUrl ?? null
}

function educationTypeTagStyle(format: string): React.CSSProperties {
  if (format === '海报') return { ...styles.educationTypeTag, ...styles.educationTypeTagPoster }
  if (format === '手册') return { ...styles.educationTypeTag, ...styles.educationTypeTagManual }
  return styles.educationTypeTag
}

function educationSource(card: HealthEducationItemWithStats): string {
  return `${card.doctor.name} · ${formatDate(card.publishedAt)}`
}

function createEducationViewId(itemId: string): string {
  const random = Math.random().toString(36).slice(2, 10)
  return `health-education-view:${itemId}:${Date.now()}:${random}`
}

function FavoriteIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M19 21l-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
    </svg>
  )
}

export default function Materials() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const returnSessionId = searchParams.get('returnSessionId')
  const returnToChatPath = returnSessionId ? `/chat/${returnSessionId}` : '/chat'
  const shouldReturnToSettings = searchParams.get('returnToSettings') === '1' || !!returnSessionId
  const returnToSettingsState = shouldReturnToSettings ? { openSidebar: true } : undefined
  const featureSnapshot = useStore((s) => s.features)
  const showHealthEducationFavorites = isFeatureEnabled(featureSnapshot, 'healthEducationFavorites')
  const [view, setView] = useState<View>('list')
  const [activeTab, setActiveTab] = useState<MaterialTab>('message')
  const [messageFavorites, setMessageFavorites] = useState<MessageFavoriteRecord[]>([])
  const [cards, setCards] = useState<CommunicationCardRecord[]>([])
  const [practiceCards, setPracticeCards] = useState<SavedInterventionMaterialRecord[]>([])
  const [videoResourcePracticeCards, setVideoResourcePracticeCards] = useState<SavedVideoResourceFavorite[]>([])
  const [educationCards, setEducationCards] = useState<HealthEducationItemWithStats[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedCard, setSelectedCard] = useState<CommunicationCardRecord | null>(null)
  const [selectedPracticeCard, setSelectedPracticeCard] = useState<SavedInterventionMaterialRecord | null>(null)
  const [selectedVideoResourcePracticeCard, setSelectedVideoResourcePracticeCard] = useState<SavedVideoResourceFavorite | null>(null)
  const [selectedEducationCard, setSelectedEducationCard] = useState<HealthEducationItemWithStats | null>(null)
  const [editingCard, setEditingCard] = useState(false)
  const [editingCardDraft, setEditingCardDraft] = useState<CommunicationCardDraft | null>(null)
  const [savingCard, setSavingCard] = useState(false)
  const [cardSaveError, setCardSaveError] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [deletingCardId, setDeletingCardId] = useState<string | null>(null)
  const [deletingPracticeId, setDeletingPracticeId] = useState<string | null>(null)
  const [deletingVideoResourcePracticeId, setDeletingVideoResourcePracticeId] = useState<string | null>(null)
  const [deletingEducationId, setDeletingEducationId] = useState<string | null>(null)
  const [deletingMessageFavoriteId, setDeletingMessageFavoriteId] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null)
  const practiceItems: PracticeListItem[] = [
    ...practiceCards.map((card) => ({
      kind: 'practice' as const,
      savedAt: card.engagement.savedAt ?? '',
      card,
    })),
    ...videoResourcePracticeCards.map((card) => ({
      kind: 'videoResourcePractice' as const,
      savedAt: card.savedAt,
      card,
    })),
  ].sort((a, b) => b.savedAt.localeCompare(a.savedAt))
  const emptyTabHint = !loading
    ? activeTab === 'message' && messageFavorites.length === 0
      ? '在对话中点击收藏后，会出现在这里。'
      : activeTab === 'communication' && cards.length === 0
        ? '对话中提出复诊或用药问题后，可生成给医生看的沟通卡。'
        : activeTab === 'practice' && practiceItems.length === 0
          ? '咨询不适症状后，可生成适合你的居家缓解跟练方案。'
          : showHealthEducationFavorites && activeTab === 'education' && educationCards.length === 0
            ? '在医生说广场收藏医生发布的内容后，会出现在这里。'
            : null
    : null

  useEffect(() => {
    loadCards()
  }, [])

  useEffect(() => {
    if (showHealthEducationFavorites) return
    if (activeTab === 'education') setActiveTab('communication')
    if (view === 'educationDetail') {
      setSelectedEducationCard(null)
      setView('list')
    }
  }, [activeTab, showHealthEducationFavorites, view])

  async function loadCards() {
    setLoading(true)
    try {
      setVideoResourcePracticeCards(readVideoResourceFavorites())
      const requests = [
        api.get<ApiResponse<MessageFavoriteListResponse>>('/message-favorites?limit=100'),
        api.get<ApiResponse<CommunicationCardRecord[]>>('/medical/communication-cards'),
        api.get<ApiResponse<SavedInterventionMaterialListResponse>>('/intervention-material-runtime/saved'),
      ] as const
      const [messageFavoriteRes, communicationRes, practiceRes] = await Promise.allSettled(requests)
      if (messageFavoriteRes.status === 'fulfilled' && messageFavoriteRes.value.data) {
        setMessageFavorites(messageFavoriteRes.value.data.items)
      }
      if (communicationRes.status === 'fulfilled' && communicationRes.value.data) {
        setCards(communicationRes.value.data)
      }
      if (practiceRes.status === 'fulfilled' && practiceRes.value.data) {
        setPracticeCards(practiceRes.value.data.items)
      }
      if (showHealthEducationFavorites) {
        const educationRes = await api.get<ApiResponse<HealthEducationSavedListResponse>>('/health-education/saved')
          .catch(() => null)
        if (educationRes?.data) setEducationCards(educationRes.data.items)
      } else {
        setEducationCards([])
      }
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }

  function openMessageFavorite(favorite: MessageFavoriteRecord) {
    navigate(`/chat/${favorite.sessionId}?focusMessageId=${encodeURIComponent(favorite.messageId)}`)
  }

  async function handleDeleteMessageFavorite(favorite: MessageFavoriteRecord) {
    if (deletingMessageFavoriteId) return

    setDeletingMessageFavoriteId(favorite.messageId)
    setDeleteError(null)
    try {
      await api.delete(`/message-favorites/${favorite.messageId}?sessionId=${encodeURIComponent(favorite.sessionId)}`)
      setMessageFavorites((prev) => prev.filter((item) => item.messageId !== favorite.messageId))
    } catch (err: any) {
      setDeleteError(err.message || '取消收藏失败，请稍后重试')
    } finally {
      setDeletingMessageFavoriteId(null)
    }
  }

  function openCardDetail(card: CommunicationCardRecord) {
    setSelectedCard(card)
    setEditingCard(false)
    setEditingCardDraft(card.contentJson.draft)
    setCardSaveError(null)
    setDeleteError(null)
    setView('communicationDetail')
  }

  function openPracticeDetail(card: SavedInterventionMaterialRecord) {
    setSelectedPracticeCard(card)
    setSelectedVideoResourcePracticeCard(null)
    setDeleteError(null)
    setView('practiceDetail')
  }

  function openVideoResourcePracticeDetail(card: SavedVideoResourceFavorite) {
    setSelectedVideoResourcePracticeCard(card)
    setSelectedPracticeCard(null)
    setDeleteError(null)
    setView('practiceDetail')
  }

  async function openEducationDetail(card: HealthEducationItemWithStats) {
    if (!showHealthEducationFavorites || card.isAvailable === false) return
    setSelectedEducationCard(mergeHealthEducationItemForDetail(card, { ...card, content: '', imageUrls: [], coverUrl: null }))
    setDeleteError(null)
    setView('educationDetail')
    try {
      const res = await api.get<ApiResponse<HealthEducationItemWithStats>>(`/health-education/items/${card.id}`)
      if (res.data) {
        const detailCard = mergeHealthEducationItemForDetail(card, res.data)
        setSelectedEducationCard(detailCard)
        setEducationCards((prev) => prev.map((item) => (
          item.id === detailCard.id ? mergeHealthEducationItemForList(item, res.data!) : item
        )))
        void recordEducationView(detailCard.id)
      }
    } catch (err: any) {
      setDeleteError(err.message || '加载医生说详情失败')
    }
  }

  async function recordEducationView(itemId: string) {
    try {
      const res = await api.post<ApiResponse<HealthEducationViewResponse>>(
        `/health-education/items/${itemId}/view`,
        { viewId: createEducationViewId(itemId), source: 'favorites' },
      )
      const stats = res.data
      if (!stats) return
      setSelectedEducationCard((prev) => {
        if (!prev || prev.id !== stats.itemId) return prev
        return { ...prev, pvCount: stats.pvCount, uvCount: stats.uvCount }
      })
      setEducationCards((prev) => prev.map((item) => (
        item.id === stats.itemId
          ? { ...item, pvCount: stats.pvCount, uvCount: stats.uvCount }
          : item
      )))
    } catch (err) {
      console.warn('[health-education] view record failed', err)
    }
  }

  function sessionQuerySuffix(): string {
    return returnSessionId ? `?sessionId=${encodeURIComponent(returnSessionId)}` : ''
  }

  async function handleSaveCardEdit() {
    if (!selectedCard || !editingCardDraft || savingCard) return

    setSavingCard(true)
    setCardSaveError(null)
    try {
      const res = await api.put<ApiResponse<CommunicationCardRecord>>(
        `/medical/communication-cards/${selectedCard.id}`,
        {
          draft: editingCardDraft,
          ...(returnSessionId ? { sessionId: returnSessionId } : {}),
        },
      )
      const updatedCard = res.data
      if (!updatedCard) throw new Error('保存失败')

      setSelectedCard(updatedCard)
      setEditingCardDraft(updatedCard.contentJson.draft)
      setEditingCard(false)
      setCards((prev) => prev.map((card) => (card.id === updatedCard.id ? updatedCard : card)))
    } catch (err: any) {
      setCardSaveError(err.message || '保存失败，请稍后重试')
    } finally {
      setSavingCard(false)
    }
  }

  async function handleDeleteCard(card: CommunicationCardRecord) {
    if (deletingCardId) return

    setDeletingCardId(card.id)
    setDeleteError(null)
    try {
      await api.delete(`/medical/communication-cards/${card.id}${sessionQuerySuffix()}`)
      setCards((prev) => prev.filter((item) => item.id !== card.id))
      if (selectedCard?.id === card.id) {
        setSelectedCard(null)
        setEditingCard(false)
        setEditingCardDraft(null)
        setCardSaveError(null)
        setView('list')
      }
    } catch (err: any) {
      setDeleteError(err.message || '取消收藏失败，请稍后重试')
    } finally {
      setDeletingCardId(null)
    }
  }

  async function handleDeletePracticeCard(card: SavedInterventionMaterialRecord) {
    if (deletingPracticeId) return

    setDeletingPracticeId(card.engagement.id)
    setDeleteError(null)
    try {
      await api.delete(`/intervention-material-runtime/saved/${card.engagement.id}${sessionQuerySuffix()}`)
      setPracticeCards((prev) => prev.filter((item) => item.engagement.id !== card.engagement.id))
      if (selectedPracticeCard?.engagement.id === card.engagement.id) {
        setSelectedPracticeCard(null)
        setView('list')
      }
    } catch (err: any) {
      setDeleteError(err.message || '取消收藏失败，请稍后重试')
    } finally {
      setDeletingPracticeId(null)
    }
  }

  function handleDeleteVideoResourcePracticeCard(card: SavedVideoResourceFavorite) {
    if (deletingVideoResourcePracticeId) return

    setDeletingVideoResourcePracticeId(card.id)
    setDeleteError(null)
    try {
      removeVideoResourceFavorite(card.id)
      setVideoResourcePracticeCards((prev) => prev.filter((item) => item.id !== card.id))
      if (selectedVideoResourcePracticeCard?.id === card.id) {
        setSelectedVideoResourcePracticeCard(null)
        setView('list')
      }
    } catch (err: any) {
      setDeleteError(err.message || '取消收藏失败，请稍后重试')
    } finally {
      setDeletingVideoResourcePracticeId(null)
    }
  }

  async function confirmDeleteTarget() {
    if (!deleteTarget) return

    const target = deleteTarget
    try {
      if (target.kind === 'communication') {
        await handleDeleteCard(target.card)
      } else if (target.kind === 'practice') {
        await handleDeletePracticeCard(target.card)
      } else {
        handleDeleteVideoResourcePracticeCard(target.card)
      }
    } finally {
      setDeleteTarget(null)
    }
  }

  const isConfirmDeleting = deleteTarget?.kind === 'communication'
    ? deletingCardId === deleteTarget.card.id
    : deleteTarget?.kind === 'practice'
      ? deletingPracticeId === deleteTarget.card.engagement.id
      : deleteTarget?.kind === 'videoResourcePractice'
        ? deletingVideoResourcePracticeId === deleteTarget.card.id
        : false

  async function handleDeleteEducationCard(card: HealthEducationItemWithStats) {
    if (!showHealthEducationFavorites) return
    if (deletingEducationId) return

    setDeletingEducationId(card.id)
    setDeleteError(null)
    try {
      const res = await api.post<ApiResponse<HealthEducationInteractionResponse>>(
        `/health-education/items/${card.id}/favorite`,
        { favorite: false },
      )
      const updated = res.data?.item
      setEducationCards((prev) => prev.filter((item) => item.id !== card.id))
      if (selectedEducationCard?.id === card.id || updated?.isFavorited === false) {
        setSelectedEducationCard(null)
        setView('list')
      }
    } catch (err: any) {
      setDeleteError(err.message || '取消收藏失败，请稍后重试')
    } finally {
      setDeletingEducationId(null)
    }
  }

  return (
    <div style={styles.container}>
      <div style={styles.scrollArea}>
        <div style={styles.nav}>
          <button
            style={styles.backBtn}
            onClick={() => {
              if (view !== 'list') {
                setView('list')
                setVideoResourcePracticeCards(readVideoResourceFavorites())
                setSelectedCard(null)
                setSelectedPracticeCard(null)
                setSelectedVideoResourcePracticeCard(null)
                setSelectedEducationCard(null)
                setEditingCard(false)
                setEditingCardDraft(null)
                setCardSaveError(null)
                setDeleteError(null)
                return
              }
              navigate(returnToChatPath, { state: returnToSettingsState })
            }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
            <span>{view === 'list' ? '返回' : '返回列表'}</span>
          </button>
        </div>

        {view === 'list' && (
          <div style={styles.content}>
            {deleteError && <div style={styles.cardSaveError}>{deleteError}</div>}

            <div
              style={{
                ...styles.tabs,
                gridTemplateColumns: showHealthEducationFavorites ? 'repeat(4, minmax(0, 1fr))' : 'repeat(3, minmax(0, 1fr))',
              }}
            >
              <button
                type="button"
                className="materials-tab-button"
                aria-pressed={activeTab === 'message'}
                style={{
                  ...styles.tabButton,
                  ...(activeTab === 'message' ? styles.tabButtonActive : {}),
                }}
                onMouseDown={(event) => event.preventDefault()}
                onClick={(event) => {
                  event.currentTarget.blur()
                  setActiveTab('message')
                }}
              >
                对话
              </button>
              <button
                type="button"
                className="materials-tab-button"
                aria-pressed={activeTab === 'communication'}
                style={{
                  ...styles.tabButton,
                  ...(activeTab === 'communication' ? styles.tabButtonActive : {}),
                }}
                onMouseDown={(event) => event.preventDefault()}
                onClick={(event) => {
                  event.currentTarget.blur()
                  setActiveTab('communication')
                }}
              >
                沟通卡
              </button>
              <button
                type="button"
                className="materials-tab-button"
                aria-pressed={activeTab === 'practice'}
                style={{
                  ...styles.tabButton,
                  ...(activeTab === 'practice' ? styles.tabButtonActive : {}),
                }}
                onMouseDown={(event) => event.preventDefault()}
                onClick={(event) => {
                  event.currentTarget.blur()
                  setActiveTab('practice')
                }}
              >
                跟练卡
              </button>
              {showHealthEducationFavorites && (
                <button
                  type="button"
                  className="materials-tab-button"
                  aria-pressed={activeTab === 'education'}
                  style={{
                    ...styles.tabButton,
                    ...(activeTab === 'education' ? styles.tabButtonActive : {}),
                  }}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={(event) => {
                    event.currentTarget.blur()
                    setActiveTab('education')
                  }}
                >
                  医生说
                </button>
              )}
            </div>
            {emptyTabHint && <p style={styles.emptyTabHint}>{emptyTabHint}</p>}

            {loading ? (
              <div style={styles.emptyState}>加载中...</div>
            ) : activeTab === 'message' && messageFavorites.length === 0 ? (
              <div style={styles.emptyState}>
                <p style={styles.emptyText}>暂无已收藏的对话</p>
              </div>
            ) : activeTab === 'message' ? (
              <div style={styles.timeline}>
                {messageFavorites.map((favorite) => (
                  <div
                    key={favorite.id}
                    style={styles.timelineItem}
                    onClick={() => openMessageFavorite(favorite)}
                  >
                    <div style={styles.timelineDot} />
                    <div style={styles.messageFavoriteCard}>
                      <div style={styles.messageFavoriteHeader}>
                        <span style={styles.messageFavoriteDate}>{formatDateTime(favorite.createdAt)}</span>
                        <button
                          type="button"
                          style={{
                            ...styles.messageFavoriteDeleteBtn,
                            ...(deletingMessageFavoriteId === favorite.messageId ? styles.detailBtnDisabled : {}),
                          }}
                          disabled={deletingMessageFavoriteId === favorite.messageId}
                          onClick={(event) => {
                            event.stopPropagation()
                            void handleDeleteMessageFavorite(favorite)
                          }}
                        >
                          {deletingMessageFavoriteId === favorite.messageId ? '取消中...' : '取消收藏'}
                        </button>
                      </div>
                      <p style={styles.messageFavoriteTitle}>{favorite.sessionTitle || '未命名对话'}</p>
                      {favorite.userContentSnapshot && (
                        <p style={styles.messageFavoriteQuestion}>
                          <span style={styles.messageFavoriteQuestionLabel}>问</span>
                          <span style={styles.messageFavoriteQuestionText}>{favorite.userContentSnapshot}</span>
                        </p>
                      )}
                      <p style={styles.messageFavoritePreview}>{favorite.contentPreview}</p>
                    </div>
                  </div>
                ))}
              </div>
            ) : activeTab === 'communication' && cards.length === 0 ? (
              <div style={styles.emptyState}>
                <p style={styles.emptyText}>暂无已收藏的沟通卡</p>
              </div>
            ) : activeTab === 'communication' ? (
              <div style={styles.timeline}>
                {cards.map((card) => (
                  <div key={card.id} style={styles.timelineItem} onClick={() => openCardDetail(card)}>
                    <div style={styles.timelineDot} />
                    <div style={styles.card}>
                      <div style={styles.cardHeader}>
                        <span style={styles.cardDate}>{card.cardDate}</span>
                        <span style={styles.cardTag}>沟通卡片</span>
                      </div>
                      <p style={styles.cardTitle}>{card.title}</p>
                      <p style={styles.cardPreview}>{card.contentJson.draft.visitPurpose}</p>
                      <div style={styles.cardFooter}>
                        <span style={styles.cardPages}>点击查看详情</span>
                        <button
                          type="button"
                          style={{
                            ...styles.deleteBtn,
                            ...(deletingCardId === card.id ? styles.detailBtnDisabled : {}),
                          }}
                          disabled={deletingCardId === card.id}
                          onClick={(event) => {
                            event.stopPropagation()
                            setDeleteTarget({ kind: 'communication', card })
                          }}
                        >
                          {deletingCardId === card.id ? '取消中...' : '取消收藏'}
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : activeTab === 'practice' && practiceItems.length === 0 ? (
              <div style={styles.emptyState}>
                <p style={styles.emptyText}>暂无已收藏的跟练卡</p>
              </div>
            ) : activeTab === 'practice' ? (
              <div style={styles.timeline}>
                {practiceItems.map((item) => {
                  if (item.kind === 'videoResourcePractice') {
                    const card = item.card
                    return (
                      <div
                        key={`video-resource-${card.id}`}
                        style={styles.timelineItem}
                        onClick={() => openVideoResourcePracticeDetail(card)}
                      >
                        <div style={styles.timelineDot} />
                        <div style={styles.card}>
                          <div style={styles.cardHeader}>
                            <span style={styles.cardDate}>{formatDate(card.savedAt)}</span>
                            <span style={styles.cardTag}>视频跟练</span>
                          </div>
                          <p style={styles.cardTitle}>{card.resource.title}</p>
                          <p style={styles.cardPreview}>
                            {card.resource.snippet || `视频总时长 ${formatDuration(card.resource.durationSec)}`}
                          </p>
                          <div style={styles.cardFooter}>
                            <div style={styles.cardFooterMeta}>
                              <span style={styles.cardPages}>完成 {getVideoResourceProgress(card)}</span>
                              <span style={styles.cardPages}>已跟练 {formatDuration(card.followedSec)}</span>
                            </div>
                            <button
                              type="button"
                              style={{
                                ...styles.deleteBtn,
                                ...(deletingVideoResourcePracticeId === card.id ? styles.detailBtnDisabled : {}),
                              }}
                              disabled={deletingVideoResourcePracticeId === card.id}
                              onClick={(event) => {
                                event.stopPropagation()
                                setDeleteTarget({ kind: 'videoResourcePractice', card })
                              }}
                            >
                              {deletingVideoResourcePracticeId === card.id ? '取消中...' : '取消收藏'}
                            </button>
                          </div>
                        </div>
                      </div>
                    )
                  }

                  const card = item.card
                  const { engagement, detail } = card
                  const progress = `${Math.min(engagement.completedStepCount, engagement.totalStepCount)}/${engagement.totalStepCount || detail?.stepsMeta.length || 0}`
                  return (
                    <div
                      key={engagement.id}
                      style={{
                        ...styles.timelineItem,
                        ...(!detail ? styles.timelineItemDisabled : {}),
                      }}
                      onClick={() => openPracticeDetail(card)}
                    >
                      <div style={styles.timelineDot} />
                      <div style={styles.card}>
                        <div style={styles.cardHeader}>
                          <span style={styles.cardDate}>{formatDate(engagement.savedAt)}</span>
                          <span style={styles.cardTag}>跟练卡</span>
                        </div>
                        <p style={styles.cardTitle}>{getPracticeCardTitle(card)}</p>
                        <p style={styles.cardPreview}>
                          {detail
                            ? `${detail.sideEffect} · ${detail.scene}`
                            : '该方案素材暂时不可用'}
                        </p>
                        <div style={styles.cardFooter}>
                          <div style={styles.cardFooterMeta}>
                            <span style={styles.cardPages}>进度 {progress}</span>
                            <span style={styles.cardPages}>已跟练 {formatDuration(engagement.totalFollowSec)}</span>
                          </div>
                          <button
                            type="button"
                            style={{
                              ...styles.deleteBtn,
                              ...(deletingPracticeId === engagement.id ? styles.detailBtnDisabled : {}),
                            }}
                            disabled={deletingPracticeId === engagement.id}
                            onClick={(event) => {
                              event.stopPropagation()
                              setDeleteTarget({ kind: 'practice', card })
                            }}
                          >
                            {deletingPracticeId === engagement.id ? '取消中...' : '取消收藏'}
                          </button>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            ) : educationCards.length === 0 ? (
              <div style={styles.educationEmptyState}>
                <div style={styles.bookmarkIcon}>
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M19 21l-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
                  </svg>
                </div>
                <p style={styles.educationEmptyTitle}>暂无收藏内容</p>
                <p style={styles.educationEmptyText}>收藏医生发布的医生说内容后会出现在这里。</p>
              </div>
            ) : (
              <div style={styles.educationList}>
                {educationCards.map((card) => (
                  <div
                    key={card.id}
                    style={{
                      ...styles.educationCard,
                      ...(card.isAvailable === false ? styles.educationCardDisabled : {}),
                    }}
                    onClick={() => void openEducationDetail(card)}
                  >
                    {firstEducationImage(card) ? (
                      <img src={firstEducationImage(card)!} alt="" style={styles.educationThumb} />
                    ) : (
                      <div style={styles.educationThumbFallback}>
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                          <rect x="3" y="4" width="18" height="16" rx="2" />
                          <circle cx="8.5" cy="9" r="1.5" />
                          <path d="M21 15l-5-5L5 20" />
                        </svg>
                      </div>
                    )}
                    <div style={styles.educationCardBody}>
                      <span style={educationTypeTagStyle(healthEducationFormat(card))}>{healthEducationFormat(card)}</span>
                      <p style={styles.educationCardTitle}>{card.title || '内容已下架'}</p>
                      <p style={styles.educationCardSource}>
                        {card.isAvailable === false ? '内容已下架' : educationSource(card)}
                      </p>
                    </div>
                    <button
                      type="button"
                      style={{
                        ...styles.educationRemoveBtn,
                        ...(deletingEducationId === card.id ? styles.detailBtnDisabled : {}),
                      }}
                      disabled={deletingEducationId === card.id}
                      onClick={(event) => {
                        event.stopPropagation()
                        void handleDeleteEducationCard(card)
                      }}
                    >
                      {deletingEducationId === card.id ? '取消中' : '移除'}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {view === 'communicationDetail' && selectedCard && (
          <div style={styles.content}>
            <div style={styles.detailHeader}>
              <h2 style={styles.detailTitle}>{editingCardDraft?.title ?? selectedCard.title}</h2>
              <div style={styles.detailMeta}>
                <span>{editingCardDraft?.cardDate ?? selectedCard.cardDate}</span>
                {selectedCard.sourceSessionId && <span>来自历史对话</span>}
              </div>
            </div>

            <div style={styles.cardDetailActions}>
              {editingCard ? (
                <>
                  <button
                    style={styles.detailSecondaryBtn}
                    onClick={() => {
                      setEditingCard(false)
                      setEditingCardDraft(selectedCard.contentJson.draft)
                      setCardSaveError(null)
                    }}
                    disabled={savingCard}
                  >
                    取消
                  </button>
                  <button
                    style={{
                      ...styles.detailPrimaryBtn,
                      ...(savingCard ? styles.detailBtnDisabled : {}),
                    }}
                    onClick={handleSaveCardEdit}
                    disabled={savingCard}
                  >
                    {savingCard ? '保存中...' : '保存修改'}
                  </button>
                </>
              ) : (
                <>
                  <button
                    style={{
                      ...styles.detailFavoriteBtn,
                      ...(deletingCardId === selectedCard.id ? styles.detailBtnDisabled : {}),
                    }}
                    onClick={() => setDeleteTarget({ kind: 'communication', card: selectedCard })}
                    disabled={deletingCardId === selectedCard.id}
                  >
                    <FavoriteIcon />
                    <span>{deletingCardId === selectedCard.id ? '取消中...' : '取消收藏'}</span>
                  </button>
                  <button
                    style={styles.detailPrimaryBtn}
                    onClick={() => {
                      setEditingCard(true)
                      setEditingCardDraft(selectedCard.contentJson.draft)
                      setCardSaveError(null)
                      setDeleteError(null)
                    }}
                  >
                    编辑卡片
                  </button>
                </>
              )}
            </div>

            {cardSaveError && <div style={styles.cardSaveError}>{cardSaveError}</div>}
            {deleteError && <div style={styles.cardSaveError}>{deleteError}</div>}

            <CommunicationCardPanel
              draft={editingCardDraft ?? selectedCard.contentJson.draft}
              editable={editingCard}
              onChange={setEditingCardDraft}
            />
          </div>
        )}

        {view === 'practiceDetail' && (selectedPracticeCard || selectedVideoResourcePracticeCard) && (
          <div style={styles.content}>
            <div style={styles.detailHeader}>
              <h2 style={styles.detailTitle}>
                {selectedPracticeCard
                  ? getPracticeCardTitle(selectedPracticeCard)
                  : selectedVideoResourcePracticeCard?.resource.title}
              </h2>
              <div style={styles.detailMeta}>
                {selectedPracticeCard && (
                  <>
                    <span>收藏于 {formatDate(selectedPracticeCard.engagement.savedAt)}</span>
                    {selectedPracticeCard.engagement.followCompletedAt && <span>已完成过跟练</span>}
                  </>
                )}
                {selectedVideoResourcePracticeCard && (
                  <>
                    <span>收藏于 {formatDate(selectedVideoResourcePracticeCard.savedAt)}</span>
                    {selectedVideoResourcePracticeCard.completedAt && <span>已完成过跟练</span>}
                  </>
                )}
              </div>
            </div>

            {deleteError && <div style={styles.cardSaveError}>{deleteError}</div>}

            {selectedVideoResourcePracticeCard ? (
              <VideoResourceInline
                resource={selectedVideoResourcePracticeCard.resource}
                sessionId={returnSessionId}
                source="materials"
                initialSaved
                initialFollowedSec={selectedVideoResourcePracticeCard.followedSec}
                onFavoriteChange={(saved) => {
                  if (saved) {
                    setVideoResourcePracticeCards(readVideoResourceFavorites())
                    return
                  }
                  setVideoResourcePracticeCards((prev) => prev.filter((item) => item.id !== selectedVideoResourcePracticeCard.id))
                  setSelectedVideoResourcePracticeCard(null)
                  setView('list')
                }}
              />
            ) : selectedPracticeCard?.detail ? (
              <InterventionMaterialInline
                output={selectedPracticeCard.detail}
                sessionId={selectedPracticeCard.engagement.sessionId}
                toolCallId={selectedPracticeCard.engagement.toolCallId}
                source="materials"
                initialSaved
                initialSavedEngagement={selectedPracticeCard.engagement}
                onUnsaved={(engagementId) => {
                  setPracticeCards((prev) => prev.filter((item) => item.engagement.id !== engagementId))
                  setSelectedPracticeCard(null)
                  setView('list')
                }}
              />
            ) : (
              <div style={styles.emptyState}>
                <p style={styles.emptyText}>该跟练方案暂时不可用</p>
                <p style={styles.emptySubText}>可能是素材版本已被下线或原会话记录不可读取</p>
              </div>
            )}
          </div>
        )}

        {view === 'educationDetail' && selectedEducationCard && (
          <div style={styles.content}>
            <div style={styles.detailHeader}>
              <h2 style={styles.detailTitle}>{selectedEducationCard.title}</h2>
              <div style={styles.detailMeta}>
                <span>{selectedEducationCard.doctor.name}</span>
                <span>{[selectedEducationCard.doctor.department, selectedEducationCard.doctor.title].filter(Boolean).join(' · ') || '医生'}</span>
                <span>{formatDate(selectedEducationCard.publishedAt)}</span>
              </div>
            </div>

            <div style={styles.cardDetailActions}>
              <button
                style={{
                  ...styles.detailFavoriteBtn,
                  ...(deletingEducationId === selectedEducationCard.id ? styles.detailBtnDisabled : {}),
                }}
                onClick={() => void handleDeleteEducationCard(selectedEducationCard)}
                disabled={deletingEducationId === selectedEducationCard.id}
              >
                <FavoriteIcon />
                <span>{deletingEducationId === selectedEducationCard.id ? '取消中...' : '取消收藏'}</span>
              </button>
            </div>

            {deleteError && <div style={styles.cardSaveError}>{deleteError}</div>}
            <div className="markdown-body cx-education-markdown" style={styles.educationContent}>
              <A2uiMarkdown content={getHealthEducationDetailMarkdown(selectedEducationCard)} />
            </div>
          </div>
        )}
      </div>

      {deleteTarget && createPortal(
        <div
          style={styles.confirmOverlay}
          onClick={() => {
            if (!isConfirmDeleting) setDeleteTarget(null)
          }}
        >
          <div style={styles.confirmDialog} onClick={(event) => event.stopPropagation()}>
            <p style={styles.confirmText}>{getDeleteConfirmText(deleteTarget)}</p>
            <div style={styles.confirmButtons}>
              <button
                type="button"
                style={{
                  ...styles.confirmCancel,
                  ...(isConfirmDeleting ? styles.confirmButtonDisabled : {}),
                }}
                disabled={isConfirmDeleting}
                onClick={() => setDeleteTarget(null)}
              >
                取消
              </button>
              <button
                type="button"
                style={{
                  ...styles.confirmDelete,
                  ...(isConfirmDeleting ? styles.confirmButtonDisabled : {}),
                }}
                disabled={isConfirmDeleting}
                onClick={() => void confirmDeleteTarget()}
              >
                {isConfirmDeleting ? '取消中...' : '取消收藏'}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    height: '100%',
    background: 'linear-gradient(180deg, #FFFDF9 0%, #FFF7F1 100%)',
    overflow: 'hidden',
  },
  scrollArea: {
    height: '100%',
    overflowY: 'auto',
    padding: 'clamp(14px, 4vw, 22px)',
    paddingTop: 'calc(clamp(14px, 4vw, 22px) + var(--safe-area-top))',
    paddingBottom: 'calc(28px + var(--safe-area-bottom))',
  },
  nav: {
    display: 'flex',
    alignItems: 'center',
    minHeight: 38,
    marginBottom: 18,
  },
  backBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    minHeight: 36,
    background: 'rgba(255,255,255,0.82)',
    border: '1px solid rgba(216, 180, 160, 0.22)',
    borderRadius: 18,
    color: 'var(--color-text-secondary)',
    fontSize: 15,
    cursor: 'pointer',
    padding: '0 12px 0 8px',
    boxShadow: '0 8px 24px rgba(188, 116, 88, 0.06)',
  },
  content: {
    width: 'min(100%, 430px)',
    maxWidth: 430,
    margin: '0 auto',
  },
  title: {
    fontSize: 28,
    fontWeight: 700,
    color: 'var(--color-text)',
    margin: '0 0 8px',
    lineHeight: 1.18,
  },
  subtitle: {
    fontSize: 14,
    color: 'var(--color-text-muted)',
    margin: 0,
    lineHeight: 1.5,
  },
  emptyTabHint: {
    fontSize: 14,
    color: 'var(--color-text-muted)',
    margin: '0 4px 14px',
    lineHeight: 1.5,
  },
  tabs: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr 1fr',
    gap: 8,
    marginBottom: 14,
    padding: 4,
    borderRadius: 16,
    background: 'rgba(255,255,255,0.62)',
    border: '1px solid rgba(216, 180, 160, 0.16)',
  },
  tabButton: {
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'transparent',
    borderRadius: 12,
    background: 'transparent',
    color: 'var(--color-text-secondary)',
    fontSize: 13,
    fontWeight: 600,
    padding: '10px 8px',
    cursor: 'pointer',
    outline: 'none',
    boxShadow: 'none',
    WebkitTapHighlightColor: 'transparent',
  },
  tabButtonActive: {
    borderColor: 'rgba(212, 135, 108, 0.24)',
    background: 'rgba(255,255,255,0.92)',
    color: 'var(--color-primary)',
    boxShadow: '0 8px 18px rgba(188, 116, 88, 0.08)',
  },
  emptyState: {
    textAlign: 'center',
    padding: '44px 18px',
    borderRadius: 20,
    background: 'rgba(255,255,255,0.62)',
    border: '1px solid rgba(216, 180, 160, 0.16)',
  },
  emptyText: {
    margin: '0 0 8px',
    color: 'var(--color-text-muted)',
    fontSize: 14,
  },
  emptySubText: {
    margin: 0,
    color: 'var(--color-text-muted)',
    fontSize: 12,
  },
  timeline: {
    display: 'flex',
    flexDirection: 'column',
    gap: 0,
    paddingLeft: 18,
    borderLeft: '2px solid rgba(212, 135, 108, 0.16)',
  },
  timelineItem: {
    position: 'relative',
    paddingLeft: 20,
    paddingBottom: 20,
    cursor: 'pointer',
  },
  timelineItemDisabled: {
    opacity: 0.72,
  },
  timelineDot: {
    position: 'absolute',
    left: -7,
    top: 12,
    width: 12,
    height: 12,
    borderRadius: '50%',
    background: 'var(--color-primary)',
    border: '3px solid #FFFDF9',
    boxShadow: '0 0 0 4px rgba(212, 135, 108, 0.08)',
  },
  card: {
    background: 'rgba(255,255,255,0.78)',
    border: '1px solid rgba(216, 180, 160, 0.14)',
    borderRadius: 18,
    padding: 16,
    boxShadow: '0 12px 30px rgba(188, 116, 88, 0.08)',
  },
  cardHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginBottom: 6,
    flexWrap: 'wrap',
  },
  cardDate: {
    fontSize: 13,
    fontWeight: 600,
    color: 'var(--color-text)',
  },
  cardTag: {
    fontSize: 11,
    padding: '2px 8px',
    borderRadius: 999,
    background: 'var(--color-primary-bg)',
    color: 'var(--color-primary)',
    fontWeight: 500,
  },
  messageFavoriteCard: {
    background: 'rgba(255,255,255,0.86)',
    border: '1px solid rgba(216, 180, 160, 0.13)',
    borderRadius: 14,
    padding: '14px 14px 16px',
    boxShadow: '0 10px 24px rgba(188, 116, 88, 0.07)',
  },
  messageFavoriteHeader: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
    marginBottom: 8,
  },
  messageFavoriteDate: {
    color: 'var(--color-text-secondary)',
    fontSize: 12,
    fontWeight: 600,
    lineHeight: 1.25,
    paddingTop: 4,
  },
  messageFavoriteTitle: {
    color: 'var(--color-text)',
    fontSize: 18,
    fontWeight: 700,
    lineHeight: 1.28,
    margin: '0 0 8px',
    overflow: 'hidden',
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical' as const,
  },
  messageFavoriteQuestion: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 6,
    color: 'var(--color-text-secondary)',
    fontSize: 14,
    lineHeight: 1.45,
    margin: '0 0 8px',
  },
  messageFavoriteQuestionLabel: {
    flexShrink: 0,
    color: 'var(--color-primary)',
    fontWeight: 700,
  },
  messageFavoriteQuestionText: {
    minWidth: 0,
    overflow: 'hidden',
    display: '-webkit-box',
    WebkitLineClamp: 1,
    WebkitBoxOrient: 'vertical' as const,
  },
  messageFavoritePreview: {
    color: 'var(--color-text-muted)',
    fontSize: 15,
    lineHeight: 1.55,
    margin: 0,
    overflow: 'hidden',
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical' as const,
  },
  messageFavoriteDeleteBtn: {
    border: '1px solid rgba(229, 72, 72, 0.18)',
    borderRadius: 999,
    background: 'rgba(229, 72, 72, 0.06)',
    color: 'var(--color-error)',
    fontSize: 12,
    fontWeight: 600,
    lineHeight: 1,
    padding: '7px 10px',
    cursor: 'pointer',
    flexShrink: 0,
  },
  cardTitle: {
    fontSize: 'calc(var(--font-size-chat) + 1px)',
    fontWeight: 500,
    color: 'var(--color-text)',
    margin: '0 0 4px',
  },
  cardPreview: {
    fontSize: 'var(--font-size-chat)',
    color: 'var(--color-text-muted)',
    margin: '0 0 8px',
    lineHeight: 1.5,
    overflow: 'hidden',
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical' as const,
  },
  cardFooter: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
  },
  cardFooterMeta: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
  },
  cardPages: {
    fontSize: 12,
    color: 'var(--color-text-muted)',
  },
  deleteBtn: {
    border: '1px solid rgba(229, 72, 72, 0.24)',
    borderRadius: 999,
    background: 'rgba(229, 72, 72, 0.08)',
    color: 'var(--color-error)',
    fontSize: 12,
    fontWeight: 600,
    padding: '6px 10px',
    cursor: 'pointer',
    flexShrink: 0,
  },
  detailHeader: {
    marginBottom: 14,
    padding: '18px 16px',
    borderRadius: 20,
    border: '1px solid rgba(216, 180, 160, 0.18)',
    background: 'rgba(255,255,255,0.78)',
    boxShadow: '0 12px 30px rgba(188, 116, 88, 0.08)',
  },
  detailTitle: {
    fontSize: 'calc(var(--font-size-chat) + 3px)',
    fontWeight: 600,
    color: 'var(--color-text)',
    margin: '0 0 10px',
    lineHeight: 1.35,
  },
  detailMeta: {
    display: 'flex',
    gap: 12,
    flexWrap: 'wrap',
    fontSize: 13,
    color: 'var(--color-text-secondary)',
  },
  cardDetailActions: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: 8,
    flexWrap: 'wrap',
    marginBottom: 12,
  },
  detailSecondaryBtn: {
    border: '1px solid rgba(212, 135, 108, 0.2)',
    borderRadius: 12,
    background: 'rgba(255,255,255,0.7)',
    color: '#A95B3E',
    fontSize: 13,
    fontWeight: 600,
    padding: '10px 14px',
    cursor: 'pointer',
  },
  detailPrimaryBtn: {
    border: 'none',
    borderRadius: 999,
    background: 'linear-gradient(135deg, #D4876C 0%, #E8A07B 100%)',
    color: '#fff',
    fontSize: 13,
    fontWeight: 600,
    padding: '10px 14px',
    cursor: 'pointer',
  },
  detailFavoriteBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    border: '1px solid rgba(212, 135, 108, 0.2)',
    borderRadius: 999,
    background: 'rgba(255,255,255,0.7)',
    color: '#A95B3E',
    fontSize: 13,
    fontWeight: 600,
    padding: '10px 14px',
    cursor: 'pointer',
  },
  detailBtnDisabled: {
    opacity: 0.6,
    cursor: 'not-allowed',
  },
  cardSaveError: {
    marginBottom: 12,
    fontSize: 12,
    color: '#E54848',
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
  },
  confirmDialog: {
    background: '#FFFDF9',
    borderRadius: 20,
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
  confirmButtonDisabled: {
    opacity: 0.6,
    cursor: 'not-allowed',
  },
  educationList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  },
  educationCard: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    background: 'rgba(255,255,255,0.78)',
    border: '1px solid rgba(216, 180, 160, 0.14)',
    borderRadius: 18,
    padding: 12,
    cursor: 'pointer',
    boxShadow: '0 12px 30px rgba(188, 116, 88, 0.08)',
  },
  educationCardDisabled: {
    cursor: 'default',
    opacity: 0.68,
  },
  educationThumb: {
    width: 64,
    height: 64,
    borderRadius: 14,
    objectFit: 'cover',
    flexShrink: 0,
  },
  educationThumbFallback: {
    width: 64,
    height: 64,
    borderRadius: 14,
    background: 'var(--color-primary-bg)',
    color: 'var(--color-primary)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  educationCardBody: {
    minWidth: 0,
    flex: 1,
  },
  educationTypeTag: {
    display: 'inline-flex',
    alignItems: 'center',
    borderRadius: 999,
    background: 'var(--color-primary-bg)',
    color: 'var(--color-primary)',
    fontSize: 11,
    fontWeight: 700,
    padding: '3px 8px',
    marginBottom: 6,
  },
  educationTypeTagManual: {
    background: 'rgba(183, 112, 90, 0.10)',
    color: '#9D604A',
  },
  educationTypeTagPoster: {
    background: 'rgba(109, 171, 142, 0.12)',
    color: '#5F9279',
  },
  educationCardTitle: {
    margin: '0 0 4px',
    fontSize: 15,
    fontWeight: 700,
    color: 'var(--color-text)',
    lineHeight: 1.35,
    overflow: 'hidden',
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical' as const,
  },
  educationCardSource: {
    margin: 0,
    fontSize: 12,
    color: 'var(--color-text-muted)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  educationRemoveBtn: {
    border: 'none',
    borderRadius: 999,
    background: 'rgba(229, 72, 72, 0.08)',
    color: 'var(--color-error)',
    fontSize: 12,
    fontWeight: 700,
    padding: '7px 10px',
    cursor: 'pointer',
    flexShrink: 0,
  },
  educationEmptyState: {
    padding: '54px 20px',
    textAlign: 'center',
    borderRadius: 20,
    background: 'rgba(255,255,255,0.62)',
    border: '1px solid rgba(216, 180, 160, 0.16)',
  },
  bookmarkIcon: {
    width: 56,
    height: 56,
    margin: '0 auto 14px',
    borderRadius: '50%',
    background: 'var(--color-primary-bg)',
    color: 'var(--color-primary)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  educationEmptyTitle: {
    margin: '0 0 6px',
    fontSize: 16,
    fontWeight: 700,
    color: 'var(--color-text)',
  },
  educationEmptyText: {
    margin: 0,
    fontSize: 13,
    color: 'var(--color-text-muted)',
    lineHeight: 1.5,
  },
  educationContent: {
    fontSize: 15,
    color: 'var(--color-text)',
    lineHeight: 1.8,
  },
}
