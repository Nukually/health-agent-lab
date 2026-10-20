import assert from 'node:assert/strict'
import type { CheckInRecord, CheckInRecordListResponse } from '@health-agent/shared'

;(globalThis as typeof globalThis & { localStorage?: Storage }).localStorage = {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
  clear: () => undefined,
  key: () => null,
  length: 0,
}

const apiModule = await import('../src/services/checkInApi.js')
const collectCheckInRecords = (apiModule as any).collectCheckInRecords

function record(id: string, recordedAt: string): CheckInRecord {
  return {
    id,
    userId: 'user-1',
    schemaId: 'schema-1',
    categoryKey: 'weather',
    schemaVersion: 1,
    title: '天气记录',
    recordedAt,
    recordedByType: 'user',
    recordedByName: null,
    sourceSessionId: null,
    sourceMessageId: null,
    toolCallId: null,
    valuesJson: {},
    attachmentsJson: [],
    renderedA2uiSchema: null,
    schemaSnapshot: null,
    tags: [],
    createdAt: recordedAt,
    updatedAt: recordedAt,
  }
}

assert.equal(typeof collectCheckInRecords, 'function')

const queries: Array<{ categoryKey?: string; cursor?: string; limit?: number }> = []
const pages: CheckInRecordListResponse[] = [
  { records: [record('r1', '2026-05-20T00:00:00.000Z'), record('r2', '2026-05-19T00:00:00.000Z')], nextCursor: '2026-05-19T00:00:00.000Z' },
  { records: [record('r3', '2026-04-01T00:00:00.000Z')], nextCursor: null },
]

const allRecords = await collectCheckInRecords(
  async (query: { categoryKey?: string; cursor?: string; limit?: number }) => {
    queries.push(query)
    return pages[queries.length - 1] ?? { records: [], nextCursor: null }
  },
  { categoryKey: 'weather', pageSize: 2, maxRecords: 10 },
)

assert.deepEqual(allRecords.map((item: CheckInRecord) => item.id), ['r1', 'r2', 'r3'])
assert.deepEqual(queries, [
  { categoryKey: 'weather', limit: 2 },
  { categoryKey: 'weather', cursor: '2026-05-19T00:00:00.000Z', limit: 2 },
])

const cappedRecords = await collectCheckInRecords(
  async () => ({ records: [record('a', '2026-05-20T00:00:00.000Z'), record('b', '2026-05-19T00:00:00.000Z')], nextCursor: 'cursor' }),
  { categoryKey: 'weather', pageSize: 2, maxRecords: 1 },
)

assert.deepEqual(cappedRecords.map((item: CheckInRecord) => item.id), ['a'])

console.log('check-in record pagination tests passed')
