/**
 * Thinking Phase 注册表 —— 单一真实源
 *
 * 模型在 <thinking> 块内用 <|阶段名|> 标记当前推理维度。
 * 展示层仍兼容历史 <phase name="xxx">...</phase>。
 * 医学场景推荐使用下方 2 个中文 phase；其他场景 AI 也应优先使用中文短 phase。
 * 历史会话中可能仍残留旧英文 phase 名，展示层会归一化为旧中文名继续按原效果展示。
 *
 * 修改本文件同步检查：
 *   1. packages/backend/src/agent/prompt/sections/static.ts 的 thinkingProtocolSection（由 renderThinkingPhaseSchema 注入）
 *   2. packages/frontend/src/components/chat/ProcessIndicator.tsx（消费 normalizeThinkingPhaseName）
 */

export type ThinkingPhase = '风险分级' | '处置策略'

export type LegacyThinkingPhase =
  | 'medical_evidence'
  | 'compliance'
  | 'actionable_plan'
  | 'question_strategy'
  | '风险边界'

export interface ThinkingPhaseDef {
  name: ThinkingPhase
  /** 前端流式 pill 文案 */
  label: string
  /** 前端 timeline 标题 */
  title: string
  /** 写入 prompt 的引导描述 */
  description: string
}

export const THINKING_PHASES = {
  风险分级: {
    name: '风险分级',
    label: '风险分级中...',
    title: '风险分级',
    description:
      '风险分级：用一句话判断本轮属于 S/A/B0/B1/C 哪一档，并写清关键依据；同时完成合规自检：不确诊、不让用户自行停换加减处方药、不输出处方药具体 mg+用法+疗程、不阻断必要就医。S/A 先分诊；B0/B1 给线下就医或复查路径；C 给科普、资料整理、提醒或安全网。',
  },
  处置策略: {
    name: '处置策略',
    label: '处置策略中...',
    title: '处置策略',
    description:
      '处置策略：用一句话规划用户可见回答的处理路径：S/A 先给安全指令；其他等级先用一句贴着具体不适、担心或报告压力的自然话开头，再答核心问题，并给当前可做事项、升级阈值或医生沟通点；若信息不足，优先给条件分支，不要只追问。确需追问时，答案尾部最多问 1 个最高价值问题，并说明为什么问。',
  },
} as const satisfies Record<ThinkingPhase, ThinkingPhaseDef>

export const THINKING_PHASE_LEGACY_ALIASES = {
  medical_evidence: '核心判断',
  compliance: '医学合规',
  actionable_plan: '下一步行动',
  question_strategy: '是否追问',
  风险边界: '医学合规',
} as const satisfies Record<LegacyThinkingPhase, string>

export const THINKING_PHASE_NAMES: readonly ThinkingPhase[] =
  Object.keys(THINKING_PHASES) as ThinkingPhase[]

export const THINKING_PHASE_LABELS: Record<ThinkingPhase, string> = Object.fromEntries(
  THINKING_PHASE_NAMES.map((n) => [n, THINKING_PHASES[n].label]),
) as Record<ThinkingPhase, string>

export const THINKING_PHASE_TITLES: Record<ThinkingPhase, string> = Object.fromEntries(
  THINKING_PHASE_NAMES.map((n) => [n, THINKING_PHASES[n].title]),
) as Record<ThinkingPhase, string>

/** 把历史英文 phase 名归一化为历史中文展示名；未知名称原样返回。 */
export function normalizeThinkingPhaseName(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) return ''
  if (trimmed in THINKING_PHASES) return trimmed
  if (trimmed in THINKING_PHASE_LEGACY_ALIASES) {
    return THINKING_PHASE_LEGACY_ALIASES[trimmed as LegacyThinkingPhase]
  }
  return trimmed
}

/** 机读 schema 文本，供后端 prompt 静态区注入。纯函数，无 per-user 条件分支。 */
export function renderThinkingPhaseSchema(): string {
  const lines: string[] = []
  for (const name of THINKING_PHASE_NAMES) {
    const p = THINKING_PHASES[name]
    lines.push(`- <|${p.name}|> ${p.description}`)
  }
  return lines.join('\n')
}
