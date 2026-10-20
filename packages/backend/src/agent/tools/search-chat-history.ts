import { TOOL_UI_MANIFEST } from '@health-agent/shared'
import type { ToolDefinition } from '../../api/types.js'

export const SEARCH_CHAT_HISTORY_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'search_chat_history',
    description: `搜索当前用户的历史对话明细，返回原始的"用户提问 + AI 回复 + 时间"，不做摘要。

用途：当用户引用过去说过的具体内容，但当前上下文/画像/摘要里没有精确明细时使用。典型如"昨天说的饮食""上次那个检查结果""之前我说饭后吃了什么""我们当时怎么聊的"。

何时用：
- 用户提到昨天/前天/上次/之前/当时/我们说过/我不是说过，并需要精确回忆。
- 饮食、症状变化、用药细节、检查前后对比等不能靠画像猜测的历史明细。
- 需要核对历史对话原文，再基于命中内容回答。

何时不用：
- 当前会话上下文已经有精确信息。
- 用户问的是稳定画像或偏好，且上下文已覆盖。
- 用户要读取已保存跟练卡/跟练视频、沟通卡片、病历原图，或找回历史已发送但未保存收藏的视频/卡片时，应使用 saved_content。

参数：
- pattern：PostgreSQL case-insensitive 正则表达式。中文关键词可直接传，如"豆腐脑|鸡蛋|饮食"；想扩大召回可用 "|" 连接多个关键词；用户问"昨天说了什么/最后一句是什么"这类范围问题时，用 ".*" 配合 timeRange 拉取最近轮次，不要把"昨天|最后一句"当作内容关键词。
- timeRange：可选，Asia/Shanghai 日期范围，startDate/endDate 均为 YYYY-MM-DD，包含 endDate 当天。相对时间要换算成具体日期；用户说"昨天"时只搜昨天那一天。
- title：可选，只搜标题包含该文本的历史会话。
- limit：可选，默认 5，最大 10。

返回给你的工具结果是精简纯文本：原始对话标题、原始对话时间、用户问题、AI回复。历史 user 消息里的图片会用 [image] 占位，不返回图片 URL 或图片内容。`,
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'PostgreSQL case-insensitive 正则表达式，例如 "豆腐脑|鸡蛋|饮食"',
        },
        timeRange: {
          type: 'object',
          description: '可选，按 Asia/Shanghai 日期过滤命中消息时间',
          properties: {
            startDate: {
              type: 'string',
              description: '开始日期，YYYY-MM-DD，包含当天',
            },
            endDate: {
              type: 'string',
              description: '结束日期，YYYY-MM-DD，包含当天',
            },
          },
        },
        title: {
          type: 'string',
          description: '可选，只搜索标题包含该文本的会话',
        },
        limit: {
          type: 'integer',
          description: '最多返回多少个用户-助手轮次，默认 5，最大 10',
          default: 5,
        },
      },
      required: ['pattern'],
    },
  },
  uiMeta: TOOL_UI_MANIFEST.search_chat_history,
  isReadOnly: true,
  maxResultSizeChars: 20_000,
}
