import { TOOL_UI_MANIFEST } from '@health-agent/shared'
import type { ToolDefinition } from '../../api/types.js'

export const SAVE_CHECK_IN_CARD_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'save_check_in_card',
    description: `保存一张已经生成的打卡卡片。该工具仅保留给历史消息/兼容执行分支,不再对模型开放。

行为契约:
- 这是原子化保存工具:只负责把已有 check-in card 落成正式打卡记录,或在该 card 已经保存过时更新对应记录;不会生成新卡片。
- 新打卡流程必须由用户在卡片 UI 上手动点击保存;前端会直接调用业务接口,不需要 Agent 调用本工具。
- 如果用户没有指明卡片 ID,工具会尝试保存或更新当前会话最新一张打卡卡片;若没有可保存/更新卡片,会返回需要用户确认。
- valuesPatch / note / tags 只能来自用户明确修改或确认的内容;不要为了补全而编造。valuesPatch 可以是字段 key,也可以是字段中文 label,系统会映射到模板字段。
- recordedAt 在卡片草稿生成时已经固定;本工具不会接收、推导或改写 recordedAt。
- 保存前会校验必填字段;缺必填时工具会失败并提示缺哪些字段,你需要请用户补充或让用户明确授权你按其原话填充。
- 工具结果会告诉你本次是新增记录(created)还是更新已有记录(updated),并返回记录唯一 ID;最终回答只需简短说明已保存/已更新和可去记录页编辑,不要额外生成评分、summary,也不要评价用户记录内容好坏、健康程度或表现。`,
    parameters: {
      type: 'object',
      properties: {
        checkInCardId: {
          type: 'string',
          description: '要保存或更新的 check-in card UUID;用户没有指明时可省略,系统会处理当前会话最新打卡卡片。',
        },
        valuesPatch: {
          type: 'object',
          description: '用户明确要求覆盖的字段值;不确定就省略,会使用卡片已有值。',
        },
        note: { type: 'string', description: '用户明确要求覆盖的备注;不确定就省略。' },
        tags: { type: 'array', items: { type: 'string' }, description: '用户明确要求覆盖的标签;不确定就省略。' },
      },
      required: [],
    },
  },
  uiMeta: TOOL_UI_MANIFEST.save_check_in_card,
  maxResultSizeChars: 4_000,
}
