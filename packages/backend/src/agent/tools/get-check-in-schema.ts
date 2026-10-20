import { TOOL_UI_MANIFEST } from '@health-agent/shared'
import type { ToolDefinition } from '../../api/types.js'

export const GET_CHECK_IN_SCHEMA_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'get_check_in_schema',
    description: `只读读取指定打卡分类的当前 card schema,用于生成本次打卡卡片前确认分类和字段。

行为契约:
- 本工具不会创建、保存、失效任何卡片或正式记录。
- 用户继续记录已有分类,或你不确定 categoryQuery 是否会命中正确分类时,先调用本工具读取分类 schema。
- 若返回 matched,后续调用 propose_check_in_record 时必须传 categoryKey;用户本轮明确内容优先于 schema, schema 只是字段稳定性的参考。
- 若返回 candidates,不要猜测分类,先让用户确认。
- 若返回 not_found,后续可直接调用 propose_check_in_record;工具内部会根据 categoryQuery、draftValues 和用户原文创建轻量新分类。
- 修改同一张未保存卡片时,仍由 propose_check_in_record/propose_check_in_draft 的 supersedesCheckInCardId 处理旧卡失效。`,
    parameters: {
      type: 'object',
      properties: {
        categoryQuery: {
          type: 'string',
          description: '用户说的分类名或别名,例如 饮食记录、血压打卡、服药记录。',
        },
        categoryKey: {
          type: 'string',
          description: '可选。已知精确 categoryKey 时传入,优先于 categoryQuery。',
        },
      },
      required: ['categoryQuery'],
    },
  },
  uiMeta: TOOL_UI_MANIFEST.get_check_in_schema,
  isReadOnly: true,
  maxResultSizeChars: 4_000,
}
