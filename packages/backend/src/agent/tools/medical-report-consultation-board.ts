import { TOOL_UI_MANIFEST } from '@health-agent/shared'
import type { ToolDefinition } from '../../api/types.js'

export const MEDICAL_REPORT_CONSULTATION_TOOL_NAME = 'medical_report_consultation_board'

export const MEDICAL_REPORT_CONSULTATION_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: MEDICAL_REPORT_CONSULTATION_TOOL_NAME,
    description: `病历解读协会。仅当本轮真实用户消息刚上传了病历/检查报告/检验单/病理报告/影像报告/处方/用药单/药品说明书等报告类医疗图片时调用。

工作方式：
- 系统会自动读取本轮用户刚上传的图片，不信任也不接受你传入图片 URL。
- 本工具不支持被拆成多个并行 tool call；本轮有多张报告图片时只调用一次，工具内部会按最多 5 张图一批并行处理多图。
- 如果报告图片原文清楚写有“报告出具时间/报告日期/审核日期/检查日期”等可作为报告出具时间的日期，必须把该日期作为 reportIssuedDate 传入，格式 YYYY-MM-DD（兼容 YYYY--MM--DD，会归一化）；看不清或没有则省略。
- 除可选 reportIssuedDate 外不要传图片 URL、用户文字、历史资料 ID 或其他字段。
- 工具内部会对每张图片并行调用 3 个百炼视觉模型：kimi-k2.6、qwen3.6-plus、kimi-k2.5。
- 工具会按“图片 1/图片 2/……”返回三位专家模型的解读结果、当前系统时间、报告距今多久和安全提醒。
- 专家模型也可能识别错误；工具结果不是诊断结论。你最终输出时，必须只使用“你自己对照图片能看清/确认”且“专家结果形成共识”的部分。专家之间冲突、你看不清或图片未明确写明的内容，都要标为不确定并提醒用户找医生/报告出具方核对。
- 涉及最近/既往/术后多久/报告新旧/用药多久/治疗阶段等时间判断时，必须使用工具返回的 time_anchor、report_issued_date 和 report_age。

何时用：
- 用户本轮上传的是报告类医疗图片，并要求解读、看看报告、说明指标、判断新旧/时间、解释病理/免疫组化/影像/检验/处方内容。

何时不用：
- 本轮没有图片。
- 图片不是报告类医疗资料（如普通症状照片、生活照片）。
- 只是一般健康常识问答，不依赖本轮图片。`,
    parameters: {
      type: 'object',
      properties: {
        reportIssuedDate: {
          type: 'string',
          description: '可选。报告图片原文清楚写出的报告出具时间，格式 YYYY-MM-DD（兼容 YYYY--MM--DD，会归一化）；没有或看不清则不要传。',
        },
      },
      additionalProperties: false,
    },
  },
  uiMeta: TOOL_UI_MANIFEST.medical_report_consultation_board,
  isReadOnly: true,
  maxResultSizeChars: 80_000,
}
