const PROBE_FONT_SIZE_PX = 100
const PROBE_TEXT = 'mmmmmmmmmm'
const PROBE_FONT_FAMILY = 'Arial, sans-serif'
const MIN_SCALE_CORRECTION = 0.75
const MAX_SCALE_CORRECTION = 1
const SCALE_CORRECTION_THRESHOLD = 0.12

export interface ChatFontApplication {
  targetPx: number
  appliedPx: number
  measuredTextScale: number
  correction: number
  nativeFontScale: number
}

export interface FontEnvironmentSnapshot extends ChatFontApplication {
  trigger: string
  chatFontScale: string
  nativePlatform: string | null
  nativeContentSizeCategory: string | null
  nativeDynamicTypeScale: number | null
  nativeDeviceFontScale: number | null
  nativeEffectiveFontScale: number | null
  computedChatFontPx: number | null
  rootFontSizePx: number | null
  bodyFontSizePx: number | null
  textSizeAdjust: string | null
  webkitTextSizeAdjust: string | null
  viewportWidth: number
  viewportHeight: number
  visualViewportWidth: number | null
  visualViewportHeight: number | null
  visualViewportScale: number | null
  screenWidth: number | null
  screenHeight: number | null
  devicePixelRatio: number
  orientation: string | null
  isWeChat: boolean
  isAndroid: boolean
  isIOS: boolean
  userAgent: string
}

function round(value: number, digits = 3): number {
  const base = 10 ** digits
  return Math.round(value * base) / base
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function parsePx(value: string): number | null {
  const n = Number.parseFloat(value)
  return Number.isFinite(n) ? n : null
}

function parseScale(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''))
  return Number.isFinite(n) && n > 0 ? n : null
}

function nativeFontEnvironment(): {
  platform: string | null
  contentSizeCategory: string | null
  dynamicTypeScale: number | null
  deviceFontScale: number | null
  effectiveFontScale: number
} {
  if (typeof window === 'undefined') {
    return {
      platform: null,
      contentSizeCategory: null,
      dynamicTypeScale: null,
      deviceFontScale: null,
      effectiveFontScale: 1,
    }
  }

  const env = window.__CXFontEnvironment__
  const rootStyle = typeof document !== 'undefined'
    ? window.getComputedStyle(document.documentElement)
    : null
  const platform = typeof env?.platform === 'string' ? env.platform : null
  const rawEffectiveFontScale = parseScale(env?.effectiveFontScale)
    ?? parseScale(rootStyle?.getPropertyValue('--android-effective-font-scale'))
    ?? parseScale(rootStyle?.getPropertyValue('--android-font-scale'))
    ?? parseScale(rootStyle?.getPropertyValue('--ios-effective-font-scale'))
    ?? 1
  const maxEffectiveFontScale = platform === 'android' ? 1.3 : 1.55
  const effectiveFontScale = clamp(rawEffectiveFontScale, 0.88, maxEffectiveFontScale)

  return {
    platform,
    contentSizeCategory: typeof env?.contentSizeCategory === 'string' ? env.contentSizeCategory : null,
    dynamicTypeScale: parseScale(env?.dynamicTypeScale)
      ?? parseScale(rootStyle?.getPropertyValue('--ios-dynamic-type-scale')),
    deviceFontScale: parseScale(env?.deviceFontScale)
      ?? parseScale(rootStyle?.getPropertyValue('--android-system-font-scale'))
      ?? parseScale(rootStyle?.getPropertyValue('--ios-device-font-scale')),
    effectiveFontScale,
  }
}

export function measureBrowserTextScale(): number {
  if (typeof document === 'undefined' || !document.body) return 1

  const probe = document.createElement('div')
  probe.setAttribute('aria-hidden', 'true')
  probe.style.position = 'absolute'
  probe.style.left = '-10000px'
  probe.style.top = '-10000px'
  probe.style.width = '1em'
  probe.style.height = '1em'
  probe.style.margin = '0'
  probe.style.padding = '0'
  probe.style.border = '0'
  probe.style.overflow = 'hidden'
  probe.style.pointerEvents = 'none'
  probe.style.fontFamily = PROBE_FONT_FAMILY
  probe.style.fontSize = `${PROBE_FONT_SIZE_PX}px`
  probe.style.lineHeight = '1'

  document.body.appendChild(probe)
  const rect = probe.getBoundingClientRect()
  const computedFontSize = parsePx(window.getComputedStyle(probe).fontSize) ?? PROBE_FONT_SIZE_PX
  probe.remove()

  const measured = Math.max(
    rect.width / PROBE_FONT_SIZE_PX,
    computedFontSize / PROBE_FONT_SIZE_PX,
    measureRenderedTextScale(),
  )
  if (!Number.isFinite(measured) || measured <= 0) return 1
  return round(measured)
}

function measureRenderedTextScale(): number {
  if (typeof document === 'undefined' || !document.body) return 1
  if (typeof HTMLCanvasElement === 'undefined') return 1

  const probe = document.createElement('span')
  probe.textContent = PROBE_TEXT
  probe.setAttribute('aria-hidden', 'true')
  probe.style.position = 'absolute'
  probe.style.left = '-10000px'
  probe.style.top = '0'
  probe.style.margin = '0'
  probe.style.padding = '0'
  probe.style.border = '0'
  probe.style.whiteSpace = 'nowrap'
  probe.style.pointerEvents = 'none'
  probe.style.fontFamily = PROBE_FONT_FAMILY
  probe.style.fontSize = `${PROBE_FONT_SIZE_PX}px`
  probe.style.lineHeight = '1'

  document.body.appendChild(probe)
  const renderedWidth = probe.getBoundingClientRect().width
  probe.remove()

  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  if (!ctx) return 1
  ctx.font = `${PROBE_FONT_SIZE_PX}px ${PROBE_FONT_FAMILY}`
  const expectedWidth = ctx.measureText(PROBE_TEXT).width
  if (!Number.isFinite(renderedWidth) || !Number.isFinite(expectedWidth) || expectedWidth <= 0) return 1

  const scale = renderedWidth / expectedWidth
  if (scale <= 0 || scale > 3) return 1
  return scale
}

function correctionForTextScale(textScale: number): number {
  if (!Number.isFinite(textScale) || textScale <= 0) return 1
  if (textScale <= 1 + SCALE_CORRECTION_THRESHOLD) return 1
  return round(clamp(1 / textScale, MIN_SCALE_CORRECTION, MAX_SCALE_CORRECTION))
}

export function applyStableChatFontSize(targetPx: number): ChatFontApplication {
  const measuredTextScale = measureBrowserTextScale()
  const correction = correctionForTextScale(measuredTextScale)
  const nativeFontScale = nativeFontEnvironment().effectiveFontScale
  const appliedPx = round(targetPx * correction * nativeFontScale, 2)

  if (typeof document !== 'undefined') {
    const root = document.documentElement
    root.style.setProperty('--font-size-chat-target', `${targetPx}px`)
    root.style.setProperty('--font-size-chat-scale-correction', String(correction))
    root.style.setProperty('--font-size-chat-measured-scale', String(measuredTextScale))
    root.style.setProperty('--font-size-chat-native-scale', String(nativeFontScale))
    root.style.setProperty('--font-size-chat', `${appliedPx}px`)
  }

  return { targetPx, appliedPx, measuredTextScale, correction, nativeFontScale }
}

export function collectFontEnvironmentSnapshot(
  trigger: string,
  chatFontScale: string,
  targetPx: number,
): FontEnvironmentSnapshot {
  const applied = applyStableChatFontSize(targetPx)
  const rootStyle = typeof document !== 'undefined'
    ? window.getComputedStyle(document.documentElement)
    : null
  const bodyStyle = typeof document !== 'undefined' && document.body
    ? window.getComputedStyle(document.body)
    : null
  const visualViewport = typeof window !== 'undefined' ? window.visualViewport : null
  const nativeEnv = nativeFontEnvironment()
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
  const orientation = typeof screen !== 'undefined'
    ? screen.orientation?.type ?? null
    : null

  return {
    ...applied,
    trigger,
    chatFontScale,
    nativePlatform: nativeEnv.platform,
    nativeContentSizeCategory: nativeEnv.contentSizeCategory,
    nativeDynamicTypeScale: nativeEnv.dynamicTypeScale,
    nativeDeviceFontScale: nativeEnv.deviceFontScale,
    nativeEffectiveFontScale: nativeEnv.effectiveFontScale,
    computedChatFontPx: rootStyle ? parsePx(rootStyle.getPropertyValue('--font-size-chat')) : null,
    rootFontSizePx: rootStyle ? parsePx(rootStyle.fontSize) : null,
    bodyFontSizePx: bodyStyle ? parsePx(bodyStyle.fontSize) : null,
    textSizeAdjust: rootStyle?.getPropertyValue('text-size-adjust').trim() || null,
    webkitTextSizeAdjust: rootStyle?.getPropertyValue('-webkit-text-size-adjust').trim() || null,
    viewportWidth: typeof window !== 'undefined' ? window.innerWidth : 0,
    viewportHeight: typeof window !== 'undefined' ? window.innerHeight : 0,
    visualViewportWidth: visualViewport ? round(visualViewport.width, 1) : null,
    visualViewportHeight: visualViewport ? round(visualViewport.height, 1) : null,
    visualViewportScale: visualViewport ? round(visualViewport.scale, 3) : null,
    screenWidth: typeof screen !== 'undefined' ? screen.width : null,
    screenHeight: typeof screen !== 'undefined' ? screen.height : null,
    devicePixelRatio: typeof window !== 'undefined' ? round(window.devicePixelRatio || 1, 3) : 1,
    orientation,
    isWeChat: /MicroMessenger/i.test(ua),
    isAndroid: /Android/i.test(ua),
    isIOS: /iPhone|iPad|iPod/i.test(ua),
    userAgent: ua,
  }
}

declare global {
  interface Window {
    __CXFontEnvironment__?: {
      platform?: string
      contentSizeCategory?: string
      dynamicTypeScale?: number
      deviceFontScale?: number
      effectiveFontScale?: number
    }
  }
}
