import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const useSSESource = readFileSync(resolve(__dirname, '../src/hooks/useSSE.ts'), 'utf8')

assert.match(
  useSSESource,
  /getTrackingContextHeaders/,
  'streaming chat requests must import/use getTrackingContextHeaders so backend analytics can receive app/web session context',
)
assert.match(
  useSSESource,
  /headers:\s*{[\s\S]*\.\.\.getTrackingContextHeaders\(\)[\s\S]*Authorization/s,
  'POST /api/chat/send headers must include Tracking v2 context before auth so chat_request_completed can be linked to native/h5 sessions',
)
