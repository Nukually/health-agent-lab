import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const authRouteSource = readFileSync(resolve(__dirname, './auth.ts'), 'utf8')
const authServiceSource = readFileSync(resolve(__dirname, '../services/auth.ts'), 'utf8')

test('login backend tracking receives request context headers', () => {
  assert.match(
    authRouteSource,
    /findOrCreateUser\([\s\S]*c\.get\('trackingContext'\)[\s\S]*\)/,
    'POST /api/auth/login must pass request tracking context into findOrCreateUser',
  )
})

test('user_login tracking event forwards request context to tracking v2', () => {
  assert.match(
    authServiceSource,
    /trackingContext\?: TrackingRequestContext/,
    'findOrCreateUser should accept an optional request tracking context',
  )
  assert.match(
    authServiceSource,
    /safeTrackBackendEvent\(event, logger, trackingContext\)/,
    'user_login safeTrackBackendEvent calls must forward the request tracking context',
  )
})
