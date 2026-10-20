import { useEffect } from 'react'

function getAndroidMajorVersion(userAgent: string): number | null {
  const match = /Android\s+(\d+)/i.exec(userAgent)
  if (!match) return null
  const version = Number.parseInt(match[1], 10)
  return Number.isFinite(version) ? version : null
}

function shouldReserveLegacyNavBar(): boolean {
  const nativePlatform = window.__CXNativeBridge__?.info?.platform?.toLowerCase()
  const userAgent = navigator.userAgent || ''
  const isAndroid = nativePlatform === 'android' || /Android/i.test(userAgent)
  if (!isAndroid) return false

  const majorVersion = getAndroidMajorVersion(userAgent)
  if (majorVersion === null || majorVersion > 9) return false

  return window.matchMedia('(hover: none), (pointer: coarse)').matches
}

export function useLegacyAndroidInsets() {
  useEffect(() => {
    const root = document.documentElement

    const apply = () => {
      const reserveNavBar = shouldReserveLegacyNavBar()
      root.style.setProperty('--legacy-android-nav-bottom', reserveNavBar ? '30px' : '0px')
      root.classList.toggle('cx-legacy-android-nav-inset', reserveNavBar)
    }

    apply()
    window.addEventListener('resize', apply)
    window.addEventListener('orientationchange', apply)

    return () => {
      window.removeEventListener('resize', apply)
      window.removeEventListener('orientationchange', apply)
      root.style.removeProperty('--legacy-android-nav-bottom')
      root.classList.remove('cx-legacy-android-nav-inset')
    }
  }, [])
}
