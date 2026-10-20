import { TOOL_UI_MANIFEST } from '@health-agent/shared'
import type { ToolDefinition } from '../../api/types.js'

export const ADD_SCHEDULED_TASK_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'add_scheduled_task',
    description: `创建一条未来主动发送给用户的定时任务。到期后会写入当前会话，并通过 APP 推送提醒用户回来查看。

适用场景：
- 用户明确要求设置提醒，或在你询问后同意设置提醒。
- 用户给出了具体或相对触发时间，且上下文能确定提醒内容。
- 如果时间和提醒内容已经足够明确，应该调用工具创建，而不是只口头说“我会提醒你/已记下”。
- 时间不清楚时先澄清；cron 语法或频率不合法时，工具会返回错误，你要向用户说明并重新确认。
- 如果可能已有相同或近似提醒，可先调用 list_scheduled_tasks 查重；工具内部也会限制单个用户最多 100 个未来任务。

参数：
- task：任务名称，简短描述用户要被提醒的动作或对象。标题就是任务本身，不要加入病情、治疗阶段、诊疗背景、原因或推测出来的前缀；例如用户说“半小时后提醒我吃饭”，task 写“吃饭提醒”，不要写“化疗后吃饭提醒”。可用示例：“他莫西芬用药提醒”“完成恶心跟练卡”“5月20日乳腺外科复查提醒”“今晚喝水提醒”。
- message：未来到点后发送给用户的提醒信息；简练、温暖、直接，不要复制上一轮询问或确认话术。
- time：未来时间或 cron 表达式。一次性提醒传 ISO 8601 字符串；重复提醒传 5/6/7 字段 cron，默认按 Asia/Shanghai 解释，例如每天 10 点 "0 10 * * *"，每天 11:30 "30 11 * * *"，每周三 10 点 "0 10 * * 3"，2026-05-14 当天每 2 小时 "0 0 */2 14 5 * 2026"。相对时间请先基于当前时间换算。`,
    parameters: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: '任务名称，不超过 120 字。只写提醒动作或对象，不写病情/治疗阶段/原因等背景信息。',
        },
        message: {
          type: 'string',
          description: '未来发送给用户的提醒信息，简练并温暖，不超过 800 字。',
        },
        time: {
          type: 'string',
          description: '未来时间或 cron 表达式。一次性提醒传 ISO 8601；重复提醒传 5/6/7 字段 cron。',
        },
      },
      required: ['task', 'message', 'time'],
    },
  },
  uiMeta: TOOL_UI_MANIFEST.add_scheduled_task,
  isReadOnly: false,
  maxResultSizeChars: 1_200,
}
