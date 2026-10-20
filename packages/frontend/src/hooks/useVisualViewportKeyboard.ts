import { useEffect } from 'react'

type NativeKeyboardEventDetail = {
  offset?: number
  rawOffset?: number
  layoutAlreadyResized?: boolean
  keyboardQuirkMode?: string
}

declare global {
  interface Window {
    __cxAndroidKeyboardQuirkMode?: string
  }
}

function isHonorLikeAndroidKeyboardResizeQuirk(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent || ''
  if (!/Android/i.test(ua)) return false
  const nativePlatform = window.__CXNativeBridge__?.info?.platform?.toLowerCase()
  const isNativeAndroidWebView = nativePlatform === 'android' || /;\s*wv[);]/i.test(ua)
  if (!isNativeAndroidWebView) return false
  return /Honor|HONOR|荣耀|BND-AL10|BND-L\d+/i.test(ua)
}

/**
 * 监听 window.visualViewport，把键盘高度写入 CSS 变量 --keyboard-offset。
 * InputBar 通过 bottom: var(--keyboard-offset) 在旧 WebView 中跟随键盘上浮。
 *
 * 为什么需要这个：
 * - 部分旧 iOS Safari / WKWebView 键盘弹起时 layout viewport 不会自动收缩，
 *   100dvh 也不会变小，导致 position:fixed/absolute 的底部元素被键盘遮挡。
 * - visualViewport API 是所有现代移动浏览器（含微信 X5）都支持的标准方案。
 * - 新版 iOS WKWebView 已经会让 100dvh / documentElement.clientHeight 跟着键盘收缩，
 *   这种情况下不能再叠加 visualViewport delta，否则输入框会离键盘很远。
 */
export function useVisualViewportKeyboard() {
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return

    const root = document.documentElement
    let raf = 0
    let baselineHeight = Math.max(window.innerHeight, vv.height, root.clientHeight)
    const setInputBarFloatingLift = (keyboardOpen: boolean) => {
      root.style.setProperty(
        '--input-bar-floating-lift',
        keyboardOpen ? '0px' : 'var(--input-bar-lift, 32px)',
      )
    }
    const resetKeyboardVars = (keyboardOpen = false) => {
      root.style.setProperty('--keyboard-offset', '0px')
      root.style.setProperty(
        '--keyboard-safe-area-bottom',
        keyboardOpen ? '0px' : 'var(--chat-bottom-system-inset)',
      )
      setInputBarFloatingLift(keyboardOpen)
    }
    // vivo/iQOO 使用 native-only offset；Honor 保持 adjustResize，但禁用 H5 visualViewport
    // 临时 offset，避免先顶起再因 layout viewport 收缩落回来的可见抖动。
    let keyboardQuirkMode = window.__cxAndroidKeyboardQuirkMode || ''
    let isVivoKeyboardQuirk = keyboardQuirkMode === 'vivo_adjust_resize'
    let isNativeResizeKeyboardQuirk = keyboardQuirkMode === 'honor_adjust_resize'
      || isHonorLikeAndroidKeyboardResizeQuirk()
    let nativeKeyboardOpen = false

    const update = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        if (isVivoKeyboardQuirk) {
          resetKeyboardVars(nativeKeyboardOpen)
          return
        }
        if (isNativeResizeKeyboardQuirk) {
          resetKeyboardVars(nativeKeyboardOpen)
          return
        }
        // pinch-zoom（trackpad 双指 / 移动端双指）会让 vv.height < window.innerHeight，但并不是键盘弹起；
        // 只有 scale ≈ 1 时才把视口收缩归因为键盘，避免桌面端放大时输入框被顶上去。
        if (vv.scale > 1.01) {
          resetKeyboardVars()
          return
        }

        const layoutHeight = root.clientHeight
        if (vv.height >= layoutHeight - 8 && layoutHeight >= baselineHeight - 8) {
          baselineHeight = Math.max(baselineHeight, window.innerHeight, vv.height, layoutHeight)
        }

        // Some iOS WKWebView builds already shrink 100dvh/layout viewport above the keyboard.
        // In that case, applying the visualViewport delta again lifts the input bar too high.
        const layoutViewportAlreadyShrunk =
          window.innerHeight < baselineHeight - 80 || layoutHeight < baselineHeight - 80
        const rawOffset = layoutViewportAlreadyShrunk
          ? 0
          : Math.max(0, window.innerHeight - vv.height - vv.offsetTop)
        const offset = rawOffset < 8 ? 0 : rawOffset
        root.style.setProperty('--keyboard-offset', `${offset}px`)
        const keyboardOpen = nativeKeyboardOpen || offset > 0 || layoutViewportAlreadyShrunk
        root.style.setProperty(
          '--keyboard-safe-area-bottom',
          keyboardOpen ? '0px' : 'var(--chat-bottom-system-inset)',
        )
        setInputBarFloatingLift(keyboardOpen)
      })
    }

    const handleNativeKeyboard = (event: Event) => {
      const detail = (event as CustomEvent<NativeKeyboardEventDetail>).detail
      nativeKeyboardOpen = Boolean((detail?.rawOffset ?? detail?.offset ?? 0) > 0 || detail?.layoutAlreadyResized)
      keyboardQuirkMode = typeof detail?.keyboardQuirkMode === 'string'
        ? detail.keyboardQuirkMode
        : window.__cxAndroidKeyboardQuirkMode || ''
      isVivoKeyboardQuirk = keyboardQuirkMode === 'vivo_adjust_resize'
      isNativeResizeKeyboardQuirk = keyboardQuirkMode === 'honor_adjust_resize'
        || isHonorLikeAndroidKeyboardResizeQuirk()
      // 非 quirk 机型不响应 native keyboard 事件，完全沿用原来的 visualViewport 计算逻辑。
      if (!isVivoKeyboardQuirk && !isNativeResizeKeyboardQuirk) {
        setInputBarFloatingLift(nativeKeyboardOpen)
        return
      }
      if (isNativeResizeKeyboardQuirk && !isVivoKeyboardQuirk) resetKeyboardVars(nativeKeyboardOpen)
      update()
    }

    window.addEventListener('cx-native-keyboard', handleNativeKeyboard)

    if (typeof vv.addEventListener !== 'function') {
      update()
      return () => {
        cancelAnimationFrame(raf)
        window.removeEventListener('cx-native-keyboard', handleNativeKeyboard)
        resetKeyboardVars()
        root.style.removeProperty('--input-bar-floating-lift')
      }
    }

    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)
    update()

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('cx-native-keyboard', handleNativeKeyboard)
      vv.removeEventListener('resize', update)
      vv.removeEventListener('scroll', update)
      resetKeyboardVars()
      root.style.removeProperty('--input-bar-floating-lift')
    }
  }, [])
}
