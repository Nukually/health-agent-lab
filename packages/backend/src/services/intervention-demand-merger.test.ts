import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeOps } from './intervention-demand-merger.js'

const noopLog = { warn() {}, info() {}, error() {}, child() { return noopLog } } as any

const groups = [{ id: 'group-1' }, { id: 'group-2' }]
const demands = [{ id: 'raw-1' }, { id: 'raw-2' }, { id: 'raw-3' }]

test('maps valid g/r seqs to ids for append and update', () => {
  const { ops, skipped } = normalizeOps(
    {
      operations: [
        { action: 'append', name: '化疗后恶心居家缓解', memberSeqs: ['r1', 'r3'] },
        { action: 'update', targetGroupSeq: 'g2', memberSeqs: ['r2'], newName: '潮热夜间应对' },
      ],
    },
    groups,
    demands,
    noopLog,
  )
  assert.equal(skipped, 0)
  assert.equal(ops.length, 2)
  assert.deepEqual(ops[0], { action: 'append', name: '化疗后恶心居家缓解', rawIds: ['raw-1', 'raw-3'] })
  assert.deepEqual(ops[1], { action: 'update', groupId: 'group-2', rawIds: ['raw-2'], newName: '潮热夜间应对' })
})

test('drops ops referencing unknown group/raw seqs', () => {
  const { ops, skipped } = normalizeOps(
    {
      operations: [
        { action: 'update', targetGroupSeq: 'g9', memberSeqs: ['r1'] }, // 不存在的 group
        { action: 'append', name: '凭空建组', memberSeqs: ['r99'] }, // member 全越界 → 空 → 丢弃
      ],
    },
    groups,
    demands,
    noopLog,
  )
  assert.equal(ops.length, 0)
  assert.equal(skipped, 2)
})

test('each raw is claimed by at most one op (first wins)', () => {
  const { ops } = normalizeOps(
    {
      operations: [
        { action: 'append', name: 'A', memberSeqs: ['r1', 'r2'] },
        { action: 'update', targetGroupSeq: 'g1', memberSeqs: ['r2', 'r3'] }, // r2 已被上一个 op 占用
      ],
    },
    groups,
    demands,
    noopLog,
  )
  assert.deepEqual(ops[0], { action: 'append', name: 'A', rawIds: ['raw-1', 'raw-2'] })
  assert.deepEqual(ops[1], { action: 'update', groupId: 'group-1', rawIds: ['raw-3'], newName: undefined })
})

test('update with only newName (no members) is kept', () => {
  const { ops } = normalizeOps(
    { operations: [{ action: 'update', targetGroupSeq: 'g1', newName: '改个名' }] },
    groups,
    demands,
    noopLog,
  )
  assert.equal(ops.length, 1)
  assert.deepEqual(ops[0], { action: 'update', groupId: 'group-1', rawIds: [], newName: '改个名' })
})

test('handles missing / non-array operations safely', () => {
  assert.deepEqual(normalizeOps(null, groups, demands, noopLog), { ops: [], skipped: 0 })
  assert.deepEqual(normalizeOps({ operations: 'nope' }, groups, demands, noopLog), { ops: [], skipped: 0 })
})
