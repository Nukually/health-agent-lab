import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeEfficacyItems, normalizeLifecycleDecision, normalizeVerifyVerdict, parseMatchId, quoteIsGrounded } from './efficacy-reviewer.js'

test('normalizeEfficacyItems: 空数组即 exit', () => {
  assert.deepEqual(normalizeEfficacyItems('{"items":[]}'), [])
  assert.deepEqual(normalizeEfficacyItems('随便不是 json'), [])
})

test('normalizeEfficacyItems: 非法枚举降级、cadence 默认 oneshot', () => {
  const items = normalizeEfficacyItems(JSON.stringify({
    items: [{
      problem: '术后肩痛',
      finalPlan: '热敷加缓慢画圈活动肩部',
      cadence: '乱填',
      adoptionStatus: '乱填',
      outcome: '乱填',
      confidence: 999,
    }],
  }))
  assert.equal(items.length, 1)
  assert.equal(items[0].cadence, 'oneshot')
  assert.equal(items[0].adoptionStatus, 'unknown')
  assert.equal(items[0].outcome, 'no_feedback')
  assert.equal(items[0].confidence, 100) // clamp 到 max
})

test('normalizeEfficacyItems: expectedEndAt 仅接受 ISO 日期前缀', () => {
  const ok = normalizeEfficacyItems(JSON.stringify({
    items: [{ problem: '潮热失眠', finalPlan: '睡前呼吸练习', cadence: 'periodic', expectedEndAt: '2026-08-31T00:00:00Z' }],
  }))
  assert.equal(ok[0].expectedEndAt, '2026-08-31')
  const bad = normalizeEfficacyItems(JSON.stringify({
    items: [{ problem: '潮热失眠', finalPlan: '睡前呼吸练习', cadence: 'periodic', expectedEndAt: '两周后' }],
  }))
  assert.equal(bad[0].expectedEndAt, null)
})

test('normalizeEfficacyItems: 过短字段丢弃、按 problem 去重、最多 5 条', () => {
  const items = normalizeEfficacyItems(JSON.stringify({
    items: [
      { problem: 'x', finalPlan: '太短被丢' }, // problem < 4
      { problem: '便秘肛裂', finalPlan: '加乳果糖软化大便' },
      { problem: '便秘肛裂', finalPlan: '重复 problem 被去重' },
      { problem: '关节酸痛甲', finalPlan: '温热泡脚' },
      { problem: '关节酸痛乙', finalPlan: '温热泡脚' },
      { problem: '关节酸痛丙', finalPlan: '温热泡脚' },
      { problem: '关节酸痛丁', finalPlan: '温热泡脚' },
      { problem: '关节酸痛戊', finalPlan: '温热泡脚' },
    ],
  }))
  assert.ok(items.length <= 5)
  const problems = items.map((i) => i.problem)
  assert.equal(new Set(problems).size, problems.length) // 无重复
  assert.ok(!problems.includes('x'))
})

test('quoteIsGrounded: 子串命中/归一化/空值放行', () => {
  const userText = '没量体温，出汗没有心慌手抖\n睡前开空调25度'
  assert.equal(quoteIsGrounded('出汗没有心慌手抖', userText), true)        // 命中
  assert.equal(quoteIsGrounded('出汗没有，心慌手抖。', userText), true)     // 标点差异归一化后命中
  assert.equal(quoteIsGrounded('试试睡眠模式', userText), false)           // AI 的方案话，用户没说过 → 不命中
  assert.equal(quoteIsGrounded('', userText), true)                        // 空 quote 放行
  assert.equal(quoteIsGrounded('任何话', ''), true)                        // 无上下文不校验
})

test('normalizeEfficacyItems: 传 userText 时，未落地的 adoptionQuote 降级 unknown（Yang 场景）', () => {
  const raw = JSON.stringify({ items: [{
    problem: '内分泌治疗期间夜间潮热',
    finalPlan: '空调改睡眠模式或定时到凌晨；睡前做呼吸放松跟练',
    cadence: 'periodic',
    adoptionStatus: 'adopted',
    outcome: 'no_feedback',
    evidence: { planQuote: '试试睡眠模式或定时到凌晨', adoptionQuote: '空调改用睡眠模式或定时到凌晨...睡前做几分钟呼吸放松跟练视频', outcomeQuote: '' },
  }] })
  const userText = '早上热醒，背上头上汗多\n最近都有，入睡和醒来都会热出汗\n没量体温，出汗没有心慌手抖，睡前开空调25度入睡就关掉'
  // 不传 userText：保持模型原判（向后兼容）
  assert.equal(normalizeEfficacyItems(raw)[0].adoptionStatus, 'adopted')
  // 传 userText：adoptionQuote 不在用户原话里 → 降级 unknown、清空假原话
  const fixed = normalizeEfficacyItems(raw, userText)[0]
  assert.equal(fixed.adoptionStatus, 'unknown')
  assert.equal(fixed.evidence.adoptionQuote, '')
})

test('normalizeLifecycleDecision: 传 userText 时，未落地的采纳推进被撤销', () => {
  const raw = JSON.stringify({ action: 'update', targetId: 'R1', adoptionStatus: 'adopted', evidence: { adoptionQuote: '帮你找放松跟练视频' } })
  const userText = '热出汗，胸口闷闷的'
  const d = normalizeLifecycleDecision(raw, ['R1'], userText)
  assert.equal(d.action, 'update')
  assert.equal(d.adoptionStatus, undefined)          // 撤销
  assert.equal(d.evidence?.adoptionQuote, undefined) // 清空
})

test('normalizeEfficacyItems: 传 userText 时，adopted 但 adoptionQuote 为空 → 降级 unknown', () => {
  // 表第7行场景：模型判 adopted 却没给患者采纳原话，空 quote 不能放行成「无依据采纳」。
  const raw = JSON.stringify({ items: [{
    problem: '腋网综合征',
    finalPlan: '每天轻柔推揉条索部位，配合手臂上举外展拉伸',
    cadence: 'periodic',
    adoptionStatus: 'adopted',
    outcome: 'no_feedback',
    evidence: { planQuote: '顺着条索走向做轻柔的推揉', adoptionQuote: '', outcomeQuote: '' },
  }] })
  const userText = '我这条筋还是硬的，按起来有点疼'
  const fixed = normalizeEfficacyItems(raw, userText)[0]
  assert.equal(fixed.adoptionStatus, 'unknown')
  assert.equal(fixed.evidence.adoptionQuote, '')
})

test('normalizeLifecycleDecision: 传 userText 时，adopted 但无 adoptionQuote → 撤销推进', () => {
  // lifecycle update 路径同样的洞：判 adopted 但 evidence 缺 adoptionQuote，空 quote 不能放行。
  const raw = JSON.stringify({ action: 'update', targetId: 'R1', adoptionStatus: 'adopted', evidence: { planQuote: '轻柔推揉条索' } })
  const userText = '这条筋还是硬的'
  const d = normalizeLifecycleDecision(raw, ['R1'], userText)
  assert.equal(d.action, 'update')
  assert.equal(d.adoptionStatus, undefined)
  assert.equal(d.evidence?.adoptionQuote, undefined)
})

test('normalizeVerifyVerdict: 未送审维度恒 approve；送审维度只认 true', () => {
  // 只送审采纳：approve=true 透传，outcome 未送审恒 true
  let v = normalizeVerifyVerdict('{"adoptionApprove":true,"outcomeApprove":false}', { needAdoption: true, needOutcome: false })
  assert.equal(v.adoptionApprove, true)
  assert.equal(v.outcomeApprove, true) // 未送审，忽略模型给的 false，恒 true
  // 送审采纳被 reject
  v = normalizeVerifyVerdict('{"adoptionApprove":false}', { needAdoption: true, needOutcome: false })
  assert.equal(v.adoptionApprove, false)
  // 同时送审采纳+疗效
  v = normalizeVerifyVerdict('{"adoptionApprove":true,"outcomeApprove":true}', { needAdoption: true, needOutcome: true })
  assert.equal(v.adoptionApprove, true)
  assert.equal(v.outcomeApprove, true)
})

test('normalizeVerifyVerdict: 解析失败/缺字段 → 送审维度按 reject 兜底', () => {
  // 坏 JSON：送审维度一律 false（审核不通过比误放行安全）
  let v = normalizeVerifyVerdict('坏 json', { needAdoption: true, needOutcome: true })
  assert.equal(v.adoptionApprove, false)
  assert.equal(v.outcomeApprove, false)
  // 缺字段：缺的按 false
  v = normalizeVerifyVerdict('{"adoptionApprove":true}', { needAdoption: true, needOutcome: true })
  assert.equal(v.adoptionApprove, true)
  assert.equal(v.outcomeApprove, false) // 缺 outcomeApprove → false
  // 非布尔 truthy 不算 approve（只认严格 true）
  v = normalizeVerifyVerdict('{"adoptionApprove":"yes"}', { needAdoption: true, needOutcome: false })
  assert.equal(v.adoptionApprove, false)
})

test('parseMatchId: none / 缺失 → null，合法 id 透传', () => {
  assert.equal(parseMatchId('{"matchId":"none"}'), null)
  assert.equal(parseMatchId('{"matchId":""}'), null)
  assert.equal(parseMatchId('{}'), null)
  assert.equal(parseMatchId('```json\n{"matchId":"R3"}\n```'), 'R3')
})

test('normalizeLifecycleDecision: targetId 越界降级 skip', () => {
  const d = normalizeLifecycleDecision('{"action":"update","targetId":"NOPE","adoptionStatus":"adopted"}', ['R1', 'R2'])
  assert.equal(d.action, 'skip')
})

test('normalizeLifecycleDecision: update 合法字段保留、非法枚举忽略', () => {
  const d = normalizeLifecycleDecision(JSON.stringify({
    action: 'update', targetId: 'R1', adoptionStatus: 'adopted', outcome: '乱填', finalPlan: '  ',
  }), ['R1'])
  assert.equal(d.action, 'update')
  assert.equal(d.targetId, 'R1')
  assert.equal(d.adoptionStatus, 'adopted')
  assert.equal(d.outcome, undefined) // 非法枚举忽略
  assert.equal(d.finalPlan, undefined) // 空白 finalPlan 忽略
})

test('normalizeLifecycleDecision: create / skip / 非法 action', () => {
  assert.equal(normalizeLifecycleDecision('{"action":"create"}', []).action, 'create')
  assert.equal(normalizeLifecycleDecision('{"action":"skip"}', ['R1']).action, 'skip')
  assert.equal(normalizeLifecycleDecision('{"action":"乱填"}', ['R1']).action, 'skip')
  assert.equal(normalizeLifecycleDecision('坏 json', ['R1']).action, 'skip')
})
