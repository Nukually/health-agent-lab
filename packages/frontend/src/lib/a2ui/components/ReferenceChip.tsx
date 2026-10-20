import { useState } from 'react'
import type {
  ApiResponse,
  MedicalDocument,
  SyntheticDocPreview,
} from '@health-agent/shared'
import ImageLightbox from '../../../components/ImageLightbox.js'
import { api } from '../../../services/api.js'

interface Props {
  doc: SyntheticDocPreview
}

export default function ReferenceChip({ doc }: Props) {
  const [loading, setLoading] = useState(false)
  const [lightboxImages, setLightboxImages] = useState<string[] | null>(null)

  const label = doc.shortId != null ? `病历 #${doc.shortId}` : (doc.title || '病历引用')

  async function handleOpen() {
    const directImages = doc.imageUrls?.filter(Boolean) ?? []
    if (directImages.length > 0) {
      setLightboxImages(directImages)
      return
    }

    if (doc.docId) {
      setLoading(true)
      try {
        const res = await api.get<ApiResponse<MedicalDocument>>(`/medical/documents/${doc.docId}`)
        const fetchedImages = res.data?.imageUrls?.filter(Boolean) ?? []
        if (fetchedImages.length > 0) {
          setLightboxImages(fetchedImages)
          return
        }
      } catch {
        // ignore
      } finally {
        setLoading(false)
      }
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => void handleOpen()}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          padding: '3px 9px',
          border: '1px solid #E5E7EB',
          borderRadius: 12,
          background: '#fff',
          fontSize: 'calc(var(--font-size-chat) - 2px)',
          color: 'var(--color-text-muted)',
          cursor: loading ? 'progress' : 'pointer',
          lineHeight: 1.4,
          marginRight: 6,
          opacity: loading ? 0.7 : 1,
          WebkitTapHighlightColor: 'transparent',
        }}
        aria-label={loading ? `正在加载${label}` : `查看${label}`}
      >
        <svg
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
        </svg>
        <span>{loading ? '原图加载中...' : label}</span>
      </button>

      {lightboxImages && (
        <ImageLightbox
          images={lightboxImages}
          initialIndex={0}
          privacyProtected
          onClose={() => setLightboxImages(null)}
        />
      )}
    </>
  )
}
