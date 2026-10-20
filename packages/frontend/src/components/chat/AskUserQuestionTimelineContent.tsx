/**
 * AskUserQuestionTimelineContent — 思考过程时间线里「需求确认」节点的只读回显。
 *
 * 展示 AI 当时给到用户的原始问题 + 选项，并标出用户最终勾选项（来自紧随的用户答案消息）。
 * 多个问题用「1 of N + 左右箭头」分页查看，和 inline 卡片一致。聊天页和分享页复用。
 */

import { useState, type CSSProperties } from 'react'
import type { AskUserQuestionItem } from '@health-agent/shared'
import { stripRefIdAnnotation } from '../../utils/text.js'
import { isAskUserQuestionOptionSelected, parseAskUserQuestionAnswerMap } from './askUserQuestionTimeline.js'

interface Props {
  questions: AskUserQuestionItem[]
  /** 紧随该轮的用户答案消息正文（formatAnswers 文本）；无则只展示问题+选项 */
  answerText?: string
}

export default function AskUserQuestionTimelineContent({ questions, answerText }: Props) {
  const [index, setIndex] = useState(0)
  if (questions.length === 0) return null

  const answerMap = parseAskUserQuestionAnswerMap(answerText)
  const current = questions[Math.min(index, questions.length - 1)]
  const answer = answerMap.get(current.question.trim())
  const matchedSome = current.options.some((opt) => isAskUserQuestionOptionSelected(opt, answer))
  const customAnswer = answer && !matchedSome ? stripRefIdAnnotation(answer).trim() : ''

  return (
    <div style={styles.card}>
      {questions.length > 1 && (
        <div style={styles.navRow}>
          <button
            type="button"
            style={{ ...styles.navBtn, ...(index > 0 ? {} : styles.navBtnDisabled) }}
            disabled={index <= 0}
            onClick={() => setIndex((i) => Math.max(0, i - 1))}
            aria-label="上一题"
          >
            <Chevron dir="left" />
          </button>
          <span style={styles.count}>{index + 1} / {questions.length}</span>
          <button
            type="button"
            style={{ ...styles.navBtn, ...(index < questions.length - 1 ? {} : styles.navBtnDisabled) }}
            disabled={index >= questions.length - 1}
            onClick={() => setIndex((i) => Math.min(questions.length - 1, i + 1))}
            aria-label="下一题"
          >
            <Chevron dir="right" />
          </button>
        </div>
      )}

      <div style={styles.question}>{current.question}</div>

      <div style={styles.options}>
        {current.options.map((option) => {
          const selected = isAskUserQuestionOptionSelected(option, answer)
          return (
            <div
              key={option.label}
              style={{ ...styles.option, ...(selected ? styles.optionSelected : {}) }}
            >
              <span style={{ ...styles.bullet, ...(selected ? styles.bulletSelected : {}) }}>
                {selected ? <Check /> : null}
              </span>
              <span style={styles.optionText}>{option.label}</span>
              {selected && <span style={styles.selectedTag}>用户已选</span>}
            </div>
          )
        })}
      </div>

      {customAnswer && (
        <div style={styles.customAnswer}>用户填写：{customAnswer}</div>
      )}
    </div>
  )
}

function Chevron({ dir }: { dir: 'left' | 'right' }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points={dir === 'left' ? '15 18 9 12 15 6' : '9 18 15 12 9 6'} />
    </svg>
  )
}

function Check() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
}

const styles: Record<string, CSSProperties> = {
  card: {
    border: '1px solid var(--color-border)',
    borderRadius: 12,
    padding: '10px 12px',
    background: 'var(--color-bg-subtle, rgba(0,0,0,0.02))',
  },
  navRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    marginBottom: 6,
  },
  navBtn: {
    width: 24,
    height: 24,
    border: 'none',
    borderRadius: 12,
    background: 'transparent',
    color: 'var(--color-text-primary)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
    cursor: 'pointer',
  },
  navBtnDisabled: {
    color: 'var(--color-text-tertiary)',
    cursor: 'default',
  },
  count: {
    fontSize: 12,
    color: 'var(--color-text-secondary)',
    fontWeight: 500,
    minWidth: 40,
    textAlign: 'center',
  },
  question: {
    fontSize: 13,
    lineHeight: 1.45,
    fontWeight: 600,
    color: 'var(--color-text-primary)',
    wordBreak: 'break-word',
  },
  options: {
    marginTop: 6,
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
  },
  option: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '5px 0',
  },
  optionSelected: {
    color: 'var(--color-primary)',
  },
  bullet: {
    width: 18,
    height: 18,
    borderRadius: 9,
    border: '1.5px solid var(--color-border)',
    background: 'transparent',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    color: 'transparent',
    boxSizing: 'border-box',
  },
  bulletSelected: {
    background: 'var(--color-primary)',
    borderColor: 'var(--color-primary)',
    color: 'white',
  },
  optionText: {
    fontSize: 13,
    lineHeight: 1.4,
    color: 'var(--color-text-primary)',
    wordBreak: 'break-word',
  },
  selectedTag: {
    marginLeft: 'auto',
    fontSize: 11,
    color: 'var(--color-primary)',
    fontWeight: 600,
    flexShrink: 0,
  },
  customAnswer: {
    marginTop: 6,
    paddingTop: 6,
    borderTop: '1px solid var(--color-border)',
    fontSize: 12,
    lineHeight: 1.45,
    color: 'var(--color-text-secondary)',
    wordBreak: 'break-word',
  },
}
