import assert from 'node:assert/strict'
import type { CheckInFieldDefinition, CheckInRecord } from '@health-agent/shared'

;(globalThis as typeof globalThis & { localStorage?: Storage }).localStorage = {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
  clear: () => undefined,
  key: () => null,
  length: 0,
}

const { shouldShowCalendarTrend } = await import('../src/pages/CheckInRecords.js')

const fields: CheckInFieldDefinition[] = [
  { key: 'pain', label: '疼痛程度', type: 'number', unit: '分' },
  { key: 'note', label: '备注', type: 'text' },
]

function record(valuesJson: CheckInRecord['valuesJson']): CheckInRecord {
  return {
    id: 'record-1',
    userId: 'user-1',
    schemaId: 'schema-1',
    categoryKey: 'skin',
    schemaVersion: 1,
    title: '皮肤观察',
    recordedAt: '2026-05-22T00:00:00.000Z',
    recordedByType: 'agent',
    recordedByName: null,
    sourceSessionId: null,
    sourceMessageId: null,
    toolCallId: null,
    valuesJson,
    attachmentsJson: [],
    renderedA2uiSchema: null,
    schemaSnapshot: null,
    tags: [],
    createdAt: '2026-05-22T00:00:00.000Z',
    updatedAt: '2026-05-22T00:00:00.000Z',
  }
}

assert.equal(
  shouldShowCalendarTrend([record({ pain: 2 })], fields),
  true,
  'calendar categories should show a trend chart when records contain numeric values',
)

assert.equal(
  shouldShowCalendarTrend([record({ pain: '暂未填写' })], fields),
  false,
  'calendar categories should not show an empty trend chart without numeric values',
)

assert.equal(
  shouldShowCalendarTrend([record({ pain: { value: '3' } })], fields),
  true,
  'numeric values wrapped with metadata should still be trendable',
)

console.log('check-in record trend display tests passed')
