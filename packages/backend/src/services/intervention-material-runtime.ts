import { createHash } from 'node:crypto'
import type {
  InterventionMaterialRecord,
  InterventionMaterialToolOutput,
} from '@health-agent/shared'
import { getEnv } from '../env.js'
import type { Logger } from '../lib/logger.js'
import {
  getInterventionMaterialVersion,
  listInterventionMaterialsForEnv,
  resolveInterventionBucketEnv,
} from './intervention-material.js'

const CACHE_TTL_MS = 30_000

export interface InterventionCatalogCodeEntry {
  code: string
  materialId: string
  version: string
  sideEffect: string
  scene: string
  actionName: string
}

export interface InterventionCatalogGroup {
  sideEffect: string
  items: InterventionCatalogCodeEntry[]
}

export interface InterventionRuntimeCatalogSnapshot {
  targetEnv: 'dev' | 'sit' | 'prod'
  version: string
  groups: InterventionCatalogGroup[]
  codeMap: Map<string, InterventionCatalogCodeEntry>
}

interface CacheEntry {
  expiresAt: number
  snapshot: InterventionRuntimeCatalogSnapshot
}

const runtimeCatalogCache = new Map<'dev' | 'sit' | 'prod', CacheEntry>()

function createEmptySnapshot(
  targetEnv: 'dev' | 'sit' | 'prod',
): InterventionRuntimeCatalogSnapshot {
  return {
    targetEnv,
    version: 'empty',
    groups: [],
    codeMap: new Map(),
  }
}

function compareText(a: string, b: string): number {
  return a.localeCompare(b, 'zh-CN')
}

function filterRuntimeItems(
  items: InterventionMaterialRecord[],
  targetEnv: 'dev' | 'sit' | 'prod',
): InterventionMaterialRecord[] {
  if (targetEnv === 'dev') {
    return items.filter((item) => item.status !== 'archived')
  }
  return items.filter((item) => item.status === 'published')
}

function hashCatalog(items: InterventionMaterialRecord[]): string {
  const payload = items.map((item) => ({
    materialId: item.materialId,
    version: item.version,
    status: item.status,
    sideEffect: item.sideEffect,
    scene: item.scene,
    actionName: item.actionName,
    updatedAt: item.updatedAt,
  }))
  return createHash('sha1').update(JSON.stringify(payload)).digest('hex')
}

function buildSnapshot(
  items: InterventionMaterialRecord[],
  targetEnv: 'dev' | 'sit' | 'prod',
): InterventionRuntimeCatalogSnapshot {
  const sorted = [...items].sort((a, b) => {
    const sideEffectCmp = compareText(a.sideEffect, b.sideEffect)
    if (sideEffectCmp !== 0) return sideEffectCmp
    const sceneCmp = compareText(a.scene, b.scene)
    if (sceneCmp !== 0) return sceneCmp
    const actionCmp = compareText(a.actionName, b.actionName)
    if (actionCmp !== 0) return actionCmp
    return compareText(a.materialId, b.materialId)
  })

  const groups: InterventionCatalogGroup[] = []
  const codeMap = new Map<string, InterventionCatalogCodeEntry>()

  for (const item of sorted) {
    let group = groups[groups.length - 1]
    if (!group || group.sideEffect !== item.sideEffect) {
      group = { sideEffect: item.sideEffect, items: [] }
      groups.push(group)
    }

    const code = `${groups.length}-${group.items.length + 1}`
    const entry: InterventionCatalogCodeEntry = {
      code,
      materialId: item.materialId,
      version: item.version,
      sideEffect: item.sideEffect,
      scene: item.scene,
      actionName: item.actionName,
    }
    group.items.push(entry)
    codeMap.set(code, entry)
  }

  return {
    targetEnv,
    version: hashCatalog(sorted),
    groups,
    codeMap,
  }
}

export function invalidateInterventionRuntimeCatalogCache(): void {
  runtimeCatalogCache.clear()
}

export async function getInterventionRuntimeCatalog(
  logger: Logger,
): Promise<InterventionRuntimeCatalogSnapshot> {
  const targetEnv = resolveInterventionBucketEnv(getEnv().DEPLOY_ENV)
  const now = Date.now()
  const cached = runtimeCatalogCache.get(targetEnv)
  if (cached && cached.expiresAt > now) {
    return cached.snapshot
  }

  let snapshot: InterventionRuntimeCatalogSnapshot
  try {
    const items = filterRuntimeItems(
      await listInterventionMaterialsForEnv(targetEnv, logger, true),
      targetEnv,
    )
    snapshot = buildSnapshot(items, targetEnv)
  } catch (err: any) {
    snapshot = createEmptySnapshot(targetEnv)
    logger.warn({
      targetEnv,
      error: err?.message ?? String(err),
    }, 'failed to load intervention runtime catalog, fallback to empty snapshot')
  }

  runtimeCatalogCache.set(targetEnv, {
    expiresAt: now + CACHE_TTL_MS,
    snapshot,
  })

  logger.info({
    targetEnv,
    materialCount: snapshot.codeMap.size,
    catalogVersion: snapshot.version,
  }, 'intervention runtime catalog prepared')

  return snapshot
}

export function buildInterventionToolOutput(
  code: string,
  material: InterventionMaterialRecord,
): InterventionMaterialToolOutput {
  return {
    kind: 'intervention_material',
    code,
    materialId: material.materialId,
    version: material.version,
    sideEffect: material.sideEffect,
    scene: material.scene,
    actionName: material.actionName,
    overview: {
      totalDurationSec: material.steps.reduce((sum, step) => sum + step.durationSec, 0),
      prepareItems: material.prepareItems,
      precheckQuestion: material.precheckQuestion,
      feedbackQuestion: material.feedbackQuestion,
      effectiveRule: material.effectiveRule,
      fallbackAction: material.fallbackAction,
      redFlags: material.redFlags,
      safetyNote: material.safetyNote,
    },
    stepsMeta: material.steps
      .slice()
      .sort((a, b) => a.stepIndex - b.stepIndex)
      .map((step) => ({
        stepIndex: step.stepIndex,
        durationSec: step.durationSec,
        displayText: step.displayText,
      })),
    stableAssetKeys: {
      overviewImageKey: material.overviewAsset.key,
      stepImageKeys: material.steps
        .slice()
        .sort((a, b) => a.stepIndex - b.stepIndex)
        .map((step) => step.imageAsset.key),
      stepAudioKeys: material.steps
        .slice()
        .sort((a, b) => a.stepIndex - b.stepIndex)
        .map((step) => step.audioAsset.key),
    },
    currentSignedUrls: {
      overviewImageUrl: material.overviewAsset.url ?? '',
      stepImageUrls: material.steps
        .slice()
        .sort((a, b) => a.stepIndex - b.stepIndex)
        .map((step) => step.imageAsset.url ?? ''),
      stepAudioUrls: material.steps
        .slice()
        .sort((a, b) => a.stepIndex - b.stepIndex)
        .map((step) => step.audioAsset.url ?? ''),
    },
  }
}

export async function getInterventionToolOutputByCode(
  code: string,
  codeMap: Map<string, InterventionCatalogCodeEntry>,
  logger: Logger,
): Promise<InterventionMaterialToolOutput | null> {
  const entry = codeMap.get(code)
  if (!entry) return null

  const targetEnv = resolveInterventionBucketEnv(getEnv().DEPLOY_ENV)
  const material = await getInterventionMaterialVersion(
    targetEnv,
    entry.materialId,
    entry.version,
    logger,
  )
  if (!material) return null

  return buildInterventionToolOutput(code, material)
}

export async function refreshInterventionToolOutput(
  snapshot: InterventionMaterialToolOutput,
  logger: Logger,
): Promise<InterventionMaterialToolOutput | null> {
  const targetEnv = resolveInterventionBucketEnv(getEnv().DEPLOY_ENV)
  const material = await getInterventionMaterialVersion(
    targetEnv,
    snapshot.materialId,
    snapshot.version,
    logger,
  )
  if (!material) return null

  return buildInterventionToolOutput(snapshot.code, material)
}
