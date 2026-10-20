import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveFeatureSnapshot } from '@health-agent/shared'
import {
  AGENT_TOOLS,
  ASK_USER_QUESTION_TOOL,
  GENERATE_COMMUNICATION_CARD_TOOL,
  getAgentTools,
  LOAD_SKILL_TOOL,
  MEDICAL_REPORT_CONSULTATION_TOOL,
  READ_CX_PRODUCT_GUIDE_TOOL,
  SAVED_CONTENT_TOOL,
  SCHEDULE_TOOL,
  TODOS_TOOL,
  toLLMToolSchema,
  UPDATE_STRUCTURED_PROFILE_TOOL,
} from './index.js'

test('toLLMToolSchema strips local-only tool metadata', () => {
  const schema = toLLMToolSchema(MEDICAL_REPORT_CONSULTATION_TOOL) as any

  assert.equal(schema.type, 'function')
  assert.equal(schema.function.name, 'medical_report_consultation_board')
  assert.equal(schema.uiMeta, undefined)
  assert.equal(schema.isReadOnly, undefined)
  assert.equal(schema.maxResultSizeChars, undefined)
})

test('AGENT_TOOLS exposes active chat tools without legacy staged tools', () => {
  const toolsByName = new Map(AGENT_TOOLS.map((tool) => [tool.function.name, tool]))
  const names = [...toolsByName.keys()]

  assert.ok(names.includes('grade_medical_risk'))
  assert.ok(names.includes('generate_plan'))
  assert.ok(names.includes('load_skill'))
  assert.ok(!names.includes('medical_literature_search'))
  assert.ok(!names.includes('memory'))
  assert.ok(names.includes('search_chat_history'))
  assert.ok(names.includes('ask_user_question'))
  assert.ok(names.includes('saved_content'))
  assert.ok(names.includes('read_product_guide'))
  assert.ok(!names.includes('read_product_ui_guide'))
  assert.ok(!names.includes('read_medical_documents'))
  assert.ok(names.includes('schedule'))
  assert.ok(!names.includes('list_scheduled_tasks'))
  assert.ok(!names.includes('add_scheduled_task'))
  assert.ok(!names.includes('update_scheduled_task'))
  assert.ok(names.includes('get_check_in_schema'))
  assert.ok(names.includes('todos'))
  assert.ok(names.includes('propose_check_in_draft'))
  assert.ok(names.includes('propose_check_in_record'))
  assert.ok(!names.includes('save_check_in_card'))
  assert.ok(!names.includes('create_check_in_schema'))
  assert.ok(!names.includes('record_check_in_by_category'))
  assert.ok(!names.includes('update_memory'))
  assert.equal(toolsByName.get('grade_medical_risk')?.uiMeta?.title, '风险分级')
  assert.equal(toolsByName.get('grade_medical_risk')?.uiMeta?.renderKind, 'default')
  assert.equal(toolsByName.get('generate_plan')?.uiMeta?.title, '生成干预方案')
  assert.equal(toolsByName.get('generate_plan')?.uiMeta?.renderKind, 'default')
  assert.deepEqual(
    (toolsByName.get('grade_medical_risk')?.function.parameters as any).required,
    ['reason', 'level', 'category'],
  )
  const riskSchema = toolsByName.get('grade_medical_risk')?.function.parameters as any
  const planSchema = toolsByName.get('generate_plan')?.function.parameters as any
  const riskDescription = toolsByName.get('grade_medical_risk')?.function.description ?? ''
  const planDescription = toolsByName.get('generate_plan')?.function.description ?? ''
  assert.match(riskDescription, /最终回答前调用一次本工具/)
  assert.match(riskDescription, /症状\/副作用疗程 skill/)
  assert.match(riskSchema.properties.category.description, /side_effect=治疗或药物相关副作用/)
  assert.match(riskSchema.properties.category.description, /current_symptom=.*B0\/B1\/C 会返回症状疗程 skill 调度/)
  assert.doesNotMatch(riskDescription, /generate_plan/)
  assert.doesNotMatch(riskDescription, /<resource_ref|编号通常形如|不要调用其他工具展示干预资料/)
  assert.doesNotMatch(riskDescription, /medical_literature_search|RAG/)
  assert.equal(riskSchema.properties.search_query, undefined)
  assert.equal(riskSchema.properties.rag_query, undefined)
  assert.match(riskSchema.properties.reason.description, /一句话简要说明分级依据/)
  assert.deepEqual(riskSchema.properties.level.enum, ['S', 'A', 'B0', 'B1', 'C'])
  assert.match(riskSchema.properties.level.description, /S=危急/)
  assert.match(riskSchema.properties.level.description, /B0=要紧/)
  assert.match(riskSchema.properties.level.description, /地舒单抗是否继续/)
  assert.match(riskSchema.properties.level.description, /C=低风险/)
  assert.match(riskSchema.properties.category.description, /side_effect=治疗或药物相关副作用/)
  assert.match(riskSchema.properties.category.description, /不要为了后续生成干预资源改错分类/)
  assert.match(riskSchema.properties.category.description, /无急症信号时通常走 B1/)
  assert.match(riskSchema.properties.category.description, /活着没意思/)
  assert.match(planDescription, /为用户生成可跟练的症状\/副作用干预卡片或视频候选/)
  assert.match(planDescription, /必须调用本工具/)
  assert.match(planDescription, /不能用本工具替代就医、复诊或医生确认/)
  assert.doesNotMatch(planDescription, /仅当 grade_medical_risk 已判定/)
  assert.deepEqual(planSchema.required, ['search_query'])
  assert.match(planSchema.properties.search_query.description, /不适症状 \+ 明确场景/)
  assert.match(planSchema.properties.search_query.description, /不要为了补全主动加入乳腺癌、乳腺结节/)
  assert.match(planSchema.properties.search_query.description, /最长 72 个字符/)
  assert.match(AGENT_TOOLS.map((tool) => tool.function.name).join(','), /grade_medical_risk/)
  assert.match(AGENT_TOOLS.map((tool) => tool.function.name).join(','), /generate_plan/)
  assert.match(AGENT_TOOLS.map((tool) => tool.function.name).join(','), /load_skill/)
  assert.doesNotMatch(AGENT_TOOLS.map((tool) => tool.function.name).join(','), /medical_literature_search/)
  assert.ok(!names.includes('show_intervention_material'))
  assert.match(riskSchema.properties.category.description, /report_interpretation=病理、免疫组化/)
  assert.equal(toolsByName.get('search_chat_history')?.maxResultSizeChars, 20_000)
  assert.equal(toolsByName.get('read_product_guide')?.uiMeta?.title, '读取产品说明')
  assert.equal(toolsByName.get('load_skill')?.uiMeta?.title, '加载技能')
  assert.equal(toolsByName.get('read_product_guide')?.isReadOnly, true)
  assert.equal(toolsByName.get('load_skill')?.isReadOnly, true)
  assert.equal(toolsByName.get('schedule')?.uiMeta?.renderKind, 'scheduled_task')
  assert.equal(toolsByName.get('get_check_in_schema')?.isReadOnly, true)
  assert.equal(toolsByName.get('propose_check_in_draft')?.uiMeta?.renderKind, 'check_in')
  assert.equal(toolsByName.get('propose_check_in_record')?.uiMeta?.renderKind, 'check_in')
  assert.equal(toolsByName.get('save_check_in_card'), undefined)
})

test('load_skill exposes a single-name read-only skill loader contract', () => {
  const tool = LOAD_SKILL_TOOL as any

  assert.equal(tool.function.name, 'load_skill')
  assert.equal(tool.isReadOnly, true)
  assert.equal(tool.maxResultSizeChars, 60_000)
  assert.match(tool.function.description, /一次只加载一个 skill/)
  assert.match(tool.function.description, /name/)
  assert.deepEqual(tool.function.parameters.required, ['name'])
  assert.equal(tool.function.parameters.properties.name.type, 'string')
  assert.equal(tool.function.parameters.additionalProperties, false)
})

test('get_check_in_schema exposes a read-only category schema lookup contract', () => {
  const tool = AGENT_TOOLS.find((item) => item.function.name === 'get_check_in_schema') as any

  assert.equal(tool?.isReadOnly, true)
  assert.match(tool.function.description, /只读/)
  assert.match(tool.function.description, /propose_check_in_record/)
  assert.deepEqual(tool.function.parameters.required, ['categoryQuery'])
  assert.equal(tool.function.parameters.properties.categoryQuery.type, 'string')
  assert.equal(tool.function.parameters.properties.categoryKey.type, 'string')
})

test('ask_user_question schema asks compact multiple-choice questions', () => {
  const tool = ASK_USER_QUESTION_TOOL as any
  const params = tool.function.parameters
  const question = params.properties.questions.items

  assert.equal(tool.function.name, 'ask_user_question')
  assert.equal(tool.isReadOnly, true)
  assert.equal(tool.uiMeta.title, '需求确认')
  assert.equal(tool.uiMeta.activeLabel, '需求确认中...')
  assert.equal(tool.uiMeta.doneLabel, '已发起需求确认')
  assert.equal(tool.uiMeta.detailText, '正在确认继续回答前需要补齐的关键信息。')
  assert.equal(tool.uiMeta.renderKind, 'ask_user_question')
  assert.deepEqual(params.required, ['questions'])
  assert.equal(params.properties.questions.minItems, 1)
  assert.equal(params.properties.questions.maxItems, 4)
  assert.equal(question.required.includes('question'), true)
  assert.equal(question.required.includes('header'), true)
  assert.equal(question.required.includes('options'), true)
  assert.equal(question.required.includes('multiSelect'), true)
  assert.equal(question.properties.options.minItems, 2)
  assert.equal(question.properties.options.maxItems, 4)
  assert.equal(question.properties.options.items.properties.ref_id.type, 'string')
  assert.equal(question.properties.options.items.required.includes('ref_id'), false)
  assert.equal(question.properties.multiSelect.type, 'boolean')
  assert.equal(params.properties.answers.additionalProperties.type, 'string')
  assert.equal(params.properties.annotations.additionalProperties.properties.notes.type, 'string')
  assert.equal(params.properties.metadata.properties.source.type, 'string')
  assert.equal(tool.maxResultSizeChars, 100_000)
  assert.match(tool.function.description, /Use this tool when you need to ask the user questions during execution/)
  assert.match(tool.function.description, /Gather user preferences or requirements/)
  assert.match(tool.function.description, /Clarify ambiguous instructions/)
  assert.match(tool.function.description, /Get decisions on implementation choices as you work/)
  assert.match(tool.function.description, /Offer choices to the user about what direction to take/)
  assert.match(tool.function.description, /When to prefer this tool over plain-text follow-ups/)
  assert.match(tool.function.description, /preference, goal, or direction is unclear/)
  assert.match(tool.function.description, /instruction is ambiguous/)
  assert.match(tool.function.description, /several materially different options/)
  assert.match(tool.function.description, /several independent clarifying dimensions/)
  assert.match(tool.function.description, /batch them into one call instead of asking across multiple turns/)
  assert.match(tool.function.description, /Users will always be able to select "Other" to provide custom text input/)
  assert.match(tool.function.description, /Use multiSelect: true to allow multiple answers/)
  assert.doesNotMatch(tool.function.description, /\(Recommended\)/)
  assert.doesNotMatch(tool.function.description, /recommend a specific option/)
  assert.doesNotMatch(tool.function.description, /HIGHLY PREFERRED/)
  assert.doesNotMatch(tool.function.description, /Default to batching/)
  assert.doesNotMatch(tool.function.description, /trip length, budget, travel style/)
  assert.match(params.properties.questions.description, /Questions to ask the user \(1-4 questions\)/)
  assert.match(params.properties.answers.description, /User answers collected by the permission component/)
  assert.match(params.properties.annotations.description, /Optional per-question annotations/)
  assert.match(params.properties.metadata.description, /Optional metadata for tracking and analytics purposes/)
})

test('check-in tools describe the persistent card draft contract', () => {
  const toolsByName = new Map(AGENT_TOOLS.map((tool) => [tool.function.name, tool]))
  const draftDescription = toolsByName.get('propose_check_in_draft')?.function.description ?? ''
  const recordDescription = toolsByName.get('propose_check_in_record')?.function.description ?? ''

  for (const description of [draftDescription, recordDescription]) {
    assert.match(description, /草稿/)
    assert.match(description, /check-in card/)
    assert.match(description, /点击.*保存/)
    assert.match(description, /用户/)
    assert.match(description, /正式打卡记录/)
    assert.doesNotMatch(description, /每次打卡必须给/)
    assert.doesNotMatch(description, /rating|summary/)
  }
})

test('medical document tool schemas own report and history-read contracts', () => {
  const reportDescription = MEDICAL_REPORT_CONSULTATION_TOOL.function.description
  const savedContentDescription = SAVED_CONTENT_TOOL.function.description
  const savedContentParameters = SAVED_CONTENT_TOOL.function.parameters as any

  assert.match(reportDescription, /3 个百炼视觉模型/)
  assert.match(reportDescription, /除可选 reportIssuedDate 外不要传图片 URL、用户文字、历史资料 ID 或其他字段/)
  assert.match(reportDescription, /time_anchor、report_issued_date 和 report_age/)
  assert.deepEqual(savedContentParameters.properties.action.enum, ['list', 'read', 'show'])
  assert.deepEqual(savedContentParameters.properties.type.enum, ['A', 'B', 'C'])
  assert.deepEqual(savedContentParameters.properties.saved.enum, ['yes', 'no'])
  assert.match(savedContentDescription, /A=跟练卡\/跟练视频/)
  assert.match(savedContentDescription, /B=我的沟通卡/)
  assert.match(savedContentDescription, /C=病历文档/)
  assert.match(savedContentDescription, /saved=no/)
  assert.match(savedContentDescription, /show/)
  assert.match(savedContentDescription, /不要根据列表摘要猜测正文/)
})

test('schedule schema owns reminder list/create/update/delete rules', () => {
  const description = SCHEDULE_TOOL.function.description
  const parameters = SCHEDULE_TOOL.function.parameters as any

  assert.deepEqual(parameters.properties.action.enum, ['list', 'create', 'update', 'delete'])
  assert.deepEqual(parameters.required, ['action', 'brief'])
  assert.match(description, /action=create/)
  assert.match(description, /action=update/)
  assert.match(description, /action=delete/)
  assert.match(description, /不是只口头说“我会提醒你\/已记下”/)
  assert.match(description, /标题就是任务本身/)
  assert.match(description, /不要写“化疗后吃饭提醒”/)
  assert.match(description, /cron 语法或频率不合法时/)
  assert.match(description, /id 来自 action=list/)
})

test('todos schema owns plan create and update rules', () => {
  const description = TODOS_TOOL.function.description
  const parameters = TODOS_TOOL.function.parameters as any

  assert.deepEqual(parameters.properties.action.enum, ['create', 'update', 'stop'])
  assert.equal(parameters.properties.updateType, undefined)
  assert.equal(parameters.properties.advance_status, undefined)
  assert.equal(parameters.properties.todo_id, undefined)
  assert.equal(parameters.properties.feedback, undefined)
  assert.deepEqual(parameters.properties.source_type.enum, ['intervention', 'video_resource', 'custom'])
  assert.equal(parameters.properties.course_days.minimum, 1)
  assert.equal(parameters.properties.course_days.maximum, 100)
  assert.equal(parameters.properties.course_days.enum, undefined)
  assert.doesNotMatch(description, /副作用疗程优先 3、5、7/)
  assert.doesNotMatch(parameters.properties.course_days.description, /副作用疗程优先/)
  assert.deepEqual(parameters.required, ['action', 'brief'])
  assert.match(description, /周期跟练任务/)
  assert.match(description, /action=create/)
  assert.match(description, /action=update/)
  assert.match(description, /action=stop/)
  assert.doesNotMatch(description, /action=advance/)
  assert.match(description, /废弃旧计划/)
  assert.match(description, /已执行或已闭合的 todo 只保留在旧计划历史中/)
  assert.match(description, /todos 只能包含未来待执行时间/)
  assert.match(description, /今天同一触发时间已过.*从明天开始/)
  assert.match(description, /仍生成 course_days 条未来 todo/)
  assert.match(description, /show_prompt/)
  assert.match(description, /resource_ref_id/)
  assert.match(description, /信息不足时，应先调用 ask_user_question 补齐/)
  assert.doesNotMatch(description, /上层 skill/)
  assert.doesNotMatch(description, /用户点击“开始跟练”/)
  assert.doesNotMatch(description, /好一些了 \/ 差不多 \/ 更不舒服/)
  assert.doesNotMatch(description, /updateType/)
  assert.doesNotMatch(description, /reschedule_todo/)
  assert.match(description, /必须在用户确认资源、疗程天数和触发时间后再创建/)
  assert.match(description, /资源选择本身不等于确认周期或提醒时间/)
  assert.match(description, /创建新计划前会检测已有进行中跟练计划/)
  assert.match(description, /todos_conflict/)
  assert.match(description, /ask_user_question/)
  assert.doesNotMatch(description, /选中资源后，即视为确认该资源和基础跟练计划/)
  assert.doesNotMatch(description, /不要再追问天数、每日时间、提醒或反馈偏好/)
})

test('profile schema owns detailed operating rules', () => {
  const profileDescription = UPDATE_STRUCTURED_PROFILE_TOOL.function.description

  assert.match(profileDescription, /相对时间结合本轮后台上下文里的当前时间换算/)
  assert.match(profileDescription, /多字段一次性放进 updates 数组/)
})

test('check-in tools require strict user-grounded card content', () => {
  const toolsByName = new Map(AGENT_TOOLS.map((tool) => [tool.function.name, tool]))
  const draftDescription = toolsByName.get('propose_check_in_draft')?.function.description ?? ''
  const recordDescription = toolsByName.get('propose_check_in_record')?.function.description ?? ''

  assert.match(draftDescription, /严格来自用户|先追问/)
  assert.match(recordDescription, /严格来自用户|不要自行发散/)
  assert.match(draftDescription, /不要生成泛化空卡/)
  assert.match(draftDescription, /逐项填入/)
  assert.match(recordDescription, /逐项填入/)
})

test('check-in card draft tools expose recordedAt as YYYY-MM-DD only', () => {
  for (const name of ['propose_check_in_draft', 'propose_check_in_record']) {
    const tool = AGENT_TOOLS.find((item) => item.function.name === name) as any
    const description = tool?.function.parameters.properties.recordedAt?.description ?? ''
    assert.match(description, /YYYY-MM-DD/)
    assert.doesNotMatch(description, /ISO/)
  }
})

test('check-in field schema tells the model text means textarea and date labels must use date', () => {
  const draftTool = AGENT_TOOLS.find((item) => item.function.name === 'propose_check_in_draft') as any
  const recordTool = AGENT_TOOLS.find((item) => item.function.name === 'propose_check_in_record') as any
  const fieldTypeDescription = draftTool
    ?.function
    .parameters
    .properties
    .fields
    .items
    .properties
    .type
    .description ?? ''

  assert.match(fieldTypeDescription, /text.*textarea|textarea.*text/)
  assert.match(fieldTypeDescription, /日期.*date|date.*日期/)
  assert.match(draftTool?.function.description ?? '', /日期.*type.*date/)
  assert.match(recordTool?.function.description ?? '', /日期.*type.*date/)
})

test('check-in draft tools do not expose automatic save intent', () => {
  for (const name of ['propose_check_in_draft', 'propose_check_in_record']) {
    const tool = AGENT_TOOLS.find((item) => item.function.name === name) as any
    const properties = tool?.function.parameters.properties ?? {}
    const required = tool?.function.parameters.required ?? []

    assert.equal(properties.is_save, undefined)
    assert.equal(properties.isSave, undefined)
    assert.equal(required.includes('is_save'), false)
    assert.match(tool.function.description, /待保存/)
    assert.match(tool.function.description, /不能.*自动保存/)
  }
})

test('check-in tools discourage text-only recording for explicit record intents', () => {
  const toolsByName = new Map(AGENT_TOOLS.map((tool) => [tool.function.name, tool]))
  const draftDescription = toolsByName.get('propose_check_in_draft')?.function.description ?? ''
  const recordDescription = toolsByName.get('propose_check_in_record')?.function.description ?? ''

  assert.match(draftDescription, /天气、日记、备忘/)
  assert.match(draftDescription, /不要只口头说"已记下"/)
  assert.match(draftDescription, /未来日期/)
  assert.match(recordDescription, /不要只口头说"已记下"/)
})

test('check-in record tool keeps missing-category fallback internal', () => {
  const recordTool = AGENT_TOOLS.find((item) => item.function.name === 'propose_check_in_record') as any
  const description = recordTool?.function.description ?? ''
  const properties = recordTool?.function.parameters.properties ?? {}

  assert.match(description, /未命中.*工具内部.*创建/)
  assert.doesNotMatch(description, /fallback/)
  assert.equal(properties.fallbackCategoryName, undefined)
  assert.equal(properties.fallbackDisplayMode, undefined)
  assert.equal(properties.fallbackFields, undefined)
})

test('check-in record schema exposed to the model stays compact', () => {
  const recordTool = AGENT_TOOLS.find((item) => item.function.name === 'propose_check_in_record') as any
  const properties = recordTool?.function.parameters.properties ?? {}

  assert.equal(properties.categoryKey?.type, 'string')
  assert.deepEqual(Object.keys(properties).sort(), [
    'categoryKey',
    'categoryQuery',
    'draftNote',
    'draftTags',
    'draftValues',
    'recordedAt',
    'supersedesCheckInCardId',
  ].sort())
})

test('check-in field labels are described as Chinese-only in tool schema', () => {
  const draftTool = AGENT_TOOLS.find((item) => item.function.name === 'propose_check_in_draft') as any
  const fieldSchema = draftTool?.function.parameters.properties.fields.items

  assert.match(fieldSchema.properties.label.description, /必须.*中文/)
  assert.match(fieldSchema.properties.label.description, /不得.*英文/)
})

test('check-in draft schema leaves derived template details to the executor', () => {
  const draftTool = AGENT_TOOLS.find((item) => item.function.name === 'propose_check_in_draft') as any
  const properties = draftTool?.function.parameters.properties ?? {}

  assert.equal(properties.categoryName?.type, 'string')
  assert.equal(properties.displayMode?.type, 'string')
  assert.equal(properties.fields?.type, 'array')
  assert.equal(properties.categoryDescription, undefined)
  assert.equal(properties.aliases, undefined)
  assert.equal(properties.titleTemplate, undefined)
  assert.equal(properties.layout, undefined)
})

test('check-in tools require user confirmation before records are saved', () => {
  const toolsByName = new Map(AGENT_TOOLS.map((tool) => [tool.function.name, tool]))
  const draftDescription = toolsByName.get('propose_check_in_draft')?.function.description ?? ''
  const recordDescription = toolsByName.get('propose_check_in_record')?.function.description ?? ''

  for (const description of [draftDescription, recordDescription]) {
    assert.match(description, /点击.*保存/)
    assert.match(description, /不能.*自动保存/)
    assert.match(description, /多个独立记录/)
    assert.match(description, /合并/)
    assert.doesNotMatch(description, /单轮最多调用 1 次/)
    assert.doesNotMatch(description, /recordId 后再处理下一条/)
  }

  assert.match(draftDescription, /继续记录已有分类.*propose_check_in_record/)
  assert.equal(toolsByName.get('save_check_in_card'), undefined)
})

test('structured profile tool forbids inferring tumor type from partial IHC markers', () => {
  const description = UPDATE_STRUCTURED_PROFILE_TOOL.function.description

  assert.match(description, /不要仅凭 ER\/PR 阳性、HER2 阴性推断 Luminal A/)
  assert.match(description, /缺少 Ki-67/)
  assert.match(description, /unknown_or_untested/)
})

test('check-in draft tools expose explicit supersede intent for modifying an unsaved card', () => {
  const toolsByName = new Map(AGENT_TOOLS.map((tool) => [tool.function.name, tool as any]))

  for (const name of ['propose_check_in_draft', 'propose_check_in_record']) {
    const tool = toolsByName.get(name)
    const properties = tool?.function.parameters.properties ?? {}
    const description = tool?.function.description ?? ''
    const supersedes = properties.supersedesCheckInCardId
    const supersedesDescription = supersedes?.description ?? ''

    assert.equal(supersedes?.type, 'string')
    assert.match(description, /继续修改.*上一张未保存|新增、更新、删除字段内容/)
    assert.match(supersedesDescription, /语义上替换同一会话内某张未保存/)
    assert.match(supersedesDescription, /修改、补充、更新、删除、替换或重做/)
    assert.match(supersedesDescription, /合并后的完整新草稿/)
    assert.match(supersedesDescription, /不要因为同分类/)
    assert.match(supersedesDescription, /不要传已保存卡片/)
  }
})

test('getAgentTools keeps schedule and check-in tools for prod feature profile', () => {
  const tools = getAgentTools(resolveFeatureSnapshot({ profile: 'prod' }))
  const names = tools.map((tool) => tool.function.name)

  assert.ok(names.includes('schedule'))
  assert.ok(names.includes('todos'))
  assert.ok(!names.includes('list_scheduled_tasks'))
  assert.ok(!names.includes('add_scheduled_task'))
  assert.ok(!names.includes('update_scheduled_task'))
  assert.ok(!names.includes('create_check_in_schema'))
  assert.ok(!names.includes('record_check_in_by_category'))
  assert.ok(names.includes('get_check_in_schema'))
  assert.ok(names.includes('propose_check_in_draft'))
  assert.ok(names.includes('propose_check_in_record'))
  assert.ok(!names.includes('save_check_in_card'))
  assert.ok(names.includes('grade_medical_risk'))
  assert.ok(names.includes('generate_plan'))
  assert.ok(names.includes('load_skill'))
  assert.ok(!names.includes('memory'))
  assert.ok(!names.includes('medical_literature_search'))
  assert.ok(names.includes('search_chat_history'))
  assert.ok(names.includes('saved_content'))
  assert.ok(names.includes('read_product_guide'))
})

test('getAgentTools keeps scheduled task and check-in tools for dev and sit feature profiles', () => {
  for (const profile of ['dev', 'sit'] as const) {
    const names = getAgentTools(resolveFeatureSnapshot({ profile })).map((tool) => tool.function.name)

    assert.ok(names.includes('schedule'))
    assert.ok(names.includes('todos'))
    assert.ok(!names.includes('list_scheduled_tasks'))
    assert.ok(!names.includes('add_scheduled_task'))
    assert.ok(!names.includes('update_scheduled_task'))
    assert.ok(names.includes('get_check_in_schema'))
    assert.ok(names.includes('propose_check_in_draft'))
    assert.ok(names.includes('propose_check_in_record'))
    assert.ok(!names.includes('save_check_in_card'))
    assert.ok(!names.includes('create_check_in_schema'))
    assert.ok(!names.includes('record_check_in_by_category'))
    assert.ok(names.includes('grade_medical_risk'))
    assert.ok(names.includes('generate_plan'))
    assert.ok(names.includes('load_skill'))
    assert.ok(!names.includes('memory'))
    assert.ok(!names.includes('medical_literature_search'))
    assert.ok(names.includes('saved_content'))
    assert.ok(names.includes('read_product_guide'))
  }
})

test('CX product guide schema requires reading the active product guide before answering product questions', () => {
  const description = READ_CX_PRODUCT_GUIDE_TOOL.function.description
  const parameters = READ_CX_PRODUCT_GUIDE_TOOL.function.parameters as any

  assert.match(description, /实际生效的Health Agent Lab UI release/)
  assert.match(description, /移动端 App 下载指南/)
  assert.match(description, /必须先调用本工具/)
  assert.match(description, /TestFlight、APK、鸿蒙内测入口/)
  assert.deepEqual(parameters.properties.topic.enum, [
    'all',
    'navigation',
    'data_management',
    'account_settings',
    'app_download',
    'feature_availability',
    'future_notes',
  ])
  assert.deepEqual(parameters.required, [])
  assert.equal(READ_CX_PRODUCT_GUIDE_TOOL.function.name, 'read_product_guide')
  assert.equal(READ_CX_PRODUCT_GUIDE_TOOL.maxResultSizeChars, 8_000)
})

test('generate_communication_card schema encourages proactive offer for visit intent', () => {
  const description = GENERATE_COMMUNICATION_CARD_TOOL.function.description

  assert.match(description, /怎么跟医生说 \/ 就诊前准备 \/ 复诊沟通要点 \/ 问医生的问题 \/ 带什么资料/)
  assert.match(description, /线下就医意图包括但不限于/)
  assert.match(description, /去复诊 \/ 复查 \/ 随访 \/ 门诊 \/ 挂号 \/ 约了医生 \/ 看医生 \/ 找医生/)
  assert.match(description, /做检查 \/ 抽血 \/ B超 \/ 钼靶 \/ 磁共振 \/ 穿刺 \/ 入院 \/ 住院 \/ 日间治疗/)
  assert.match(description, /必须在最终回答尾部自然问一句/)
  assert.match(description, /只有用户明确同意后，才能调用/)
  assert.match(description, /最终回答不要复述整张卡片/)
  assert.match(description, /卡片已生成，可在上方收藏或编辑/)
})
