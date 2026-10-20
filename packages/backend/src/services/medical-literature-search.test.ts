import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildMedicalLiteratureSources,
  filterMedicalLiteratureChunksByScore,
  formatMedicalLiteratureToolOutput,
  MEDICAL_LITERATURE_MIN_SCORE,
  normalizeMedicalLiteratureHit,
  parseMedicalLiteratureIdArray,
} from './medical-literature-search.js'
import type { MedicalLiteratureSearchOutput } from '@health-agent/shared'

test('filterMedicalLiteratureChunksByScore keeps only score-qualified chunks', () => {
  const chunks = [
    { sourceRank: 1, score: 0.64, title: '低分', content: '低相关。' },
    { sourceRank: 2, score: 0.65, title: '边界', content: '可进入。' },
    { sourceRank: 3, score: 0.72, title: '高分', content: '可进入。' },
    { sourceRank: 4, title: '缺分', content: '接口缺少 score。' },
  ]

  assert.deepEqual(
    filterMedicalLiteratureChunksByScore(chunks).map((chunk) => chunk.sourceRank),
    [2, 3],
  )
})

test('normalizeMedicalLiteratureHit reads vec_score from query API', () => {
  const chunk = normalizeMedicalLiteratureHit({
    rank: 5,
    vec_score: 0.852,
    title: '中国乳腺癌随诊随访与健康管理指南(2022版)',
    content: '治疗方案正文。',
    pub_year: '2022',
  }, 1)

  assert.equal(chunk?.sourceRank, 5)
  assert.equal(chunk?.score, 0.852)
  assert.equal(chunk?.pubYear, 2022)
})

test('buildMedicalLiteratureSources groups chunks from the same article', () => {
  const sources = buildMedicalLiteratureSources([
    {
      sourceRank: 1,
      score: 0.8,
      title: '同一指南',
      doi: '10.1/demo',
      content: '第一段。',
    },
    {
      sourceRank: 3,
      score: 0.9,
      title: '同一指南',
      doi: '10.1/demo',
      content: '第三段。',
    },
    {
      sourceRank: 2,
      score: 0.7,
      title: '另一篇',
      pubYear: 2024,
      content: '另一段。',
    },
  ], 2)

  assert.equal(sources.length, 2)
  assert.equal(sources[0].id, 'd-2-1')
  assert.equal(sources[0].score, 0.9)
  assert.deepEqual(sources[0].chunks.map((chunk) => chunk.sourceRank), [1, 3])
  assert.equal(sources[1].id, 'd-2-2')
})

test('parseMedicalLiteratureIdArray accepts JSON arrays and caps selected ids', () => {
  const validIds = new Set(['d-1-1', 'd-1-2', 'd-1-3', 'd-1-4', 'd-1-5', 'd-1-6'])

  assert.deepEqual(
    parseMedicalLiteratureIdArray('["d-1-1", "d-1-2", "d-1-2", "bad"]', validIds),
    ['d-1-1', 'd-1-2'],
  )
  assert.deepEqual(
    parseMedicalLiteratureIdArray('```json\n["D-1-1","d-1-3","d-1-4","d-1-5","d-1-6","d-1-2"]\n```', validIds),
    ['d-1-1', 'd-1-3', 'd-1-4', 'd-1-5', 'd-1-6'],
  )
  assert.deepEqual(parseMedicalLiteratureIdArray('选择 d-1-2 和 d-1-6', validIds), ['d-1-2', 'd-1-6'])
  assert.equal(parseMedicalLiteratureIdArray('没有相关文献', validIds), null)
})

test('formatMedicalLiteratureToolOutput renders selected grouped sources only', () => {
  const output: MedicalLiteratureSearchOutput = {
    kind: 'medical_literature_search',
    query: '乳腺癌 潮热 处理',
    citationStyle: 'numeric',
    searchedCount: 3,
    scoreThreshold: MEDICAL_LITERATURE_MIN_SCORE,
    scoreQualifiedCount: 3,
    candidateCount: 2,
    selectedCount: 1,
    allSources: [],
    selectedSources: [{
      id: '1',
      title: '中国乳腺癌随诊随访与健康管理指南(2022版)',
      doi: '10.3760/demo',
      pubYear: 2022,
      articleClass: '指南',
      score: 0.9,
      chunks: [
        { sourceRank: 1, score: 0.8, title: '指南', content: '非药物治疗可用于较轻潮热。', sectionName: '更年期综合征的管理' },
        { sourceRank: 2, score: 0.9, title: '指南', content: '全身激素替代治疗会增加乳腺癌患者复发风险，因此不推荐。', sectionName: '更年期综合征的管理' },
      ],
    }],
  }

  const formatted = formatMedicalLiteratureToolOutput(output)

  assert.match(formatted, /找到 1 篇相关文献/)
  assert.match(formatted, /文献编号 \[1\]/)
  assert.match(formatted, /## \[1\] 中国乳腺癌随诊随访与健康管理指南/)
  assert.match(formatted, /片段 1/)
  assert.match(formatted, /片段 2/)
  assert.match(formatted, /不要给原文无法支持/)
  assert.doesNotMatch(formatted, /\[d-\d+-\d+\]/)
  assert.doesNotMatch(formatted, /候选 chunk|score ≥|qwen3\.5-flash|进入.*判断/)
  assert.doesNotMatch(formatted, /score 0\.9/)
})
