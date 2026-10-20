/**
 * 引用标签 ↔ 来源数据 的统一绑定校验。
 *
 * 模型最终正文里可以出现若干「引用类」A2UI 标签（如 <resource_ref id="1-1" />），
 * 每个标签的合法 id 必须来自某个确定的来源（工具输出、prompt 注入索引等）。
 * 模型有时会在没有对应来源的情况下臆造编号，前端按 id 找不到资源就渲染成空，
 * 用户看到的就是「AI 像没回复」的空气泡。
 *
 * 这里把「标签名 + 引用属性 + 如何从本轮上下文解析合法 id」收敛成一张注册表，
 * loop 用一个通用检测器遍历校验，新增引用类标签时只往 REFERENCE_BINDINGS 加一条，
 * 不必在 loop core 里散落 if 分支，避免每个引用类型各写一套校验导致腐化。
 */
import { parseMedicalRiskToolOutput } from '@health-agent/shared'

/** 单条工具结果的最小形状：来自 session 里 role:'tool' 的消息。 */
export interface ToolResultLike {
  /** 工具结果的结构化输出（前端展示用，含 resources）；可能为对象或 JSON 字符串。 */
  displayOutput?: unknown
  /** 工具结果给 LLM 的文本输出；displayOutput 缺失时回退用它。 */
  content?: unknown
}

/** 检测时可用的本轮上下文。后续新增来源（病历文档 shortId、文献编号等）在此扩展字段。 */
export interface ReferenceBindingContext {
  /**
   * 当前 session 里所有工具结果（role:'tool' 消息）。
   * 注意：assistant.toolCalls[].output 在 loop 运行期间尚未回填（在 chat.ts 聚合阶段才配对），
   * 所以合法资源 id 必须从 tool 结果消息里取，而不是从 assistant.toolCalls 取。
   */
  toolResults: ToolResultLike[]
}

export interface ReferenceBinding {
  /** A2UI 标签名，如 resource_ref。 */
  tagName: string
  /** 承载引用编号的属性名，如 id。 */
  idAttr: string
  /** 给日志/告警用的可读名称。 */
  label: string
  /** 从本轮上下文解析出「合法可引用 id」全集。 */
  collectAllowedIds: (ctx: ReferenceBindingContext) => Set<string>
  /**
   * 检出悬空引用、触发二次请求时，注入给模型的「正确做法」提示。
   * 按标签维度给出（该用哪些工具/前置动作才能合法引用），不依赖具体 id 的语义，
   * 这样新增引用标签只需在本注册表补一条，loop 的恢复消息构造无需改动。
   */
  recoveryHint: string
}

function normalizeRefId(value: string): string {
  return value.trim().replace(/^\[|\]$/g, '')
}

/** 匹配某个标签的所有自闭合/开口引用，并抽取其引用属性值。 */
function buildTagIdRegex(tagName: string, idAttr: string): RegExp {
  return new RegExp(
    `<${tagName}\\b[^>]*\\b${idAttr}\\s*=\\s*(?:"([^"]+)"|'([^']+)'|([^\\s/>]+))[^>]*/?>`,
    'gi',
  )
}

function collectMedicalRiskResourceIds(ctx: ReferenceBindingContext): Set<string> {
  const ids = new Set<string>()
  for (const toolResult of ctx.toolResults) {
    // displayOutput 是结构化输出（含完整 resources）；content 是给 LLM 的文本回退。
    // 由 output 的 kind 自行判别是否为干预资源结果，不依赖工具名。
    const parsed =
      parseMedicalRiskToolOutput(toolResult.displayOutput) ??
      parseMedicalRiskToolOutput(toolResult.content)
    if (!parsed) continue
    for (const resource of parsed.resources) {
      if (resource.id) ids.add(resource.id)
    }
  }
  return ids
}

/**
 * 引用绑定注册表。本次只接入 resource_ref；reference(doc_id) / 文献编号等
 * 后续标签按相同形状追加一条即可，无需改动 loop core 与检测器。
 */
export const REFERENCE_BINDINGS: ReferenceBinding[] = [
  {
    tagName: 'resource_ref',
    idAttr: 'id',
    label: 'medical_risk_resource',
    collectAllowedIds: collectMedicalRiskResourceIds,
    recoveryHint:
      '资源引用是硬约束：只有先调用工具（需要给用户看视频/跟练资源时必须调用 generate_plan 搜索；展示已保存资源用 saved_content action=show）拿到工具结果里的可引用编号，才能在正文里写对应的 <resource_ref id="..." />。严禁臆造、猜测或复用记不准的编号。如果本轮无法获得合适资源，就只用自然中文回答，不要写任何 resource_ref。',
  },
]

export interface DanglingReference {
  binding: ReferenceBinding
  /** 正文里引用了、但不在合法集合内的 id。 */
  invalidIds: string[]
}

/**
 * 检测正文里所有「悬空引用」：引用属性指向的 id 不在该标签的合法来源集合内。
 * 返回空数组表示全部引用合法。
 */
export function detectDanglingReferences(
  content: string,
  ctx: ReferenceBindingContext,
): DanglingReference[] {
  const result: DanglingReference[] = []
  for (const binding of REFERENCE_BINDINGS) {
    const regex = buildTagIdRegex(binding.tagName, binding.idAttr)
    const referenced = new Set<string>()
    for (const match of content.matchAll(regex)) {
      const id = normalizeRefId(match[1] ?? match[2] ?? match[3] ?? '')
      if (id) referenced.add(id)
    }
    if (referenced.size === 0) continue

    const allowed = binding.collectAllowedIds(ctx)
    const invalidIds = [...referenced].filter((id) => !allowed.has(id))
    if (invalidIds.length > 0) {
      result.push({ binding, invalidIds })
    }
  }
  return result
}

/** 把悬空引用的标签从正文里剥离（重试用尽后的兜底，避免给用户留下空气泡）。 */
export function stripDanglingReferences(
  content: string,
  dangling: DanglingReference[],
): string {
  let next = content
  for (const { binding, invalidIds } of dangling) {
    const invalid = new Set(invalidIds)
    const regex = buildTagIdRegex(binding.tagName, binding.idAttr)
    next = next.replace(regex, (full, dq, sq, bare) => {
      const id = normalizeRefId(dq ?? sq ?? bare ?? '')
      return invalid.has(id) ? '' : full
    })
  }
  return next
}
