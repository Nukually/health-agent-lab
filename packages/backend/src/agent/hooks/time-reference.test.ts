import assert from 'node:assert/strict'
import test from 'node:test'
import { buildTimeReferenceReminder } from './time-reference.js'

const ANCHOR = new Date('2026-05-25T04:01:00.000Z')

test('builds relative date/month/year and lunar festival lines from user text', () => {
  const reminder = buildTimeReferenceReminder('昨天不舒服，上个月做过检查，上一年也复查过；中秋是哪天？', ANCHOR)

  assert.ok(reminder)
  assert.match(reminder, /昨天：2026年5月24日 星期天/)
  assert.match(reminder, /上个月：2026年4月/)
  assert.match(reminder, /上一年：2025年/)
  assert.match(reminder, /中秋：今年中秋是 2026年9月25日 星期五/)
})

test('skips today line because current-time already carries the anchor date', () => {
  const reminder = buildTimeReferenceReminder('昨天做完检查，今天有点担心。', ANCHOR)

  assert.ok(reminder)
  assert.match(reminder, /昨天：2026年5月24日 星期天/)
  assert.doesNotMatch(reminder, /今天：2026年5月25日 星期一/)
})

test('builds relative weekday lines using Monday as week start', () => {
  const reminder = buildTimeReferenceReminder('上周五复查了，下周一还要去医院', ANCHOR)

  assert.ok(reminder)
  assert.match(reminder, /上周五：2026年5月22日 星期五/)
  assert.match(reminder, /上周：2026年5月18日 星期一 至 2026年5月24日 星期天/)
  assert.match(reminder, /下周一：2026年6月1日 星期一/)
  assert.match(reminder, /下周：2026年6月1日 星期一 至 2026年6月7日 星期天/)
})

test('builds numeric and Chinese N-days-before or after lines', () => {
  const reminder = buildTimeReferenceReminder('3天前开始疼，5天后复查；两天前也记录过，二十一天后再看。', ANCHOR)

  assert.ok(reminder)
  assert.match(reminder, /3天前：2026年5月22日 星期五/)
  assert.match(reminder, /5天后：2026年5月30日 星期六/)
  assert.match(reminder, /两天前：2026年5月23日 星期六/)
  assert.match(reminder, /二十一天后：2026年6月15日 星期一/)
})

test('builds common festival lines with nearby year qualifiers', () => {
  const reminder = buildTimeReferenceReminder('明年春节、去年国庆、今年清明分别是哪天？', ANCHOR)

  assert.ok(reminder)
  assert.match(reminder, /春节：明年春节是 2027年2月7日 星期天/)
  assert.match(reminder, /国庆：去年国庆是 2025年10月1日 星期三/)
  assert.match(reminder, /清明：今年清明是 2026年4月5日 星期天/)
})

test('returns null when user text has no supported time reference', () => {
  assert.equal(buildTimeReferenceReminder('帮我看看这个报告', ANCHOR), null)
})

test('reads text blocks from multimodal message content', () => {
  const reminder = buildTimeReferenceReminder([
    { type: 'text', text: '前天拍的报告，端午后还要复查。' },
    { type: 'image_url' },
  ], ANCHOR)

  assert.ok(reminder)
  assert.match(reminder, /前天：2026年5月23日 星期六/)
  assert.match(reminder, /端午：今年端午是 2026年6月19日 星期五/)
})
