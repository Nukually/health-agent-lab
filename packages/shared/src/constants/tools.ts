export type ToolRenderKind = 'default' | 'communication_card' | 'intervention_material' | 'medical_report_consultation' | 'scheduled_task' | 'check_in' | 'ask_user_question' | 'todos'

export interface ToolUiMeta {
  title: string
  activeLabel: string
  doneLabel: string
  detailText: string
  renderKind: ToolRenderKind
}

export const TOOL_UI_MANIFEST = {
  update_memory: {
    title: '更新记忆',
    activeLabel: '记忆更新中...',
    doneLabel: '已更新记忆',
    detailText: '正在记录对后续陪伴有帮助的信息，方便之后更贴近您的情况。',
    renderKind: 'default',
  },
  memory: {
    title: '整理长期偏好',
    activeLabel: '长期偏好整理中...',
    doneLabel: '已整理长期偏好',
    detailText: '正在更新长期服务偏好和沟通方式，方便之后更贴近您的习惯。',
    renderKind: 'default',
  },
  update_structured_profile: {
    title: '更新档案',
    activeLabel: '档案更新中...',
    doneLabel: '已更新档案',
    detailText: '正在整理您提到的档案信息；需要您确认的内容会以卡片形式单独展示。',
    renderKind: 'default',
  },
  search_chat_history: {
    title: '搜索历史对话',
    activeLabel: '历史搜索中...',
    doneLabel: '已搜索历史对话',
    detailText: '正在查找过往对话里的具体细节，避免只凭印象回答。',
    renderKind: 'default',
  },
  ask_user_question: {
    title: '需求确认',
    activeLabel: '需求确认中...',
    doneLabel: '已发起需求确认',
    detailText: '正在确认继续回答前需要补齐的关键信息。',
    renderKind: 'ask_user_question',
  },
  load_skill: {
    title: '加载技能',
    activeLabel: '技能加载中...',
    doneLabel: '已加载技能',
    detailText: '正在读取当前任务匹配的专项工作流说明。',
    renderKind: 'default',
  },
  grade_medical_risk: {
    title: '风险分级',
    activeLabel: '风险分级中...',
    doneLabel: '已完成风险分级',
    detailText: '正在根据当前医学问题判断风险层级，并匹配后续处置策略。',
    renderKind: 'default',
  },
  generate_plan: {
    title: '生成干预方案',
    activeLabel: '方案生成中...',
    doneLabel: '已生成干预方案',
    detailText: '正在为当前副作用匹配可跟练的干预卡片或视频。',
    renderKind: 'default',
  },
  medical_literature_search: {
    title: '检索医学资料',
    activeLabel: '医学资料检索中...',
    doneLabel: '已检索医学资料',
    detailText: '正在检索医学知识库资料，帮助回答更有依据。',
    renderKind: 'default',
  },
  saved_content: {
    title: '查看保存内容',
    activeLabel: '查看保存内容中...',
    doneLabel: '已查看保存内容',
    detailText: '正在查看您的跟练卡/跟练视频、沟通卡、病历资料，以及历史发送但未保存的内容，以便结合资料回复。',
    renderKind: 'default',
  },
  read_product_guide: {
    title: '读取产品说明',
    activeLabel: '产品说明读取中...',
    doneLabel: '已读取产品说明',
    detailText: '正在确认当前客户端实际生效的界面布局、入口和 App 下载方式，避免按另一套 UI 回答。',
    renderKind: 'default',
  },
  medical_report_consultation_board: {
    title: '病历解读协会',
    activeLabel: '病历解析中...',
    doneLabel: '已完成病历解读',
    detailText: '正在从多位模型视角交叉核对报告内容，稍后会整理成更清楚的说明。',
    renderKind: 'medical_report_consultation',
  },
  generate_communication_card: {
    title: '生成沟通卡片',
    activeLabel: '整理沟通卡片中...',
    doneLabel: '已生成沟通卡片',
    detailText: '正在把本次沟通重点整理成就诊时可直接给医生看的卡片。',
    renderKind: 'communication_card',
  },
  show_intervention_material: {
    title: '展示干预方案',
    activeLabel: '方案生成中...',
    doneLabel: '已展示干预方案',
    detailText: '正在为当前不适匹配合适的干预辅导方案，并准备可跟练的内容。',
    renderKind: 'intervention_material',
  },
  schedule: {
    title: '处理提醒',
    activeLabel: '提醒处理中...',
    doneLabel: '已处理提醒',
    detailText: '正在查看、设置或调整未来提醒。',
    renderKind: 'scheduled_task',
  },
  todos: {
    title: '任务跟练',
    activeLabel: '跟练任务处理中...',
    doneLabel: '已处理跟练任务',
    detailText: '正在创建或调整阶段性的跟练任务，并同步未来提醒。',
    renderKind: 'todos',
  },
  list_scheduled_tasks: {
    title: '查看提醒',
    activeLabel: '查看提醒中...',
    doneLabel: '已查看提醒',
    detailText: '正在查看已设置的未来提醒，避免重复创建或便于调整。',
    renderKind: 'scheduled_task',
  },
  add_scheduled_task: {
    title: '设置提醒',
    activeLabel: '提醒设置中...',
    doneLabel: '已设置提醒',
    detailText: '正在为你设置未来提醒。',
    renderKind: 'scheduled_task',
  },
  update_scheduled_task: {
    title: '调整提醒',
    activeLabel: '提醒调整中...',
    doneLabel: '已调整提醒',
    detailText: '正在更新或取消已有提醒。',
    renderKind: 'scheduled_task',
  },
  get_check_in_schema: {
    title: '获取打卡模板',
    activeLabel: '获取打卡模板中...',
    doneLabel: '已获取打卡模板',
    detailText: '正在读取当前打卡分类的模板字段，用来生成更准确的本次记录卡片。',
    renderKind: 'default',
  },
  propose_check_in_draft: {
    title: '生成打卡卡片',
    activeLabel: '打卡卡片生成中...',
    doneLabel: '已生成打卡卡片',
    detailText: '正在把本次记录整理成可编辑的打卡卡片，等你核对后保存。',
    renderKind: 'check_in',
  },
  propose_check_in_record: {
    title: '生成打卡卡片',
    activeLabel: '打卡卡片生成中...',
    doneLabel: '已生成打卡卡片',
    detailText: '正在按已有打卡模板生成本次记录卡片，等你核对后保存。',
    renderKind: 'check_in',
  },
  save_check_in_card: {
    title: '保存打卡卡片',
    activeLabel: '打卡保存中...',
    doneLabel: '已保存打卡',
    detailText: '正在把已确认的打卡卡片保存为正式记录。',
    renderKind: 'check_in',
  },
  create_check_in_schema: {
    title: '创建打卡模板',
    activeLabel: '打卡模板生成中...',
    doneLabel: '已创建打卡模板',
    detailText: '正在把本次记录整理成后续可复用的打卡卡片结构。',
    renderKind: 'check_in',
  },
  record_check_in_by_category: {
    title: '记录打卡',
    activeLabel: '打卡记录保存中...',
    doneLabel: '已保存打卡记录',
    detailText: '正在按已有打卡模板保存本次记录。',
    renderKind: 'check_in',
  },
} as const satisfies Record<string, ToolUiMeta>

export type KnownToolName = keyof typeof TOOL_UI_MANIFEST

export function getToolUiMeta(name: string): ToolUiMeta {
  return TOOL_UI_MANIFEST[name as KnownToolName] ?? {
    title: name,
    activeLabel: `${name}中...`,
    doneLabel: name,
    detailText: '正在处理相关步骤。',
    renderKind: 'default',
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const KNOWN_TOOL_NAMES = Object.keys(TOOL_UI_MANIFEST)
  .sort((a, b) => b.length - a.length) as KnownToolName[]

export function replaceToolNameAliases(text: string): string {
  let next = text

  for (const name of KNOWN_TOOL_NAMES) {
    const alias = TOOL_UI_MANIFEST[name].title
    const escapedName = escapeRegExp(name)
    next = next.replace(new RegExp(`\`${escapedName}\``, 'g'), alias)
    next = next.replace(
      new RegExp(`(^|[^A-Za-z0-9_])${escapedName}(?=$|[^A-Za-z0-9_])`, 'g'),
      (_match, prefix: string) => `${prefix}${alias}`,
    )
  }

  return next
}
