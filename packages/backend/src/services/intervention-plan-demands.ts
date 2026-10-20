import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import { getDb } from '../db/client.js'
import { interventionPlanDemandGroups, interventionPlanDemands } from '../db/schema/index.js'
import type { Logger } from '../lib/logger.js'

export type InterventionPlanDemand = typeof interventionPlanDemands.$inferSelect
export type InterventionPlanDemandGroup = typeof interventionPlanDemandGroups.$inferSelect

/**
 * 采集一条原始干预方案需求（append-only）。在 generate_plan 内部干预卡匹配为 0 时由埋点 fire-and-forget 调用。
 * 调用方负责吞掉异常（不得阻塞或破坏 generate_plan 返回）。
 */
export async function recordInterventionDemand(
  input: { searchQuery: string; userId: string; sessionId: string | null },
  logger: Logger,
): Promise<void> {
  const searchQuery = input.searchQuery.trim()
  if (!searchQuery) return
  const db = getDb()
  await db.insert(interventionPlanDemands).values({
    searchQuery,
    userId: input.userId,
    sessionId: input.sessionId,
  })
  logger.info({ userId: input.userId, sessionId: input.sessionId }, 'intervention plan demand recorded')
}

/** 拉取待合并（pending）的原始需求，按创建时间升序，供 cron 合并。 */
export async function listPendingDemands(limit: number): Promise<InterventionPlanDemand[]> {
  const db = getDb()
  return db
    .select()
    .from(interventionPlanDemands)
    .where(eq(interventionPlanDemands.status, 'pending'))
    .orderBy(asc(interventionPlanDemands.createdAt))
    .limit(limit)
}

/** 拉取现存聚合需求（open），按热度降序，供 cron 给 LLM 做归并候选。 */
export async function listOpenGroups(limit: number): Promise<InterventionPlanDemandGroup[]> {
  const db = getDb()
  return db
    .select()
    .from(interventionPlanDemandGroups)
    .where(eq(interventionPlanDemandGroups.status, 'open'))
    .orderBy(desc(interventionPlanDemandGroups.demandCount))
    .limit(limit)
}

/**
 * 新建一个聚合需求，并把指定的 pending raw 需求并入。
 * demand_count = 实际并入条数（仅统计执行时仍为 pending 的 raw，避免重复并入）。返回实际并入条数。
 */
export async function appendGroupWithMembers(name: string, rawIds: string[]): Promise<number> {
  const trimmedName = name.trim()
  if (!trimmedName || rawIds.length === 0) return 0
  const db = getDb()
  return db.transaction(async (tx) => {
    const [group] = await tx
      .insert(interventionPlanDemandGroups)
      .values({ name: trimmedName, demandCount: 0 })
      .returning({ id: interventionPlanDemandGroups.id })
    const merged = await tx
      .update(interventionPlanDemands)
      .set({ status: 'merged', mergedIntoId: group.id, updatedAt: new Date() })
      .where(and(inArray(interventionPlanDemands.id, rawIds), eq(interventionPlanDemands.status, 'pending')))
      .returning({ id: interventionPlanDemands.id })
    const count = merged.length
    await tx
      .update(interventionPlanDemandGroups)
      .set({ demandCount: count, updatedAt: new Date() })
      .where(eq(interventionPlanDemandGroups.id, group.id))
    return count
  })
}

/**
 * 把指定的 pending raw 需求并入已有聚合需求，原子自增 demand_count（按实际并入条数）。
 * 可选改名。返回实际并入条数。
 */
export async function mergeIntoGroup(groupId: string, rawIds: string[], newName?: string): Promise<number> {
  if (rawIds.length === 0 && !newName) return 0
  const db = getDb()
  return db.transaction(async (tx) => {
    let count = 0
    if (rawIds.length > 0) {
      const merged = await tx
        .update(interventionPlanDemands)
        .set({ status: 'merged', mergedIntoId: groupId, updatedAt: new Date() })
        .where(and(inArray(interventionPlanDemands.id, rawIds), eq(interventionPlanDemands.status, 'pending')))
        .returning({ id: interventionPlanDemands.id })
      count = merged.length
    }
    const trimmedName = newName?.trim()
    if (count > 0 || trimmedName) {
      await tx
        .update(interventionPlanDemandGroups)
        .set({
          ...(count > 0 ? { demandCount: sql`${interventionPlanDemandGroups.demandCount} + ${count}` } : {}),
          ...(trimmedName ? { name: trimmedName } : {}),
          updatedAt: new Date(),
        })
        .where(eq(interventionPlanDemandGroups.id, groupId))
    }
    return count
  })
}
