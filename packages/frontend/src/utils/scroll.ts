function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function blurActiveTextInput(): void {
  if (typeof document === 'undefined') return
  const active = document.activeElement
  if (!(active instanceof HTMLElement)) return
  if (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT') {
    active.blur()
  }
}

export function scrollElementToTop(element: HTMLElement | null): void {
  if (!element) return
  blurActiveTextInput()

  try {
    element.scrollTo({
      top: 0,
      left: 0,
      behavior: prefersReducedMotion() ? 'instant' : 'smooth',
    })
  } catch {
    element.scrollTop = 0
    element.scrollLeft = 0
  }
}
