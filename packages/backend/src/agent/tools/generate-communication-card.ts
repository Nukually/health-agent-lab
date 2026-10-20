import { TOOL_UI_MANIFEST } from '@health-agent/shared'
import type { ToolDefinition } from '../../api/types.js'

export const GENERATE_COMMUNICATION_CARD_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'generate_communication_card',
    description: `生成一张医患协同卡片草稿，方便用户线下复诊/门诊时直接和医生沟通。

触发规则：
- 用户明确要求"帮我整理/生成一张给医生看的卡片/复诊沟通卡/就诊沟通卡"时，直接调用。
- 用户虽然没说"卡片"，但明确让你帮忙整理"怎么跟医生说 / 就诊前准备 / 复诊沟通要点 / 问医生的问题 / 带什么资料"时，也视为明确要求整理就诊沟通材料，直接调用。
- 当用户只表达线下就医意图，但还没有要求你整理材料时，必须在最终回答尾部自然问一句。线下就医意图包括但不限于："要去医院 / 准备去医院 / 去复诊 / 复查 / 随访 / 门诊 / 挂号 / 约了医生 / 看医生 / 找医生 / 去乳腺科或肿瘤科 / 拿报告去问医生 / 带报告给医生看 / 做检查 / 抽血 / B超 / 钼靶 / 磁共振 / 穿刺 / 入院 / 住院 / 日间治疗"等任何表示接下来要到医院或线下诊疗场景的表达：
  "要不要我帮你整理一张医患协同卡片，方便你就诊时直接给医生看？"
  只有用户明确同意后，才能调用。
- 普通知识问答、没有就诊沟通需求时不要调用。
- 急症危险信号/急症场景优先给就医建议，不要插入此工具流程。

使用原则：
- 只填写业务内容；userId、sessionId、createdAt、templateVersion 等系统字段会由系统自动补全，你不要传。
- 如果卡片内容需要依赖已保存病历，先用 saved_content 的 list/read 读取后再生成。
- 不要输出 HTML；本工具返回结构化卡片草稿，前端会按固定模板渲染。currentSituation / informationForDoctor 支持 Markdown 列表和表格。
- 单轮用户请求内本工具最多调用 1 次；不要为了修正、补充或生成多张卡片在同一轮再次调用。若已经调用过，直接基于第一次工具结果说明用户可编辑、保存或继续补充。
- 工具成功后，最终回答不要复述整张卡片；只简短说明卡片已生成，可在上方收藏或编辑。需要补充时只提示两类：不清楚的报告/药名/日期/检查结果，以及症状明显加重或出现危急信号时不要等卡片，及时联系医生、就医或急诊。

制作策略：
- 直接出卡：就诊目的清楚，且已有报告、症状、病理、治疗记录、用药记录等核心信息源时，直接整理；不要等信息“完整”才出卡。
- 继续收集：主场景清楚但缺少会让卡片失去作用的核心字段时，只追问当前场景最小必要信息，再生成。
- 不普通收集：发现明显危急信号时，先给就医/急诊安全提示，不要把沟通卡当作延后处理的理由。

参数说明：
- title: AI 自动生成的卡片标题（必填）。根据患者本次线下就诊目的生成，建议格式为"时间/就诊动作 + 沟通卡/准备卡 +（本次核心目的）"，如"下周复诊沟通卡（腹泻和用药调整）"。
- cardDate: 可选，YYYY-MM-DD。若用户明确说了就诊日期可填写；否则可省略，由系统自动补当天日期。
- visitPurpose: 就诊目标（必填）。用一句话说明本次就诊主要想解决什么，例如复查随访、评估药物初期耐受性、确认是否需要调整方案。
- currentSituation: 我的情况（可选）。用患者能直接说出口的话，概括 3-5 个重点：症状/报告/时间变化/既往治疗/当前状态/最担心问题；信息较多时可用 Markdown 表格或列表。
- informationForDoctor: 这次建议带上（可选）。根据本次目的生成资料清单，如报告纸质/电子版、影像光盘/原片、病理切片/蜡块、用药清单、医保资料等；不要机械列出所有资料，只筛选本次就诊需要的。
- 不要再传 questionsForDoctor；如果有想问医生的问题，融入 visitPurpose 或 currentSituation。
- 三个业务字段都用简洁中文填写；如果一个字段里有多条内容，用 Markdown 换行/列表/表格，不要传数组，更不要输出 HTML。

示例（good）：
- {
    "title": "下周复诊沟通卡（腹泻与用药调整）",
    "visitPurpose": "和医生确认腹泻是否与当前用药有关，以及是否需要调整方案。",
    "currentSituation": "| 重点 | 情况 |\n| --- | --- |\n| 当前治疗 | 乳腺手术后 4 个月，正在服用阿贝西利和来曲唑，已用 6 周 |\n| 最近变化 | 近 3 天腹泻明显增多，昨晚腹泻 4 次，食欲也比之前差 |\n| 想确认 | 是否和用药有关，是否需要处理或调整方案 |",
    "informationForDoctor": "- 近期检查/复查报告（纸质或电子版）\n- 当前所有用药清单：药名、剂量、服用频次、开始日期\n- 腹泻记录：每天次数、是否发热/腹痛/便血、是否影响进食饮水"
  }

示例（bad）：
- 直接传 userId / sessionId / createdAt ← 这些系统会自动补
- 直接写成 HTML 字符串 ← 禁止
- 同一轮用户请求内多次调用本工具 ← 禁止，只有第一次会生效
- 继续传 questionsForDoctor 生成第四个小标题 ← 禁止
- 用户没同意，你自行生成一张卡 ← 禁止`,
    parameters: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: '卡片标题（必填）；需具体明确，不要使用泛标题',
        },
        cardDate: {
          type: 'string',
          description: '可选，YYYY-MM-DD；用户明确提到就诊日期时填写',
        },
        visitPurpose: {
          type: 'string',
          description: '就诊目标；用一句话说明本次就诊主要想解决什么',
        },
        currentSituation: {
          type: 'string',
          description: '我的情况；概括 3-5 个重点，信息较多时可用 Markdown 列表或表格',
        },
        informationForDoctor: {
          type: 'string',
          description: '这次建议带上；根据就诊目标筛选报告、影像、病理、用药、医保等资料，支持 Markdown 列表或表格',
        },
      },
      required: ['title', 'visitPurpose'],
      additionalProperties: false,
    },
  },
  uiMeta: TOOL_UI_MANIFEST.generate_communication_card,
  isReadOnly: true,
  maxResultSizeChars: 4_000,
}
