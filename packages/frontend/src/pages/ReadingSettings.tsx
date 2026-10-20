/**
 * ReadingSettings — 阅读设置页
 *
 * 入口：侧边栏「阅读设置」
 * 内容：聊天内容字体大小三档选择（小 / 中 / 大）
 */

import { useNavigate, useSearchParams } from 'react-router-dom'
import { useStore } from '../stores/index.js'
import type { ChatFontScale } from '../stores/slices/settings.js'

interface Option {
  value: ChatFontScale
  label: string
  primaryDesc: string
  secondaryDesc: string
  previewSize: number
}

const OPTIONS: Option[] = [
  { value: 'small', label: '小', primaryDesc: '紧凑', secondaryDesc: '显示更多', previewSize: 30 },
  { value: 'medium', label: '中', primaryDesc: '标准', secondaryDesc: '推荐使用', previewSize: 36 },
  { value: 'large', label: '大', primaryDesc: '舒适', secondaryDesc: '便于阅读', previewSize: 42 },
]

export default function ReadingSettings() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const returnSessionId = searchParams.get('returnSessionId')
  const shouldReturnToSettings = searchParams.get('returnToSettings') === '1' || !!returnSessionId

  const chatFontScale = useStore((s) => s.chatFontScale)
  const setChatFontScale = useStore((s) => s.setChatFontScale)

  function handleBack() {
    const target = returnSessionId ? `/chat/${returnSessionId}` : '/chat'
    const state = shouldReturnToSettings ? { openSidebar: true } : undefined
    navigate(target, { state })
  }

  return (
    <div style={styles.container}>
      <div style={styles.topBar}>
        <button style={styles.backBtn} onClick={handleBack} aria-label="返回">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <h1 style={styles.title}>阅读设置</h1>
        <div style={styles.topBarSpacer} />
      </div>

      <div style={styles.divider} />

      <div style={styles.scrollArea}>
        <div style={styles.section}>
          <div style={styles.sectionHeader}>
            <span style={styles.sectionTitle}>字体大小</span>
            <span style={styles.sectionHint}>选择适合您的阅读字号</span>
          </div>

          <div style={styles.cardGrid}>
            {OPTIONS.map((opt) => {
              const active = chatFontScale === opt.value
              const handleSelect = () => setChatFontScale(opt.value)
              return (
                <div
                  key={opt.value}
                  role="button"
                  tabIndex={0}
                  className="reading-font-option"
                  onClick={handleSelect}
                  onMouseDown={(event) => event.preventDefault()}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return
                    event.preventDefault()
                    handleSelect()
                  }}
                  style={{
                    ...styles.card,
                    ...(active ? styles.cardActive : {}),
                  }}
                  aria-pressed={active}
                >
                  {active && (
                    <span style={styles.checkBadge} aria-hidden="true">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    </span>
                  )}
                  <span
                    style={{
                      ...styles.cardLabel,
                      fontSize: opt.previewSize,
                      color: active ? 'var(--color-primary)' : 'var(--color-text)',
                    }}
                  >
                    {opt.label}
                  </span>
                  <span
                    style={{
                      ...styles.cardDescPrimary,
                      color: active ? 'var(--color-primary)' : 'var(--color-text-secondary)',
                    }}
                  >
                    {opt.primaryDesc}
                  </span>
                  <span
                    style={{
                      ...styles.cardDescSecondary,
                      color: active ? 'var(--color-primary)' : 'var(--color-text-muted)',
                    }}
                  >
                    {opt.secondaryDesc}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    height: '100%',
    background: 'linear-gradient(180deg, #FFFDF9 0%, #FFF7F1 100%)',
    display: 'flex',
    flexDirection: 'column',
  },
  topBar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '14px 18px 8px',
    paddingTop: 'calc(14px + var(--safe-area-top))',
    background: 'transparent',
    flexShrink: 0,
  },
  backBtn: {
    width: 40,
    height: 40,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: '1px solid rgba(216, 180, 160, 0.22)',
    background: 'rgba(255,255,255,0.82)',
    color: 'var(--color-text)',
    cursor: 'pointer',
    padding: 0,
    borderRadius: 20,
    boxShadow: '0 8px 24px rgba(188, 116, 88, 0.06)',
  },
  title: {
    fontSize: 20,
    fontWeight: 700,
    color: 'var(--color-text)',
    margin: 0,
    letterSpacing: 0.5,
  },
  topBarSpacer: {
    width: 36,
    height: 36,
  },
  divider: {
    height: 1,
    background: 'transparent',
    flexShrink: 0,
    opacity: 0.6,
  },
  scrollArea: {
    flex: 1,
    overflowY: 'auto',
    padding: '16px clamp(14px, 4vw, 22px) calc(28px + var(--safe-area-bottom))',
  },
  section: {
    maxWidth: 430,
    margin: '0 auto',
    padding: 18,
    borderRadius: 20,
    border: '1px solid rgba(216, 180, 160, 0.18)',
    background: 'rgba(255,255,255,0.78)',
    boxShadow: '0 12px 34px rgba(188, 116, 88, 0.08)',
  },
  sectionHeader: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 10,
    flexWrap: 'wrap',
    padding: '4px 4px 14px',
  },
  sectionTitle: {
    fontSize: 17,
    fontWeight: 700,
    color: 'var(--color-text)',
  },
  sectionHint: {
    fontSize: 13,
    color: 'var(--color-text-muted)',
    fontWeight: 400,
  },
  cardGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
    gap: 10,
  },
  card: {
    position: 'relative',
    minWidth: 0,
    minHeight: 132,
    borderRadius: 16,
    border: '1px solid rgba(216, 180, 160, 0.22)',
    background: 'rgba(255, 249, 245, 0.78)',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    padding: '14px 8px',
    cursor: 'pointer',
    transition: 'border-color 0.18s, background 0.18s, transform 0.18s, box-shadow 0.18s',
    outline: 'none',
    WebkitTapHighlightColor: 'transparent',
    overflow: 'hidden',
  },
  cardActive: {
    borderColor: 'var(--color-primary)',
    background: 'var(--color-primary-bg)',
    boxShadow: '0 8px 18px rgba(188, 116, 88, 0.10)',
  },
  checkBadge: {
    position: 'absolute',
    top: 8,
    right: 8,
    width: 22,
    height: 22,
    borderRadius: '50%',
    background: 'var(--color-primary)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    boxShadow: '0 2px 6px rgba(212,135,108,0.35)',
  },
  cardLabel: {
    fontWeight: 700,
    lineHeight: 1.1,
    marginBottom: 4,
  },
  cardDescPrimary: {
    fontSize: 13,
    fontWeight: 500,
    lineHeight: 1.3,
  },
  cardDescSecondary: {
    fontSize: 12,
    lineHeight: 1.3,
  },
}
