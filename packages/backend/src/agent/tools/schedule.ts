import { TOOL_UI_MANIFEST } from '@health-agent/shared'
import type { ToolDefinition } from '../../api/types.js'

export const SCHEDULE_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'schedule',
    description: `管理用户的未来提醒任务。

使用 action 区分操作：
- action=list：列出当前用户已有的未来提醒；创建前不确定是否重复、修改或删除前需要拿 id 时使用。
- action=create：创建一条未来主动发送给用户的提醒。用户明确要求设置提醒，或在你询问后同意设置提醒，且时间和提醒内容明确时使用；不是只口头说“我会提醒你/已记下”。
- action=update：修改已有提醒。id 来自 action=list 返回的用户维度数字 ID；只改用户明确要求修改的字段。
- action=delete：删除/取消已有提醒。id 来自 action=list 返回的用户维度数字 ID。

共同规则：
- brief 用一句话说明本次操作目的，便于审计。
- task 是任务名称，简短描述用户要被提醒的动作或对象。标题就是任务本身，不要加入病情、治疗阶段、诊疗背景、原因或推测出来的前缀；例如用户说“半小时后提醒我吃饭”，task 写“吃饭提醒”，不要写“化疗后吃饭提醒”。
- message 是未来到点后发送给用户的提醒信息；简练、温暖、直接，不要复制上一轮询问或确认话术。
- time 是未来时间或 cron 表达式。一次性提醒传 ISO 8601；重复提醒传 5/6/7 字段 cron，默认按 Asia/Shanghai 解释，例如每天 10 点 "0 10 * * *"，每周三 10 点 "0 10 * * 3"。相对时间请先基于当前时间换算。
- 时间不清楚时先澄清；cron 语法或频率不合法时，工具会返回错误，你要向用户说明并重新确认。
- 如果可能已有相同或近似提醒，先用 action=list 查重；系统也会限制单个用户最多 100 个未来任务。`,
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'create', 'update', 'delete'],
          description: '要执行的提醒操作。',
        },
        brief: {
          type: 'string',
          description: '一句话说明本次提醒操作目的。',
        },
        id: {
          type: 'number',
          description: '已有提醒的用户维度数字 ID；action=update/delete 时必填，来自 action=list 的返回。',
        },
        task: {
          type: 'string',
          description: '任务名称，不超过 120 字。只写提醒动作或对象，不写病情/治疗阶段/原因等背景信息。',
        },
        message: {
          type: 'string',
          description: '未来发送给用户的提醒信息，简练并温暖，不超过 800 字。action=create 时必填；action=update 时按需填写。',
        },
        time: {
          type: 'string',
          description: '未来时间或 cron 表达式。一次性提醒传 ISO 8601；重复提醒传 5/6/7 字段 cron。action=create 时必填；action=update 时按需填写。',
        },
      },
      required: ['action', 'brief'],
      additionalProperties: false,
    },
  },
  uiMeta: TOOL_UI_MANIFEST.schedule,
  isReadOnly: false,
  maxResultSizeChars: 30_000,
}
