function getSelectionSafely(): Selection | null {
  try {
    return window.getSelection?.() ?? null
  } catch {
    return null
  }
}

function isDetachedNode(node: Node | null): boolean {
  return !!node && !document.contains(node)
}

function isEditableElement(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  return !!target.closest('input, textarea, select, [contenteditable="true"]')
}

export function clearDocumentSelection(): void {
  const sel = getSelectionSafely()
  if (!sel || sel.rangeCount === 0) return
  try {
    sel.removeAllRanges()
  } catch {
    // noop
  }
}

export function clearDetachedSelection(): boolean {
  const sel = getSelectionSafely()
  if (!sel || sel.rangeCount === 0) return false
  if (!isDetachedNode(sel.anchorNode) && !isDetachedNode(sel.focusNode)) return false
  clearDocumentSelection()
  return true
}

export function scheduleSelectionCleanup(): void {
  if (typeof window === 'undefined') return
  const cleanup = () => clearDocumentSelection()
  window.requestAnimationFrame(cleanup)
  window.setTimeout(cleanup, 0)
  window.setTimeout(cleanup, 120)
}

export function installInteractiveSelectionGuard(): () => void {
  if (typeof document === 'undefined') return () => {}

  const handlePointerLikeEvent = (event: Event) => {
    const target = event.target
    if (!(target instanceof Element)) return
    const interactive = target.closest('button, a, input, textarea, select, [role="button"]')
    if (!interactive) return
    clearDetachedSelection()
  }

  const blockNonEditableTextInteraction = (event: Event) => {
    if (isEditableElement(event.target)) return
    event.preventDefault()
    clearDocumentSelection()
  }

  const blockZoomGesture = (event: Event) => {
    event.preventDefault()
  }

  const blockMultiTouchZoom = (event: TouchEvent) => {
    if (event.touches.length < 2) return
    event.preventDefault()
  }

  const blockCtrlWheelZoom = (event: WheelEvent) => {
    if (!event.ctrlKey) return
    event.preventDefault()
  }

  document.addEventListener('touchstart', handlePointerLikeEvent, true)
  document.addEventListener('pointerdown', handlePointerLikeEvent, true)
  document.addEventListener('selectstart', blockNonEditableTextInteraction, true)
  document.addEventListener('contextmenu', blockNonEditableTextInteraction, true)
  document.addEventListener('touchmove', blockMultiTouchZoom, { capture: true, passive: false })
  document.addEventListener('wheel', blockCtrlWheelZoom, { capture: true, passive: false })
  document.addEventListener('gesturestart', blockZoomGesture, { capture: true, passive: false })
  document.addEventListener('gesturechange', blockZoomGesture, { capture: true, passive: false })
  document.addEventListener('gestureend', blockZoomGesture, { capture: true, passive: false })

  return () => {
    document.removeEventListener('touchstart', handlePointerLikeEvent, true)
    document.removeEventListener('pointerdown', handlePointerLikeEvent, true)
    document.removeEventListener('selectstart', blockNonEditableTextInteraction, true)
    document.removeEventListener('contextmenu', blockNonEditableTextInteraction, true)
    document.removeEventListener('touchmove', blockMultiTouchZoom, true)
    document.removeEventListener('wheel', blockCtrlWheelZoom, true)
    document.removeEventListener('gesturestart', blockZoomGesture, true)
    document.removeEventListener('gesturechange', blockZoomGesture, true)
    document.removeEventListener('gestureend', blockZoomGesture, true)
  }
}
