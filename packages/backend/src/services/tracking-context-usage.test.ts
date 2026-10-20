import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const backendSrc = resolve(__dirname, '..')
function source(path: string): string {
  return readFileSync(resolve(backendSrc, path), 'utf8')
}

test('request middleware creates one shared tracking context for backend events', () => {
  const requestIdSource = source('middleware/request-id.ts')
  assert.match(requestIdSource, /trackingContext: TrackingRequestContext/, 'Hono context should expose trackingContext')
  assert.match(
    requestIdSource,
    /c\.set\('trackingContext',\s*trackingRequestContextFromHeaders\([\s\S]*requestId[\s\S]*\)\)/,
    'request-id middleware should parse tracking headers once and store them on the request context',
  )
  assert.match(
    requestIdSource,
    /safeTrackBackendEvent\([\s\S]*c\.get\('trackingContext'\)[\s\S]*\)/,
    'chat completion backend tracking should use the shared request tracking context',
  )
})

test('http routes reuse shared tracking context instead of reparsing headers', () => {
  for (const path of ['routes/auth.ts', 'routes/medical.ts', 'routes/intervention-material-runtime.ts']) {
    const routeSource = source(path)
    assert.doesNotMatch(
      routeSource,
      /trackingRequestContextFromHeaders/,
      `${path} should not reparse tracking headers after middleware centralizes request tracking context`,
    )
  }

  assert.match(source('routes/auth.ts'), /findOrCreateUser\([\s\S]*c\.get\('trackingContext'\)[\s\S]*\)/)
  assert.match(source('routes/medical.ts'), /safeTrackBackendEvent\([\s\S]*c\.get\('trackingContext'\)[\s\S]*\)/)
  assert.match(source('routes/intervention-material-runtime.ts'), /safeTrackBackendEvent\([\s\S]*c\.get\('trackingContext'\)[\s\S]*\)/)
})

test('agent tool backend tracking receives request tracking context', () => {
  assert.match(
    source('agent/types.ts'),
    /trackingContext\?: TrackingRequestContext/,
    'AgentRequestContext should carry request tracking context into tool execution',
  )
  assert.match(
    source('agent/loop.ts'),
    /trackingContext: ctx\.trackingContext/,
    'agent loop should pass request tracking context to tool executor context',
  )
  assert.match(
    source('routes/chat.ts'),
    /trackingContext: c\.get\('trackingContext'\)/,
    'chat routes should pass request tracking context into agentLoop',
  )
  assert.match(
    source('agent/tools/executor.ts'),
    /safeTrackBackendEvent\(analyticsEvent, log, ctx\.trackingContext\)/,
    'tool executor backend tracking events should be linked with the same native/h5/backend context',
  )
})
