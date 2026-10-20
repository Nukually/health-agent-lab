import assert from 'node:assert/strict'
import test from 'node:test'
import { XmlToolCallDetector } from './xml-tool-detector.js'

const TOOL_NAMES = [
  'update_structured_profile',
  'search_chat_history',
  'saved_content',
  'show_intervention_material',
  'generate_communication_card',
  'generate_plan',
  'schedule',
  'propose_check_in_draft',
  'grade_medical_risk',
  'add_scheduled_task',
  'propose_check_in_record',
]

test('detects XML-style tool tag', () => {
  const detector = new XmlToolCallDetector(TOOL_NAMES)
  const violation = detector.push('<generate_communication_card>{"title":"复诊卡"}</generate_communication_card>')

  assert.deepEqual(violation, {
    reason: 'xml_tool_call_in_final_answer',
    toolName: 'generate_communication_card',
  })
})

test('detects function-style pseudo tool tag', () => {
  const detector = new XmlToolCallDetector(TOOL_NAMES)
  const violation = detector.push('<show_intervention_material({ code: "2-1" })>')

  assert.deepEqual(violation, {
    reason: 'xml_tool_call_in_final_answer',
    toolName: 'show_intervention_material',
  })
})

test('detects visible function-style tool call text', () => {
  const detector = new XmlToolCallDetector(TOOL_NAMES)
  const violation = detector.push('schedule({"action":"create","task":"喝水提醒","time":"2026-05-15T11:28:00+08:00"})')

  assert.deepEqual(violation, {
    reason: 'xml_tool_call_in_final_answer',
    toolName: 'schedule',
  })
})

test('detects visible legacy function-style tool call text', () => {
  const detector = new XmlToolCallDetector(TOOL_NAMES)
  const violation = detector.push('add_scheduled_task({"task":"喝水提醒","time":"2026-05-15T11:28:00+08:00"})')

  assert.deepEqual(violation, {
    reason: 'xml_tool_call_in_final_answer',
    toolName: 'add_scheduled_task',
  })
})

test('detects visible bare JSON tool call text', () => {
  const detector = new XmlToolCallDetector(TOOL_NAMES)
  const violation = detector.push('grade_medical_risk {"reason":"耳部嗡嗡响需排除听力下降、感染、药物耳毒性等风险。","level":"B1","category":"current_symptom"}')

  assert.deepEqual(violation, {
    reason: 'xml_tool_call_in_final_answer',
    toolName: 'grade_medical_risk',
  })
})

test('detects visible generate_plan tool call text', () => {
  const detector = new XmlToolCallDetector(TOOL_NAMES)
  const violation = detector.push('generate_plan({"search_query":"潮热 夜间发作"})')

  assert.deepEqual(violation, {
    reason: 'xml_tool_call_in_final_answer',
    toolName: 'generate_plan',
  })
})

test('detects visible tool_type JSON wrapper inside generic tool tag', () => {
  const detector = new XmlToolCallDetector(TOOL_NAMES)
  const violation = detector.push('<tool>{"tool_type":"grade_medical_risk","tool_input":{"reason":"焦虑失眠","level":"C","category":"mental_crisis"}}</tool>')

  assert.deepEqual(violation, {
    reason: 'xml_tool_call_in_final_answer',
    toolName: 'grade_medical_risk',
  })
})

test('detects visible function-style tool call inside generic tool tag', () => {
  const detector = new XmlToolCallDetector(TOOL_NAMES)
  const violation = detector.push('<tool>schedule({"action":"create","task":"喝水提醒"})</tool>')

  assert.deepEqual(violation, {
    reason: 'xml_tool_call_in_final_answer',
    toolName: 'schedule',
  })
})

test('detects generic tool tag with tool_type json', () => {
  const detector = new XmlToolCallDetector(TOOL_NAMES)
  const violation = detector.push('<tool>\n{"tool_type":"propose_check_in_draft","tool_input":{"categoryName":"饮食记录"}}\n</tool>')

  assert.deepEqual(violation, {
    reason: 'xml_tool_call_in_final_answer',
    toolName: 'propose_check_in_draft',
  })
})

test('detects generic tool_type json across chunks', () => {
  const detector = new XmlToolCallDetector(TOOL_NAMES)

  assert.equal(detector.push('<tool>\n{"tool_'), null)
  const violation = detector.push('type":"propose_check_in_draft","tool_input":{}')

  assert.equal(violation?.toolName, 'propose_check_in_draft')
})

test('detects wrapped XML tool_call with tool_name tag', () => {
  const detector = new XmlToolCallDetector(TOOL_NAMES)
  const violation = detector.push('<tool>\n<tool_call>\n<tool_name>grade_medical_risk</tool_name>\n<tool_params>{"reason":"耳部嗡嗡响","level":"B1","category":"current_symptom"}</tool_params>\n</tool_call>\n</tool>')

  assert.deepEqual(violation, {
    reason: 'xml_tool_call_in_final_answer',
    toolName: 'grade_medical_risk',
  })
})

test('detects bare parameter tags that expose tool arguments', () => {
  const detector = new XmlToolCallDetector(TOOL_NAMES)
  const violation = detector.push('<parameter name="categoryQuery">水肿观察打卡</parameter> <parameter name="draftValues">{"limb":"右臂"}</parameter>')

  assert.deepEqual(violation, {
    reason: 'xml_tool_call_in_final_answer',
    toolName: 'propose_check_in_record',
  })
})

test('detects XML-style tool tag across chunks', () => {
  const detector = new XmlToolCallDetector(TOOL_NAMES)

  assert.equal(detector.push('<generate_'), null)
  assert.equal(detector.push('communication_'), null)
  const violation = detector.push('card>{"title":"复诊卡"}')

  assert.equal(violation?.toolName, 'generate_communication_card')
})

test('detects function-style pseudo tool tag across chunks', () => {
  const detector = new XmlToolCallDetector(TOOL_NAMES)

  assert.equal(detector.push('<show_intervention_'), null)
  const violation = detector.push('material({ code: "')

  assert.equal(violation?.toolName, 'show_intervention_material')
})

test('detects visible function-style tool call across chunks', () => {
  const detector = new XmlToolCallDetector(TOOL_NAMES)

  assert.equal(detector.push('好的，我来处理： sche'), null)
  const violation = detector.push('dule({"action":"create","task":"喝水提醒"})')

  assert.equal(violation?.toolName, 'schedule')
})

test('detects visible bare JSON tool call across chunks', () => {
  const detector = new XmlToolCallDetector(TOOL_NAMES)

  assert.equal(detector.push('grade_medical_'), null)
  const violation = detector.push('risk {"reason":"耳部嗡嗡响"}')

  assert.equal(violation?.toolName, 'grade_medical_risk')
})

test('detects visible tool_type JSON wrapper across chunks', () => {
  const detector = new XmlToolCallDetector(TOOL_NAMES)

  assert.equal(detector.push('<tool>{"tool_type":"grade_'), null)
  const violation = detector.push('medical_risk","tool_input":{')

  assert.equal(violation?.toolName, 'grade_medical_risk')
})

test('detects wrapped XML tool_call with tool_name tag across chunks', () => {
  const detector = new XmlToolCallDetector(TOOL_NAMES)

  assert.equal(detector.push('<tool><tool_call><tool_name>grade_'), null)
  const violation = detector.push('medical_risk</tool_name>')

  assert.equal(violation?.toolName, 'grade_medical_risk')
})

test('detects visible bare tool-name text', () => {
  const detector = new XmlToolCallDetector(TOOL_NAMES)
  const violation = detector.push('请调用 generate_communication_card 来生成卡片。')

  assert.deepEqual(violation, {
    reason: 'xml_tool_call_in_final_answer',
    toolName: 'generate_communication_card',
  })
})

test('does not detect longer non-tool tag that only starts with a tool name', () => {
  const detector = new XmlToolCallDetector(TOOL_NAMES)

  assert.equal(detector.push('<show_intervention_material_extra code="2-1">'), null)
})

test('does not detect longer function name that only starts with a tool name', () => {
  const detector = new XmlToolCallDetector(TOOL_NAMES)

  assert.equal(detector.push('show_intervention_material_extra({ code: "2-1" })'), null)
})

test('does not detect A2UI tags', () => {
  const detector = new XmlToolCallDetector(TOOL_NAMES)

  assert.equal(detector.push('<recommendation priority="high">今天联系医生</recommendation>'), null)
})
