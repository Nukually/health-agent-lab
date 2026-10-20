/**
 * 内部高质量跟练视频资源库类型。
 *
 * 与 bilibili 外链（MedicalRiskVideoResource）不同：内部视频转码后存我们自己的 OSS，
 * 用原生 <video> 播放器播放，因此能拿到精确的播放时长与停止时刻（打点只落 DB）。
 * 资产由 scripts/sync-internal-videos.mjs 同步到 dev/sit/prod 三套 OSS，
 * catalog 落在各环境 bucket 的 internal-videos/catalog/index.json。
 */

/** 富标签，沿用飞书资源库的维度，用于关键词匹配与卡片展示 */
export interface InternalVideoTags {
  difficulty: string[]
  bodyParts: string[]
  severity: string[]
  triggerScenes: string[]
  conditions: string[]
  environments: string[]
}

/** OSS catalog/index.json 中的单条记录 */
export interface InternalVideoCatalogEntry {
  id: string
  version: string
  title: string
  description: string
  sourceRef: string
  tags: InternalVideoTags
  durationSec: number
  videoKey: string
  posterKey: string
}

export interface InternalVideoCatalog {
  catalogVersion: string
  videos: InternalVideoCatalogEntry[]
}

/** 打点事件：只记录播放时长与停止时刻 */
export type InternalVideoInteractionEvent = 'play_start' | 'progress' | 'pause' | 'ended'

export type InternalVideoStopReason = 'pause' | 'ended' | 'pagehide' | 'unmount' | 'seek'

export interface InternalVideoInteractionRequest {
  sessionId: string
  toolCallId: string
  resourceId: string
  videoId: string
  videoVersion: string
  event: InternalVideoInteractionEvent
  /** 当前播放头位置（秒） */
  positionSec: number
  /** 本次互动累计已观看秒数 */
  watchedSec: number
  durationSec: number
  endReason?: InternalVideoStopReason | null
}

export interface InternalVideoEngagementRecord {
  id: string
  userId: string
  sessionId: string
  toolCallId: string
  videoId: string
  videoVersion: string
  durationSec: number
  /** 累计观看秒数（播放多久） */
  totalWatchedSec: number
  /** 最后播放头位置（秒），用于续播 */
  lastPositionSec: number
  playStartedAt: string | null
  /** 最后一次停止时刻（什么时候停止） */
  lastStoppedAt: string | null
  completedAt: string | null
  /** 停止次数 */
  stopCount: number
  createdAt: string
  updatedAt: string
}

export interface InternalVideoInteractionResponse {
  engagement: InternalVideoEngagementRecord
}
