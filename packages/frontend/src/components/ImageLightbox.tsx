import { useState, useEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { PrivacyProtectionBadge } from './PrivacyProtectedImage.js'

interface Props {
  images: string[]
  downloadImages?: string[]
  initialIndex: number
  onClose: () => void
  privacyProtected?: boolean
}

type Phase = 'closed' | 'opening' | 'open' | 'closing'

export default function ImageLightbox({ images, downloadImages, initialIndex, onClose, privacyProtected = false }: Props) {
  const [currentIndex, setCurrentIndex] = useState(initialIndex)
  const [phase, setPhase] = useState<Phase>('closed')
  const [scale, setScale] = useState(1)
  const [translate, setTranslate] = useState({ x: 0, y: 0 })

  const touchStartRef = useRef({ x: 0, y: 0, time: 0 })
  const lastTapRef = useRef(0)
  const pinchStartDistRef = useRef(0)
  const pinchStartScaleRef = useRef(1)
  const isDraggingRef = useRef(false)
  const translateStartRef = useRef({ x: 0, y: 0 })

  // Phase transition
  useEffect(() => {
    setPhase('opening')
    requestAnimationFrame(() => {
      requestAnimationFrame(() => setPhase('open'))
    })
  }, [])

  const handleClose = useCallback(() => {
    setPhase('closing')
    setTimeout(() => onClose(), 250)
  }, [onClose])

  // ESC key
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') handleClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [handleClose])

  // Reset zoom when switching images
  useEffect(() => {
    setScale(1)
    setTranslate({ x: 0, y: 0 })
  }, [currentIndex])

  function getTouchDist(e: React.TouchEvent) {
    const [a, b] = [e.touches[0], e.touches[1]]
    return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
  }

  function handleTouchStart(e: React.TouchEvent) {
    if (e.touches.length === 2) {
      pinchStartDistRef.current = getTouchDist(e)
      pinchStartScaleRef.current = scale
      return
    }
    const t = e.touches[0]
    touchStartRef.current = { x: t.clientX, y: t.clientY, time: Date.now() }
    if (scale > 1) {
      isDraggingRef.current = true
      translateStartRef.current = { ...translate }
    }
  }

  function handleTouchMove(e: React.TouchEvent) {
    e.preventDefault()
    if (e.touches.length === 2) {
      const dist = getTouchDist(e)
      const ratio = dist / pinchStartDistRef.current
      setScale(Math.min(4, Math.max(1, pinchStartScaleRef.current * ratio)))
      return
    }
    if (isDraggingRef.current && scale > 1) {
      const dx = e.touches[0].clientX - touchStartRef.current.x
      const dy = e.touches[0].clientY - touchStartRef.current.y
      setTranslate({
        x: translateStartRef.current.x + dx,
        y: translateStartRef.current.y + dy,
      })
    }
  }

  function handleTouchEnd(e: React.TouchEvent) {
    if (e.touches.length > 0) return
    isDraggingRef.current = false

    if (scale <= 1) {
      setScale(1)
      setTranslate({ x: 0, y: 0 })
    }

    const dx = e.changedTouches[0].clientX - touchStartRef.current.x
    const dy = e.changedTouches[0].clientY - touchStartRef.current.y
    const elapsed = Date.now() - touchStartRef.current.time

    // Double tap detection
    if (Math.abs(dx) < 10 && Math.abs(dy) < 10 && elapsed < 300) {
      const now = Date.now()
      if (now - lastTapRef.current < 300) {
        lastTapRef.current = 0
        if (scale > 1) {
          setScale(1)
          setTranslate({ x: 0, y: 0 })
        } else {
          setScale(2.5)
        }
        return
      }
      lastTapRef.current = now
    }

    // Swipe detection (only at 1x scale)
    if (scale <= 1 && Math.abs(dx) > 60 && elapsed < 400) {
      if (dx < 0 && currentIndex < images.length - 1) {
        setCurrentIndex(currentIndex + 1)
      } else if (dx > 0 && currentIndex > 0) {
        setCurrentIndex(currentIndex - 1)
      }
    }
  }

  async function handleDownload() {
    const url = downloadImages?.[currentIndex] ?? images[currentIndex]
    try {
      const res = await fetch(url)
      const blob = await res.blob()
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `medical-image-${currentIndex + 1}.jpg`
      a.click()
      URL.revokeObjectURL(a.href)
    } catch {
      window.open(url, '_blank')
    }
  }

  const isVisible = phase === 'open'

  return createPortal(
    <div
      style={{
        ...styles.overlay,
        opacity: isVisible ? 1 : 0,
        transition: 'opacity 0.25s ease',
      }}
    >
      {/* Header */}
      <div style={styles.header}>
        {images.length > 1 && (
          <span style={styles.counter}>{currentIndex + 1} / {images.length}</span>
        )}
        <button style={styles.closeBtn} onClick={handleClose}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      {/* Image area */}
      <div
        style={styles.imageArea}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        <img
          src={images[currentIndex]}
          alt={`图片 ${currentIndex + 1}`}
          style={{
            ...styles.image,
            transform: `scale(${scale}) translate(${translate.x / scale}px, ${translate.y / scale}px)`,
            transition: isDraggingRef.current ? 'none' : 'transform 0.2s ease',
          }}
          draggable={false}
        />
        {privacyProtected && (
          <PrivacyProtectionBadge style={styles.privacyBadge} />
        )}
      </div>

      {/* Footer */}
      <div style={styles.footer}>
        <button style={styles.downloadBtn} onClick={handleDownload}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
          <span>保存图片</span>
        </button>
      </div>
    </div>,
    document.body,
  )
}

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 10000,
    background: 'rgba(0, 0, 0, 0.92)',
    display: 'flex',
    flexDirection: 'column',
    touchAction: 'none',
    userSelect: 'none',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '16px 16px 8px',
    paddingTop: 'calc(16px + var(--safe-area-top, 0px))',
    flexShrink: 0,
  },
  counter: {
    fontSize: 15,
    fontWeight: 500,
    color: 'rgba(255, 255, 255, 0.8)',
  },
  closeBtn: {
    width: 44,
    height: 44,
    borderRadius: '50%',
    background: 'rgba(255, 255, 255, 0.15)',
    border: 'none',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 'auto',
  },
  imageArea: {
    position: 'relative',
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    touchAction: 'none',
  },
  image: {
    maxWidth: '100%',
    maxHeight: '100%',
    objectFit: 'contain' as const,
    transformOrigin: 'center center',
  },
  privacyBadge: {
    top: 18,
    right: 18,
  },
  footer: {
    display: 'flex',
    justifyContent: 'center',
    padding: '12px 16px 16px',
    paddingBottom: 'calc(16px + var(--safe-area-bottom, 0px))',
    flexShrink: 0,
  },
  downloadBtn: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '10px 24px',
    borderRadius: 24,
    background: 'rgba(255, 255, 255, 0.15)',
    border: '1px solid rgba(255, 255, 255, 0.2)',
    color: '#fff',
    fontSize: 14,
    fontWeight: 500,
    cursor: 'pointer',
    backdropFilter: 'blur(8px)',
  },
}
