import assert from 'node:assert/strict'
import {
  cleanThinkingContent,
  extractLeadingThinkingProtocol,
  looksLikeThinkingProtocol,
  makeThinkingSummary,
  parseThinkingTimeline,
  splitLeadingThinkingProtocol,
  splitThinkingClose,
  splitPersistedThinkingParts,
} from '../src/components/chat/thinkingPhaseParser.js'

const legacy = `<thinking>
<phase name="核心判断">先判断核心问题。</phase>
<phase name="医学合规">确认不越界。</phase>
</thinking>`

const compact = `<thinking>
<|核心判断|>先判断核心问题。
<|医学合规|>确认不越界。
</thinking>`

const legacyItems = parseThinkingTimeline(legacy)
assert.equal(legacyItems.length, 2)
assert.deepEqual(
  legacyItems.map((item) => [item.title, item.content]),
  [
    ['核心判断', '先判断核心问题。'],
    ['医学合规', '确认不越界。'],
  ],
)

const compactItems = parseThinkingTimeline(compact)
assert.equal(compactItems.length, 2)
assert.deepEqual(
  compactItems.map((item) => [item.title, item.content]),
  [
    ['核心判断', '先判断核心问题。'],
    ['医学合规', '确认不越界。'],
  ],
)
assert.equal(cleanThinkingContent(compact), '先判断核心问题。\n确认不越界。')
assert.equal(makeThinkingSummary(compact), '核心判断 · 医学合规')

const persistedMultiTurn = `
<|核心判断|>先判断是否需要读报告。

---

<|核心判断|>工具返回后继续判断。
`
assert.deepEqual(splitPersistedThinkingParts(persistedMultiTurn), [
  '<|核心判断|>先判断是否需要读报告。',
  '<|核心判断|>工具返回后继续判断。',
])

const plain = '<thinking>只是一句普通思考。</thinking>'
assert.deepEqual(parseThinkingTimeline(plain), [])
assert.equal(cleanThinkingContent(plain), '只是一句普通思考。')
assert.equal(makeThinkingSummary(plain), '方案规划')

const unknown = '<thinking><|unknown_phase|>仍然不要把英文阶段名露给用户。</thinking>'
const unknownItems = parseThinkingTimeline(unknown)
assert.equal(unknownItems.length, 1)
assert.equal(unknownItems[0].title, '方案规划')
assert.equal(unknownItems[0].content, '仍然不要把英文阶段名露给用户。')

const toolName = `<thinking>
<|下一步行动|>先调用 show_intervention_material，补充安全边界。
再读 \`saved_content\`。
</thinking>`

const toolNameItems = parseThinkingTimeline(toolName)
assert.equal(toolNameItems.length, 1)
assert.equal(
  toolNameItems[0].content,
  '先调用 展示干预方案，补充安全边界。\n再读 查看保存内容。',
)
assert.equal(
  cleanThinkingContent(toolName),
  '先调用 展示干预方案，补充安全边界。\n再读 查看保存内容。',
)

const similarToolName = '<thinking>show_intervention_material_extra 和 prefix_show_intervention_material 不替换。</thinking>'
assert.equal(
  cleanThinkingContent(similarToolName),
  'show_intervention_material_extra 和 prefix_show_intervention_material 不替换。',
)

const missingOpenThink = `<|判断|>用户询问用药相关问题，需要先判断是否读病历。
</think>`
const missingOpenThinkItems = parseThinkingTimeline(missingOpenThink)
assert.equal(missingOpenThinkItems.length, 1)
assert.equal(missingOpenThinkItems[0].title, '判断')
assert.equal(missingOpenThinkItems[0].content, '用户询问用药相关问题，需要先判断是否读病历。')
assert.equal(cleanThinkingContent(missingOpenThink), '用户询问用药相关问题，需要先判断是否读病历。')
assert.equal(looksLikeThinkingProtocol(missingOpenThink), true)
assert.equal(looksLikeThinkingProtocol(`<think>\n<|判断|>先规划。\n</think>`), true)
assert.equal(looksLikeThinkingProtocol('正文里提到 <|判断|> 时不当成 thinking'), false)
assert.equal(
  extractLeadingThinkingProtocol('需要先判断问题。\n<|识别问题|>这是症状管理问题。'),
  '需要先判断问题。\n<|识别问题|>这是症状管理问题。',
)
assert.equal(
  extractLeadingThinkingProtocol(`${'这是用户可见正文。'.repeat(40)}<|识别问题|>不要折叠。`),
  null,
)
assert.deepEqual(
  splitLeadingThinkingProtocol('<|识别问题|>先判断。</think>这是最终回答。'),
  { thinking: '<|识别问题|>先判断。', answer: '这是最终回答。', closed: true },
)
assert.deepEqual(
  splitThinkingClose('继续分析。</thinking>开始回答。'),
  { thinking: '继续分析。', answer: '开始回答。', closed: true },
)

console.log('thinkingPhaseParser tests passed')
