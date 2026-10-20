import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import {
  isPromptSnapshotFeatureSignatureCompatible,
  isPromptSnapshotMetaFresh,
} from './prompt-cache.js'

test('prompt snapshot meta without createdAt is treated as expired', () => {
  assert.equal(isPromptSnapshotMetaFresh({}, 1_000), false)
})

test('prompt layout version invalidates snapshots after static prompt protocol changes', () => {
  const source = fs.readFileSync(new URL('./prompt-cache.ts', import.meta.url), 'utf8')

  assert.match(source, /PROMPT_LAYOUT_VERSION = 43/)
  assert.match(source, /v43 起恢复 thinking 隐藏渲染协议/)
})

test('prompt snapshot meta is fresh within one hour', () => {
  const now = 10_000_000
  assert.equal(isPromptSnapshotMetaFresh({ createdAt: now - 3_599_999 }, now), true)
})

test('prompt snapshot meta expires after one hour', () => {
  const now = 10_000_000
  assert.equal(isPromptSnapshotMetaFresh({ createdAt: now - 3_600_001 }, now), false)
})

test('prompt snapshot feature signature must match when expected', () => {
  assert.equal(
    isPromptSnapshotFeatureSignatureCompatible({ featureSignature: 'feature-v1:dev' }, 'feature-v1:dev'),
    true,
  )
  assert.equal(
    isPromptSnapshotFeatureSignatureCompatible({ featureSignature: 'feature-v1:dev' }, 'feature-v1:prod'),
    false,
  )
  assert.equal(
    isPromptSnapshotFeatureSignatureCompatible({}, 'feature-v1:prod'),
    false,
  )
  assert.equal(
    isPromptSnapshotFeatureSignatureCompatible({}, undefined),
    true,
  )
})
