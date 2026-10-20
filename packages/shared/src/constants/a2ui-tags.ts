/**
 * A2UI 语义标签注册表 —— 单一真实源
 *
 * 模型在用户可见正文里使用这些受控标签来标记"诊断性信息"。
 * `reference` 仅为历史消息/前端兼容保留，不再注入模型可见 schema。
 * 前端按此清单做结构化可视化渲染 + TTS 过滤。
 *
 * 修改本文件同步检查：
 *   1. packages/backend/src/agent/prompt/sections/static.ts 的 <semantic_tags> 子块（由 renderA2uiTagSchema 注入）
 *   2. packages/frontend/src/lib/a2ui/{parser, ttsSanitizer, renderer}
 */

export type A2uiTagName =
  | 'red_flag'
  | 'conclusion'
  | 'recommendation'
  | 'metric'
  | 'resource_ref'
  | 'reference'

export type A2uiTtsPolicy =
  | 'speak-inner' // 去掉标签本身，内部文本照常进 TTS
  | 'skip-all'    // 连标签带内部文本一起不进 TTS

export interface A2uiTagDef {
  name: A2uiTagName
  ttsPolicy: A2uiTtsPolicy
  attributes: readonly string[]
  description: string
  example: string
  /** false = 仅前端/历史兼容，不注入模型可见 prompt schema */
  modelVisible?: boolean
  /** 自闭合 speak-inner 标签用此函数把属性合成可朗读文本（其他标签忽略） */
  speakFromAttrs?: (attrs: Record<string, string>) => string
}

export const A2UI_TAGS = {
  red_flag: {
    name: 'red_flag',
    ttsPolicy: 'speak-inner',
    attributes: ['level'],
    description:
      '仅用于 core_workflow 中定义的急症危险信号（需立即急诊/拨 120 的情形）。level="urgent"（默认）或 "warning"。内部放最多两句话：一句说去哪/打什么、一句给原因。可用简短 Markdown 做强调或换行，但禁止任何 XML/HTML/A2UI 子标签。',
    example:
      '<red_flag level="urgent">现在立刻去急诊。发烧 38.5°C 叠加白细胞偏低，感染风险不能等。</red_flag>',
  },
  conclusion: {
    name: 'conclusion',
    ttsPolicy: 'speak-inner',
    attributes: [],
    description:
      '一句话结论或鉴别要点。仅在给出完整分析后做总括时使用，每条消息最多一个，放在分析段落末尾。可用简短 Markdown 做强调，但不要写复杂结构。日常操作/事务性确认类回复（如设置提醒、确认卡片、打卡等无需医学分析的轻量交互）不要使用 conclusion，也不要写“一句话总结”，正常把话说完即可。',
    example:
      '<conclusion>从描述和用药时程看，大概率是阿贝西利引起的腹泻，目前没有感染迹象。</conclusion>',
  },
  recommendation: {
    name: 'recommendation',
    ttsPolicy: 'speak-inner',
    attributes: ['priority'],
    description:
      '行动建议。priority="high|normal|low"（默认 normal）。high = 24 小时内需联系医生/需尽快处理；normal = 常规自我管理；low = 可选尝试。priority="high" 会渲染成“紧急”，每条消息最多 1 个；如果有多个重要事项，只保留最需要升级处理的一条为 high，其余按层次降为 normal 或 low。多条建议用多个 <recommendation> 连续书写，前端会合并为勾选列表。内部允许简短 Markdown（如加粗、真实换行、短列表），但禁止任何 XML/HTML/A2UI 子标签。若内部超过 50 个汉字，或包含 2 个以上动作/条件，必须使用真实换行加 Markdown 短列表分段，不要把多个分句塞成一整段；不要输出字面量 \\n。',
    example: `<recommendation priority="high">如果腹泻超过 3 天未缓解，请联系主治医生。

- 记录 24 小时腹泻次数和是否水样便
- 同时注意口干、尿少、头晕等脱水表现</recommendation>`,
  },
  metric: {
    name: 'metric',
    ttsPolicy: 'speak-inner',
    attributes: ['label', 'value', 'unit', 'status'],
    description:
      '关键医学指标徽章，自闭合。status="normal|abnormal|critical" 决定颜色；unit 可省。典型用途：评分、检验数值、风险层级。不要把徽章内容重复写进正文。',
    example:
      '<metric label="血红蛋白" value="95" unit="g/L" status="abnormal" />',
    speakFromAttrs: (a) =>
      [a.label, a.value, a.unit].filter((s) => s && s.trim()).join(' '),
  },
  resource_ref: {
    name: 'resource_ref',
    ttsPolicy: 'skip-all',
    attributes: ['id'],
    description:
      '引用 generate_plan 工具结果里的干预资源编号，自闭合。编号通常是“批次-序号”，如 1-1。id 必须来自工具结果的“可引用干预资源”，不要臆造。前端会把它渲染成内部跟练卡片或视频资源卡片；正文里不要再重复资源详情。历史消息也可能引用 grade_medical_risk 返回的资源。',
    example: '<resource_ref id="1-1" />',
  },
  reference: {
    name: 'reference',
    ttsPolicy: 'speak-inner',
    attributes: ['doc_id'],
    modelVisible: false,
    description:
      '引用用户已上传的病历文档，自闭合。doc_id 取【已上传病历文档】列表中 [N] 的 N。仅在结论确实基于文档内容时标注。',
    example: '<reference doc_id="1" />',
    speakFromAttrs: (a) => (a.doc_id ? `病历 ${a.doc_id}` : '病历'),
  },
} as const satisfies Record<A2uiTagName, A2uiTagDef>

export const A2UI_TAG_NAMES: readonly A2uiTagName[] = Object.keys(A2UI_TAGS) as A2uiTagName[]

/** 机读 schema 文本，供后端 prompt 静态区注入。纯函数，无 per-user 条件分支。 */
export function renderA2uiTagSchema(): string {
  const lines: string[] = []
  for (const name of A2UI_TAG_NAMES) {
    const tag = A2UI_TAGS[name]
    if ('modelVisible' in tag && tag.modelVisible === false) continue
    const attrsPart =
      tag.attributes.length > 0 ? `（属性：${tag.attributes.join('、')}）` : '（无属性）'
    lines.push(`- <${tag.name}>${attrsPart}`)
    lines.push(`  用途：${tag.description}`)
    lines.push(tag.example.includes('\n') ? `  示例：\n${tag.example}` : `  示例：${tag.example}`)
  }
  return lines.join('\n')
}
