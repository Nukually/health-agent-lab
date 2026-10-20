import { TOOL_UI_MANIFEST } from '@health-agent/shared'
import type { ToolDefinition } from '../../api/types.js'

// TODO: healthEducationFavorites 上 prod 后，将“医生说收藏”纳入本工具的后续类别。
export const SAVED_CONTENT_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'saved_content',
    description: `查看、读取或展示用户的保存/历史发送内容：A=跟练卡/跟练视频，B=我的沟通卡，C=病历文档。保存状态是独立维度：saved=yes 表示已保存，saved=no 表示历史会话里模型发送过但用户当前没有保存/收藏；不传 saved 表示两者都列出。

使用 action 区分操作：
- action=list：列出当前保存内容或历史未保存内容的编号。type 可选；不传时列出 A/B/C 三类。saved 可选；不传时展示全部保存状态。列表只用于定位资料，不代表本轮必须读取。
- action=read：读取某个编号的完整内容给你自己作为上下文依据。id 必填，格式为 A-1、B-2、C-3；编号来自 action=list 的结果。type 可选；若传入，必须与 id 的大类一致。若 list 时传了 saved，read 时也传同样 saved。
- action=show：当用户需要直接看到某个跟练卡/跟练视频时，按编号把资源返回给前端展示。id 必填，格式同 read；最终回答里要自然引导并插入工具返回的 resource_ref。

类别规则：
- A 我的跟练卡/跟练视频：read 返回已保存跟练卡/跟练视频的动作、适用场景、安全提醒、完整步骤和当前跟练进度；show 会把对应资源重新展示给用户。
- B 我的沟通卡：read 返回已保存沟通卡 markdown 原文，并标注字段最后编辑人是 AI 还是用户。
- C 病历文档：read 会把该病历原始图片以紧接工具结果之后的合成 user 消息附加到上下文；你要结合图片内容回答用户上一条问题。读取 C 后只做医学知识解读/报告条目解读：复述报告原文、解释术语、引用公开指南规则；不要输出“确诊为/诊断为/分型为/属于某型/预后较好”等结论性措辞，最终诊断、分型和治疗决策以医生判读为准。
- saved=no：A 会列出历史会话里模型发过但未保存/收藏的跟练卡或视频；B 会列出历史生成过但未保存的沟通卡草稿；C 暂无未保存列表。列表每个编号后都会标注“已保存/未保存”。

何时使用：
- 用户明确要看、回顾、引用收藏夹/病历里的某个保存内容。
- 用户要找“昨天看的视频/刚才那张卡/之前没保存的沟通卡”等历史会话里发过但未收藏的内容时，用 saved=no，并按内容类型选择 type=A 或 type=B。
- 如果用户想“看/打开/再发一下”某个跟练卡或视频，用 show；如果只是你需要知道具体内容再回答，用 read。
- 当前问题缺少必要依据，且保存内容明显相关时，先 list 找编号，再 read 最相关的 1 个。
- 用户本轮已经上传图片时，优先解读当前图片；不要仅因历史病历存在就读取 C。

返回约定：
- list 返回每类数量和可读编号清单；不要根据列表摘要猜测正文。
- read 返回的内容可直接作为本轮回答依据。
- show 返回可展示资源；硬约束：只有先调用 action=show 拿到结果，才能在正文里写它返回的 <resource_ref id="..." />。没有对应工具结果就写 resource_ref 会指向不存在的资源，前端渲染成空白、用户什么都看不到；严禁臆造或凭记忆复用编号。
- 如果用户寻找历史资源且只有一个明确资源满足需求，主动 show；如果用户询问资源内容是什么，主动 read。
- 严禁在最终回复中提及 A-1/B-1/C-1 这类资源编号，编号仅用于内部工具参数和 resource_ref 标签。若工具返回错误，按错误提示向用户说明或重新 list。`,
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'read', 'show'],
          description: '要执行的操作：list=列出编号，read=读取具体内容给模型自己用，show=把资源返回给前端展示给用户。',
        },
        type: {
          type: 'string',
          enum: ['A', 'B', 'C'],
          description: '可选内容类型：A=跟练卡/跟练视频，B=沟通卡，C=病历文档。list 可用来筛选；read/show 时若填写必须与 id 前缀一致。',
        },
        saved: {
          type: 'string',
          enum: ['yes', 'no'],
          description: '可选保存状态：yes=只看已保存内容，no=只看历史发送过但未保存/未收藏内容；不传表示全部。',
        },
        id: {
          type: 'string',
          description: 'action=read/show 时必填，来自 list 返回的编号，例如 A-1、B-2、C-3；不要传 UUID、标题或带方括号的编号。',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
  uiMeta: TOOL_UI_MANIFEST.saved_content,
  isReadOnly: true,
  maxResultSizeChars: 30_000,
}
