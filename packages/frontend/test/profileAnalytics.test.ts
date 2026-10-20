import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const profileSource = readFileSync(resolve(__dirname, '../src/pages/Profile.tsx'), 'utf8')

assert.match(
  profileSource,
  /reportAnalyticsEvent\('personal_info_time'/,
  'personal_info_time must use reportAnalyticsEvent so legacy analytics and Tracking v2 are dual-written',
)
assert.doesNotMatch(
  profileSource,
  /postKeepalive\(['"]\/analytics\/events['"]/,
  'Profile page must not bypass the dual-write analytics helper for personal_info_time',
)
