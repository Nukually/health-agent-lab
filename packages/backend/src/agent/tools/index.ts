import { isFeatureEnabled, type FeatureSnapshot } from '@health-agent/shared'
import type { ToolDefinition } from '../../api/types.js'

export { UPDATE_MEMORY_TOOL } from './update-memory.js'
/** Legacy export for cleanup/debug paths; not exposed to the active agent tool list. */
export { MEMORY_TOOL } from './memory.js'
export { UPDATE_STRUCTURED_PROFILE_TOOL } from './update-structured-profile.js'
export { SEARCH_CHAT_HISTORY_TOOL } from './search-chat-history.js'
export { LOAD_SKILL_TOOL } from './load-skill.js'
export { ASK_USER_QUESTION_TOOL } from './ask-user-question.js'
export { GRADE_MEDICAL_RISK_TOOL } from './grade-medical-risk.js'
export { GENERATE_PLAN_TOOL } from './generate-plan.js'
export { MEDICAL_LITERATURE_SEARCH_TOOL } from './medical-literature-search.js'
export { SAVED_CONTENT_TOOL } from './saved-content.js'
export { READ_CX_PRODUCT_GUIDE_TOOL } from './product-ui-guide.js'
export { MEDICAL_REPORT_CONSULTATION_TOOL } from './medical-report-consultation-board.js'
export { GENERATE_COMMUNICATION_CARD_TOOL } from './generate-communication-card.js'
export { SCHEDULE_TOOL } from './schedule.js'
export { TODOS_TOOL } from './todos.js'
export { LIST_SCHEDULED_TASKS_TOOL } from './list-scheduled-tasks.js'
export { ADD_SCHEDULED_TASK_TOOL } from './add-scheduled-task.js'
export { UPDATE_SCHEDULED_TASK_TOOL } from './update-scheduled-task.js'
export { GET_CHECK_IN_SCHEMA_TOOL } from './get-check-in-schema.js'
export { PROPOSE_CHECK_IN_DRAFT_TOOL } from './propose-check-in-draft.js'
export { PROPOSE_CHECK_IN_RECORD_TOOL } from './propose-check-in-record.js'
export { SAVE_CHECK_IN_CARD_TOOL } from './save-check-in-card.js'
export { executeToolCall, shouldPauseForAskUserQuestion, type ToolCallInput, type ToolCallResult } from './executor.js'

import { UPDATE_STRUCTURED_PROFILE_TOOL } from './update-structured-profile.js'
import { SEARCH_CHAT_HISTORY_TOOL } from './search-chat-history.js'
import { LOAD_SKILL_TOOL } from './load-skill.js'
import { ASK_USER_QUESTION_TOOL } from './ask-user-question.js'
import { GRADE_MEDICAL_RISK_TOOL } from './grade-medical-risk.js'
import { GENERATE_PLAN_TOOL } from './generate-plan.js'
import { SAVED_CONTENT_TOOL } from './saved-content.js'
import { READ_CX_PRODUCT_GUIDE_TOOL } from './product-ui-guide.js'
import { MEDICAL_REPORT_CONSULTATION_TOOL } from './medical-report-consultation-board.js'
import { GENERATE_COMMUNICATION_CARD_TOOL } from './generate-communication-card.js'
import { SCHEDULE_TOOL } from './schedule.js'
import { TODOS_TOOL } from './todos.js'
import { GET_CHECK_IN_SCHEMA_TOOL } from './get-check-in-schema.js'
import { PROPOSE_CHECK_IN_DRAFT_TOOL } from './propose-check-in-draft.js'
import { PROPOSE_CHECK_IN_RECORD_TOOL } from './propose-check-in-record.js'

const SCHEDULED_TASK_TOOL_NAMES = new Set([
  'schedule',
  'todos',
])

const CHECK_IN_TOOL_NAMES = new Set([
  'get_check_in_schema',
  'propose_check_in_draft',
  'propose_check_in_record',
])

export const BASE_AGENT_TOOLS = [
  GRADE_MEDICAL_RISK_TOOL,
  GENERATE_PLAN_TOOL,
  ASK_USER_QUESTION_TOOL,
  UPDATE_STRUCTURED_PROFILE_TOOL,
  SEARCH_CHAT_HISTORY_TOOL,
  LOAD_SKILL_TOOL,
  SAVED_CONTENT_TOOL,
  READ_CX_PRODUCT_GUIDE_TOOL,
  MEDICAL_REPORT_CONSULTATION_TOOL,
  GENERATE_COMMUNICATION_CARD_TOOL,
  SCHEDULE_TOOL,
  TODOS_TOOL,
  GET_CHECK_IN_SCHEMA_TOOL,
  PROPOSE_CHECK_IN_DRAFT_TOOL,
  PROPOSE_CHECK_IN_RECORD_TOOL,
] as const

/** Full tool set kept for legacy tests/debug imports. Runtime should call getAgentTools(). */
export const AGENT_TOOLS = BASE_AGENT_TOOLS

export function getAgentTools(features: FeatureSnapshot): readonly ToolDefinition[] {
  return BASE_AGENT_TOOLS.filter((tool) => {
    if (SCHEDULED_TASK_TOOL_NAMES.has(tool.function.name)) {
      return isFeatureEnabled(features, 'agentScheduledTasks')
    }
    if (CHECK_IN_TOOL_NAMES.has(tool.function.name)) {
      return isFeatureEnabled(features, 'checkInRecords')
    }
    return true
  })
}

/**
 * 发给 LLM 前剥掉本地元数据（uiMeta / isReadOnly / requiresApproval / maxResultSizeChars），
 * 避免无意义 token 占用，也防止元数据泄漏到模型上下文。
 */
export function toLLMToolSchema(
  def: ToolDefinition,
): Pick<ToolDefinition, 'type' | 'function'> {
  return { type: def.type, function: def.function }
}
