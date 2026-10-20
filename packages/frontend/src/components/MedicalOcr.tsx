/**
 * MedicalOcr — 病历图片上传与 OCR 解析组件
 *
 * 支持拍照（连拍）和相册多选，上传后由后端生成模型图和缩略图，
 * 返回结构化字段供父组件自动填充。
 */

import { useState, useRef, useEffect, useCallback } from 'react'
import { api } from '../services/api.js'
import ImageLightbox from './ImageLightbox.js'
import PrivacyProtectedImage from './PrivacyProtectedImage.js'
import type {
  ApiResponse,
  MedicalProfileData,
  OcrResult,
  MedicalDocument,
  MedicalDocumentOcrResult,
  ExtractedPersonalInfo,
  ImageAssetUploadResponse,
  MessageImageAttachment,
} from '@health-agent/shared'

const MAX_IMAGES = 10
const MAX_IMAGE_SIZE = 12 * 1024 * 1024
const waitForPaint = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

interface Props {
  sessionId?: string
  onFieldsExtracted?: (fields: MedicalProfileData) => void
  onPersonalInfoExtracted?: (info: ExtractedPersonalInfo) => void
  onDocumentCreated?: (doc: MedicalDocument) => void
  onClose?: () => void
}

type Status = 'idle' | 'uploading' | 'success' | 'error' | 'nonMedical'
type UploadingImage = {
  uploadId: string
  previewUrl: string
  status: 'uploading'
}
type UploadedImage = MessageImageAttachment & {
  uploadId: string
  previewUrl: string
  status: 'ready'
}
type SelectedImage = UploadingImage | UploadedImage

function isUploadedImage(image: SelectedImage): image is UploadedImage {
  return image.status === 'ready'
}

export default function MedicalOcr({ sessionId, onFieldsExtracted, onPersonalInfoExtracted, onDocumentCreated, onClose }: Props) {
  const [images, setImages] = useState<SelectedImage[]>([])
  const [status, setStatus] = useState<Status>('idle')
  const [error, setError] = useState('')
  const [toast, setToast] = useState<string | null>(null)
  const [result, setResult] = useState<MedicalDocumentOcrResult | null>(null)
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null)
  const [isProcessingImages, setIsProcessingImages] = useState(false)

  const cameraRef = useRef<HTMLInputElement>(null)
  const albumRef = useRef<HTMLInputElement>(null)
  const isProcessingImagesRef = useRef(false)
  const objectUrlsRef = useRef<Set<string>>(new Set())

  const revokePreviewUrl = useCallback((url: string) => {
    if (!url.startsWith('blob:')) return
    URL.revokeObjectURL(url)
    objectUrlsRef.current.delete(url)
  }, [])

  const showToast = useCallback((message: string) => {
    setToast(message)
    window.setTimeout(() => setToast(null), 3000)
  }, [])

  // 注入 spinner keyframes（inline style 不支持 @keyframes）
  useEffect(() => {
    const id = 'medical-ocr-spin'
    if (document.getElementById(id)) return
    const style = document.createElement('style')
    style.id = id
    style.textContent = '@keyframes spin { to { transform: rotate(360deg) } }'
    document.head.appendChild(style)
  }, [])

  useEffect(() => {
    return () => {
      for (const url of objectUrlsRef.current) URL.revokeObjectURL(url)
      objectUrlsRef.current.clear()
    }
  }, [])

  async function addFiles(files: File[]) {
    if (files.length === 0) return
    if (isProcessingImagesRef.current) {
      showToast('图片正在处理，请稍候')
      return
    }

    const remaining = MAX_IMAGES - images.length
    if (remaining <= 0) {
      showToast(`最多上传 ${MAX_IMAGES} 张图片`)
      return
    }
    if (files.length > remaining) {
      showToast(`最多上传 ${MAX_IMAGES} 张图片，仅保留前 ${remaining} 张`)
    }

    isProcessingImagesRef.current = true
    setIsProcessingImages(true)
    await waitForPaint()

    try {
      for (const file of files.slice(0, remaining)) {
        if (file.size > MAX_IMAGE_SIZE) {
          showToast('单张图片不能超过 12MB')
          continue
        }
        const previewUrl = URL.createObjectURL(file)
        const uploadId = `${Date.now()}-${Math.random().toString(36).slice(2)}`
        objectUrlsRef.current.add(previewUrl)
        setImages((prev) => [...prev, { uploadId, previewUrl, status: 'uploading' }])
        try {
          const form = new FormData()
          form.append('images', file)
          form.append('purpose', 'medical')
          const res = await api.postForm<ApiResponse<ImageAssetUploadResponse>>('/images/upload', form)
          const asset = res.data?.assets?.[0]
          if (!asset) throw new Error('图片上传失败，请稍后重试')
          setImages((prev) => prev.map((image) => image.uploadId === uploadId
            ? { ...asset, uploadId, previewUrl, status: 'ready' }
            : image))
        } catch (err) {
          setImages((prev) => prev.filter((image) => image.uploadId !== uploadId))
          revokePreviewUrl(previewUrl)
          showToast(
            err instanceof Error
              ? err.message
              : '不支持的图片格式（如 HEIC/TIFF），请转为 JPG/PNG 后重试',
          )
        }
      }
    } finally {
      isProcessingImagesRef.current = false
      setIsProcessingImages(false)
    }
  }

  function handleCamera(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files || [])
    e.target.value = ''
    void addFiles(files)
  }

  function handleAlbum(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files || [])
    e.target.value = ''
    void addFiles(files)
  }

  function removeImage(index: number) {
    setImages((prev) => {
      const target = prev[index]
      if (target) revokePreviewUrl(target.previewUrl)
      return prev.filter((_, i) => i !== index)
    })
  }

  async function handleSubmit() {
    if (images.length === 0 || isProcessingImagesRef.current) return
    setStatus('uploading')
    setError('')

    try {
      const res = await api.post<ApiResponse<OcrResult>>('/medical/ocr', {
        imageAssetIds: images.filter(isUploadedImage).map((image) => image.assetId),
        ...(sessionId ? { sessionId } : {}),
      })
      if (res.data?.isMedicalDocument === false) {
        setResult(null)
        setError(res.data.reason || '这张图片不像病历相关文件，请上传病历、检查报告、出院记录、处方或用药单等医疗资料。')
        setStatus('nonMedical')
        return
      }
      if (res.data?.isMedicalDocument) {
        setResult(res.data)
        setStatus('success')
        onFieldsExtracted?.(res.data.extractedFields)
        if (res.data.extractedPersonalInfo) onPersonalInfoExtracted?.(res.data.extractedPersonalInfo)
        onDocumentCreated?.(res.data.document)
      }
    } catch (err: any) {
      setError(err.message || '解析失败，请稍后重试')
      setStatus('error')
    }
  }

  // 成功后关闭
  function handleDone() {
    onClose?.()
  }

  const extractedFieldCount = result
    ? Object.keys(result.extractedFields ?? {}).filter((key) => key !== 'fieldUpdatedAt').length
    : 0

  return (
    <div style={styles.container}>
      {toast && <div style={styles.toast}>{toast}</div>}
      <div style={styles.header}>
        <h3 style={styles.title}>上传病历图片</h3>
        <p style={styles.subtitle}>拍照或从相册选择病历，AI 将自动识别并填充信息</p>
      </div>

      {/* 图片预览列表 */}
      {images.length > 0 && (
        <div style={styles.previewGrid}>
          {images.map((image, i) => (
            <div key={image.uploadId} style={styles.previewItem}>
              {image.status === 'uploading' ? (
                <>
                  <img
                    src={image.previewUrl}
                    alt={`病历 ${i + 1}`}
                    style={{ ...styles.previewImg, ...styles.previewImgUploading }}
                  />
                  <div style={styles.previewUploadingOverlay} aria-label="正在处理图片">
                    <span style={styles.previewSpinner} />
                  </div>
                </>
              ) : (
                <PrivacyProtectedImage
                  src={image.previewUrl}
                  alt={`病历 ${i + 1}`}
                  imageStyle={styles.previewImg}
                  wrapperStyle={styles.previewImageWrap}
                  badgeStyle={styles.previewBadge}
                  privacyProtected={status === 'success'}
                  onClick={() => setLightboxIndex(i)}
                />
              )}
              {image.status === 'ready' && (status === 'idle' || status === 'nonMedical') && !isProcessingImages && (
                <button
                  style={styles.removeBtn}
                  onClick={(e) => {
                    e.stopPropagation()
                    removeImage(i)
                  }}
                >
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
                    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* 操作区域 */}
      {status === 'idle' && (
        <>
          {/* 添加图片按钮 */}
          {images.length < MAX_IMAGES && (
            <div style={styles.btnRow}>
              <button
                style={{
                  ...styles.addBtn,
                  ...(isProcessingImages ? styles.disabledBtn : {}),
                }}
                onClick={() => cameraRef.current?.click()}
                disabled={isProcessingImages}
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                  <circle cx="12" cy="13" r="4" />
                </svg>
                <span>拍照</span>
              </button>
              <button
                style={{
                  ...styles.addBtn,
                  ...(isProcessingImages ? styles.disabledBtn : {}),
                }}
                onClick={() => albumRef.current?.click()}
                disabled={isProcessingImages}
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                  <circle cx="8.5" cy="8.5" r="1.5" />
                  <polyline points="21 15 16 10 5 21" />
                </svg>
                <span>从相册选择</span>
              </button>
            </div>
          )}

          <input ref={cameraRef} type="file" accept="image/*" capture="environment" style={{ display: 'none' }} onChange={handleCamera} />
          <input ref={albumRef} type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={handleAlbum} />

          {images.length > 0 && (
            <button
              style={{
                ...styles.submitBtn,
                ...(isProcessingImages ? styles.disabledBtn : {}),
              }}
              onClick={handleSubmit}
              disabled={isProcessingImages}
            >
              开始识别（{images.length}张）
            </button>
          )}

          {onClose && (
            <button style={styles.cancelBtn} onClick={onClose}>取消</button>
          )}
        </>
      )}

      {/* 上传/解析中 */}
      {status === 'uploading' && (
        <div style={styles.loadingWrap}>
          <div style={styles.spinner} />
          <p style={styles.loadingText}>正在识别病历内容...</p>
          <p style={styles.loadingHint}>可能需要 10-20 秒，请耐心等待</p>
        </div>
      )}

      {/* 错误 */}
      {status === 'error' && (
        <div style={styles.errorWrap}>
          <p style={styles.errorText}>{error}</p>
          <button style={styles.retryBtn} onClick={() => setStatus('idle')}>重试</button>
        </div>
      )}

      {status === 'nonMedical' && (
        <div style={styles.noticeWrap}>
          <p style={styles.noticeTitle}>请上传病历相关文件</p>
          <p style={styles.noticeText}>{error}</p>
          <button
            style={styles.retryBtn}
            onClick={() => {
              for (const image of images) revokePreviewUrl(image.previewUrl)
              setImages([])
              setError('')
              setStatus('idle')
            }}
          >
            重新选择
          </button>
        </div>
      )}

      {/* 成功 */}
      {status === 'success' && result && (
        <div style={styles.successWrap}>
          <div style={styles.successIcon}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--color-success)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          </div>
          <p style={styles.successTitle}>识别完成</p>
          {result.document.title && (
            <p style={styles.successDetail}>{result.document.title}</p>
          )}
          {result.document.hospital && (
            <p style={styles.successDetail}>{result.document.hospital}</p>
          )}
          {result.document.documentDate && (
            <p style={styles.successDetail}>{result.document.documentDate}</p>
          )}
          <p style={styles.successHint}>
            {extractedFieldCount > 0
              ? '已自动填充可识别的档案字段，请核对后保存'
              : '病历图片已保存，可返回档案页继续补充信息'}
          </p>
          <button style={styles.submitBtn} onClick={handleDone}>确认</button>
        </div>
      )}

      {lightboxIndex !== null && (
        <ImageLightbox
          images={images.filter(isUploadedImage).map((image) => image.displayUrl ?? image.previewUrl)}
          downloadImages={images.filter(isUploadedImage).map((image) => image.originalUrl ?? image.displayUrl ?? image.previewUrl)}
          initialIndex={lightboxIndex}
          privacyProtected={status === 'success'}
          onClose={() => setLightboxIndex(null)}
        />
      )}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    background: 'var(--color-surface)',
    borderRadius: 16,
    padding: 20,
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
  },
  toast: {
    padding: '6px 12px',
    borderRadius: 8,
    background: 'var(--color-error-bg)',
    color: 'var(--color-error)',
    fontSize: 13,
    textAlign: 'center' as const,
  },
  header: {},
  title: {
    fontSize: 16,
    fontWeight: 600,
    color: 'var(--color-text)',
    margin: '0 0 4px',
  },
  subtitle: {
    fontSize: 13,
    color: 'var(--color-text-muted)',
    margin: 0,
    lineHeight: 1.5,
  },
  previewGrid: {
    display: 'flex',
    flexWrap: 'wrap' as const,
    gap: 8,
  },
  previewItem: {
    position: 'relative' as const,
    width: 72,
    height: 72,
  },
  previewImageWrap: {
    width: '100%',
    height: '100%',
  },
  previewImg: {
    width: '100%',
    height: '100%',
    borderRadius: 10,
    objectFit: 'cover' as const,
    border: '1px solid var(--color-border)',
    cursor: 'pointer',
  },
  previewImgUploading: {
    display: 'block',
    filter: 'saturate(0.72) brightness(0.82)',
    cursor: 'default',
  },
  previewUploadingOverlay: {
    position: 'absolute',
    inset: 0,
    borderRadius: 10,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'rgba(24, 20, 18, 0.28)',
    pointerEvents: 'none',
  },
  previewSpinner: {
    width: 24,
    height: 24,
    borderRadius: '50%',
    border: '2.5px solid rgba(255, 255, 255, 0.58)',
    borderTopColor: '#fff',
    animation: 'spin 0.8s linear infinite',
    boxShadow: '0 2px 10px rgba(0,0,0,0.16)',
  },
  previewBadge: {
    top: 4,
    right: 4,
    minHeight: 18,
    padding: '0 6px 0 3px',
    fontSize: 10,
    transform: 'scale(0.78)',
    transformOrigin: 'top right',
  },
  removeBtn: {
    position: 'absolute' as const,
    top: -6,
    right: -6,
    width: 20,
    height: 20,
    borderRadius: '50%',
    background: 'var(--color-error)',
    color: '#fff',
    border: 'none',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
  },
  btnRow: {
    display: 'flex',
    gap: 10,
  },
  addBtn: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    height: 44,
    borderRadius: 12,
    border: '1.5px dashed var(--color-border)',
    background: 'transparent',
    color: 'var(--color-text-secondary)',
    fontSize: 14,
    fontWeight: 500,
    cursor: 'pointer',
    transition: 'all 0.2s',
  },
  submitBtn: {
    width: '100%',
    height: 44,
    borderRadius: 12,
    background: 'var(--color-primary)',
    color: '#fff',
    fontSize: 15,
    fontWeight: 600,
    border: 'none',
    cursor: 'pointer',
    marginTop: 8,
    transition: 'opacity 0.2s',
  },
  disabledBtn: {
    opacity: 0.55,
    cursor: 'not-allowed',
  },
  cancelBtn: {
    background: 'none',
    border: 'none',
    color: 'var(--color-text-muted)',
    fontSize: 13,
    cursor: 'pointer',
    textAlign: 'center' as const,
  },
  loadingWrap: {
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    gap: 12,
    padding: '20px 0',
  },
  spinner: {
    width: 32,
    height: 32,
    border: '3px solid var(--color-border)',
    borderTopColor: 'var(--color-primary)',
    borderRadius: '50%',
    animation: 'spin 0.8s linear infinite',
  },
  loadingText: {
    fontSize: 15,
    color: 'var(--color-text)',
    margin: 0,
  },
  loadingHint: {
    fontSize: 12,
    color: 'var(--color-text-muted)',
    margin: 0,
  },
  errorWrap: {
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    gap: 12,
  },
  errorText: {
    fontSize: 14,
    color: 'var(--color-error)',
    margin: 0,
    textAlign: 'center' as const,
  },
  noticeWrap: {
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    gap: 10,
    padding: '12px',
    borderRadius: 12,
    background: 'var(--color-primary-bg)',
    border: '1px solid rgba(255, 106, 42, 0.18)',
  },
  noticeTitle: {
    fontSize: 15,
    fontWeight: 700,
    color: 'var(--color-primary)',
    margin: 0,
  },
  noticeText: {
    fontSize: 13,
    lineHeight: 1.5,
    color: 'var(--color-text-secondary)',
    margin: 0,
    textAlign: 'center' as const,
  },
  retryBtn: {
    height: 36,
    padding: '0 24px',
    borderRadius: 10,
    border: '1px solid var(--color-border)',
    background: 'transparent',
    color: 'var(--color-text)',
    fontSize: 14,
    cursor: 'pointer',
  },
  successWrap: {
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    gap: 8,
    padding: '12px 0',
  },
  successIcon: {
    width: 48,
    height: 48,
    borderRadius: '50%',
    background: 'rgba(109,171,142,0.1)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  successTitle: {
    fontSize: 16,
    fontWeight: 600,
    color: 'var(--color-text)',
    margin: 0,
  },
  successDetail: {
    fontSize: 13,
    color: 'var(--color-text-secondary)',
    margin: 0,
  },
  successHint: {
    fontSize: 12,
    color: 'var(--color-text-muted)',
    margin: '4px 0 0',
  },
}
