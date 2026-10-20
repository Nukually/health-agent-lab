import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const sourcePath = join(dirname(fileURLToPath(import.meta.url)), 'index.ts')

test('cron registry does not schedule nightly profile consolidation', () => {
  const source = readFileSync(sourcePath, 'utf8')

  assert.doesNotMatch(source, /runNightlyConsolidation/)
  assert.doesNotMatch(source, /consolidationJob/)
  assert.doesNotMatch(source, /consolidationNext/)
  assert.doesNotMatch(source, /nightly consolidation cron triggered/)
})

test('cron registry keeps remaining production jobs', () => {
  const source = readFileSync(sourcePath, 'utf8')

  assert.match(source, /runNightlyStructuredProfiling/)
  assert.match(source, /runPurgeExpiredDeletions/)
  assert.match(source, /runDueScheduledProactiveMessages/)
})

test('cron registry schedules efficacy analysis sweep', () => {
  const source = readFileSync(sourcePath, 'utf8')

  assert.match(source, /runEfficacyAnalysisSweep/)
  assert.match(source, /efficacyAnalysisNext/)
})
