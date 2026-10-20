import { useMemo, useState, type CSSProperties, type KeyboardEvent } from 'react'
import type { AskUserQuestionItem, AskUserQuestionResourcePreview, AskUserQuestionToolOutput } from '@health-agent/shared'
import { interactiveSheetOverlayStyle, renderInteractiveSheetPortal } from './interactiveSheet.js'

interface Props {
  output: unknown
  onSubmit?: (content: string) => void
}

function isAskUserQuestionOutput(value: unknown): value is AskUserQuestionToolOutput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const raw = value as { kind?: unknown; questions?: unknown }
  return raw.kind === 'ask_user_question' && Array.isArray(raw.questions)
}

function normalizeOutput(output: unknown): AskUserQuestionToolOutput | null {
  if (!isAskUserQuestionOutput(output)) return null
  const questions: AskUserQuestionItem[] = []
  for (const raw of output.questions) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const q = raw as AskUserQuestionItem
    if (!q.question || !Array.isArray(q.options) || q.options.length === 0) continue
    questions.push({
      question: q.question,
      header: q.header || '问题',
      options: q.options
        .filter((opt) => opt?.label)
        .map((opt) => ({
          label: opt.label,
          description: opt.description ?? '',
          ...(opt.ref_id ? { ref_id: opt.ref_id } : {}),
        })),
      multiSelect: q.multiSelect === true,
    })
  }
  const previews = Array.isArray(output.resourcePreviews)
    ? output.resourcePreviews.filter((item): item is AskUserQuestionResourcePreview =>
      Boolean(item?.refId && item.title && item.kind))
    : undefined
  return questions.length > 0
    ? {
        kind: 'ask_user_question',
        questions,
        ...(previews?.length ? { resourcePreviews: previews } : {}),
      }
    : null
}

function formatAnswers(
  questions: AskUserQuestionItem[],
  answers: Record<string, string>,
): string {
  return questions
    .map((q) => `Q: ${q.question}\nA: ${answers[q.question] || '未回答'}`)
    .join('\n\n')
}

const RESOURCE_DIFFICULTY_LABELS: Record<string, string> = {
  simple: '简单',
  medium: '适中',
  complex: '复杂',
}

function isVideoResourceKind(kind: AskUserQuestionResourcePreview['kind'] | undefined): boolean {
  return kind === 'video_resource' || kind === 'internal_video'
}

function formatResourceDuration(durationSec: number | null | undefined): string | null {
  if (typeof durationSec !== 'number' || durationSec <= 0) return null
  const total = Math.round(durationSec)
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

function resourceMetaText(preview: AskUserQuestionResourcePreview | null): string {
  if (!preview) return ''
  const parts: string[] = []
  const difficulty = preview.difficulty ? RESOURCE_DIFFICULTY_LABELS[preview.difficulty] : null
  if (difficulty) parts.push(difficulty)
  const duration = formatResourceDuration(preview.durationSec)
  if (duration) parts.push(duration)
  return parts.join(' · ')
}

export default function AskUserQuestionInline({ output, onSubmit }: Props) {
  const parsed = useMemo(() => normalizeOutput(output), [output])
  const [currentIndex, setCurrentIndex] = useState(0)
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [multiSelections, setMultiSelections] = useState<Record<string, string[]>>({})
  const [customText, setCustomText] = useState<Record<string, string>>({})
  const [dismissed, setDismissed] = useState(false)

  if (!parsed || dismissed || !onSubmit) return null

  const questions = parsed.questions
  const current = questions[Math.min(currentIndex, questions.length - 1)]
  if (!current) return null

  const currentAnswer = answers[current.question]
  const currentCustomText = customText[current.question] ?? ''
  const currentMulti = multiSelections[current.question] ?? []
  const isLast = currentIndex >= questions.length - 1
  const canGoPrev = currentIndex > 0
  const canGoNext = currentIndex < questions.length - 1
  const previewByRef = new Map((parsed.resourcePreviews ?? []).map((item) => [item.refId, item]))
  const isResourceOptionMode = current.options.some((option) => Boolean(option.ref_id))

  function submit(nextAnswers: Record<string, string>) {
    setDismissed(true)
    onSubmit?.(formatAnswers(questions, nextAnswers))
  }

  function setAnswer(question: AskUserQuestionItem, answer: string, shouldAdvance = true) {
    const nextAnswers = { ...answers, [question.question]: answer }
    setAnswers(nextAnswers)
    if (!shouldAdvance) return
    if (currentIndex < questions.length - 1) {
      setCurrentIndex((idx) => Math.min(idx + 1, questions.length - 1))
      return
    }
    submit(nextAnswers)
  }

  function formatOptionAnswer(option: AskUserQuestionItem['options'][number]): string {
    return option.ref_id ? `${option.label}（ref_id: ${option.ref_id}）` : option.label
  }

  function handleSingleOption(option: AskUserQuestionItem['options'][number]) {
    setAnswer(current, formatOptionAnswer(option))
  }

  function handleMultiOption(option: AskUserQuestionItem['options'][number]) {
    const answer = formatOptionAnswer(option)
    const next = currentMulti.includes(answer)
      ? currentMulti.filter((item) => item !== answer)
      : [...currentMulti, answer]
    setMultiSelections((prev) => ({ ...prev, [current.question]: next }))
    if (next.length > 0) {
      setAnswers((prev) => ({ ...prev, [current.question]: next.join('、') }))
    }
  }

  function handleCustomSubmit() {
    const value = currentCustomText.trim()
    if (!value) return
    setAnswer(current, value)
  }

  function handleMultiContinue() {
    const selected = multiSelections[current.question] ?? []
    const custom = currentCustomText.trim()
    const value = [...selected, ...(custom ? [custom] : [])].join('、')
    if (!value) return
    setAnswer(current, value)
  }

  function handleCustomKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== 'Enter') return
    event.preventDefault()
    if (current.multiSelect) handleMultiContinue()
    else handleCustomSubmit()
  }

  return renderInteractiveSheetPortal(
    <div style={styles.overlay} aria-live="polite">
      <div style={styles.sheet}>
        <div style={styles.navRow}>
          <button
            type="button"
            style={{ ...styles.iconButton, ...(canGoPrev ? {} : styles.iconButtonDisabled) }}
            disabled={!canGoPrev}
            onClick={() => setCurrentIndex((idx) => Math.max(0, idx - 1))}
            aria-label="上一题"
          >
            <ChevronLeftIcon />
          </button>
          <span style={styles.countLabel}>{currentIndex + 1} of {questions.length}</span>
          <button
            type="button"
            style={{ ...styles.iconButton, ...(canGoNext ? {} : styles.iconButtonDisabled) }}
            disabled={!canGoNext}
            onClick={() => setCurrentIndex((idx) => Math.min(questions.length - 1, idx + 1))}
            aria-label="下一题"
          >
            <ChevronRightIcon />
          </button>
          <button
            type="button"
            style={{ ...styles.closeButton }}
            onClick={() => setDismissed(true)}
            aria-label="关闭"
          >
            <CloseIcon />
          </button>
        </div>

        <div style={styles.question}>{current.question}</div>

        <div style={isResourceOptionMode ? styles.resourceList : styles.optionList}>
          {current.options.map((option, index) => {
            const answer = formatOptionAnswer(option)
            const selected = current.multiSelect
              ? currentMulti.includes(answer)
              : currentAnswer === answer
            const preview = option.ref_id ? previewByRef.get(option.ref_id) : null
            if (isResourceOptionMode) {
              const title = preview?.title || option.label
              const meta = resourceMetaText(preview ?? null)
              return (
                <button
                  key={`${current.question}-${option.label}`}
                  type="button"
                  aria-label={title}
                  aria-pressed={current.multiSelect ? selected : undefined}
                  style={{
                    ...styles.resourceRow,
                    ...(selected ? styles.resourceRowSelected : {}),
                  }}
                  onClick={() => current.multiSelect
                    ? handleMultiOption(option)
                    : handleSingleOption(option)}
                >
                  <span style={styles.resourceThumbWrap}>
                    {preview?.thumbnailUrl ? (
                      <img src={preview.thumbnailUrl} alt="" style={styles.resourceImage} />
                    ) : (
                      <span style={styles.resourceFallback} aria-hidden="true" />
                    )}
                    {isVideoResourceKind(preview?.kind) && (
                      <span style={styles.resourcePlay} aria-hidden="true"><PlayIcon /></span>
                    )}
                  </span>
                  <span style={styles.resourceInfo}>
                    <span style={styles.resourceTitle}>{title}</span>
                    {meta && <span style={styles.resourceMeta}>{meta}</span>}
                  </span>
                  {selected && (
                    <span style={styles.resourceCheck} aria-hidden="true"><CheckIcon /></span>
                  )}
                </button>
              )
            }
            return (
              <button
                key={`${current.question}-${option.label}`}
                type="button"
                aria-label={option.description ? `${option.label}，${option.description}` : option.label}
                aria-pressed={current.multiSelect ? selected : undefined}
                style={{
                  ...styles.optionRow,
                  ...(selected ? styles.optionRowSelected : {}),
                }}
                onClick={() => current.multiSelect
                  ? handleMultiOption(option)
                  : handleSingleOption(option)}
              >
                {current.multiSelect ? (
                  <span
                    style={{
                      ...styles.optionCheckbox,
                      ...(selected ? styles.optionCheckboxSelected : null),
                    }}
                    aria-hidden="true"
                  >
                    {selected ? <CheckIcon /> : null}
                  </span>
                ) : (
                  <span style={{ ...styles.optionNumber, ...(selected ? styles.optionNumberSelected : null) }}>
                    {index + 1}
                  </span>
                )}
                <span style={styles.optionTextWrap}>
                  <span style={styles.optionLabel}>{option.label}</span>
                </span>
              </button>
            )
          })}
        </div>

        <div style={styles.customRow}>
          <span style={styles.pencilCircle} aria-hidden="true"><PencilIcon /></span>
          <input
            value={currentCustomText}
            onChange={(event) => setCustomText((prev) => ({
              ...prev,
              [current.question]: event.target.value,
            }))}
            onKeyDown={handleCustomKeyDown}
            placeholder="输入你的答案..."
            style={styles.customInput}
          />
          {(current.multiSelect || currentCustomText.trim()) && (
            <button
              type="button"
              style={styles.submitButton}
              onClick={current.multiSelect ? handleMultiContinue : handleCustomSubmit}
              disabled={current.multiSelect
                ? !((multiSelections[current.question]?.length ?? 0) > 0 || currentCustomText.trim())
                : !currentCustomText.trim()}
            >
              {isLast ? '提交' : '下一题'}
            </button>
          )}
        </div>
      </div>
    </div>,
  )
}

function ChevronLeftIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="15 18 9 12 15 6" />
    </svg>
  )
}

function ChevronRightIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  )
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
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
}

function PlayIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="white" stroke="none">
      <polygon points="8 5 19 12 8 19 8 5" />
    </svg>
  )
}

function PencilIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
    </svg>
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
  iconButton: {
    width: 26,
    height: 26,
    border: 'none',
    borderRadius: 13,
    background: 'transparent',
    color: 'var(--color-text-primary)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
    cursor: 'pointer',
  },
  iconButtonDisabled: {
    color: 'var(--color-text-tertiary)',
    cursor: 'default',
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
  question: {
    marginTop: 6,
    marginBottom: 2,
    fontSize: 15,
    lineHeight: 1.4,
    color: 'var(--color-text-primary)',
    fontWeight: 600,
    wordBreak: 'break-word',
  },
  optionList: {
    marginTop: 6,
    display: 'flex',
    flexDirection: 'column',
  },
  resourceList: {
    marginTop: 10,
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  resourceRow: {
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: 8,
    border: '1.5px solid var(--color-border)',
    borderRadius: 12,
    background: 'transparent',
    textAlign: 'left',
    cursor: 'pointer',
    boxSizing: 'border-box',
  },
  resourceRowSelected: {
    borderColor: 'var(--color-primary)',
    background: 'rgba(212, 135, 108, 0.06)',
  },
  resourceThumbWrap: {
    position: 'relative',
    width: 132,
    aspectRatio: '16 / 10',
    borderRadius: 8,
    overflow: 'hidden',
    flexShrink: 0,
    background: 'rgba(0,0,0,0.04)',
  },
  resourceImage: {
    width: '100%',
    height: '100%',
    objectFit: 'cover',
    display: 'block',
  },
  resourceFallback: {
    display: 'block',
    width: '100%',
    height: '100%',
    background: 'linear-gradient(135deg, rgba(212,135,108,0.18), rgba(255,255,255,0.72))',
  },
  resourcePlay: {
    position: 'absolute',
    top: '50%',
    left: '50%',
    transform: 'translate(-50%, -50%)',
    width: 30,
    height: 30,
    borderRadius: 15,
    background: 'rgba(0,0,0,0.42)',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    paddingLeft: 2,
  },
  resourceInfo: {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  resourceTitle: {
    fontSize: 14,
    fontWeight: 600,
    lineHeight: 1.35,
    color: 'var(--color-text-primary)',
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
    wordBreak: 'break-word',
  },
  resourceMeta: {
    fontSize: 12,
    color: 'var(--color-text-secondary)',
  },
  resourceCheck: {
    marginLeft: 'auto',
    width: 22,
    height: 22,
    borderRadius: 11,
    background: 'var(--color-primary)',
    color: 'white',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  optionRow: {
    minHeight: 44,
    border: 'none',
    borderTop: '1px solid var(--color-border)',
    background: 'transparent',
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '8px 0',
    color: 'var(--color-text-primary)',
    textAlign: 'left',
    cursor: 'pointer',
  },
  optionRowSelected: {
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
    background: 'rgba(212, 135, 108, 0.14)',
    color: 'var(--color-primary)',
  },
  optionCheckbox: {
    width: 26,
    height: 26,
    borderRadius: 13,
    border: '1.5px solid var(--color-border)',
    background: 'transparent',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    color: 'transparent',
    boxSizing: 'border-box',
    transition: 'background 120ms ease, border-color 120ms ease, color 120ms ease',
  },
  optionCheckboxSelected: {
    background: 'var(--color-primary)',
    borderColor: 'var(--color-primary)',
    color: 'white',
  },
  optionTextWrap: {
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
  },
  optionLabel: {
    fontSize: 14,
    lineHeight: 1.4,
    fontWeight: 400,
    wordBreak: 'break-word',
  },
  customRow: {
    minHeight: 44,
    borderTop: '1px solid var(--color-border)',
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    paddingTop: 8,
    paddingBottom: 4,
  },
  pencilCircle: {
    width: 26,
    height: 26,
    borderRadius: 13,
    background: 'rgba(0,0,0,0.04)',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: 'var(--color-text-secondary)',
    flexShrink: 0,
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
}
