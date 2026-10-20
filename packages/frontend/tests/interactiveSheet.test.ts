import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CHAT_INPUT_BAR_Z_INDEX,
  CHAT_INTERACTIVE_SHEET_Z_INDEX,
  INTERACTIVE_SHEET_PORTAL_SELECTOR,
  interactiveSheetOverlayStyle,
  renderInteractiveSheetPortal,
} from '../src/components/chat/interactiveSheet.js'

test('interactive sheets render above the fixed chat input bar', () => {
  assert.ok(CHAT_INTERACTIVE_SHEET_Z_INDEX > CHAT_INPUT_BAR_Z_INDEX)
  assert.equal(interactiveSheetOverlayStyle.zIndex, CHAT_INTERACTIVE_SHEET_Z_INDEX)
})

test('interactive sheets keep their own input visible while following keyboard offsets', () => {
  const bottom = String(interactiveSheetOverlayStyle.bottom)
  assert.match(bottom, /--keyboard-offset/)
  assert.match(bottom, /--native-keyboard-offset/)
  assert.match(bottom, /safe-area-inset-bottom/)
})

test('interactive sheets are positioned inside the mobile shell instead of the browser viewport', () => {
  assert.equal(interactiveSheetOverlayStyle.position, 'absolute')
})

test('interactive sheet portal stays scoped to the mobile shell when available', () => {
  assert.equal(INTERACTIVE_SHEET_PORTAL_SELECTOR, '.cx-mobile-shell-content')
})

test('interactive sheet portal falls back to inline rendering outside the browser', () => {
  const marker = 'sheet marker'
  assert.equal(renderInteractiveSheetPortal(marker), marker)
})
