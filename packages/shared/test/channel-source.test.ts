import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveChannelSourceTypeFromPartnerName } from '../src/channel-source.js'

test('only the explicit online partner name is classified as online', () => {
  assert.equal(resolveChannelSourceTypeFromPartnerName('线上'), 'online')
  assert.equal(resolveChannelSourceTypeFromPartnerName('线下团队'), null)
  assert.equal(resolveChannelSourceTypeFromPartnerName('内部测试'), null)
  assert.equal(resolveChannelSourceTypeFromPartnerName(' 线上 '), 'online')
  assert.equal(resolveChannelSourceTypeFromPartnerName(null), null)
})
