/**
 * Prompt Assembler — 装配器
 *
 * 静态 sections + 动态 sections
 * 静态区禁止条件判断，最大化前缀缓存命中率
 */

import {
  staticSections,
  personalInfoContext,
  currentConcernContext,
  medicalFieldPolicyContext,
  medicalRecordContext,
  medicalDocsIndex,
  userProfileSystemContext,
  communicationCardsContext,
  type TrendSnapshot,
} from './sections/index.js'
import {
  DEFAULT_FEATURE_SNAPSHOT,
  featureSignature,
  type FeatureSnapshot,
  type MedicalDocument,
  type MedicalProfileData,
} from '@health-agent/shared'
import type { Logger } from '../../lib/logger.js'
import type { InterventionRuntimeCatalogSnapshot } from '../../services/intervention-material-runtime.js'
import type { CommunicationCardPromptSummary } from '../../services/communication-card.js'
import type { SavedInterventionMaterialPromptSummary } from '../../services/intervention-material-engagement.js'
import type { RecentSessionPromptSummary } from '../../services/session.js'
import type { CheckInSchemaRecord } from '@health-agent/shared'

interface UserInfo {
  nickname?: string | null
  birthday?: string | null
  gender?: string | null
  currentConcern?: import('@health-agent/shared').CurrentConcern | null
}

export interface PromptContext {
  userInfo: UserInfo | null
  profileData: MedicalProfileData | null
  /** 病历记录 updatedAt —— 旧记录无 fieldUpdatedAt 时的"填写日期"兜底 */
  profileUpdatedAt?: string | Date | null
  medicalDocs: MedicalDocument[]
  communicationCards?: CommunicationCardPromptSummary | null
  checkInSchemas?: CheckInSchemaRecord[] | null
  savedInterventionMaterials?: SavedInterventionMaterialPromptSummary | null
  interventionCatalog: InterventionRuntimeCatalogSnapshot
  profileMemory: string | null
  todayMemory: string | null
  structuredProfileTrend: TrendSnapshot[] | null
  recentSessions?: RecentSessionPromptSummary | null
  summary: string | null
  features?: FeatureSnapshot
  logger: Logger
}

export interface AssembledPrompt {
  /** Static system prompt sent to the LLM; dynamic context is injected via reminder. */
  prompt: string
  /** Second system message for Cx Agent long-term memory, kept separate from static prompt for KV cache. */
  userProfileSystemPrompt: string | null
  staticPrefixLength: number
  dynamicPromptReminder: string
  /** Stable prompt base used for Langfuse Prompt Management versioning. */
  promptManagementPrompt: string
  docIdMap: Map<string, string>
  communicationCardIdMap: Map<string, string>
}

// 静态前缀 lazy cache — 纯函数输出不变，只计算一次
// 保证 system prompt 前缀字节相同，有利于 LLM 服务端 KV Cache 命中
let cachedStaticPrefix: string | null = null
let cachedStaticPrefixKey: string | null = null

function compactSections(sections: Array<string | null | undefined>): string {
  return sections
    .map((section) => section?.trim() ?? '')
    .filter(Boolean)
    .join('\n\n')
}

function getStaticPrefix(features: FeatureSnapshot): string {
  const cacheKey = featureSignature(features)
  if (!cachedStaticPrefix || cachedStaticPrefixKey !== cacheKey) {
    cachedStaticPrefix = staticSections()
    cachedStaticPrefixKey = cacheKey
  }
  return cachedStaticPrefix
}

export function assemblePromptManagementPrompt(input: {
  interventionCatalog: InterventionRuntimeCatalogSnapshot
  features?: FeatureSnapshot
}): string {
  const features = input.features ?? DEFAULT_FEATURE_SNAPSHOT
  return getStaticPrefix(features)
}

export function assembleSystemPrompt(ctx: PromptContext): AssembledPrompt {
  const startTime = performance.now()
  const features = ctx.features ?? DEFAULT_FEATURE_SNAPSHOT

  const staticPrefix = assemblePromptManagementPrompt({
    interventionCatalog: ctx.interventionCatalog,
    features,
  })

  const docs = medicalDocsIndex(ctx.medicalDocs)
  const communicationCards = communicationCardsContext(ctx.communicationCards)
  const stableUserContext = compactSections([
    personalInfoContext(ctx.userInfo),
    currentConcernContext(ctx.userInfo),
    medicalFieldPolicyContext(ctx.userInfo),
    medicalRecordContext(ctx.userInfo, ctx.profileData, ctx.profileUpdatedAt),
  ])
  const userProfileSystemPrompt = userProfileSystemContext(ctx.profileMemory, stableUserContext)

  // Per-user stable context now lives in the second system message. Runtime-only
  // reminders such as current time and client environment are injected by hooks.
  const dynamicPromptReminder = ''

  ctx.logger.info(
    {
      dynamicSections: 0,
      staticLength: staticPrefix.length,
      userProfileSystemPromptLength: userProfileSystemPrompt?.length ?? 0,
      dynamicReminderLength: dynamicPromptReminder.length,
      totalLength: staticPrefix.length + dynamicPromptReminder.length,
      docCount: docs.docIdMap.size,
      communicationCardCount: ctx.communicationCards?.totalCount ?? 0,
      savedInterventionMaterialCount: ctx.savedInterventionMaterials?.totalCount ?? 0,
      featureSignature: featureSignature(features),
      assemblyMs: Math.round(performance.now() - startTime),
    },
    'prompt assembled',
  )

  return {
    prompt: staticPrefix,
    userProfileSystemPrompt,
    staticPrefixLength: staticPrefix.length,
    dynamicPromptReminder,
    promptManagementPrompt: staticPrefix,
    docIdMap: docs.docIdMap,
    communicationCardIdMap: communicationCards.cardIdMap,
  }
}
