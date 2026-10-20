import { TOOL_UI_MANIFEST } from '@health-agent/shared'
import type { ToolDefinition } from '../../api/types.js'

export const LIST_SCHEDULED_TASKS_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'list_scheduled_tasks',
    description: `列出当前用户已有的未来定时任务明细。

用途：
- 创建提醒前，如不确定是否已有相同或近似任务，先调用本工具查重。
- 修改或删除提醒时，用本工具获取用户维度数字 ID。

返回内容包含：ID、任务名称、一次性/cron 类型、状态、创建时间、下一次触发时间、到期发送消息。
ID 是用户维度稳定数字 ID，用于 update_scheduled_task，不是数据库 UUID；历史已删除/已发送任务会占号，所以当前列表里的 ID 不一定连续。`,
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  uiMeta: TOOL_UI_MANIFEST.list_scheduled_tasks,
  isReadOnly: true,
  maxResultSizeChars: 30_000,
}
