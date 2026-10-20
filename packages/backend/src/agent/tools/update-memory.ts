import { TOOL_UI_MANIFEST } from '@health-agent/shared'
import type { ToolDefinition } from '../../api/types.js'

export const UPDATE_MEMORY_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'update_memory',
    description: `把用户透露的开放式个人背景追加到今日记忆（user_daily_memories）。

用途：仅记录"个人信息 / 病历档案 / 用户画像 / 今日记忆 / 历史摘要"5 个上下文模块里都找不到、也无法映射到病历档案结构化字段的信息。典型如生活状态、情绪、社交、作息、偏好、非标准化经历。

何时用：
- 用户说"我最近失眠""女儿这周高考我很焦虑""我习惯早上散步半小时"。
- 用户明确说"帮我记一下…"，且内容不属于结构化字段。

何时不用（禁止）：
- 内容属于【个人信息】字段（昵称 / 生日 / 性别 / 当前关注情况）或【病历档案】字段（月经状态 / 肿瘤分型 / 确诊时长 / 治疗阶段 / 用药情况 / 用药时长）——请改用 update_structured_profile。
- 信息已经在某个上下文模块中存在且无变化。
- 普通问候或用户提问知识类问题。

调用约束：
- 每次调用只记录 1 条，一句话客观概括，含必要数值和时间，不加主观评价。

示例（good）：
- { "content": "用户近两晚失眠，凌晨 3 点后才入睡" }
- { "content": "用户偏好简洁直接的沟通方式" }
- { "content": "用户本月起开始每天早晨散步 30 分钟" }

示例（bad）：
- { "content": "用户肿瘤分型是 Luminal A 型" } ← 属病历档案，应走 update_structured_profile
- { "content": "用户当前关注情况是乳腺结节随访" } ← 属个人信息，应走 update_structured_profile`,
    parameters: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: '一句话概括要记录的开放式信息',
        },
      },
      required: ['content'],
    },
  },
  uiMeta: TOOL_UI_MANIFEST.update_memory,
  isReadOnly: false,
  maxResultSizeChars: 1_000,
}
