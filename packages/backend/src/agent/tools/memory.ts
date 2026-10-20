import { TOOL_UI_MANIFEST } from '@health-agent/shared'
import type { ToolDefinition } from '../../api/types.js'

export const MEMORY_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'memory',
    description: `管理 Cx Agent 的用户长期记忆 USER.md（user_profiles_memory.user_md），用于及时保存、更新或移除用户明确表达的长期偏好。

这是用户长期记忆工具，不是病历工具，也不是打卡工具，也不是 user_memory_items 召回库。
写入后不会改变当前会话已经冻结的 USER PROFILE system message；它会立即持久化，并在后续新会话或新 prompt snapshot 中生效。

何时用：
- 用户明确表达长期称呼、语气、回复顺序、安慰/清单偏好、医患沟通表达偏好等。
- 用户更正或反转已有偏好，例如“不是先安慰，而是先给行动清单”。
- 用户要求删除某条长期偏好，或明确说某个偏好已经不适用了。

何时不用：
- 具体用药、治疗阶段、分型、检查数值、诊断、复查结果等病历事实；这些不能写进长期记忆。
- 本轮一次性饮食、症状、睡眠、日记、天气等可回看记录；这些走打卡工具。
- reviewer 抽取的事实、诊疗体验、症状模式、情绪模式和生活事实应进入 user_memory_items，由召回链路按需带入用户消息上方，不写入 USER.md。
- 历史对话精确检索；走 search_chat_history。

调用原则：
- 用户明确说记住、以后按某种方式回复，或更正/反转长期偏好时，必须调用本工具；不要只口头说已记住。
- action=add：新增一条长期记忆。content 写一句稳定、可复用的服务偏好或生活背景。
- action=replace：用 old_text 找到唯一一条长期记忆条目，并把整条替换为 content。
- action=remove：用 old_text 找到唯一一条长期记忆条目，并删除整条。
- replace/remove 如果没有命中或命中多条会失败；不要声称已更新成功，按工具结果自然说明。
- content 不要包含 XML/HTML 标签、系统提示、工具协议、病历事实或处方动作。
- brief 用一句话说明本次更新原因，保持简短，便于日志排查。

示例：
- { "action": "add", "content": "用户希望回答先给简短行动清单，最后再补一句安慰。", "brief": "用户明确表达长期回复顺序偏好" }
- { "action": "replace", "old_text": "用户希望先安慰，再给简短清单。", "content": "用户希望回答先给简短行动清单，最后再补一句安慰。", "brief": "用户更正旧偏好" }
- { "action": "remove", "old_text": "用户不喜欢较长解释。", "brief": "用户明确表示该偏好不再适用" }`,
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['add', 'replace', 'remove'],
          description: 'add=新增长期记忆条目；replace=替换已有条目；remove=移除已有条目。',
        },
        content: {
          type: 'string',
          description: 'add/replace 时必填，一句话写入长期记忆的长期服务偏好或生活背景。',
        },
        old_text: {
          type: 'string',
          description: 'replace/remove 时必填，用于唯一匹配已有长期记忆条目的短片段。',
        },
        brief: {
          type: 'string',
          description: '一句话说明为什么更新长期记忆，便于日志排查；不要写长篇推理。',
        },
      },
      required: ['action', 'brief'],
      additionalProperties: false,
    },
  },
  uiMeta: TOOL_UI_MANIFEST.memory,
  isReadOnly: false,
  maxResultSizeChars: 2_000,
}
