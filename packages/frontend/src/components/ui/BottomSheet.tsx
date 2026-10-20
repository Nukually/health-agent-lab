/**
 * BottomSheet — 通用底部浮窗组件
 *
 * 参照 Claude 移动端的 Summary/Thought process 浮窗设计：
 * - createPortal 渲染到 body，逃出 MobileShell overflow:hidden
 * - 半透明遮罩 + 白色圆角卡片从底部滑入
 * - 顶部拖拽手柄，支持触摸下拉关闭
 * - 标题 + 关闭(X)/返回(<) 按钮
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'

interface Props {
  open: boolean
  onClose: () => void
  title: string
  onBack?: () => void
  children: React.ReactNode
}

type Phase = 'closed' | 'opening' | 'open' | 'closing'
const CLOSE_FALLBACK_MS = 380

export default function BottomSheet({ open, onClose, title, onBack, children }: Props) {
  const [phase, setPhase] = useState<Phase>('closed')
  const [dragY, setDragY] = useState(0)
  const dragStartY = useRef(0)
  const isDragging = useRef(false)
  const sheetRef = useRef<HTMLDivElement>(null)

  // Open/close transitions
  useEffect(() => {
    if (open && phase === 'closed') {
      setPhase('opening')
      requestAnimationFrame(() => {
        requestAnimationFrame(() => setPhase('open'))
      })
    } else if (!open && (phase === 'open' || phase === 'opening')) {
      setPhase('closing')
    }
  }, [open, phase])

  const handleTransitionEnd = useCallback(() => {
    if (phase === 'closing') {
      setPhase('closed')
      setDragY(0)
    }
  }, [phase])

  useEffect(() => {
    if (phase !== 'closing') return
    const timer = window.setTimeout(() => {
      setPhase('closed')
      setDragY(0)
    }, CLOSE_FALLBACK_MS)
    return () => window.clearTimeout(timer)
  }, [phase])

  // Close on escape
  useEffect(() => {
    if (phase === 'closed') return
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [phase, onClose])

  // Touch drag-to-dismiss
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    isDragging.current = true
    dragStartY.current = e.touches[0].clientY
    setDragY(0)
  }, [])

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (!isDragging.current) return
    const delta = e.touches[0].clientY - dragStartY.current
    if (delta > 0) {
      setDragY(delta)
    }
  }, [])

  const handleTouchEnd = useCallback(() => {
    isDragging.current = false
    if (dragY > 100) {
      onClose()
    }
    setDragY(0)
  }, [dragY, onClose])

  if (phase === 'closed') return null

  const isVisible = phase === 'open'
  const isClosing = phase === 'closing'

  const overlayStyle: React.CSSProperties = {
    position: 'fixed',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 9999,
    background: `rgba(0, 0, 0, ${isVisible ? 0.35 : 0})`,
    transition: 'background 0.3s ease',
    display: 'flex',
    alignItems: 'flex-end',
    justifyContent: 'center',
  }

  const cardStyle: React.CSSProperties = {
    position: 'relative',
    width: '100%',
    maxWidth: 430,
    minHeight: '54dvh',
    maxHeight: '82dvh',
    background: '#FFFDFB',
    borderRadius: '24px 24px 0 0',
    display: 'flex',
    flexDirection: 'column',
    transform: isVisible && !isClosing
      ? `translateY(${dragY}px)`
      : 'translateY(100%)',
    transition: isDragging.current
      ? 'none'
      : 'transform 0.3s cubic-bezier(0.32, 0.72, 0, 1)',
    willChange: 'transform',
    boxShadow: 'none',
    borderTop: '1px solid rgba(226, 216, 207, 0.72)',
  }

  const handleBarStyle: React.CSSProperties = {
    display: 'flex',
    justifyContent: 'center',
    padding: '10px 0 4px',
    cursor: 'grab',
  }

  const handleDotStyle: React.CSSProperties = {
    width: 36,
    height: 4,
    borderRadius: 2,
    background: '#D1D1D6',
  }

  const headerStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    padding: '6px 20px 16px',
    gap: 12,
  }

  const titleStyle: React.CSSProperties = {
    flex: 1,
    fontSize: 20,
    fontWeight: 700,
    color: 'var(--color-text)',
    textAlign: 'center',
    letterSpacing: 0,
  }

  const btnStyle: React.CSSProperties = {
    width: 36,
    height: 36,
    borderRadius: 18,
    background: 'rgba(240, 230, 221, 0.72)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: 'none',
    cursor: 'pointer',
    flexShrink: 0,
    padding: 0,
  }

  const bodyStyle: React.CSSProperties = {
    flex: 1,
    overflowY: 'auto',
    padding: '0 24px 28px',
    WebkitOverflowScrolling: 'touch',
  }

  return createPortal(
    <div style={overlayStyle} onClick={onClose}>
      <div
        ref={sheetRef}
        style={cardStyle}
        onClick={(e) => e.stopPropagation()}
        onTransitionEnd={handleTransitionEnd}
      >
        {/* Drag handle */}
        <div
          style={handleBarStyle}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
        >
          <div style={handleDotStyle} />
        </div>

        {/* Header */}
        <div style={headerStyle}>
          {onBack ? (
            <button style={btnStyle} onClick={onBack} aria-label="返回">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#1C1C1E" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="15 18 9 12 15 6" />
              </svg>
            </button>
          ) : (
            <div style={{ width: 36 }} />
          )}
          <span style={titleStyle}>{title}</span>
          <button style={btnStyle} onClick={onClose} aria-label="关闭">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#8E8E93" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div style={bodyStyle}>{children}</div>
      </div>
    </div>,
    document.body,
  )
}
