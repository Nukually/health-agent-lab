import { TOOL_UI_MANIFEST } from '@health-agent/shared'
import type { ToolDefinition } from '../../api/types.js'

export const MEDICAL_LITERATURE_SEARCH_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'medical_literature_search',
    description: [
      '检索医学知识库 RAG，返回本会话内唯一的医学资料引用编号，供最终回答使用。',
      '医学问题需要专业医学事实、指南/共识、药品说明书、报告指标含义或副作用解释支撑时，建议调用本工具获取专业资料。',
      '本工具不做风险分级，也不替代 grade_medical_risk；医学问题仍需调用 grade_medical_risk 获得处置策略。',
      '没有高度相关资料时，不会返回可引用医学资料；最终回答不要编造引用编号。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: [
            '必填。用于搜索医学知识库的 query。',
            '保留药名、乳腺癌、治疗阶段、关键症状、检查名或人群条件；不要传姓名、手机号、医院号、完整病历号等个人隐私信息。',
            '工具会调用医学知识库 RAG 接口，并用 qwen3.5-flash 选出最多 5 篇高度相关资料；没有高度相关资料时不会返回引用资料。',
            '最长 160 个字符。',
          ].join('\n'),
        },
      },
      required: ['query'],
    },
  },
  uiMeta: TOOL_UI_MANIFEST.medical_literature_search,
  isReadOnly: true,
  maxResultSizeChars: 28_000,
}
