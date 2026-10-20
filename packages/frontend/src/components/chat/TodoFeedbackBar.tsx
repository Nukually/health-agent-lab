import React, { useState, type CSSProperties, type KeyboardEvent } from 'react'
import type {
  ApiResponse,
  MedicalRiskResourceTodoContext,
  TodoFeedback,
  TodoFeedbackResponse,
} from '@health-agent/shared'
import { api } from '../../services/api.js'
import { interactiveSheetOverlayStyle, renderInteractiveSheetPortal } from './interactiveSheet.js'

interface Props {
  visible: boolean
  sessionId: string | null
  todoContext?: MedicalRiskResourceTodoContext | null
  practiceState?: 'paused' | 'completed'
  onSubmitted?: (content: string) => void
}

const OPTIONS: Array<{ value: TodoFeedback; label: string }> = [
  { value: 'better', label: '好一些了' },
  { value: 'same', label: '差不多' },
  { value: 'worse', label: '更不舒服' },
]

const FEEDBACK_TEXT: Record<TodoFeedback, string> = {
  better: '好一些了',
  same: '差不多',
  worse: '更不舒服',
}

function isTodoContextClosed(todoContext: MedicalRiskResourceTodoContext): boolean {
  return todoContext.status === 'completed' || todoContext.status === 'not_practiced'
}

function CloseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
}

export default function TodoFeedbackBar({
  visible,
  sessionId,
  todoContext,
  practiceState = 'completed',
  onSubmitted,
}: Props) {
  const [selectedFeedback, setSelectedFeedback] = useState<TodoFeedback | null>(null)
  const [submitting, setSubmitting] = useState<TodoFeedback | null>(null)
  const [submitted, setSubmitted] = useState<TodoFeedback | null>(todoContext?.feedback ?? null)
  const [customText, setCustomText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [dismissed, setDismissed] = useState(false)

  if (!visible || dismissed) return null

  const activeTodoContext = todoContext?.scheduledMessageId ? todoContext : null
  const readonlyFeedback = submitted ?? todoContext?.feedback ?? null
  if (readonlyFeedback) return null
  if (todoContext && isTodoContextClosed(todoContext)) return null

  const disabled = !sessionId || submitting !== null

  async function submit(feedback = selectedFeedback) {
    if (!sessionId || disabled || !feedback) return
    setSubmitting(feedback)
    setError(null)
    try {
      if (activeTodoContext) {
        await api.post<ApiResponse<TodoFeedbackResponse>>(
          `/todos/items/${activeTodoContext.todoId}/feedback`,
          {
            sessionId,
            planId: activeTodoContext.planId,
            feedback,
          },
        )
      }
      setSubmitted(feedback)
      setDismissed(true)
      const statusText = practiceState === 'paused' ? '我这次跟练先到这里。' : '我完成了这次跟练。'
      const detail = customText.trim()
      onSubmitted?.(`${statusText}反馈：${FEEDBACK_TEXT[feedback]}。${detail ? `补充：${detail}。` : ''}`)
    } catch (err: any) {
      setError(err?.message || '反馈保存失败，请稍后重试')
    } finally {
      setSubmitting(null)
    }
  }

  function handleCustomKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== 'Enter') return
    event.preventDefault()
    void submit()
  }

  return renderInteractiveSheetPortal(
    <div style={styles.overlay} aria-live="polite">
      <div style={styles.sheet}>
        <div style={styles.navRow}>
          <span style={styles.countLabel}>1 of 1</span>
          <button
            type="button"
            style={styles.closeButton}
            onClick={() => setDismissed(true)}
            aria-label="关闭"
          >
            <CloseIcon />
          </button>
        </div>

        <div style={styles.titleBlock}>
          <div style={styles.question}>先休息一下，现在感觉怎么样？</div>
          <div style={styles.subtitle}>你的反馈能帮助我们更好地推荐方案</div>
        </div>

        <div style={styles.optionList}>
          {OPTIONS.map((option, index) => {
            const selected = selectedFeedback === option.value
            return (
              <button
                key={option.value}
                type="button"
                aria-label={option.label}
                aria-pressed={selected}
                style={{
                  ...styles.optionRow,
                  ...(selected ? styles.optionRowSelected : null),
                }}
                disabled={disabled}
                onClick={() => setSelectedFeedback(option.value)}
              >
                <span style={{
                  ...styles.optionNumber,
                  ...(selected ? styles.optionNumberSelected : null),
                }}>
                  {index + 1}
                </span>
                <span style={{
                  ...styles.optionLabel,
                  ...(selected ? styles.optionLabelSelected : null),
                }}>
                  {submitting === option.value ? '保存中...' : option.label}
                </span>
                {selected && (
                  <span style={styles.selectedCheck}>
                    <CheckIcon />
                  </span>
                )}
              </button>
            )
          })}
        </div>

        <div style={styles.customRow}>
          <input
            value={customText}
            onChange={(event) => setCustomText(event.target.value)}
            onKeyDown={handleCustomKeyDown}
            placeholder="补充你的感受..."
            style={styles.customInput}
          />
          {(selectedFeedback || customText.trim()) && (
            <button
              type="button"
              style={{
                ...styles.submitButton,
                ...(!selectedFeedback ? styles.submitButtonDisabled : null),
              }}
              onClick={() => submit()}
              disabled={!selectedFeedback || submitting !== null}
            >
              提交
            </button>
          )}
        </div>

        {error && <div style={styles.error}>{error}</div>}
      </div>
    </div>,
  )
}

const styles: Record<string, CSSProperties> = {
  overlay: interactiveSheetOverlayStyle,
  sheet: {
    width: 'min(100%, 520px)',
    maxHeight: 'min(66vh, 560px)',
    overflowY: 'auto',
    borderRadius: 24,
    border: '1px solid rgba(0,0,0,0.06)',
    background: 'rgba(255,255,255,0.97)',
    boxShadow: '0 14px 38px rgba(0,0,0,0.10)',
    padding: '12px 18px 14px',
    pointerEvents: 'auto',
    WebkitBackdropFilter: 'blur(18px)',
    backdropFilter: 'blur(18px)',
  },
  navRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    minHeight: 28,
  },
  countLabel: {
    fontSize: 13,
    color: 'var(--color-text-primary)',
    fontWeight: 500,
    minWidth: 44,
    textAlign: 'center',
  },
  closeButton: {
    marginLeft: 'auto',
    width: 28,
    height: 28,
    border: 'none',
    borderRadius: 14,
    background: 'transparent',
    color: 'var(--color-text-primary)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
    cursor: 'pointer',
  },
  titleBlock: {
    marginTop: 6,
    paddingBottom: 12,
    borderBottom: '1px solid var(--color-border)',
  },
  question: {
    fontSize: 17,
    lineHeight: 1.4,
    color: 'var(--color-text-primary)',
    fontWeight: 700,
    wordBreak: 'break-word',
  },
  subtitle: {
    marginTop: 2,
    fontSize: 13,
    lineHeight: 1.4,
    color: 'var(--color-text-secondary)',
    wordBreak: 'break-word',
  },
  optionList: {
    display: 'flex',
    flexDirection: 'column',
  },
  optionRow: {
    minHeight: 52,
    border: 'none',
    background: 'transparent',
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '0 10px',
    color: 'var(--color-text-primary)',
    textAlign: 'left',
    cursor: 'pointer',
    borderRadius: 0,
    outline: 'none',
    boxShadow: 'inset 0 -1px 0 var(--color-border)',
    WebkitTapHighlightColor: 'transparent',
  },
  optionRowSelected: {
    background: 'rgba(212, 135, 108, 0.08)',
    borderRadius: 10,
    boxShadow: 'inset 0 0 0 1px rgba(212, 135, 108, 0.16)',
    color: 'var(--color-primary)',
  },
  optionNumber: {
    width: 26,
    height: 26,
    borderRadius: 13,
    background: 'rgba(0,0,0,0.04)',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    fontSize: 12,
    fontWeight: 500,
    color: 'var(--color-text-secondary)',
  },
  optionNumberSelected: {
    background: 'var(--color-primary)',
    color: '#fff',
  },
  optionLabel: {
    flex: 1,
    fontSize: 15,
    lineHeight: 1.4,
    fontWeight: 400,
    wordBreak: 'break-word',
  },
  optionLabelSelected: {
    color: 'var(--color-primary)',
    fontWeight: 600,
  },
  selectedCheck: {
    width: 24,
    height: 24,
    borderRadius: 12,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    color: 'var(--color-primary)',
  },
  customRow: {
    minHeight: 44,
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    paddingTop: 8,
    paddingBottom: 4,
  },
  customInput: {
    minWidth: 0,
    flex: 1,
    border: 'none',
    outline: 'none',
    background: 'transparent',
    color: 'var(--color-text-primary)',
    fontSize: 14,
    lineHeight: 1.4,
  },
  submitButton: {
    border: 'none',
    borderRadius: 14,
    background: 'var(--color-primary)',
    color: 'white',
    fontSize: 13,
    fontWeight: 600,
    padding: '6px 12px',
    flexShrink: 0,
    cursor: 'pointer',
  },
  submitButtonDisabled: {
    background: 'rgba(0,0,0,0.10)',
    color: 'var(--color-text-tertiary)',
    cursor: 'not-allowed',
  },
  error: {
    marginTop: 8,
    fontSize: 12,
    color: '#B04D3A',
  },
}
