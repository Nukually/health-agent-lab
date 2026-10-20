// 干预方案疗效分析（intervention efficacy tracing）共享类型。
// 由后端 cron 离线分析 session 产出，按"问题维度"记录 AI 方案的采纳与疗效。

/** 用户对某方案的采纳状态，必须基于用户明确表述判定，不可推测。 */
export type EfficacyAdoptionStatus =
  | 'adopted' // 用户明确表示已采纳/在做
  | 'rejected' // 用户明确表示不采纳/不打算做
  | 'partial' // 部分采纳/打算试还没试
  | 'unknown' // 用户未就采纳与否给出明确表述

/** 方案疗效，同样必须基于用户明确表述。 */
export type EfficacyOutcome =
  | 'improved' // 用户明确反馈变好/缓解
  | 'unchanged' // 用户明确反馈无变化
  | 'worsened' // 用户明确反馈变差/新问题
  | 'no_feedback' // 用户未就该方案效果反馈

/** 方案节律：一次性动作/决策 vs 需持续反复执行。 */
export type EfficacyCadence = 'oneshot' | 'periodic'

/**
 * 档案生命周期状态，由后端状态机驱动（非用户可见）。LLM 选历史方案只从 active+stale 召回：
 * - active：生效中——用户已采纳但未反馈效果，或采纳后仍在持续跟踪（含周期性方案、采纳后反馈变差/无变化的方案）
 * - stale：未生效——用户未就采纳给出明确表态
 * - discarded：已废弃——未生效满 14 天，或超出召回保留上限的老 stale；不再参与召回，再次提及只会新建
 * - closed：已结束——用户拒绝，或一次性方案用户已给出效果反馈
 */
export type EfficacyStatus = 'active' | 'stale' | 'discarded' | 'closed'

/** 判定采纳/疗效/方案时所依据的对话原话片段，用于人工复核。 */
export interface EfficacyEvidence {
  planQuote?: string
  adoptionQuote?: string
  outcomeQuote?: string
}
