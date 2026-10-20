import { TOOL_UI_MANIFEST } from '@health-agent/shared'
import type { ToolDefinition } from '../../api/types.js'

export const TODOS_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'todos',
    description: `创建、重新规划或停止患者的周期跟练计划。todos 用于管理“连续多天/多次跟练”的计划。

使用 action 区分操作：
- action=create：创建新的跟练计划。必须提供 title 和 todos。
- action=update：重新规划已有跟练计划。必须提供 plan_id、title 和 todos。工具会废弃旧计划，取消并移除旧计划中未执行的 todo/定时提醒；旧计划中已执行或已闭合的 todo 只保留在旧计划历史中，不复制到新计划。
- action=stop：停止已有跟练计划。必须提供 plan_id。工具会停止该计划，取消并移除未执行的后续 todo/提醒，只保留已执行的 todo 或已闭合的历史 todo。

字段说明：
- title：计划名，例如“晨僵 3 天跟练”。
- resource_ref_id：用户从 generate_plan 候选中选定的资源编号；症状/副作用疗程计划必须传。
- course_days：疗程天数，1-100。
- target_side_effect：目标症状或副作用，例如“手指晨僵”“关节痛”“潮热”“乏力”。
- source_type/source_id：记录计划来源。干预卡传 source_type=intervention；外部视频传 video_resource；用户自定义传 custom。
- dedupe_key：用于避免同一干预方案重复创建同一周期计划。
- todos：按日期和时间列出的具体待办。每条包含 date、time、show_prompt、prompt；todos 只能包含未来待执行时间。
- show_prompt 是到点提醒用户看到的话，简短、温暖、明确说明现在要做什么。
- prompt 是给 Agent 的内部执行指令，说明提醒后应如何带用户完成干预方案。

调用原则：
- 本工具只管理周期跟练任务，不用于普通提醒；普通提醒继续用 schedule。
- 症状/副作用疗程中，必须在用户确认资源、疗程天数和触发时间后再创建；资源选择本身不等于确认周期或提醒时间。
- 创建前确保 date 用 YYYY-MM-DD，time 用 HH:mm，默认 Asia/Shanghai；todos 只能包含未来待执行时间；若今天同一触发时间已过，从明天开始，仍生成 course_days 条未来 todo。若用户未给周期或时间，信息不足时，应先调用 ask_user_question 补齐。
- 创建新计划前会检测已有进行中跟练计划：同一不适/副作用、相同来源，或未来提醒时间落在 30 分钟窗口内都会被视为冲突。
- 如果 action=create 返回 kind=todos_conflict，表示新计划尚未创建；必须继续调用 ask_user_question，把冲突计划名、plan_id 和冲突时间告诉用户，让用户选择替换已有计划、换一个时间或先不创建。不要直接再次 action=create。
- 用户要求调整跟练时间、换方案、提高/降低强度，或整体重排时，用 action=update；不要只修改单条提醒。
- todos 必须表达完整的新计划，不要只给变化的单条任务；不要把过去日期、已完成日期或旧计划历史塞进新计划。
- 用户明确不想继续这套方案，用 action=stop。`,
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'update', 'stop'],
          description: '要执行的 todo 操作。',
        },
        brief: {
          type: 'string',
          description: '一句话说明本次操作目的。',
        },
        plan_id: {
          type: 'string',
          description: '已有 todo plan 的 id；action=update 或 stop 时必填。',
        },
        title: {
          type: 'string',
          description: '计划名称，不超过 160 字；action=create 或 update 时必填。',
        },
        timezone: {
          type: 'string',
          description: '时区，当前仅支持 Asia/Shanghai；不填默认 Asia/Shanghai。',
        },
        source_type: {
          type: 'string',
          enum: ['intervention', 'video_resource', 'custom'],
          description: '计划来源。干预卡传 intervention；外部视频传 video_resource；用户自定义传 custom。',
        },
        source_id: {
          type: 'string',
          description: '来源对象 id，例如干预方案 id；没有则不填。',
        },
        dedupe_key: {
          type: 'string',
          description: '幂等键，用于避免同一来源重复创建同一计划。',
        },
        resource_ref_id: {
          type: 'string',
          description: '上一轮 generate_plan 返回、用户最终选中的资源编号。副作用疗程计划必须提供。',
        },
        course_days: {
          type: 'number',
          minimum: 1,
          maximum: 100,
          description: '疗程天数，范围 1-100。',
        },
        target_side_effect: {
          type: 'string',
          description: '本计划主要针对的当前症状、治疗副作用或不适。',
        },
        todos: {
          type: 'array',
          description: '计划内的具体 todo 列表；action=create 或 update 时必填。',
          items: {
            type: 'object',
            properties: {
              date: {
                type: 'string',
                description: '执行日期，YYYY-MM-DD。',
              },
              time: {
                type: 'string',
                description: '执行时间，HH:mm。',
              },
              show_prompt: {
                type: 'string',
                description: '提醒患者的话，不超过 500 字。',
              },
              prompt: {
                type: 'string',
                description: '提醒触发后给 Agent 的内部执行指令。',
              },
            },
            required: ['date', 'time', 'show_prompt', 'prompt'],
            additionalProperties: false,
          },
        },
        reason: {
          type: 'string',
          description: '终止或重排原因，便于审计。',
        },
      },
      required: ['action', 'brief'],
      additionalProperties: false,
    },
  },
  uiMeta: TOOL_UI_MANIFEST.todos,
  isReadOnly: false,
  maxResultSizeChars: 50_000,
}
