---
name: side-effect-course-management
description: 用户反馈症状或治疗副作用导致不适，可能需要跟练资源、干预疗程或疗程反馈管理时触发。
---

# 症状/副作用疗程管理

把当前不适转化为低负担、可选择、可跟踪的跟练疗程。每轮先判 phase，再执行该 phase 的 action；资源选择只确认“练什么”，疗程周期和触发时间必须单独确认。

## 关于 action 字段
每个 phase 的 `action` 行写明的工具名（如 `ask_user_question`、`generate_plan`、`todos`、`grade_medical_risk`）都指**必须发起的原生 tool call**，不是行为描述。用正文文本表述同样的内容（例如把 `ask_user_question` 的题目写成正文列表请用户回答）不算完成 action；只有发起对应 tool call 才能进入该 phase 的 exit。

## 状态判定
按以下信号从上到下匹配，命中第一条即为当前 phase：

| 信号 | phase |
|---|---|
| 命中“安全不变量”任意一条 | offline_referral |
| system-reminder 含 `[todo:scheduled_session]`，已有当前 todo / resource 上下文 | scheduled_follow |
| system-reminder 含 `[todo:active_plans]`，且用户要求换方案、提高强度、降低强度或整体重排当前疗程 | plan_adjust |
| 上一条 user 是 ask_user_question 的计划配置回填，且资源、周期和触发时间都明确 | plan_create |
| 资源、周期和触发时间都明确，或用户在资源选择时明确说“按推荐安排” | plan_create |
| 上一条 user 是 ask_user_question 的资源选择回填，含 `ref_id: <id>`，但周期或触发时间缺失 | plan_config |
| 上一条 assistant 用普通正文追问周期/触发时间，或 user 说“给我选择/给我选项/让我选时间” | plan_config（纠偏为工具选择） |
| 上一条 user 是 ask_user_question 的计划配置回填，但只回答了周期或触发时间之一 | plan_config |
| 上一条 assistant 已展示候选资源 ask_user_question，但 user 回复未选中 ref_id | plan_pick（重新引导选择） |
| 已有候选资源（generate_plan 结果），尚未让用户选 | plan_pick |
| 分流问卷三项齐全（部位 + 活动影响 + 红旗），尚无候选 | plan_search |
| 用户已开始疗程（todos 已创建），本轮反馈进展或不适变化 | feedback |
| 其他（刚加载 skill / 分流信息缺失） | triage |

## Phase 1: triage（澄清需求）
- **entry**: 刚加载 skill，或 部位 / 活动影响 / 红旗 三项中任一缺失。
- **action**: **必须**发起 tool call `ask_user_question`，一次性批量问三题（题目模板见附录 A）。把题目写成正文文本不算完成 action。
- **exit**: 用户答完三题 → plan_search。
- **失败兜底**: 用户回答跳题或含糊，缺哪一项就再发起一次 `ask_user_question` tool call 单独补问该项。

## Phase 2: plan_search（生成候选）
- **entry**: 部位 + 活动影响 + 红旗 三项齐全，本轮尚未拿到候选资源。
- **action**: **必须**发起 tool call `generate_plan`，`search_query` 按附录 B 模板拼接。
- **exit**: 拿到 ≥3 条候选 → plan_pick。
- **失败兜底**: 0-2 条候选时换 query 再发起 `generate_plan`，最多 3 次；仍不足则进入 plan_pick 用现有条目。

## Phase 3: plan_pick（用户选）
- **entry**: 已有候选资源。
- **action**: **必须**发起 tool call `ask_user_question` 展示候选；按附录 C 收敛为简单/中等/复杂分层；每个 option 必须带 `ref_id`。
- **exit**: 用户回复中含 `ref_id: <id>` → plan_config。
- **失败兜底**: 用户没选 ref_id 而是问问题，回答后再发起一次 `ask_user_question` tool call 重新引导选择。

## Phase 4: plan_config（配置疗程）
- **entry**: 用户已选资源，但疗程周期或触发时间缺失。
- **action**: **必须**发起 tool call `ask_user_question`，且是**同一次工具调用**；questions 数组必须同时包含两道题：1）触发时间；2）跟练天数。时间候选按附录 E 基于当前最新系统时间动态生成。普通正文追问不算完成 action，也不能先用正文问“早上/晚上/中午”。
- **exit**: 用户明确 `course_days` 和未来 `trigger_time` → plan_create。
- **失败兜底**: 如果用户只回答了其中一题，再发起 `ask_user_question` tool call 单独补齐缺失项；时间无法解析时重新发起 `ask_user_question` 确认触发时间。

## Phase 5: plan_create（创建疗程）
- **entry**: 资源、周期和触发时间都明确；或用户明确授权“按推荐安排”。
- **action**: **必须**发起 tool call `todos`，`action=create`；按附录 D/E 生成连续日期任务；触发时间在今天已过时，从明天开始生成第 1 天，仍生成 `course_days` 条未来 todo，不要包含过去或已完成日期；最终回复正文必须包含 `<resource_ref id="<ref_id>" />`。
- **exit**: 回复展示完成 → 等待用户后续反馈进入 feedback。
- **冲突兜底**: 如果 `todos` 返回 `todos_conflict`，说明新计划尚未创建；**必须**发起 tool call `ask_user_question`，把冲突计划名、`plan_id` 和冲突时间告诉用户，并提供三个选择：1）替换已有计划；2）换一个时间；3）先不创建。用户选替换 → 用冲突 `plan_id` 调 `todos action=update`；用户选换时间 → 回到 plan_config；用户选先不创建 → 正文确认取消。
- **失败兜底**: `todos` 工具失败则正文说明并请用户稍后重试；信息缺失时回到 plan_config。

## plan_adjust（调整已有疗程）
- **entry**: system-reminder 含 `[todo:active_plans]`，且用户要求换方案、提高强度、降低强度、整体重排，或明确表达对当前疗程方案不满意。
- **action**: 先匹配同一不适/副作用的 active plan；若新资源、周期和触发时间已明确，**必须**发起 tool call `todos`，`action=update`，传入匹配到的 `plan_id` 和新的 title/todos；不要直接 `action=create` 叠加新计划。
- **缺信息**: 缺新资源时回到 plan_search/plan_pick；缺周期或触发时间时回到 plan_config。拿到完整信息后继续用同一个 `plan_id` 做 `action=update`。
- **调时间**: 用户说“今天晚点/明天再练/换个跟练时间”也属于整体重排，使用 `action=update`，让工具废弃旧计划、取消未执行提醒；已执行的 todo 只保留在旧计划历史中，不要算进新计划天数。
- **重排边界**: 覆盖/替换只作用于未开始的未来安排；新计划不得包含过去或已完成日期，也不要把旧计划已执行记录复制进新计划。
- **停止**: 用户明确不继续这套疗程时，用 `action=stop`。
- **exit**: 回复展示完成，说明旧计划已废弃、未开始提醒已取消、旧计划已执行记录仍留在历史中，并展示新计划。

## feedback（疗程反馈）
- 变好：文字鼓励 + 提示保持节奏（无 tool call）。
- 没变化：文字建议继续 1-2 天观察；用户同意微调时**必须**发起 `todos` tool call 调整。
- 变差：**必须**发起 `grade_medical_risk` tool call 重新分级；命中安全不变量 → offline_referral；否则可发起 `todos` tool call 降阶。

## scheduled_follow（定时跟练）
- **entry**: system-reminder 含 `[todo:scheduled_session]`，并提供当前 todo、计划进度和资源。
- **action**: 围绕当前 todo / resource 直接引导用户完成跟练；需要展示资源时引用 `<resource_ref id="todo-resource" />`；收到“变好了/没变化/变差了”用户反馈后按 feedback。
- **exit**: 当前跟练引导完成 → 等待下次提醒；全部 todo 完成 → 引导用户选择延长当前方案、挑战更高级方案或停止疗程。

## offline_referral（安全兜底，跨 phase）
- **action**: 不发起 `generate_plan` / `todos` tool call；输出线下就医沟通卡片，包含：主要不适+开始时间、治疗背景、已尝试资源、希望医生判断的问题。
- 必要时发起 `grade_medical_risk` tool call 重新分级供下游路由。

## 附录 A：分流问卷模板
发起 `ask_user_question` tool call，一次性问以下三题：
| 题 | 选项示例 |
|---|---|
| 部位 | 手指 / 手腕 / 肘肩 / 颈肩 / 腰背 / 膝踝 / 全身 / 自定义 |
| 活动或功能影响 | 能正常活动 / 影响握拳或拿东西 / 影响抬手或走路 / 明显受限 |
| 红旗 | 无 / 红肿发热 / 麻木无力 / 医生限制运动·热敷·按摩 / 近期手术伤口 / 输液港或骨转移风险 |
红旗为后三项之一时仍可进入 plan_search，但要在 search_query 里带“轻量”“可随时停止”，并在 plan_pick 优先推简单候选。命中“安全不变量”才转 offline_referral。

## 附录 B：search_query 模板
`目标不适 + 部位 + 活动/功能影响关键词`。例："晨僵 手指 握拳"、"关节痛 肘肩 手腕 明显受限"、"潮热 全身 影响睡眠"、"手脚麻木 化疗后 手指"。

## 附录 C：候选分层
| 层级 | 特征 |
|---|---|
| 简单 | 准备少、≤5 分钟、无器械 |
| 中等 | 5-15 分钟、少量准备或器械 |
| 复杂 | ≥15 分钟、需场地/器械/他人协助 |

## 附录 D：周期候选
| 候选层级或用户状态 | course_days |
|---|---|
| 简单 / 红旗存在 / 医生限制不确定 | 3 |
| 中等 / 状态稳定无限制 | 5 |
| 复杂 / 无红旗 / 体力允许 | 7 |

## 附录 E：触发时间候选生成规则
- 必须基于 system-reminder 里的当前最新系统时间和本地时区生成候选。
- 候选必须是未来时间，label 必须包含具体日期和时间。
- 优先提供时间段语义（如早间、午间、晚间、睡前）加具体时间；不要只给裸时间。
- 根据用户场景、症状描述、既有偏好和任务负担，生成 2-4 个合理候选。
- 用户已表达时间偏好时，候选围绕该偏好生成；未表达时，覆盖不同日常节奏。
- 用户选择某个时刻后，后续每日任务沿用同一时刻；若当天该时刻已过，则从下一天开始计算第 1 天，`course_days` 不减少；若用户说“按推荐安排”，选用当前最适配的推荐候选。

## 安全不变量
任意一条命中 → offline_referral：
- 医生明确禁止运动 / 热敷 / 按摩
- 近期手术或伤口未愈合
- 输液港或骨转移风险部位
- 疼痛 / 麻木 / 无力快速加重，已明显不能使用肢体
- 持续高热或全身感染表现
- 用户表达急症或自感无法保证安全
