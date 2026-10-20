import assert from 'node:assert/strict'
import test from 'node:test'
import type { SessionState } from '../state/session.js'
import {
  calculateReportAgeInMonths,
  formatReportAge,
  MEDICAL_REPORT_EXPERT_MODELS,
  normalizeReportIssuedDate,
  runMedicalReportConsultation,
  type MedicalReportExpertRunner,
} from './medical-report-consultation.js'

const logger = {
  child: () => logger,
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as any

function sessionWithMessages(messages: SessionState['messages']): SessionState {
  return {
    sessionId: 'session-1',
    userId: 'user-1',
    messages,
    tokenCount: 0,
    summary: null,
    abortController: new AbortController(),
    logger,
  }
}

test('medical report consultation returns a deterministic error when latest real user message has no image', async () => {
  const result = await runMedicalReportConsultation(
    sessionWithMessages([{ role: 'user', content: '帮我看报告' }]),
    logger,
    {},
    async () => {
      throw new Error('runner should not be called')
    },
  )

  assert.equal(result.imageCount, 0)
  assert.equal(result.successCount, 0)
  assert.match(result.output, /当前未发现可用于病历解析的本轮图片/)
})

test('medical report consultation runs three expert models for one image with user text and captured time', async () => {
  const calls: Array<{ model: string; imageCount: number; userText: string; capturedTimeText: string }> = []
  const runner: MedicalReportExpertRunner = async (model, input: any) => {
    calls.push({
      model,
      imageCount: input.imageBlocks.length,
      userText: input.userText,
      capturedTimeText: input.capturedTimeText,
    })
    return `${model} 专家结果：报告可见 HER2 1+。`
  }

  const result = await runMedicalReportConsultation(
    sessionWithMessages([
      {
        role: 'user',
        content: [
          { type: 'text', text: '帮我解释这张病理报告' },
          { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,abc' } },
        ],
        untrustedInput: true,
      },
    ]),
    logger,
    { reportIssuedDate: '2026--02--06' },
    runner,
  )

  assert.equal(result.imageCount, 1)
  assert.equal(result.successCount, 3)
  assert.equal(calls.length, 3)
  assert.deepEqual(calls.map((c) => c.model), [...MEDICAL_REPORT_EXPERT_MODELS])
  assert.ok(calls.every((c) => c.imageCount === 1))
  assert.ok(calls.every((c) => c.userText === '帮我解释这张病理报告'))
  assert.ok(calls.every((c) => c.capturedTimeText === calls[0].capturedTimeText))
  assert.match(result.output, /当前系统时间\(time_anchor\)：/)
  assert.match(result.output, /报告出具时间\(report_issued_date\)：2026-02-06/)
  assert.match(result.output, /报告距今\(report_age\)：/)
  assert.match(result.output, /图片 1：三位专家识别结果/)
  assert.match(result.output, /专家模型也可能看错、漏读或理解错/)
  assert.match(result.output, /专家结果之间形成共识/)
  assert.match(result.output, /基于返回成功专家识别结果之间的共识/)
  assert.match(result.output, /这份报告说明了什么、关键指标通常意味着什么、医生还需要结合什么/)
  assert.match(result.output, /以返回成功专家结果一致确认、且可在原文核实的内容为准/)
  assert.match(result.output, /报告新旧、治疗阶段等时间信息，只使用工具返回的 time_anchor、report_issued_date、report_age/)
  assert.match(result.output, /不复述专家结果，不把参数列成清单后就结束/)
})

test('medical report consultation avoids three-expert consensus wording when some experts fail', async () => {
  const runner: MedicalReportExpertRunner = async (model) => {
    if (model === MEDICAL_REPORT_EXPERT_MODELS[0]) {
      throw new Error('expert unavailable')
    }
    return `${model} 专家结果：报告可见 HER2 1+。`
  }

  const result = await runMedicalReportConsultation(
    sessionWithMessages([
      {
        role: 'user',
        content: [
          { type: 'text', text: '帮我解释这张病理报告' },
          { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,abc' } },
        ],
        untrustedInput: true,
      },
    ]),
    logger,
    {},
    runner,
  )

  assert.equal(result.successCount, 2)
  assert.match(result.output, /本次总计 2\/3 份专家结果返回成功/)
  assert.match(result.output, /基于返回成功专家识别结果之间的共识/)
  assert.doesNotMatch(result.output, /基于三位专家识别结果的共识/)
  assert.doesNotMatch(result.output, /以三份结果一致确认/)
})

test('medical report consultation keeps long-image slices grouped as one uploaded image', async () => {
  const calls: Array<{ model: string; imageCount: number }> = []
  const runner: MedicalReportExpertRunner = async (model, input) => {
    calls.push({ model, imageCount: input.imageBlocks.length })
    return `${model} 专家结果：两张切片属于同一份报告。`
  }

  const result = await runMedicalReportConsultation(
    sessionWithMessages([
      {
        role: 'user',
        content: [
          { type: 'text', text: '帮我解释这张长图报告' },
          { type: 'image_url', image_url: { url: 'slice-1', detail: 'high' } },
          { type: 'image_url', image_url: { url: 'slice-2', detail: 'high' } },
        ],
        imageAssetIds: ['asset-1'],
        imageBlockGroups: [
          {
            assetId: 'asset-1',
            imageBlocks: [
              { type: 'image_url', image_url: { url: 'slice-1', detail: 'high' } },
              { type: 'image_url', image_url: { url: 'slice-2', detail: 'high' } },
            ],
          },
        ],
        untrustedInput: true,
      },
    ]),
    logger,
    {},
    runner,
  )

  assert.equal(result.imageCount, 1)
  assert.equal(result.successCount, 3)
  assert.equal(calls.length, 3)
  assert.ok(calls.every((call) => call.imageCount === 2))
  assert.match(result.output, /本轮图片数量：1/)
  assert.match(result.output, /图片 1：三位专家识别结果/)
  assert.doesNotMatch(result.output, /图片 2：三位专家识别结果/)
  assert.match(result.output, /本次总计 3\/3 份专家结果返回成功/)
})

test('medical report consultation processes images in queued batches of five', async () => {
  const calls: Array<{ model: string; url: string }> = []
  let releaseFirstBatch!: () => void
  let firstBatchStartedResolve!: () => void
  const firstBatchGate = new Promise<void>((resolve) => {
    releaseFirstBatch = resolve
  })
  const firstBatchStarted = new Promise<void>((resolve) => {
    firstBatchStartedResolve = resolve
  })
  const runner: MedicalReportExpertRunner = async (model, input) => {
    const url = input.imageBlocks[0].image_url.url
    calls.push({ model, url })
    if (url <= 'img-5') {
      if (calls.filter((call) => call.url <= 'img-5').length === 15) {
        firstBatchStartedResolve()
      }
      await firstBatchGate
    }
    return `${url} ${model} 专家结果`
  }

  const resultPromise = runMedicalReportConsultation(
    sessionWithMessages([
      {
        role: 'user',
        content: [
          { type: 'text', text: '帮我解释这几张报告' },
          ...Array.from({ length: 7 }, (_, idx) => ({
            type: 'image_url' as const,
            image_url: { url: `img-${idx + 1}` },
          })),
        ],
        untrustedInput: true,
      },
    ]),
    logger,
    {},
    runner,
  )

  let timeout: ReturnType<typeof setTimeout> | null = null
  try {
    await Promise.race([
      firstBatchStarted,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('first batch did not start')), 1000)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
  assert.deepEqual([...new Set(calls.map((call) => call.url))], ['img-1', 'img-2', 'img-3', 'img-4', 'img-5'])
  releaseFirstBatch()

  const result = await resultPromise
  assert.equal(result.imageCount, 7)
  assert.equal(result.successCount, 21)
  assert.equal(calls.length, 21)
  assert.match(result.output, /图片 1：三位专家识别结果/)
  assert.match(result.output, /图片 7：三位专家识别结果/)
  assert.match(result.output, /最多同时处理 5 张图片/)
})

test('medical report consultation normalizes report issued date and calculates whole months in Shanghai time', () => {
  assert.equal(normalizeReportIssuedDate('2026--02--06'), '2026-02-06')
  assert.equal(normalizeReportIssuedDate('2026-02-30'), null)

  const age = calculateReportAgeInMonths('2026-02-06', new Date('2026-05-06T04:00:00Z'))
  assert.equal(age.currentDate, '2026-05-06')
  assert.equal(age.months, 3)
  assert.equal(age.isFuture, false)

  const oldAge = calculateReportAgeInMonths('2019-11-15', new Date('2026-05-06T04:00:00Z'))
  assert.equal(oldAge.months, 77)
  assert.equal(formatReportAge(oldAge.months!), '距今 6 年 5 个月')
  assert.equal(formatReportAge(12), '距今 1 年')
  assert.equal(formatReportAge(0), '距今 0 个月（未满 1 个月）')
})
