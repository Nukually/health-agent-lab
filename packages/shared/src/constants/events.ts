export const SSE_EVENTS = {
  COMPACTION_START: 'compaction_start',
  COMPACTION_END: 'compaction_end',
  THINKING_START: 'thinking_start',
  THINKING_DELTA: 'thinking_delta',
  THINKING_END: 'thinking_end',
  TOOL_CALL_START: 'tool_call_start',
  TOOL_CALL_END: 'tool_call_end',
  TEXT_DELTA: 'text_delta',
  ANSWER_START: 'answer_start',
  ITERATION_START: 'iteration_start',
  MESSAGE_END: 'message_end',
  ASSISTANT_OUTPUT_RETRACTED: 'assistant_output_retracted',
  ERROR: 'error',
  TOOL_APPROVAL_REQUIRED: 'tool_approval_required',
  /** schedule 工具发起 add/update/delete 后，前端展示确认卡片让用户同意/拒绝；同意后调 REST 接口落库，拒绝调 reject 接口登记 */
  SCHEDULE_CONFIRMATION_REQUIRED: 'schedule_confirmation_required',
  PROFILE_AUTO_UPDATED: 'profile_auto_updated',
  /** medical_report_consultation_board 成功解析本轮图片后，前端展示“保存到健康档案”按钮；保存流程独立异步执行，不阻塞对话 */
  MEDICAL_DOCUMENT_SAVE_SUGGESTION: 'medical_document_save_suggestion',
  /** saved_content 读取病历后，系统自动把病历原图以合成 user 消息附加到对话；前端据此在 assistant 气泡上方显示"已查阅 [N] xxx" */
  DOCUMENT_ATTACHED: 'document_attached',
  /** saved_content 读取已保存医患沟通卡片后，前端据此在 assistant 气泡上方显示卡片引用 chip */
  COMMUNICATION_CARD_ATTACHED: 'communication_card_attached',
} as const
