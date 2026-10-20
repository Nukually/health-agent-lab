import assert from 'node:assert/strict'
import test from 'node:test'
import {
  RECOMMENDED_QUESTION_SYSTEM_PROMPT,
  RECOMMENDED_QUESTION_DATA_TTL_SECONDS,
  RECOMMENDED_QUESTION_LOCK_TTL_SECONDS,
  RECOMMENDED_QUESTION_MAX_GENERATION_ATTEMPTS,
  buildRecommendedQuestionUserPrompt,
  extractStoredUserQuestionText,
  parseRecommendedQuestionCacheValue,
  parseRecommendedQuestionJson,
  retryRecommendedQuestionGeneration,
  sanitizeRecentUserQuestions,
} from './recommended-question-agent.js'

test('recommended question parser accepts exactly three string questions', () => {
  const parsed = parseRecommendedQuestionJson('{"questions":["乳房疼怎么缓解？","最近睡眠怎么调？","复查前准备什么？"]}')

  assert.deepEqual(parsed, [
    '乳房疼怎么缓解？',
    '最近睡眠怎么调？',
    '复查前准备什么？',
  ])
})

test('recommended question parser accepts markdown fenced json', () => {
  const parsed = parseRecommendedQuestionJson('```json\n{"questions":["报告指标怎么看？","最近睡眠怎么调？","复查前准备什么？"]}\n```')

  assert.deepEqual(parsed, [
    '报告指标怎么看？',
    '最近睡眠怎么调？',
    '复查前准备什么？',
  ])
})

test('recommended question parser rejects prose and object shaped questions', () => {
  assert.throws(
    () => parseRecommendedQuestionJson('好的，{"questions":["A","B","C"]}'),
    /valid JSON object/,
  )
  assert.throws(
    () => parseRecommendedQuestionJson('{"questions":[{"text":"A"},{"text":"B"},{"text":"C"}]}'),
    /string/,
  )
})

test('recommended question parser rejects pressure-inducing wording', () => {
  assert.throws(
    () => parseRecommendedQuestionJson('{"questions":["怎么判断会不会复发？","最近睡眠怎么调整？","复查前准备什么？"]}'),
    /pressure-inducing/,
  )
})

test('recommended question parser rejects agent asking user wording', () => {
  assert.throws(
    () => parseRecommendedQuestionJson('{"questions":["今天感觉怎么样？","最近睡眠怎么调？","复查前准备什么？"]}'),
    /user-to-agent/,
  )
  assert.throws(
    () => parseRecommendedQuestionJson('{"questions":["哪里不舒服？","最近睡眠怎么调？","复查前准备什么？"]}'),
    /user-to-agent/,
  )
})

test('recommended question parser rejects questions longer than 15 chars', () => {
  assert.throws(
    () => parseRecommendedQuestionJson(`{"questions":["${'睡'.repeat(16)}？","最近睡眠怎么调？","复查前准备什么？"]}`),
    /15/,
  )
})

test('stored user question extraction strips reminders and text blocks', () => {
  assert.equal(
    extractStoredUserQuestionText('<system-reminder>\nignore\n</system-reminder>\n\n最近睡不好怎么办？'),
    '最近睡不好怎么办？',
  )
  assert.equal(
    extractStoredUserQuestionText('[{"type":"text","text":"<system-reminder>\\nignore\\n</system-reminder>\\n\\n复查前准备什么？"},{"type":"image_url","image_url":{"url":"oss://x"}}]'),
    '复查前准备什么？',
  )
})

test('recent user questions are capped by count, per item length, and total length', () => {
  const rows = Array.from({ length: 120 }, (_, index) => `${index + 1}. ${'睡眠'.repeat(120)}怎么办？`)
  const result = sanitizeRecentUserQuestions(rows, {
    maxCount: 100,
    maxQuestionChars: 12,
    maxTotalChars: 80,
  })

  assert.equal(result.length <= 100, true)
  assert.equal(result.every((item) => item.length <= 12), true)
  assert.equal(result.join('\n').length <= 80, true)
})

test('prompts require json-only output and handle missing recent questions', () => {
  assert.match(RECOMMENDED_QUESTION_SYSTEM_PROMPT, /最终输出只能是一个合法 JSON 对象/)
  assert.match(RECOMMENDED_QUESTION_SYSTEM_PROMPT, /不要输出 ```json 代码块/)
  assert.match(RECOMMENDED_QUESTION_SYSTEM_PROMPT, /输出不符合 JSON 会被系统直接判定为失败/)
  assert.match(RECOMMENDED_QUESTION_SYSTEM_PROMPT, /不超过 15/)
  assert.match(RECOMMENDED_QUESTION_SYSTEM_PROMPT, /"questions"/)
  assert.match(RECOMMENDED_QUESTION_SYSTEM_PROMPT, /用户发给演示助手 Agent 的提问/)
  assert.match(RECOMMENDED_QUESTION_SYSTEM_PROMPT, /不要站在 Agent 视角反问用户/)

  const prompt = buildRecommendedQuestionUserPrompt({
    userProfile: {
      nickname: null,
      birthday: null,
      gender: '女',
      currentConcernLabel: '还不确定，先想了解看看',
    },
    longTermPreference: null,
    recentUserQuestions: [],
  })

  assert.match(prompt, /输出必须是 JSON/)
  assert.match(prompt, /站在用户视角/)
  assert.match(prompt, /不要生成 Agent 反问用户/)
  assert.match(prompt, /暂无可参考的近期问题/)
  assert.match(prompt, /性别：女/)
})

test('recommended question cache parser distinguishes ready and generating states', () => {
  assert.deepEqual(
    parseRecommendedQuestionCacheValue(JSON.stringify({
      status: 'ready',
      source: 'agent',
      generatedAt: '2026-06-02T08:00:00.000Z',
      questions: ['报告指标怎么看？', '最近睡眠怎么调？', '复查前准备什么？'],
    })),
    {
      status: 'ready',
      source: 'agent',
      generatedAt: '2026-06-02T08:00:00.000Z',
      questions: ['报告指标怎么看？', '最近睡眠怎么调？', '复查前准备什么？'],
    },
  )

  assert.deepEqual(
    parseRecommendedQuestionCacheValue(JSON.stringify({
      status: 'generating',
      source: 'agent',
      generationId: 'generation-1',
      startedAt: '2026-06-02T08:00:00.000Z',
    })),
    {
      status: 'generating',
      source: 'agent',
      generationId: 'generation-1',
      startedAt: '2026-06-02T08:00:00.000Z',
    },
  )

  assert.equal(parseRecommendedQuestionCacheValue('{"source":"agent","questions":[]}'), null)
  assert.equal(parseRecommendedQuestionCacheValue(JSON.stringify({
    source: 'agent',
    generatedAt: '2026-06-02T08:00:00.000Z',
    questions: ['报告指标怎么看？', '最近睡眠怎么调？', '复查前准备什么？'],
  })), null)
})

test('recommended question data and lock caches use separate TTLs', () => {
  assert.equal(RECOMMENDED_QUESTION_DATA_TTL_SECONDS, 5 * 60)
  assert.equal(RECOMMENDED_QUESTION_LOCK_TTL_SECONDS, 30)
})

test('recommended question generation retries up to three attempts', async () => {
  let attempts = 0

  const result = await retryRecommendedQuestionGeneration(async () => {
    attempts += 1
    if (attempts < 3) throw new Error(`attempt ${attempts} failed`)
    return ['乳房疼怎么缓解？', '最近睡眠怎么调？', '复查前准备什么？']
  })

  assert.equal(attempts, RECOMMENDED_QUESTION_MAX_GENERATION_ATTEMPTS)
  assert.deepEqual(result, ['乳房疼怎么缓解？', '最近睡眠怎么调？', '复查前准备什么？'])
})

test('recommended question generation stops after three failed attempts', async () => {
  let attempts = 0

  await assert.rejects(
    () => retryRecommendedQuestionGeneration(async () => {
      attempts += 1
      throw new Error(`attempt ${attempts} failed`)
    }),
    /attempt 3 failed/,
  )

  assert.equal(attempts, RECOMMENDED_QUESTION_MAX_GENERATION_ATTEMPTS)
})
