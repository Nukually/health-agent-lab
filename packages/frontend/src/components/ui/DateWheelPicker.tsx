/**
 * DateWheelPicker — iOS 风格滚轮日期选择器
 *
 * 三列（年/月/日）可触摸惯性滚动，CSS scroll-snap 吸附。
 * 通过 createPortal 渲染到 body，底部弹出 + 半透明遮罩。
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'

interface DateWheelPickerProps {
  open: boolean
  onClose: () => void
  value: { year: number | ''; month: number | ''; day: number | '' }
  onChange: (value: { year: number; month: number; day: number }) => void
  minYear?: number
  maxYear?: number
}

const ITEM_HEIGHT = 44
const VISIBLE_COUNT = 5
const VIEWPORT_HEIGHT = ITEM_HEIGHT * VISIBLE_COUNT

function getDaysInMonth(year: number, month: number) {
  return new Date(year, month, 0).getDate()
}

// ─── Single wheel column ───

interface WheelColumnProps {
  items: number[]
  selected: number
  onSelect: (val: number) => void
  suffix: string
}

function WheelColumn({ items, selected, onSelect, suffix }: WheelColumnProps) {
  const ref = useRef<HTMLDivElement>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const isInitialMount = useRef(true)

  const selectedIndex = items.indexOf(selected)

  // Scroll to selection on mount and when items/selected change from outside
  useEffect(() => {
    if (!ref.current) return
    const target = (selectedIndex >= 0 ? selectedIndex : 0) * ITEM_HEIGHT
    if (isInitialMount.current) {
      ref.current.scrollTop = target
      isInitialMount.current = false
    } else {
      ref.current.scrollTo({ top: target, behavior: 'smooth' })
    }
  }, [items, selectedIndex])

  const handleScroll = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      if (!ref.current) return
      const idx = Math.round(ref.current.scrollTop / ITEM_HEIGHT)
      const clamped = Math.max(0, Math.min(idx, items.length - 1))
      if (items[clamped] !== selected) {
        onSelect(items[clamped])
      }
    }, 80)
  }, [items, selected, onSelect])

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current) }, [])

  const padCount = Math.floor(VISIBLE_COUNT / 2)

  return (
    <div style={colStyles.wrapper}>
      {/* Selection band */}
      <div style={colStyles.selectionBand} />
      {/* Gradient masks */}
      <div style={colStyles.maskTop} />
      <div style={colStyles.maskBottom} />
      {/* Scrollable column */}
      <div ref={ref} className="wheel-scroll" style={colStyles.scroll} onScroll={handleScroll}>
        {/* Top spacer */}
        {Array.from({ length: padCount }, (_, i) => (
          <div key={`pad-top-${i}`} style={colStyles.item} />
        ))}
        {items.map((val) => {
          const isSelected = val === selected
          return (
            <div
              key={val}
              style={{
                ...colStyles.item,
                color: isSelected ? 'var(--color-primary)' : 'var(--color-text-muted)',
                fontWeight: isSelected ? 600 : 400,
                fontSize: isSelected ? 18 : 15,
              }}
            >
              {val}{suffix}
            </div>
          )
        })}
        {/* Bottom spacer */}
        {Array.from({ length: padCount }, (_, i) => (
          <div key={`pad-bot-${i}`} style={colStyles.item} />
        ))}
      </div>
    </div>
  )
}

const colStyles: Record<string, React.CSSProperties> = {
  wrapper: {
    position: 'relative',
    flex: 1,
    height: VIEWPORT_HEIGHT,
    overflow: 'hidden',
  },
  scroll: {
    position: 'relative',
    zIndex: 1,
    height: VIEWPORT_HEIGHT,
    overflowY: 'auto',
    scrollSnapType: 'y mandatory',
    WebkitOverflowScrolling: 'touch',
    // Hide scrollbar
    scrollbarWidth: 'none',
    msOverflowStyle: 'none',
  },
  item: {
    height: ITEM_HEIGHT,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    scrollSnapAlign: 'center',
    transition: 'color 0.15s, font-size 0.15s',
    userSelect: 'none',
  },
  selectionBand: {
    position: 'absolute',
    top: ITEM_HEIGHT * Math.floor(VISIBLE_COUNT / 2),
    left: 4,
    right: 4,
    height: ITEM_HEIGHT,
    borderTop: '1px solid var(--color-primary-light)',
    borderBottom: '1px solid var(--color-primary-light)',
    background: 'var(--color-primary-bg)',
    borderRadius: 8,
    pointerEvents: 'none',
    zIndex: 0,
  },
  maskTop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: ITEM_HEIGHT * Math.floor(VISIBLE_COUNT / 2),
    background: 'linear-gradient(to bottom, var(--color-bg), transparent)',
    pointerEvents: 'none',
    zIndex: 2,
  },
  maskBottom: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: ITEM_HEIGHT * Math.floor(VISIBLE_COUNT / 2),
    background: 'linear-gradient(to top, var(--color-bg), transparent)',
    pointerEvents: 'none',
    zIndex: 2,
  },
}

// ─── Main picker component ───

type Phase = 'closed' | 'opening' | 'open' | 'closing'
const CLOSE_FALLBACK_MS = 380

export default function DateWheelPicker({
  open,
  onClose,
  value,
  onChange,
  minYear = 1930,
  maxYear,
}: DateWheelPickerProps) {
  const today = useMemo(() => new Date(), [])
  const todayYear = today.getFullYear()
  const todayMonth = today.getMonth() + 1
  const todayDay = today.getDate()

  const resolvedMaxYear = maxYear ?? todayYear
  const years = useMemo(
    () => Array.from({ length: resolvedMaxYear - minYear + 1 }, (_, i) => resolvedMaxYear - i),
    [minYear, resolvedMaxYear],
  )

  const [phase, setPhase] = useState<Phase>('closed')
  const [selYear, setSelYear] = useState(value.year || 1990)
  const [selMonth, setSelMonth] = useState(value.month || 1)
  const [selDay, setSelDay] = useState(value.day || 1)

  const months = useMemo(() => {
    const max = selYear === todayYear ? todayMonth : 12
    return Array.from({ length: max }, (_, i) => i + 1)
  }, [selYear, todayYear, todayMonth])

  const days = useMemo(() => {
    const maxByMonth = getDaysInMonth(selYear as number, selMonth as number)
    const max = selYear === todayYear && selMonth === todayMonth
      ? Math.min(todayDay, maxByMonth)
      : maxByMonth
    return Array.from({ length: max }, (_, i) => i + 1)
  }, [selYear, selMonth, todayYear, todayMonth, todayDay])

  // Clamp month when year changes into current year
  useEffect(() => {
    if (selYear === todayYear && (selMonth as number) > todayMonth) setSelMonth(todayMonth)
  }, [selYear, selMonth, todayYear, todayMonth])

  // Clamp day when month/year changes
  useEffect(() => {
    const maxByMonth = getDaysInMonth(selYear as number, selMonth as number)
    const maxDay = selYear === todayYear && selMonth === todayMonth
      ? Math.min(todayDay, maxByMonth)
      : maxByMonth
    if ((selDay as number) > maxDay) setSelDay(maxDay)
  }, [selYear, selMonth, selDay, todayYear, todayMonth, todayDay])

  // Sync from props when opening
  useEffect(() => {
    if (open) {
      setSelYear(value.year || 1990)
      setSelMonth(value.month || 1)
      setSelDay(value.day || 1)
    }
  }, [open])

  // Phase transitions
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
    if (phase === 'closing') setPhase('closed')
  }, [phase])

  useEffect(() => {
    if (phase !== 'closing') return
    const timer = window.setTimeout(() => setPhase('closed'), CLOSE_FALLBACK_MS)
    return () => window.clearTimeout(timer)
  }, [phase])

  useEffect(() => {
    if (phase === 'closed') return
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [phase, onClose])

  function handleConfirm() {
    onChange({ year: selYear as number, month: selMonth as number, day: selDay as number })
    onClose()
  }

  if (phase === 'closed') return null

  const isVisible = phase === 'open'
  const isClosing = phase === 'closing'

  return createPortal(
    <div style={{ ...pickerStyles.overlay, background: isVisible ? 'rgba(0,0,0,0.35)' : 'rgba(0,0,0,0)' }} onClick={onClose}>
      <div
        style={{
          ...pickerStyles.card,
          transform: isVisible && !isClosing ? 'translateY(0)' : 'translateY(100%)',
        }}
        onClick={(e) => e.stopPropagation()}
        onTransitionEnd={handleTransitionEnd}
      >
        {/* Header */}
        <div style={pickerStyles.header}>
          <button style={pickerStyles.headerBtn} onClick={onClose}>取消</button>
          <span style={pickerStyles.headerTitle}>选择出生日期</span>
          <button style={{ ...pickerStyles.headerBtn, color: 'var(--color-primary)' }} onClick={handleConfirm}>确定</button>
        </div>

        {/* Wheels */}
        <div style={pickerStyles.wheelsRow}>
          <WheelColumn items={years} selected={selYear as number} onSelect={setSelYear} suffix="年" />
          <WheelColumn items={months} selected={selMonth as number} onSelect={setSelMonth} suffix="月" />
          <WheelColumn items={days} selected={selDay as number} onSelect={setSelDay} suffix="日" />
        </div>
      </div>
    </div>,
    document.body,
  )
}

const pickerStyles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 9999,
    display: 'flex',
    alignItems: 'flex-end',
    justifyContent: 'center',
    transition: 'background 0.3s ease',
  },
  card: {
    width: '100%',
    maxWidth: 430,
    background: 'var(--color-bg)',
    borderRadius: '16px 16px 0 0',
    transition: 'transform 0.3s cubic-bezier(0.32, 0.72, 0, 1)',
    willChange: 'transform',
    boxShadow: '0 -4px 24px rgba(0,0,0,0.08)',
    paddingBottom: 'calc(16px + var(--safe-area-bottom, 0px))',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '14px 16px 10px',
    borderBottom: '1px solid var(--color-border)',
  },
  headerTitle: {
    fontSize: 16,
    fontWeight: 600,
    color: 'var(--color-text)',
  },
  headerBtn: {
    background: 'none',
    border: 'none',
    fontSize: 15,
    fontWeight: 500,
    color: 'var(--color-text-muted)',
    cursor: 'pointer',
    padding: '4px 8px',
  },
  wheelsRow: {
    display: 'flex',
    padding: '8px 12px',
    gap: 4,
  },
}
