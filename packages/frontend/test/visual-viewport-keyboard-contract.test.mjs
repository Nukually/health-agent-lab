import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('../src/hooks/useVisualViewportKeyboard.ts', import.meta.url), 'utf8')

test('Honor Android resize quirk is detected before native keyboard events arrive', () => {
  assert.match(source, /function isHonorLikeAndroidKeyboardResizeQuirk\(\)/, 'H5 should have a local Honor detector')
  assert.match(
    source,
    /let isNativeResizeKeyboardQuirk = keyboardQuirkMode === 'honor_adjust_resize'\s*\|\|\s*isHonorLikeAndroidKeyboardResizeQuirk\(\)/,
    'initial quirk state should not depend only on the late native keyboard event',
  )
})

test('Honor Android resize quirk clears transient visualViewport offset instead of writing one', () => {
  assert.match(source, /honor_adjust_resize/, 'Honor keyboard quirk mode should be recognized by H5')
  assert.match(
    source,
    /if \(isNativeResizeKeyboardQuirk\) \{\s*resetKeyboardVars\(nativeKeyboardOpen\)\s*return\s*\}/s,
    'Honor resize quirk should clear transient H5 keyboard offset and skip visualViewport offset writes',
  )
  assert.match(
    source,
    /keyboardQuirkMode === 'vivo_adjust_resize'/,
    'vivo native-only mode should stay separate from Honor resize suppression',
  )
})

test('Keyboard-open state removes the resting input bar lift', () => {
  assert.match(
    source,
    /const setInputBarFloatingLift = \(keyboardOpen: boolean\) =>/,
    'keyboard hook should own the floating input-bar lift override',
  )
  assert.match(
    source,
    /'--input-bar-floating-lift',\s*keyboardOpen \? '0px' : 'var\(--input-bar-lift, 32px\)'/s,
    'input bar lift should be preserved at rest and removed while keyboard is open',
  )
  assert.match(
    source,
    /const keyboardOpen = nativeKeyboardOpen \|\| offset > 0 \|\| layoutViewportAlreadyShrunk/,
    'visualViewport and already-resized keyboard states should both remove the lift',
  )
})
