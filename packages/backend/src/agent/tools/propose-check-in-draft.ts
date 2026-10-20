import { TOOL_UI_MANIFEST } from '@health-agent/shared'
import type { ToolDefinition } from '../../api/types.js'

export const CHECK_IN_FIELD_SCHEMA = {
  type: 'object',
  properties: {
    key: { type: 'string', description: '字段英文 key,使用 snake_case,例如 nausea_level' },
    label: { type: 'string', description: '字段展示名必须使用中文,不得包含英文 key、英文单词或英文缩写,例如 恶心程度' },
    type: {
      type: 'string',
      enum: ['text', 'number', 'boolean', 'choice', 'date'],
      description: '字段控件类型。text 表示多行文本 textarea,不是单行 input text; 普通文字、描述、感受、备注类字段默认用 text。日期/记录日期/打卡日期/发生日期或 key 为 *_date/date/record_date 的字段必须用 date,值用 YYYY-MM-DD,不要用 text 承载日期。',
    },
    unit: { type: 'string', description: '可选单位,例如 分、次、mg' },
    required: { type: 'boolean' },
    options: { type: 'array', items: { type: 'string' }, description: 'choice 类型可选项' },
  },
  required: ['key', 'label', 'type'],
} as const

export const SUPERSEDES_CHECK_IN_CARD_ID_DESCRIPTION = [
  '可选。仅当本次卡片语义上替换同一会话内某张未保存打卡卡片时，传入被替换卡片的 checkInCardId。',
  '触发条件：用户本轮是在修改、补充、更新、删除、替换或重做这张未保存卡片的内容，而不是新增另一条独立记录。',
  '使用方式：生成一张合并后的完整新草稿，保留旧卡片仍有效的信息，并合入用户本轮新增/修改的信息；旧卡片会由后端置为已失效。',
  '不要因为同分类、同类型或同一天就自动传；只有语义上确认是同一张卡片的延续修改才传。',
  '不要传已保存卡片 ID；已保存卡片不可被失效。用户只是要求保存时，不要传本字段，也不要新建重复卡片，应告知用户需要手动点击卡片里的“保存打卡”。',
].join('\n')

export const PROPOSE_CHECK_IN_DRAFT_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'propose_check_in_draft',
    description: `为用户首次记录的某个新打卡分类生成"打卡卡片草稿"。

行为契约:
- 本工具会持久化一张可编辑的 check-in card 草稿,但不会保存为正式打卡记录。卡片会作为表单展示给用户,用户在 UI 上核对/编辑/补全后点击"保存",才正式生成记录。
- recordedAt 是这张草稿的记录归属日期,会在草稿生成时固定下来;后续用户手动保存不会再改写它。
- 即使用户说"帮我保存/存下来",本工具也只能生成待保存卡片,不能替用户自动保存为正式记录;最终回答请引导用户在卡片里核对后点击保存。
- 如果用户在上一张未保存卡片基础上要求 Agent 继续修改、新增、更新、删除字段内容,或要求"继续改刚才那张",本工具应生成一张新的完整草稿卡片,并通过 supersedesCheckInCardId 指向上一张未保存卡片;旧卡片由后端置为已失效。不要把这类请求理解为自动保存。
- 同一轮包含多条/多个独立记录(例如早餐/午餐/晚餐分别记录)时,应尽量合并为本次可保存记录的轻提示体验;确需多张卡片时保持每张都是待保存,不要自动落库。
- 如果 fields 中有"日期/记录日期/打卡日期"字段,并且你根据用户描述传入 recordedAt,也应在 draftValues 里填入同一个 YYYY-MM-DD;后端会兜底同步空的日期字段。
- 未来日期不可生成历史打卡。用户说"明天/下周/三天后"等未来事项时,不要调用本工具,应改走提醒/计划能力。
- 工具参数只包含卡片草稿内容,不要生成评分、评价或总结。
- draftValues 必须严格来自用户本轮输入和追问得到的内容。用户明说且能直接映射到 fields 的内容必须逐项填入,不要漏掉主食/药名/症状/数值/反应等已明确字段。不要凭上下文自行发散、推断或补全;不确定的字段就不要填。不要填 0、"未知"、"待填写"等占位值。
- 如果类别清楚但具体数值暂缺,可以留空让用户在卡片里填;如果类别不清、字段不清或记录对象不明,先追问。
- 用户上传图片由系统自动作为附件附到草稿,不要在参数里传图片 URL。
- 一般单轮只生成 1 张卡片;只有用户明确一次提供多条独立记录时,才可逐条生成对应卡片。
- 调用后:最终回答简短引导用户在卡片里核对/补全后点击保存,不要假设已经保存。

触发规则:
- 用户说"我要记录一个新的 xxx / 帮我记录 xxx / 记下 xxx / 保存一下 xxx / 第一次记录 xxx",且现有打卡分类不能覆盖,并且本轮或追问后已经给出足够生成卡片的分类和核心字段。天气、日记、备忘等自定义事项也属于可记录分类。
- 不要只口头说"已记下";只要用户想把已经发生的信息保存成以后能查看的记录,就应生成待保存卡片草稿。
- 如果缺少严重关键信息(例如不知道要记录什么类别、字段含义不清、记录对象不明),先追问,不要生成泛化空卡。
- 如果用户是在继续记录已有分类,应该调用 propose_check_in_record,不要重复创建模板。

设计原则:
- schema 使用受控字段类型(text/number/boolean/choice/date);标题和布局由工具内部兜底,别名和说明不要求模型生成。
- 字段类型语义:text 渲染为多行 textarea,系统不存在单行 text input 这种打卡字段;日期/记录日期/打卡日期/发生日期等日期字段必须使用 type=date。
- fields[].label 是用户界面展示文案,必须是中文,不得出现英文 key、英文单词或英文缩写;字段机器名只放在 key。
- displayMode:能沉淀连续数值指标的分类用 quantitative;无法量化或以文字/图片/餐次为主的用 calendar。
- 字段应能支持后续同类记录复用;不要把当天具体值写进字段 label。
- fields 控制在 3-6 个,避免做成繁琐问卷。
- 不要输出 HTML/CSS/脚本。

最佳实践示例:
- "我想给我的体重打个卡" → 可调用本工具,fields=[体重 kg(number)],draftValues 留空;这是分类清楚但数值待用户在卡片里填。
- "我今天体重 56.4kg,帮我开始记录体重" → 调用本工具,draftValues={ weight_kg: 56.4 }。
- "帮我记录今天午饭,吃了半碗面,还喝了汤" → 调用本工具,displayMode=calendar,fields=[餐次/主食/汤水],draftValues 基于用户原话填入。
- "帮我记录下明天的杭州天气是多云转晴" → 不调用本工具;未来日期应转为提醒/计划,不能生成历史打卡。`,
    parameters: {
      type: 'object',
      properties: {
        categoryName: { type: 'string', description: '打卡分类名称,例如 化疗后恶心记录' },
        displayMode: {
          type: 'string',
          enum: ['quantitative', 'calendar'],
          description: 'quantitative=记录页展示趋势图;calendar=记录页展示日历',
        },
        fields: { type: 'array', items: CHECK_IN_FIELD_SCHEMA, minItems: 1, maxItems: 12 },
        draftValues: {
          type: 'object',
          description: '预填字段值,key 必须来自 fields。只填用户本轮明确说出的内容;用户明说且能直接映射到 fields 的内容必须逐项填入,不要漏填;其余留空让用户填。',
        },
        draftNote: { type: 'string', description: '本次备注内容。用户说“备注/感受/补充说明”时放这里,不要放进 draftValues.note。可省略。' },
        draftTags: { type: 'array', items: { type: 'string' } },
        recordedAt: { type: 'string', description: '记录归属日期,格式 YYYY-MM-DD;只能来自今天、昨天或过去具体日期。未来日期不要传,应改走提醒/计划能力。' },
        supersedesCheckInCardId: {
          type: 'string',
          description: SUPERSEDES_CHECK_IN_CARD_ID_DESCRIPTION,
        },
      },
      required: ['categoryName', 'displayMode', 'fields'],
    },
  },
  uiMeta: TOOL_UI_MANIFEST.propose_check_in_draft,
  maxResultSizeChars: 4_000,
}
