import type { AskUserQuestionOption } from '@health-agent/shared'

/**
 * 把「需求确认」用户答案消息（formatAnswers 生成的 `Q: ...\nA: ...` 文本）
 * 反解析成 question → answer 映射，供思考过程时间线回显用户最终勾选。
 */
export function parseAskUserQuestionAnswerMap(answerText?: string | null): Map<string, string> {
  const map = new Map<string, string>()
  if (!answerText) return map
  for (const block of answerText.split('\n\n')) {
    const match = /^Q:\s*([\s\S]*?)\nA:\s*([\s\S]*)$/.exec(block.trim())
    if (!match) continue
    map.set(match[1].trim(), match[2].trim())
  }
  return map
}

/** 判断某个选项是否被用户选中：优先 ref_id 精确匹配，否则按 label 包含。 */
export function isAskUserQuestionOptionSelected(
  option: AskUserQuestionOption,
  answer: string | undefined,
): boolean {
  if (!answer) return false
  if (option.ref_id && answer.includes(`（ref_id: ${option.ref_id}）`)) return true
  return answer.includes(option.label)
}
