import type { Logger } from '../lib/logger.js'
import type { SessionState } from '../state/session.js'
import type { MedicalProfileData } from '@health-agent/shared'
import type { InterventionCatalogCodeEntry } from '../services/intervention-material-runtime.js'
import type { ResolvedClientEnvironment } from '../services/client-environment.js'
import type { TrackingRequestContext } from '../services/tracking.js'

interface UserInfo {
  nickname?: string | null
  birthday?: string | null
  gender?: string | null
  currentConcern?: import('@health-agent/shared').CurrentConcern | null
}

/**
 * 每个 chat 请求一个实例。携带 executor 执行工具所需的上下文。
 * docIdMap / communicationCardIdMap 来自 assembler 生成的旧版短 ID 索引（d-* / c-* → UUID），保留给 session-events 和历史上下文兼容。
 * userInfo / profileData 用于 update_structured_profile / generate_communication_card 等工具做上下文补全。
 * interventionCodeMap 来自本会话冻结的干预资料库快照（编号 → materialId/version）。
 * rejectedFields 由 session-events 派生（本会话用户已拒绝的字段），executor 用它直接拦截重复更新。
 * sessionId 供工具记录会话级副作用或按当前会话过滤/回放上下文。
 */
export interface AgentRequestContext {
  userId: string
  sessionId: string
  session: SessionState
  logger: Logger
  docIdMap: Map<string, string>
  communicationCardIdMap: Map<string, string>
  interventionCodeMap: Map<string, InterventionCatalogCodeEntry>
  userInfo: UserInfo | null
  profileData: MedicalProfileData | null
  clientEnvironment: ResolvedClientEnvironment
  rejectedFields: Set<string>
  trackingContext?: TrackingRequestContext
}
