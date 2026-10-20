import { TOOL_UI_MANIFEST } from '@health-agent/shared'
import type { ToolDefinition } from '../../api/types.js'
import {
  SUPERSEDES_CHECK_IN_CARD_ID_DESCRIPTION,
} from './propose-check-in-draft.js'

export const PROPOSE_CHECK_IN_RECORD_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'propose_check_in_record',
    description: `为用户生成"本次打卡记录草稿"。优先复用已有打卡分类;如果没有匹配分类,工具内部会创建新分类并同时生成可编辑卡片。

行为契约:
- 本工具会持久化一张可编辑的 check-in card 草稿,但不会保存为正式打卡记录。卡片会作为表单展示给用户,用户在 UI 上核对/编辑/补全后点击"保存",才正式生成记录。
- 生成已有分类的卡片前,优先用 get_check_in_schema 读取当前分类 schema;若读取结果 matched,调用本工具时必须传 categoryKey,避免把新内容挂到相似但错误的分类。
- 用户本轮描述的内容优先级高于已有 schema;schema 只是字段稳定性的参考。用户明说的指标、数值、状态、药名、餐次、备注等必须进入 draftValues/draftNote,不要因为已有 schema 较少就漏掉。
- recordedAt 是这张草稿的记录归属日期,会在草稿生成时固定下来;后续用户手动保存不会再改写它。
- 即使用户说"帮我保存/存下来",本工具也只能生成待保存卡片,不能替用户自动保存为正式记录;最终回答请引导用户在卡片里核对后点击保存。
- 如果用户在上一张未保存卡片基础上要求 Agent 继续修改、新增、更新、删除字段内容,或要求"继续改刚才那张",本工具应生成一张新的完整草稿卡片,并通过 supersedesCheckInCardId 指向上一张未保存卡片;旧卡片由后端置为已失效。不要把这类请求理解为自动保存。
- 同一轮包含多条/多个独立记录(例如早餐/午餐/晚餐分别记录)时,应尽量合并为本次可保存记录的轻提示体验;确需多张卡片时保持每张都是待保存,不要自动落库。
- 如果已有模板中有"日期/记录日期/打卡日期"字段,并且你根据用户描述传入 recordedAt,也应在 draftValues 里填入同一个 YYYY-MM-DD;后端会兜底同步空的日期字段。
- 未来日期不可生成历史打卡。用户说"明天/下周/三天后"等未来事项时,不要调用本工具,应改走提醒/计划能力。
- 工具参数只包含卡片草稿内容,不要生成评分、评价或总结。
- draftValues 必须严格来自用户本轮输入和追问得到的内容;用户明说且能直接映射到已有字段的内容必须逐项填入,不要漏掉主食/药名/症状/数值/反应等已明确字段;其余字段留空让用户在卡片里填。不要自行发散、推断或填 0、"未知"、"待填写" 等占位值。
- 用户上传图片由系统自动作为附件附到草稿,不要传图片 URL。
- 一般单轮只生成 1 张卡片;只有用户明确一次提供多条独立记录时,才可逐条生成对应卡片。
- 未命中已有分类时,不要告诉用户"没有找到分类";工具内部会根据 categoryQuery、draftValues 和用户原文创建轻量新分类。若类别清楚但字段较少,也可以创建轻量卡片让用户补全。
- 调用后:最终回答简短引导用户在卡片里核对/补全后点击保存,不要假设已经保存。

字段类型语义:
- text 渲染为多行 textarea,系统不存在单行 text input 这种打卡字段。
- 日期/记录日期/打卡日期/发生日期等日期字段必须使用 type=date,值用 YYYY-MM-DD;不要用 text 承载日期。

触发规则:
- 用户说"继续记录 xxx / 今天也打卡 xxx / 记一下 xxx / 记下 xxx / 保存一下 xxx",且想把已经发生的信息保存成以后能查看的记录。
- 不要只口头说"已记下";只要用户想把已经发生的信息保存成以后能查看的记录,就应生成待保存卡片草稿。
- 工具会按 categoryKey 精确复用已有 schema;未传 categoryKey 时按 categoryQuery 兼容旧流程检索用户已有 schema;未命中时工具内部会创建新 schema。
- 若工具返回多个候选分类,不要猜,先让用户确认具体分类。`,
    parameters: {
      type: 'object',
      properties: {
        categoryQuery: { type: 'string', description: '用户说的分类名或别名,例如 恶心打卡' },
        categoryKey: { type: 'string', description: '可选。get_check_in_schema 返回 matched 时必须传入,用于精确复用分类;没有读取到精确分类时不要伪造。' },
        recordedAt: { type: 'string', description: '记录归属日期,格式 YYYY-MM-DD;只能来自今天、昨天或过去具体日期。未来日期不要传,应改走提醒/计划能力。' },
        draftValues: { type: 'object', description: '预填字段值,key 尽量与已有模板一致。用户明说且能直接映射到已有字段的内容必须逐项填入,不要漏填。' },
        draftNote: { type: 'string', description: '本次备注内容。用户说“备注/感受/补充说明”时放这里,不要放进 draftValues.note。' },
        draftTags: { type: 'array', items: { type: 'string' } },
        supersedesCheckInCardId: {
          type: 'string',
          description: SUPERSEDES_CHECK_IN_CARD_ID_DESCRIPTION,
        },
      },
      required: ['categoryQuery'],
    },
  },
  uiMeta: TOOL_UI_MANIFEST.propose_check_in_record,
  maxResultSizeChars: 4_000,
}
