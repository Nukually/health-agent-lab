/**
 * MedicalRecords — 健康档案页面
 *
 * 管理结构化病历信息与已上传病历文档。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { api } from '../services/api.js'
import MedicalOcr from '../components/MedicalOcr.js'
import MedicalProfileCard from '../components/MedicalProfileCard.js'
import ImageLightbox from '../components/ImageLightbox.js'
import PrivacyProtectedImage from '../components/PrivacyProtectedImage.js'
import HealthProfileConsentDialog from '../components/agreement/HealthProfileConsentDialog.js'
import { useHealthProfileConsent } from '../hooks/useHealthProfileConsent.js'
import type {
  ApiResponse,
  CurrentConcern,
  MedicalDocument,
  ProfileResponse,
  MedicalProfileData,
} from '@health-agent/shared'

type View = 'list' | 'add' | 'detail'

type DeleteTarget =
  | { kind: 'document'; docId: string }
  | { kind: 'image'; docId: string; imageIndex: number }

function formatUploadTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value

  const pad = (n: number) => (n < 10 ? `0${n}` : String(n))
  const yyyy = date.getFullYear()
  const mm = pad(date.getMonth() + 1)
  const dd = pad(date.getDate())
  const hh = pad(date.getHours())
  const min = pad(date.getMinutes())

  return `${yyyy}-${mm}-${dd} ${hh}:${min}`
}

export default function MedicalRecords() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const returnSessionId = searchParams.get('returnSessionId')
  const returnToChatPath = returnSessionId ? `/chat/${returnSessionId}` : '/chat'
  const shouldReturnToSettings = searchParams.get('returnToSettings') === '1' || !!returnSessionId
  const returnToSettingsState = useMemo(
    () => (shouldReturnToSettings ? { openSidebar: true } : undefined),
    [shouldReturnToSettings],
  )
  const { guard, hasConsent, dialogProps } = useHealthProfileConsent()
  const [view, setView] = useState<View>('list')
  const [docs, setDocs] = useState<MedicalDocument[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedDoc, setSelectedDoc] = useState<MedicalDocument | null>(null)
  const selectedDocIdRef = useRef<string | null>(null)
  const imageRefreshAttemptsRef = useRef<Set<string>>(new Set())

  const [gender, setGender] = useState<string | null>(null)
  const [currentConcern, setCurrentConcern] = useState<CurrentConcern | null>(null)
  const [medicalProfileData, setMedicalProfileData] = useState<MedicalProfileData | null>(null)
  const [lightboxOpen, setLightboxOpen] = useState(false)
  const [lightboxIndex, setLightboxIndex] = useState(0)
  const [deletingImageIndex, setDeletingImageIndex] = useState<number | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null)
  const [isConfirmDeleting, setIsConfirmDeleting] = useState(false)

  useEffect(() => {
    if (hasConsent) return
    guard(
      () => {},
      () => navigate(returnToChatPath, { replace: true, state: returnToSettingsState }),
    )
  }, [guard, hasConsent, navigate, returnToChatPath, returnToSettingsState])

  useEffect(() => {
    if (!hasConsent) return
    void loadDocs()
  }, [hasConsent])

  useEffect(() => {
    if (!hasConsent) return
    api.get<ApiResponse<ProfileResponse>>('/medical')
      .then((res) => {
        if (res.data) {
          setGender(res.data.user?.gender ?? null)
          setCurrentConcern(res.data.user?.currentConcern ?? null)
          setMedicalProfileData(res.data.medical?.profileData ?? null)
        }
      })
      .catch(() => {})
  }, [hasConsent])

  async function loadDocs() {
    setLoading(true)
    try {
      const res = await api.get<ApiResponse<MedicalDocument[]>>('/medical/documents')
      if (res.data) setDocs(res.data)
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }

  async function refreshDocument(docId: string): Promise<MedicalDocument | null> {
    try {
      const res = await api.get<ApiResponse<MedicalDocument>>(`/medical/documents/${docId}`)
      if (!res.data) return null

      const freshDoc = res.data
      setDocs((prev) => prev.map((doc) => (doc.id === freshDoc.id ? freshDoc : doc)))
      if (selectedDocIdRef.current === freshDoc.id) {
        setSelectedDoc(freshDoc)
      }
      return freshDoc
    } catch {
      return null
    }
  }

  async function handleDelete(docId: string) {
    try {
      const suffix = returnSessionId ? `?sessionId=${encodeURIComponent(returnSessionId)}` : ''
      await api.delete(`/medical/documents/${docId}${suffix}`)
      setDocs((prev) => prev.filter((d) => d.id !== docId))
      if (selectedDoc?.id === docId) {
        selectedDocIdRef.current = null
        imageRefreshAttemptsRef.current.clear()
        setSelectedDoc(null)
        setView('list')
      }
    } catch {
      // ignore
    }
  }

  async function handleDeleteImage(docId: string, imageIndex: number) {
    if (!selectedDoc || selectedDoc.id !== docId || selectedDoc.imageUrls.length <= 1) return

    setDeletingImageIndex(imageIndex)
    try {
      const suffix = returnSessionId ? `?sessionId=${encodeURIComponent(returnSessionId)}` : ''
      const res = await api.delete<ApiResponse<MedicalDocument>>(
        `/medical/documents/${docId}/images/${imageIndex}${suffix}`,
      )
      if (!res.data) return

      const freshDoc = res.data
      setDocs((prev) => prev.map((doc) => (doc.id === freshDoc.id ? freshDoc : doc)))
      if (selectedDocIdRef.current === freshDoc.id) {
        setSelectedDoc(freshDoc)
        setLightboxOpen(false)
        setLightboxIndex((prev) => Math.min(prev, Math.max(freshDoc.imageUrls.length - 1, 0)))
      }
      imageRefreshAttemptsRef.current.clear()
    } catch {
      // ignore
    } finally {
      setDeletingImageIndex(null)
    }
  }

  function getDeleteConfirmText(target: DeleteTarget): string {
    if (target.kind === 'image') return `确定删除第 ${target.imageIndex + 1} 张病历图片？`
    return '确定删除这份病历？'
  }

  async function confirmDeleteTarget() {
    if (!deleteTarget) return
    const target = deleteTarget
    setIsConfirmDeleting(true)
    try {
      if (target.kind === 'image') {
        await handleDeleteImage(target.docId, target.imageIndex)
      } else {
        await handleDelete(target.docId)
      }
    } finally {
      setIsConfirmDeleting(false)
      setDeleteTarget(null)
    }
  }

  function openDetail(doc: MedicalDocument) {
    selectedDocIdRef.current = doc.id
    imageRefreshAttemptsRef.current.clear()
    setSelectedDoc(doc)
    setView('detail')
    void refreshDocument(doc.id)
  }

  function handleImageError(docId: string, imageIndex: number) {
    const key = `${docId}:${imageIndex}`
    if (imageRefreshAttemptsRef.current.has(key)) return

    imageRefreshAttemptsRef.current.add(key)
    void refreshDocument(docId)
  }

  const typeLabels: Record<string, string> = {
    outpatient: '门诊病历',
    pathology: '病理报告',
    imaging: '影像报告',
    discharge: '出院记录',
    lab: '检验报告',
    other: '其他',
  }

  return (
    <div style={styles.container}>
      <div style={styles.scrollArea}>
        <div style={styles.nav}>
          <button
            style={styles.backBtn}
            onClick={() => {
              if (view === 'detail') {
                selectedDocIdRef.current = null
                imageRefreshAttemptsRef.current.clear()
                setLightboxOpen(false)
                setView('list')
                setSelectedDoc(null)
              } else if (view === 'add') {
                setView('list')
              } else {
                navigate(returnToChatPath, { state: returnToSettingsState })
              }
            }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
            <span>{view === 'list' ? '返回' : '返回列表'}</span>
          </button>
          {view === 'list' && (
            <button style={styles.addNavBtn} onClick={() => setView('add')}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
          )}
        </div>

        {view === 'list' && (
          <div style={styles.content}>
            <MedicalProfileCard
              gender={gender}
              currentConcern={currentConcern}
              initialData={medicalProfileData}
              sessionId={returnSessionId ?? undefined}
              onSaved={(profileData) => setMedicalProfileData(profileData)}
            />

            <div style={styles.sectionHeader}>病历文档</div>

            {loading ? (
              <div style={styles.emptyState}>加载中...</div>
            ) : docs.length === 0 ? (
              <div style={styles.emptyState}>
                <p style={{ margin: '0 0 12px', color: 'var(--color-text-muted)' }}>暂无病历文档</p>
                <button style={styles.emptyAddBtn} onClick={() => setView('add')}>
                  上传第一份病历
                </button>
              </div>
            ) : (
              <div style={styles.timeline}>
                {docs.map((doc) => (
                  <div key={doc.id} style={styles.timelineItem} onClick={() => openDetail(doc)}>
                    <div style={styles.timelineDot} />
                    <div style={styles.card}>
                      <div style={styles.cardHeader}>
                        <span style={styles.cardDate}>
                          {doc.documentDate || doc.uploadedAt.slice(0, 10)}
                        </span>
                        {doc.documentType && (
                          <span style={styles.cardTag}>
                            {typeLabels[doc.documentType] || doc.documentType}
                          </span>
                        )}
                      </div>
                      {doc.title && <p style={styles.cardTitle}>{doc.title}</p>}
                      {doc.hospital && <p style={styles.cardSub}>{doc.hospital}</p>}
                      <div style={styles.cardFooter}>
                        <div style={styles.cardFooterMeta}>
                          <span style={styles.cardPages}>{doc.pageCount}页</span>
                          <span style={styles.cardUploadTime}>
                            上传于 {formatUploadTime(doc.uploadedAt)}
                          </span>
                        </div>
                        <button
                          style={styles.deleteBtn}
                          onClick={(e) => {
                            e.stopPropagation()
                            setDeleteTarget({ kind: 'document', docId: doc.id })
                          }}
                        >
                          删除
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {view === 'add' && (
          <div style={styles.content}>
            <h1 style={styles.title}>上传病历</h1>
            <MedicalOcr
              sessionId={returnSessionId ?? undefined}
              onFieldsExtracted={(fields) => {
                setMedicalProfileData((prev) => ({ ...(prev ?? {}), ...fields }))
              }}
              onPersonalInfoExtracted={(info) => {
                if (info.gender) setGender(info.gender)
              }}
              onDocumentCreated={(doc) => {
                setDocs((prev) => [doc, ...prev])
                setView('list')
              }}
              onClose={() => setView('list')}
            />
          </div>
        )}

        {view === 'detail' && selectedDoc && (
          <div style={styles.content}>
            <div style={styles.detailHeader}>
              {selectedDoc.title && <h2 style={styles.detailTitle}>{selectedDoc.title}</h2>}
              <div style={styles.detailMeta}>
                {selectedDoc.documentDate && <span>{selectedDoc.documentDate}</span>}
                {selectedDoc.hospital && <span>{selectedDoc.hospital}</span>}
                {selectedDoc.documentType && (
                  <span>{typeLabels[selectedDoc.documentType] || selectedDoc.documentType}</span>
                )}
                <span>上传于 {formatUploadTime(selectedDoc.uploadedAt)}</span>
              </div>
            </div>

            {selectedDoc.imageUrls.length > 0 && (
              <div style={styles.detailImages}>
                {selectedDoc.imageUrls.map((url, i) => (
                  <div key={i} style={styles.detailImageItem}>
                    <PrivacyProtectedImage
                      src={url}
                      alt={`病历图片 ${i + 1}`}
                      imageStyle={styles.detailImg}
                      wrapperStyle={styles.detailImageWrap}
                      onClick={() => {
                        setLightboxIndex(i)
                        setLightboxOpen(true)
                      }}
                      onError={() => handleImageError(selectedDoc.id, i)}
                    />
                    {selectedDoc.imageUrls.length > 1 && (
                      <button
                        type="button"
                        style={{
                          ...styles.imageDeleteBtn,
                          opacity: deletingImageIndex === i ? 0.6 : 1,
                        }}
                        title="删除这张图片"
                        aria-label={`删除第 ${i + 1} 张病历图片`}
                        disabled={deletingImageIndex !== null}
                        onClick={(e) => {
                          e.stopPropagation()
                          setDeleteTarget({ kind: 'image', docId: selectedDoc.id, imageIndex: i })
                        }}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="M3 6h18" />
                          <path d="M8 6V4h8v2" />
                          <path d="M19 6l-1 14H6L5 6" />
                          <path d="M10 11v5" />
                          <path d="M14 11v5" />
                        </svg>
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}

            {lightboxOpen && (
              <ImageLightbox
                images={selectedDoc.imageUrls}
                initialIndex={lightboxIndex}
                privacyProtected
                onClose={() => setLightboxOpen(false)}
              />
            )}

            <button
              style={styles.deleteBtnFull}
              onClick={() => setDeleteTarget({ kind: 'document', docId: selectedDoc.id })}
            >
              删除此病历
            </button>
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
                {isConfirmDeleting ? '删除中...' : '确定删除'}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
      <HealthProfileConsentDialog {...dialogProps} />
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
    justifyContent: 'space-between',
    alignItems: 'center',
    minHeight: 40,
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
  addNavBtn: {
    width: 44,
    height: 44,
    borderRadius: '50%',
    background: 'linear-gradient(135deg, #D4876C 0%, #E4A084 100%)',
    color: '#fff',
    border: '3px solid rgba(255,255,255,0.92)',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    boxShadow: '0 10px 26px rgba(188, 116, 88, 0.18)',
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
  sectionHeader: {
    fontSize: 18,
    fontWeight: 700,
    color: 'var(--color-text)',
    letterSpacing: 0,
    marginTop: 22,
    marginBottom: 12,
  },
  emptyState: {
    textAlign: 'center',
    padding: '44px 18px',
    borderRadius: 20,
    background: 'rgba(255,255,255,0.62)',
    border: '1px solid rgba(216, 180, 160, 0.16)',
  },
  emptyAddBtn: {
    height: 40,
    padding: '0 20px',
    borderRadius: 999,
    background: 'linear-gradient(135deg, #D4876C 0%, #E4A084 100%)',
    color: '#fff',
    fontSize: 14,
    fontWeight: 500,
    border: 'none',
    cursor: 'pointer',
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
  cardTitle: {
    fontSize: 15,
    fontWeight: 500,
    color: 'var(--color-text)',
    margin: '0 0 4px',
  },
  cardSub: {
    fontSize: 13,
    color: 'var(--color-text-secondary)',
    margin: '0 0 6px',
  },
  cardFooter: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
    flexWrap: 'wrap',
  },
  cardFooterMeta: {
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    minWidth: 0,
  },
  cardPages: {
    fontSize: 12,
    color: 'var(--color-text-muted)',
  },
  cardUploadTime: {
    fontSize: 12,
    color: 'var(--color-text-muted)',
  },
  deleteBtn: {
    background: 'rgba(229, 72, 72, 0.08)',
    border: '1px solid rgba(229, 72, 72, 0.18)',
    borderRadius: 999,
    color: 'var(--color-error)',
    fontSize: 12,
    cursor: 'pointer',
    padding: '5px 10px',
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
    fontSize: 20,
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
  detailImages: {
    display: 'flex',
    gap: 10,
    overflowX: 'auto',
    marginBottom: 16,
    paddingBottom: 4,
  },
  detailImageItem: {
    position: 'relative',
    width: 132,
    height: 176,
    flexShrink: 0,
  },
  detailImg: {
    width: '100%',
    height: '100%',
    borderRadius: 16,
    objectFit: 'cover',
    border: '1px solid rgba(216, 180, 160, 0.18)',
    cursor: 'pointer',
  },
  detailImageWrap: {
    width: '100%',
    height: '100%',
  },
  imageDeleteBtn: {
    position: 'absolute',
    top: 6,
    right: 6,
    width: 28,
    height: 28,
    borderRadius: '50%',
    border: '1px solid rgba(255,240,240,0.95)',
    background: 'var(--color-error)',
    color: '#fff',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    padding: 0,
  },
  deleteBtnFull: {
    width: '100%',
    height: 44,
    borderRadius: 999,
    border: '1px solid var(--color-error)',
    background: 'transparent',
    color: 'var(--color-error)',
    fontSize: 14,
    cursor: 'pointer',
  },
  confirmOverlay: {
    position: 'fixed',
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
    textAlign: 'center',
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
}
