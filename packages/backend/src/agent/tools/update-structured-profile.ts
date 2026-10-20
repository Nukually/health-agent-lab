import type { ToolDefinition } from '../../api/types.js'
import {
  TOOL_UI_MANIFEST,
  STRUCTURED_PROFILE_FIELDS,
  requiresApprovalForField,
} from '@health-agent/shared'

export const UPDATE_STRUCTURED_PROFILE_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'update_structured_profile',
    description: `批量请求更新【个人信息】或【病历档案】中的 1 个或多个结构化字段。

工作机制（根据字段分类不同）：

**自动直接落库字段（nickname / birthday / gender）**：
- 工具调用后立即直接落库，无需用户确认。
- 界面会展示一条轻量只读提示条。
- 同值情况下仍跳过。

**需用户确认但不需要健康档案授权的字段（currentConcern）**：
- 工具调用后不会立即落库，会弹出确认卡片。
- 若用户在本会话内已拒绝过该字段，不要再次尝试。
- 同值情况下跳过。

**需用户确认且需要健康档案授权的病历字段（menstrualStatus / noduleBiradsGrade / tumorType / diagnosisDuration / treatmentPhase / medications / medicationDuration）**：
- 工具调用后不会立即落库。系统向用户弹出确认卡片，由用户确认。
- 若用户在本会话内已拒绝过该字段，不要再次尝试。
- 同值情况下跳过。
- 肿瘤分型 / 确诊时长 / 治疗阶段只在乳腺肿瘤相关诊疗场景可更新；若当前场景不允许，但用户内容已明显进入乳腺肿瘤诊疗，先单独更新 currentConcern=breast_tumor_care，再在后续轮次更新这些字段。
- 乳腺检查分型只在乳腺结节随访场景可更新；若当前场景不允许，但用户内容已明显进入乳腺结节随访，先单独更新 currentConcern=breast_nodule_followup，再在后续轮次更新该字段。

共同原则：
- 确认卡片 / 只读提示条就是确认机制本身。不要在调用工具前再问“需要帮您更新到档案吗”。
- 一旦从用户消息中明确识别到 1 个或多个字段的新值，直接调用本工具，多字段一次性放进 updates 数组。
- 枚举字段必须使用英文枚举值，不要传中文 label。
- tumorType 只能记录用户明确说出的分型，或报告原文直接写明的分型。不要仅凭 ER/PR 阳性、HER2 阴性推断 Luminal A；缺少 Ki-67、PR 比例/强度、分级等关键信息时，若用户只是说“还不清楚/没测/大概不确定”，传 unknown_or_untested，否则不要更新 tumorType。
- 需要把相对时间结合本轮后台上下文里的当前时间换算后再映射字段，例如“上周五/上个月/今年 3 月”用于 diagnosisDuration 时先算到具体日期区间。
- 用药情况支持多选和自定义药名：medications 的 value 是“更新后的完整数组”。如果档案里已有老药、用户又说新增一种药，新 value 应包含老药和新药，例如已有 tamoxifen，用户新增来曲唑 → value=["tamoxifen","letrozole"]。
- 自定义药物名称不是独立 field。遇到不在 medications 枚举内的具体药名时，medications.value 放 "other"，并在同一个 update 对象里填写 medicationCustom（多个自定义药用 "、" 连接）。例如用户“我在打戈舍瑞林，吃哌柏西利” → { field:"medications", value:["other"], medicationCustom:"戈舍瑞林、哌柏西利" }。
- 用药时长必须和具体药物绑定：在 field="medications" 的同一个 update 对象内填写 medicationDurations（key 为药物枚举值；自定义药 key 为 custom:药名）。如果用户只说了药名、没有说时长，可以不传 medicationDurations，系统会在确认卡片里默认填 within_1m，用户可在卡片内编辑后保存。
- 如果用户同时说了药名和同一个时长，也可以在 medications update 里用 medicationDuration 作为默认时长，系统会应用到本次所有药物。不要为 medications 和 medicationDuration 分开发两张卡片。
- 用户明确“暂未用药/没有服用”时，medications.value=["none"]，不用再单独传 medicationDuration；系统会把用药时长填为 not_required（无需填写）。
- 用户说“不吃/停用/不用某个药了”时，也用 medications 做完整目标数组更新：把该药从数组中移除，保留仍在用的其他药。例如当前为 ["tamoxifen","letrozole"]，用户“不吃他莫昔芬了” → value=["letrozole"]。如果移除的是自定义药名，需要同步改 medicationCustom；没有自定义药剩余时，value 中不要保留 "other"，medicationCustom 置空。

field 枚举值：
- nickname（昵称） — value: string
- birthday（生日） — value: "YYYY-MM-DD"
- gender（性别） — value: "男" | "女"
- currentConcern（当前关注情况） — value: breast_tumor_care | breast_nodule_followup | awaiting_exam_or_results | not_sure_exploring | other_breast_issue
- menstrualStatus（月经状态） — value: premenopausal | perimenopausal | postmenopausal | treatment_induced | uncertain
- noduleBiradsGrade（乳腺检查分型） — value: birads_1_2 | birads_3 | birads_4 | birads_5 | uncertain
- tumorType（肿瘤分型） — value: luminal_a | luminal_b_her2_negative | luminal_b_her2_positive | her2_positive_hr_negative | triple_negative | unknown_or_untested
- diagnosisDuration（确诊时长） — value: within_3m | 3_to_6m | 6_to_12m | 1_to_3y | over_3y
- treatmentPhase（治疗阶段） — value: pre_surgery(手术前/等待手术) | surgery_recovery(术后恢复中) | on_endocrine(内分泌治疗中) | on_chemo(化疗中) | on_radiation(放疗中) | on_targeted(靶向治疗中) | non_surgical_comprehensive(未手术，正在综合治疗中) | phase_completed_waiting_next(阶段性治疗已结束，等待下一步) | completed_main(主要治疗已完成，定期复查中) | paused_observation(暂停治疗/观察中) | uncertain(不确定)
- medications（用药情况） — value: 字符串数组，每项取自 tamoxifen | letrozole | anastrozole | exemestane | fulvestrant | other | none；这是完整目标数组，不是 append 操作，支持新增和删除；自定义药名用同一 update 对象的 medicationCustom；时长用同一对象的 medicationDuration 或 medicationDurations
- medicationDuration（用药时长） — value: within_1m | 1_to_3m | 3_to_6m | 6_to_12m | over_1y | not_required；仅在单独更新已有药物时使用，和 medications 同批出现时会合并为一张用药确认卡

调用后你会收到 tool_result 文本，列出每个字段的处理结果：
- 自动字段：“已直接更新为 X”
- 确认字段：“已发送确认卡片” / “当前已是 X 无需更新” / “用户此前已拒绝” / “当前关注情况不允许更新此字段”

对确认字段不要声称“已更新成功”；根据 tool_result 自然衔接下文即可。`,
    parameters: {
      type: 'object',
      properties: {
        updates: {
          type: 'array',
          description: '要更新的字段列表；支持单次传多项',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              field: {
                type: 'string',
                enum: [...STRUCTURED_PROFILE_FIELDS],
                description: '要更新的字段名',
              },
              value: {
                description:
                  '新值。字符串或字符串数组（medications 字段为更新后的完整数组）。枚举字段必须使用英文枚举值。',
              },
              medicationCustom: {
                type: 'string',
                description:
                  '仅 field=medications 且 value 包含 other 时使用，填写具体自定义药名；多个药名用“、”连接。不是独立字段。',
              },
              medicationDuration: {
                type: 'string',
                enum: ['within_1m', '1_to_3m', '3_to_6m', '6_to_12m', 'over_1y'],
                description:
                  '仅 field=medications 时可选。作为本次所有具体药物的默认用药时长；用户只说药名时可省略，确认卡会默认 1个月内。',
              },
              medicationDurations: {
                type: 'object',
                additionalProperties: {
                  type: 'string',
                  enum: ['within_1m', '1_to_3m', '3_to_6m', '6_to_12m', 'over_1y'],
                },
                description:
                  '仅 field=medications 时可选。按具体药物绑定时长；常见药 key 用枚举值（如 letrozole），自定义药 key 用 custom:药名。',
              },
            },
            required: ['field', 'value'],
          },
        },
      },
      required: ['updates'],
    },
  },
  uiMeta: TOOL_UI_MANIFEST.update_structured_profile,
  isReadOnly: false,
  maxResultSizeChars: 6_000,
  /**
   * 确认路径由字段定义驱动：
   * - nickname / birthday / gender 直接落库
   * - currentConcern + 所有病历字段进入确认卡片流程
   */
  requiresApproval: (input) => {
    const args = input as { updates?: Array<{ field?: unknown }>; field?: unknown } | null
    const raw: Array<{ field?: unknown }> = Array.isArray(args?.updates)
      ? (args!.updates as Array<{ field?: unknown }>)
      : typeof args?.field === 'string'
        ? [{ field: args!.field }]
        : []
    const approvalFields: string[] = []
    for (const u of raw) {
      const f = u?.field
      if (typeof f === 'string' && requiresApprovalForField(f)) {
        approvalFields.push(f)
      }
    }
    return approvalFields.length ? approvalFields : null
  },
}
