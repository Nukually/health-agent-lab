import { useState, useEffect } from 'react'

const MAX_WIDTH = 430
const MOBILE_QUERY = `(max-width: ${MAX_WIDTH}px), (hover: none) and (pointer: coarse)`
const CONTAINER_UNITS_CLASS = 'cx-container-units-ok'

function supportsStableContainerUnits() {
  if (
    typeof window === 'undefined' ||
    typeof document === 'undefined' ||
    !document.body ||
    !window.CSS?.supports?.('width', '1cqw')
  ) {
    return false
  }

  const host = document.createElement('div')
  const probe = document.createElement('div')
  host.style.cssText = [
    'position:absolute',
    'left:-10000px',
    'top:-10000px',
    'width:200px',
    'height:100px',
    'container-type:size',
    'contain:size layout style',
    'visibility:hidden',
    'pointer-events:none',
  ].join(';')
  probe.style.cssText = 'width:50cqw;height:50cqh'

  host.appendChild(probe)
  document.body.appendChild(host)
  const rect = probe.getBoundingClientRect()
  host.remove()

  return Math.abs(rect.width - 100) <= 2 && Math.abs(rect.height - 50) <= 2
}

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(() => window.matchMedia(MOBILE_QUERY).matches)

  useEffect(() => {
    const mql = window.matchMedia(MOBILE_QUERY)
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches)
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', handler)
      return () => mql.removeEventListener('change', handler)
    }
    const legacyHandler = (e: MediaQueryListEvent) => setIsMobile(e.matches)
    mql.addListener(legacyHandler)
    return () => mql.removeListener(legacyHandler)
  }, [])

  return isMobile
}

export default function MobileShell({ children }: { children: React.ReactNode }) {
  const isMobile = useIsMobile()
  const [containerUnitsSupported, setContainerUnitsSupported] = useState(false)

  useEffect(() => {
    setContainerUnitsSupported(supportsStableContainerUnits())
  }, [])

  const shellClassName = containerUnitsSupported
    ? `cx-mobile-shell ${CONTAINER_UNITS_CLASS}`
    : 'cx-mobile-shell'

  if (isMobile) {
    return (
      <div className={shellClassName} style={styles.mobileRoot}>
        <div className="cx-mobile-shell-content" style={styles.shellContent}>{children}</div>
      </div>
    )
  }

  return (
    <div style={styles.desktopOuter}>
      <div className={shellClassName} style={styles.desktopPhone}>
        <div className="cx-mobile-shell-content" style={styles.shellContent}>{children}</div>
      </div>
      <p style={styles.hint}>拖动浏览器窗口调整宽度以模拟不同设备</p>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  mobileRoot: {
    width: '100%',
    height: '100%',
    overflow: 'hidden',
  },
  shellContent: {
    width: '100%',
    height: '100%',
    position: 'relative',
    overflow: 'hidden',
  },
  desktopOuter: {
    position: 'fixed',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'var(--color-shell-bg)',
    gap: 12,
  },
  desktopPhone: {
    width: MAX_WIDTH,
    height: `min(932px, calc(var(--app-height) - 80px))`,
    borderRadius: 44,
    overflow: 'hidden',
    boxShadow: 'var(--shadow-phone)',
    background: 'var(--color-bg)',
    border: '1px solid rgba(255,255,255,0.76)',
    position: 'relative',
    flexShrink: 0,
  },
  hint: {
    fontSize: 12,
    color: 'var(--color-text-muted)',
    margin: 0,
    flexShrink: 0,
  },
}
