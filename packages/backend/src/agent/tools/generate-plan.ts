import { TOOL_UI_MANIFEST } from '@health-agent/shared'
import type { ToolDefinition } from '../../api/types.js'

export const GENERATE_PLAN_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'generate_plan',
    description: [
      '为用户生成可跟练的症状/副作用干预卡片或视频候选，返回最多 10 个可引用资源标题/类型/时长/难度。',
      '当用户明确反馈具体当前症状或副作用不适、明确要求跟练/视频/干预资源，或上下文已有症状/副作用干预需求，且适合居家轻量干预或动作跟练资源时，必须调用本工具。',
      '如果用户没有明确具体症状或副作用不适，或不适不适合居家轻量干预/动作跟练资源，不要调用；明显急症、明显恶化或治疗/用药决策不能用本工具替代就医、复诊或医生确认。',
      '硬约束：要给用户看视频/跟练资源，必须先调用本工具拿到结果，再引用工具结果给出的编号；没有调用工具就引用资源会指向不存在的资源，前端渲染成空白、用户什么都看不到。严禁臆造、猜测或凭记忆复用编号，也不要复述资源详情。',
      '候选里标注「内部高质量视频(优先)」的是我们内部托管、经过审核的高质量跟练视频，可用我们自己的播放器播放、记录更准确；在同等贴合用户情况的前提下，优先选用内部高质量视频，再考虑跟练卡和外部视频。',
      '返回资源后，先从候选中按执行阻力收敛为简单/中等/复杂 3 个，再调用 ask_user_question 让用户选择。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        search_query: {
          type: 'string',
          description: [
            '必填。写成“不适症状 + 明确场景”。症状必填；场景只在用户明确提到时附加，例如“恶心想吐 化疗后”“反胃 吃药后难受”“潮热 夜间发作”。',
            '不要为了补全主动加入乳腺癌、乳腺结节等人群/疾病关键词；不要写具体药名、处方、医院或个人隐私信息。',
            '工具会在内部追加“动作跟练 视频”做外部搜索，同时用该 query 匹配内部干预卡片；最长 72 个字符。',
          ].join('\n'),
        },
      },
      required: ['search_query'],
    },
  },
  uiMeta: TOOL_UI_MANIFEST.generate_plan,
  isReadOnly: true,
  maxResultSizeChars: 4_000,
}
