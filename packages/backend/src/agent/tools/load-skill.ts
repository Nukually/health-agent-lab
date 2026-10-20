import { TOOL_UI_MANIFEST } from '@health-agent/shared'
import type { ToolDefinition } from '../../api/types.js'

export const LOAD_SKILL_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'load_skill',
    description: `按 name 从已注册 Agent Skill 中加载一个 skill 的完整说明。

一次只加载一个 skill。需要使用多个 skill 时，也必须逐个调用本工具。

何时用：
- 静态 prompt 中的 skill metadata 与当前任务匹配时，先调用本工具读取完整 SKILL 内容，再继续规划或执行。
- 工具结果或上游流程只返回 skill 名称/描述，而没有返回完整工作流说明时，用 name 精确加载。

何时不用：
- 不要把本工具当作文件读取器；name 只能是已注册 skill 名称，不能是路径、URL 或自然语言查询。
- 如果当前任务没有命中任何 skill metadata，不要调用。

参数：
- name：已注册 skill 的精确名称。`,
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: '已注册 skill 的精确名称，例如 side-effect-course-management。',
        },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  uiMeta: TOOL_UI_MANIFEST.load_skill,
  isReadOnly: true,
  maxResultSizeChars: 60_000,
}
