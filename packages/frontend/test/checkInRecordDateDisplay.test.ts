import assert from 'node:assert/strict'

;(globalThis as typeof globalThis & { localStorage?: Storage }).localStorage = {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
  clear: () => undefined,
  key: () => null,
  length: 0,
}

const { formatRecordDate } = await import('../src/pages/CheckInRecords.js')

assert.equal(formatRecordDate('2026-05-20T00:00:00.000Z'), '2026-05-20')
assert.equal(formatRecordDate('2026-05-20T14:37:00.000Z'), '2026-05-20')
assert.equal(formatRecordDate('bad-value'), 'bad-value')

console.log('check-in record date display tests passed')
