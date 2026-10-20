import { getToolUiMeta, parseMedicalRiskToolOutput, type ToolCallRecord } from '@health-agent/shared'
import { resolveAgentSkillDisplayName } from '../agent/skills/registry.js'

const SCHEDULED_TASK_TOOLS = new Set([
  'schedule',
  'list_scheduled_tasks',
  'add_scheduled_task',
  'update_scheduled_task',
])

const MEDICAL_RISK_LEVEL_LABELS: Record<string, string> = {
  S: '危急安全风险',
  A: '紧急就医/安全兜底',
  B0: '尽快线下评估',
  B1: '近期复诊/联系医生',
  C: '低风险',
}

const MEDICAL_RISK_CATEGORY_LABELS: Record<string, string> = {
  general_knowledge: '医学科普',
  current_symptom: '当前症状',
  side_effect: '副作用',
  medication_treatment: '用药/治疗决策',
  report_interpretation: '报告解读',
  followup_rehab: '随访/康复',
  mental_crisis: '心理危机',
  other_medical: '其他医学',
}

function trimString(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return trimmed.slice(0, max)
}

function sanitizeMedicalRiskInput(input: unknown): unknown {
  if (!input || typeof input !== 'object') return null
  const value = input as Record<string, unknown>
  const reason = trimString(value.reason, 120)
  const level = typeof value.level === 'string'
    ? MEDICAL_RISK_LEVEL_LABELS[value.level] ?? trimString(value.level, 40)
    : null
  const category = typeof value.category === 'string'
    ? MEDICAL_RISK_CATEGORY_LABELS[value.category] ?? trimString(value.category, 40)
    : null

  if (!reason && !level && !category) return null
  return {
    analysis: reason,
    level,
    category,
  }
}

function sanitizeGeneratePlanInput(input: unknown): unknown {
  if (!input || typeof input !== 'object') return null
  const value = input as Record<string, unknown>
  const searchQuery = trimString(value.search_query, 72)
  return searchQuery ? { searchQuery } : null
}

function sanitizeMedicalLiteratureSearchInput(input: unknown): unknown {
  if (!input || typeof input !== 'object') return null
  const value = input as Record<string, unknown>
  const query = trimString(value.query, 160)
  return query ? { query } : null
}

function sanitizeScheduledTaskInput(name: string, input: unknown): unknown {
  if (!input || typeof input !== 'object') return null
  const value = input as Record<string, unknown>
  if (name === 'schedule') {
    const action = typeof value.action === 'string' ? value.action : null
    if (action === 'create') {
      return {
        action,
        taskName: trimString(value.task, 120),
        dueAt: trimString(value.time, 80),
      }
    }
    if (action === 'update' || action === 'delete') {
      return {
        action,
        taskId: typeof value.id === 'number' || typeof value.id === 'string' ? value.id : null,
        taskName: trimString(value.task, 120),
        dueAt: trimString(value.time, 80),
        status: action === 'delete' ? 'deleted' : null,
      }
    }
    if (action === 'list') return { action }
    return null
  }
  if (name === 'add_scheduled_task') {
    return {
      taskName: trimString(value.task, 120),
      dueAt: trimString(value.time, 80),
    }
  }
  if (name === 'update_scheduled_task') {
    return {
      taskId: typeof value.id === 'number' || typeof value.id === 'string' ? value.id : null,
      taskName: trimString(value.task, 120),
      dueAt: trimString(value.time, 80),
      status: value.status === 'deleted' ? 'deleted' : null,
    }
  }
  return null
}

function sanitizeAskUserQuestionInput(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const questions = (input as { questions?: unknown }).questions
  if (!Array.isArray(questions)) return null
  return {
    questions: questions.map((raw) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
      const q = raw as Record<string, unknown>
      return {
        question: trimString(q.question, 160),
        header: trimString(q.header, 12),
        optionCount: Array.isArray(q.options) ? q.options.length : 0,
        multiSelect: q.multiSelect === true,
      }
    }).filter(Boolean),
  }
}

/**
 * 前端只需要展示固定工具文案、耗时和少量安全摘要。
 * 完整入参 / LLM tool_result 仍保存在 DB 的 toolCalls 中用于回放与审计；
 * 对客户端默认剥离，只有定时任务这类轻量工具保留可读摘要。
 */
export function sanitizeToolCallsForClient(
  toolCalls: ToolCallRecord[] | null | undefined,
): ToolCallRecord[] | null {
  if (!toolCalls?.length) return null

  return toolCalls.map((tc) => ({
    toolCallId: tc.toolCallId,
    name: tc.name,
    input: getClientToolInput(tc.name, tc.input),
    output: getClientToolOutput(tc.name, tc.output),
    durationMs: tc.durationMs,
  }))
}

export function getClientToolInput(name: string, input: unknown): unknown {
  if (name === 'grade_medical_risk') {
    return sanitizeMedicalRiskInput(input)
  }
  if (name === 'generate_plan') {
    return sanitizeGeneratePlanInput(input)
  }
  if (name === 'medical_literature_search') {
    return sanitizeMedicalLiteratureSearchInput(input)
  }
  if (SCHEDULED_TASK_TOOLS.has(name)) {
    return sanitizeScheduledTaskInput(name, input)
  }
  if (name === 'ask_user_question') {
    return sanitizeAskUserQuestionInput(input)
  }
  if (name === 'load_skill') {
    return sanitizeLoadSkillInput(input)
  }
  return null
}

/** load_skill 只下发 skill 标识 + 简短中文名，供前端时间线展示「已加载 X 技能」。 */
function sanitizeLoadSkillInput(input: unknown): unknown {
  const skillName = trimString((input as { name?: unknown } | null)?.name, 120)
  if (!skillName) return null
  const displayName = resolveAgentSkillDisplayName(skillName)
  return displayName ? { name: skillName, displayName } : { name: skillName }
}

/**
 * todos 工具的 displayOutput 含给 Agent 的内部执行指令（todo.prompt）和 todosMd，
 * 这些不是用户可见内容；只下发前端卡片需要的字段。
 */
function sanitizeTodosToolOutput(output: unknown): unknown {
  if (!output || typeof output !== 'object') return null
  const value = output as Record<string, unknown>
  if (value.kind !== 'todos') return null
  const plan = value.plan
  if (!plan || typeof plan !== 'object') return null
  const planRecord = plan as Record<string, unknown>
  const todos = Array.isArray(planRecord.todos) ? planRecord.todos : []
  return {
    kind: 'todos',
    action: value.action,
    plan: {
      id: planRecord.id,
      title: planRecord.title,
      status: planRecord.status,
      sourceType: planRecord.sourceType ?? null,
      sourceId: planRecord.sourceId ?? null,
      resourceRefId: planRecord.resourceRefId ?? null,
      courseDays: planRecord.courseDays ?? null,
      targetSideEffect: planRecord.targetSideEffect ?? null,
      todos: todos.map((todo) => {
        const item = todo as Record<string, unknown>
        return {
          id: item.id,
          date: item.date,
          time: item.time,
          showPrompt: item.showPrompt,
          status: item.status ?? 'pending',
          feedback: item.feedback ?? null,
        }
      }),
    },
  }
}

/**
 * 只有需要由前端渲染成业务卡片或轻量摘要的工具结果才下发给客户端。
 * 默认工具的 output 是给 LLM 继续推理用的，不属于用户可读内容。
 */
export function getClientToolOutput(name: string, output: unknown): unknown {
  if (name === 'todos') {
    return sanitizeTodosToolOutput(output)
  }
  if (name === 'grade_medical_risk') {
    return parseMedicalRiskToolOutput(output)
  }
  if (name === 'generate_plan') {
    return parseMedicalRiskToolOutput(output)
  }
  if (name === 'medical_literature_search') {
    return parseMedicalRiskToolOutput(output)
  }
  if (name === 'saved_content') {
    return parseMedicalRiskToolOutput(output)
  }
  const renderKind = getToolUiMeta(name).renderKind
  if (
    renderKind === 'communication_card' ||
    renderKind === 'intervention_material' ||
    renderKind === 'check_in' ||
    renderKind === 'ask_user_question'
  ) {
    return output ?? null
  }
  if (renderKind === 'scheduled_task') {
    return output ?? null
  }
  return null
}
