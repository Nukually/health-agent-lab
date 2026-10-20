import { llmCall } from '../lib/llm.js'
import { getEnv } from '../env.js'
import {
  appendGroupWithMembers,
  listOpenGroups,
  listPendingDemands,
  mergeIntoGroup,
  type InterventionPlanDemand,
  type InterventionPlanDemandGroup,
} from './intervention-plan-demands.js'
import { parseEfficacyJson } from './efficacy-reviewer.js'
import type { Logger } from '../lib/logger.js'

const RAW_BATCH_LIMIT = 50
const GROUP_CANDIDATE_LIMIT = 50
const MAX_JSON_RETRIES = 3

export interface DemandMergeStats {
  pending: number
  appended: number
  updated: number
  mergedRaws: number
  skippedOps: number
}

function demandMergeModel(): string {
  return getEnv().INTERVENTION_DEMAND_MERGE_MODEL
}

const SYSTEM_PROMPT = `你是Health Agent Lab的"干预方案需求"归并助手。

背景：当 AI 给乳腺健康用户推荐居家干预/跟练时，内部干预资源库没有匹配到合适内容，系统就会记录一条"原始需求"（一句用户不适症状+场景的搜索词）。这些原始需求会重复、近义。你的任务是把它们归并成可读的"聚合需求"，方便运营判断该补哪些干预素材。

你会看到两部分：
- 现存聚合需求列表（编号 g1、g2…，含名称和当前计数）
- 本批待归并的原始需求列表（编号 r1、r2…）

你必须把每一条原始需求归到某个聚合需求里，输出两类操作：
- append：当一批原始需求表达的是一个现存聚合需求里没有的新内容时，新建一个聚合需求。name 是这个聚合需求的简洁中文名称（不超过 20 字，概括症状+场景，不含药名/医院/隐私）。memberSeqs 是归入它的原始需求编号。
- update：当一批原始需求应并入某个现存聚合需求时。targetGroupSeq 是现存聚合需求编号；memberSeqs 是归入它的原始需求编号；可选 newName 用更准确的名称替换原名称。

严格输出协议：
1. 只输出一个合法 JSON 对象，不要 Markdown，不要代码块，不要解释。
2. 形如：{"operations":[{"action":"append","name":"...","memberSeqs":["r1","r3"]},{"action":"update","targetGroupSeq":"g2","memberSeqs":["r2"],"newName":"..."}]}
3. 只能使用上面给出的 g/r 编号，不要编造编号。
4. 不要输出计数，计数由系统按实际并入条数计算。
5. 每条原始需求最多归入一个操作。`

function buildUserPrompt(groups: InterventionPlanDemandGroup[], demands: InterventionPlanDemand[]): string {
  const groupLines = groups.length
    ? groups.map((g, i) => `[g${i + 1}] ${g.name}（当前计数 ${g.demandCount}）`).join('\n')
    : '（暂无现存聚合需求）'
  const demandLines = demands.map((d, i) => `[r${i + 1}] ${d.searchQuery}`).join('\n')
  return `现存聚合需求：\n${groupLines}\n\n本批待归并原始需求：\n${demandLines}`
}

interface NormalizedAppend {
  action: 'append'
  name: string
  rawIds: string[]
}
interface NormalizedUpdate {
  action: 'update'
  groupId: string
  rawIds: string[]
  newName?: string
}
type NormalizedOp = NormalizedAppend | NormalizedUpdate

/**
 * 归一化 LLM 输出的操作：白名单校验 g/r 编号，过滤越界，丢弃非法 op。
 * 每条原始需求只允许进入一个 op（先到先得），防止同一 raw 被多个 op 抢占。
 */
export function normalizeOps(
  parsed: Record<string, unknown> | null,
  groups: Pick<InterventionPlanDemandGroup, 'id'>[],
  demands: Pick<InterventionPlanDemand, 'id'>[],
  log: Logger,
): { ops: NormalizedOp[]; skipped: number } {
  const ops: NormalizedOp[] = []
  let skipped = 0
  const rawSeqToId = new Map(demands.map((d, i) => [`r${i + 1}`, d.id]))
  const groupSeqToId = new Map(groups.map((g, i) => [`g${i + 1}`, g.id]))
  const claimedRawIds = new Set<string>()

  const rawOps = Array.isArray(parsed?.operations) ? (parsed!.operations as unknown[]) : []
  for (const item of rawOps) {
    if (!item || typeof item !== 'object') {
      skipped++
      continue
    }
    const op = item as Record<string, unknown>
    const memberSeqs = Array.isArray(op.memberSeqs) ? (op.memberSeqs as unknown[]) : []
    const rawIds: string[] = []
    for (const seq of memberSeqs) {
      if (typeof seq !== 'string') continue
      const id = rawSeqToId.get(seq)
      if (id && !claimedRawIds.has(id)) {
        claimedRawIds.add(id)
        rawIds.push(id)
      }
    }

    if (op.action === 'append') {
      const name = typeof op.name === 'string' ? op.name.trim() : ''
      if (!name || rawIds.length === 0) {
        skipped++
        continue
      }
      ops.push({ action: 'append', name, rawIds })
    } else if (op.action === 'update') {
      const groupId = typeof op.targetGroupSeq === 'string' ? groupSeqToId.get(op.targetGroupSeq) : undefined
      const newName = typeof op.newName === 'string' && op.newName.trim() ? op.newName.trim() : undefined
      if (!groupId || (rawIds.length === 0 && !newName)) {
        skipped++
        continue
      }
      ops.push({ action: 'update', groupId, rawIds, newName })
    } else {
      skipped++
    }
  }

  if (skipped > 0) log.warn({ skipped }, 'intervention demand merge: skipped invalid ops')
  return { ops, skipped }
}

async function callMergeLLM(prompt: string, log: Logger): Promise<Record<string, unknown> | null> {
  for (let attempt = 1; attempt <= MAX_JSON_RETRIES; attempt++) {
    try {
      const response = await llmCall(
        {
          model: demandMergeModel(),
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: prompt },
          ],
          max_tokens: 2000,
          temperature: 0.1,
          enable_thinking: false,
          response_format: { type: 'json_object' },
        },
        log,
      )
      const content = response.choices[0]?.message?.content ?? ''
      const parsed = parseEfficacyJson(content)
      if (parsed) return parsed
      log.warn({ attempt }, 'intervention demand merge: json parse failed, retrying')
    } catch (err: any) {
      log.warn({ attempt, error: err?.message ?? String(err) }, 'intervention demand merge: llm call failed, retrying')
    }
  }
  return null
}

/**
 * 单批合并：拉 pending raw + open groups → LLM 归并 → 归一化 → 逐 op 事务执行。
 * 解析失败或无 op 时不动数据，下周期重试。返回本批统计。
 */
export async function runDemandMergeBatch(logger: Logger): Promise<DemandMergeStats> {
  const log = logger.child({ module: 'intervention-demand-merger' })
  const stats: DemandMergeStats = { pending: 0, appended: 0, updated: 0, mergedRaws: 0, skippedOps: 0 }

  const demands = await listPendingDemands(RAW_BATCH_LIMIT)
  stats.pending = demands.length
  if (demands.length === 0) {
    log.info('no pending intervention plan demands')
    return stats
  }

  const groups = await listOpenGroups(GROUP_CANDIDATE_LIMIT)
  const parsed = await callMergeLLM(buildUserPrompt(groups, demands), log)
  if (!parsed) {
    log.warn({ pending: demands.length }, 'intervention demand merge: no usable llm output, leaving pending')
    return stats
  }

  const { ops, skipped } = normalizeOps(parsed, groups, demands, log)
  stats.skippedOps = skipped

  for (const op of ops) {
    try {
      if (op.action === 'append') {
        const merged = await appendGroupWithMembers(op.name, op.rawIds)
        if (merged > 0) {
          stats.appended++
          stats.mergedRaws += merged
        }
      } else {
        const merged = await mergeIntoGroup(op.groupId, op.rawIds, op.newName)
        stats.updated++
        stats.mergedRaws += merged
      }
    } catch (err: any) {
      log.error({ action: op.action, error: err?.message ?? String(err) }, 'intervention demand merge op failed')
    }
  }

  log.info({ ...stats }, 'intervention demand merge batch completed')
  return stats
}
