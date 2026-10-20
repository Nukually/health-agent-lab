import { TOOL_UI_MANIFEST } from '@health-agent/shared'
import type { ToolDefinition } from '../../api/types.js'

export const UPDATE_SCHEDULED_TASK_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'update_scheduled_task',
    description: `更新或删除用户已有的未来定时任务。

使用规则：
- 修改或删除前，先调用 list_scheduled_tasks 获取 ID。
- id 是 list_scheduled_tasks 返回的用户维度稳定数字 ID，不是数据库 UUID；历史已删除/已发送任务会占号，所以当前列表里的 ID 不一定连续。
- 用户要删除/取消提醒时，把 status 设置为 deleted。
- 只更新用户明确要求修改的字段，不要擅自改其他任务。
- time 规则同 add_scheduled_task，既可改成一次性 ISO，也可改成 cron 重复提醒；时间不清楚时先澄清。`,
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'number',
          description: '未来定时任务 ID，来自 list_scheduled_tasks 返回的数字 ID。',
        },
        task: {
          type: 'string',
          description: '可选，新的任务名称。',
        },
        message: {
          type: 'string',
          description: '可选，新的未来提醒信息，简练并温暖。',
        },
        time: {
          type: 'string',
          description: '可选，新的未来触发时间或 cron 表达式。一次性提醒传 ISO 8601；重复提醒传 5/6/7 字段 cron。',
        },
        status: {
          type: 'string',
          enum: ['deleted'],
          description: '可选；设置为 deleted 表示删除/取消这个未来任务。',
        },
      },
      required: ['id'],
    },
  },
  uiMeta: TOOL_UI_MANIFEST.update_scheduled_task,
  isReadOnly: false,
  maxResultSizeChars: 1_200,
}
