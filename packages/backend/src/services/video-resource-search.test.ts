import assert from 'node:assert/strict'
import test from 'node:test'
import { buildVideoResourceSearchQueries, VIDEO_RESOURCE_SITE } from './baidu-web-search.js'

test('video search site filter matches Baidu accepted host format', () => {
  assert.equal(VIDEO_RESOURCE_SITE, 'bilibili.com')
})

test('buildVideoResourceSearchQueries keeps a broader fallback for narrow symptoms', () => {
  assert.deepEqual(
    buildVideoResourceSearchQueries('化疗后 恶心 嗓子酸'),
    ['化疗后 恶心 嗓子酸', '化疗后 恶心'],
  )
})

test('buildVideoResourceSearchQueries does not duplicate already broad queries', () => {
  assert.deepEqual(
    buildVideoResourceSearchQueries('乳腺癌 化疗后 恶心'),
    ['乳腺癌 化疗后 恶心'],
  )
})
