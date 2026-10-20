import { TOOL_UI_MANIFEST, type AskUserQuestionItem } from '@health-agent/shared'
import type { ToolDefinition } from '../../api/types.js'

const ASK_USER_QUESTION_UI_META = TOOL_UI_MANIFEST.ask_user_question ?? {
  title: '需求确认',
  activeLabel: '需求确认中...',
  doneLabel: '已发起需求确认',
  detailText: '正在确认继续回答前需要补齐的关键信息。',
  renderKind: 'ask_user_question' as const,
}

const ASK_USER_QUESTION_TOOL_CHIP_WIDTH = 12

const ASK_USER_QUESTION_DESCRIPTION = `Use this tool when you need to ask the user questions during execution. This allows you to:
1. Gather user preferences or requirements
2. Clarify ambiguous instructions
3. Get decisions on implementation choices as you work
4. Offer choices to the user about what direction to take.

Batch independent questions into a single call (DEFAULT behavior):
- The schema accepts up to 4 questions per call. When the user's request raises several independent clarifying dimensions (e.g. scope + style + target + format), you MUST include all of them in one ask_user_question call.
- Asking one question, waiting for an answer, then asking the next is the wrong default. Each extra round-trip forces the user to reply again and replays the entire prior conversation through the model — wasting both the user's time and a large number of tokens.
- Only split questions across multiple calls when a later question genuinely depends on the answer to an earlier one (e.g. you cannot enumerate sensible options for Q2 until Q1 is answered). Sequential dependency is the exception, not the rule.
- Before calling, list every distinct clarifying dimension you currently have. If two or more are independent, they belong in the same call.

When to prefer this tool over plain-text follow-ups:
- The user's preference, goal, or direction is unclear and you need to clarify before continuing
- The user's instruction is ambiguous and the answer depends on which interpretation they meant
- The next step has several materially different options and the user should pick
- There are several independent clarifying dimensions — batch them into one call instead of asking across multiple turns

Usage notes:
- Users will always be able to select "Other" to provide custom text input
- Use multiSelect: true to allow multiple answers to be selected for a question`

const OPTION_SCHEMA = {
  type: 'object',
  properties: {
    label: {
      type: 'string',
      description: 'The display text for this option that the user will see and select. Should be concise (1-5 words) and clearly describe the choice.',
    },
    description: {
      type: 'string',
      description: 'Explanation of what this option means or what will happen if chosen. Useful for providing context about trade-offs or implications.',
    },
    ref_id: {
      type: 'string',
      description: 'Optional resource id from a previous generate_plan result. Only use when the option represents a concrete resource candidate already returned in this conversation.',
    },
  },
  required: ['label', 'description'],
  additionalProperties: false,
} as const

const QUESTION_SCHEMA = {
  type: 'object',
  properties: {
    question: {
      type: 'string',
      description: 'The complete question to ask the user. Should be clear, specific, and end with a question mark. Example: "Which library should we use for date formatting?" If multiSelect is true, phrase it accordingly, e.g. "Which features do you want to enable?"',
    },
    header: {
      type: 'string',
      description: `Very short label displayed as a chip/tag (max ${ASK_USER_QUESTION_TOOL_CHIP_WIDTH} chars). Examples: "Auth method", "Library", "Approach".`,
    },
    options: {
      type: 'array',
      minItems: 2,
      maxItems: 4,
      items: OPTION_SCHEMA,
      description: `The available choices for this question. Must have 2-4 options. Each option should be a distinct, mutually exclusive choice (unless multiSelect is enabled). There should be no 'Other' option, that will be provided automatically.`,
    },
    multiSelect: {
      type: 'boolean',
      default: false,
      description: 'Set to true to allow the user to select multiple options instead of just one. Use when choices are not mutually exclusive.',
    },
  },
  required: ['question', 'header', 'options', 'multiSelect'],
  additionalProperties: false,
} as const

const ANNOTATION_SCHEMA = {
  type: 'object',
  properties: {
    notes: {
      type: 'string',
      description: 'Free-text notes the user added to their selection.',
    },
  },
  additionalProperties: false,
} as const

export const ASK_USER_QUESTION_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'ask_user_question',
    description: ASK_USER_QUESTION_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          minItems: 1,
          maxItems: 4,
          items: QUESTION_SCHEMA,
          description: 'Questions to ask the user (1-4 questions)',
        },
        answers: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'User answers collected by the permission component',
        },
        annotations: {
          type: 'object',
          additionalProperties: ANNOTATION_SCHEMA,
          description: 'Optional per-question annotations from the user (e.g., notes on selections). Keyed by question text.',
        },
        metadata: {
          type: 'object',
          properties: {
            source: {
              type: 'string',
              description: 'Optional identifier for the source of this question (e.g., "remember" for /remember command). Used for analytics tracking.',
            },
          },
          additionalProperties: false,
          description: 'Optional metadata for tracking and analytics purposes. Not displayed to user.',
        },
      },
      required: ['questions'],
      additionalProperties: false,
    },
  },
  uiMeta: ASK_USER_QUESTION_UI_META,
  isReadOnly: true,
  maxResultSizeChars: 100_000,
}

export function normalizeAskUserQuestionInput(input: unknown): AskUserQuestionItem[] | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const rawQuestions = (input as { questions?: unknown }).questions
  if (!Array.isArray(rawQuestions) || rawQuestions.length < 1) return null

  const seenQuestions = new Set<string>()
  const questions: AskUserQuestionItem[] = []

  for (const raw of rawQuestions.slice(0, 4)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const value = raw as Record<string, unknown>
    const question = typeof value.question === 'string' ? value.question.trim() : ''
    const header = typeof value.header === 'string' ? value.header.trim().slice(0, 12) : ''
    const rawOptions = value.options
    if (!question || !header || !Array.isArray(rawOptions) || rawOptions.length < 2) {
      return null
    }
    if (seenQuestions.has(question)) return null
    seenQuestions.add(question)

    const seenLabels = new Set<string>()
    const options: AskUserQuestionItem['options'] = []
    for (const rawOption of rawOptions.slice(0, 4)) {
      if (!rawOption || typeof rawOption !== 'object' || Array.isArray(rawOption)) return null
      const optionValue = rawOption as Record<string, unknown>
      const label = typeof optionValue.label === 'string' ? optionValue.label.trim() : ''
      const description = typeof optionValue.description === 'string' ? optionValue.description.trim() : ''
      const refId = typeof optionValue.ref_id === 'string' ? optionValue.ref_id.trim() : ''
      if (!label || !description || seenLabels.has(label)) return null
      seenLabels.add(label)
      options.push(refId ? { label, description, ref_id: refId } : { label, description })
    }

    questions.push({
      question,
      header,
      options,
      multiSelect: value.multiSelect === true,
    })
  }

  return questions
}
