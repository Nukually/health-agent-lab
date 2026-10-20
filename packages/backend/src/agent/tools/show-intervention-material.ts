import { TOOL_UI_MANIFEST } from '@health-agent/shared'
import type { ToolDefinition } from '../../api/types.js'

export const SHOW_INTERVENTION_MATERIAL_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'show_intervention_material',
    description: `展示一套副作用干预辅导资料，让前端在聊天区渲染“总览 + 跟练”卡片。

触发规则：
- 仅当用户当前问题和 grade_medical_risk 返回的某个“可选干预资料编号”的“副作用 + 细分场景 + 动作”高度匹配时调用。
- 适用于短时、非药物、低风险的辅导材料展示。
- 当症状匹配且已排除急症危险信号、3/4 级或明显恶化时，优先调用本工具发卡片，不要只用自然语言替代。
- 若当前情况存在急症危险信号、急性恶化、明显需要立即就医，不要调用，应优先给出及时就医建议。
- 如果资料库里没有贴合编号，不要臆造编号、不要调用。

使用原则：
- 只能传 grade_medical_risk 工具结果里“可选干预资料编号”列出的 code；不要臆造编号。
- 一次只展示 1 套最匹配的方案，不要同一轮连续展示多个素材。
- 调用完成后，界面会直接展示方案卡片；你不要把全部步骤再逐条复述一遍。
- 工具成功后，最终回答只需结合下方卡片给一句引导或安全提醒。
- 单轮用户请求内本工具最多调用 1 次；不要为了展示多个方案、修正参数或补充内容在同一轮再次调用。若已经调用过，直接基于第一次工具结果继续回复。

参数：
- code: string，必填。格式是“数字-数字”，例如 "1-1"、"2-3"、"10-2"；这些只是格式示例，真实可用编号必须来自 grade_medical_risk 的工具结果。

示例：
- ✅ show_intervention_material({ code: "1-1" })
- ✅ show_intervention_material({ code: "2-3" })
- ❌ show_intervention_material({ code: "恶心-1" }) ← 编号格式错误
- ❌ show_intervention_material({ code: "9-9" }) ← 如果 grade_medical_risk 未返回这个编号，就不要调用
- ❌ 同一轮用户请求内多次调用本工具 ← 禁止，只有第一次会生效
- ❌ 在急症/急症危险信号场景下调用 ← 禁止`,
    parameters: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: 'grade_medical_risk 返回的可选干预资料编号，例如 "1-1"',
        },
      },
      required: ['code'],
    },
  },
  uiMeta: TOOL_UI_MANIFEST.show_intervention_material,
  isReadOnly: true,
  maxResultSizeChars: 1_200,
}
