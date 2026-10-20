import type { CSSProperties, ReactNode } from 'react'
import { createPortal } from 'react-dom'

export const CHAT_INPUT_BAR_Z_INDEX = 20
export const CHAT_INTERACTIVE_SHEET_Z_INDEX = 1200
export const INTERACTIVE_SHEET_PORTAL_SELECTOR = '.cx-mobile-shell-content'

export const interactiveSheetOverlayStyle: CSSProperties = {
  position: 'absolute',
  top: 0,
  left: 0,
  right: 0,
  bottom: 'calc(max(var(--keyboard-offset, 0px), var(--native-keyboard-offset, 0px)) + env(safe-area-inset-bottom) + 10px)',
  zIndex: CHAT_INTERACTIVE_SHEET_Z_INDEX,
  display: 'flex',
  justifyContent: 'center',
  alignItems: 'flex-end',
  pointerEvents: 'none',
  padding: '0 max(14px, var(--chat-horizontal-padding, 12px))',
  background: 'linear-gradient(to top, rgba(255,247,240,0.98) 0, rgba(255,247,240,0.94) 112px, rgba(255,247,240,0) 260px)',
  boxSizing: 'border-box',
}

export function renderInteractiveSheetPortal(children: ReactNode): ReactNode {
  if (typeof document === 'undefined') return children
  const target = document.querySelector(INTERACTIVE_SHEET_PORTAL_SELECTOR)
  if (!target) return children
  return createPortal(children, target)
}
