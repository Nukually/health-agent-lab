import type { ReactNode } from 'react'
import {
  type CommunicationCardDraft,
  type CommunicationCardField,
} from '@health-agent/shared'
import A2uiMarkdown from '../../lib/a2ui/markdown.js'

interface Props {
  draft: CommunicationCardDraft
  editable?: boolean
  onChange?: (draft: CommunicationCardDraft) => void
  footer?: ReactNode
}

const COMMUNICATION_CARD_FIELD_DISPLAY_LABELS: Record<
  Extract<
    CommunicationCardField,
    'visitPurpose' | 'currentSituation' | 'informationForDoctor'
  >,
  string
> = {
  visitPurpose: '就诊目标',
  currentSituation: '我的情况',
  informationForDoctor: '这次建议带上',
}

export default function CommunicationCardPanel({
  draft,
  editable = false,
  onChange,
  footer,
}: Props) {
  function updateField<K extends CommunicationCardField>(field: K, value: CommunicationCardDraft[K]) {
    if (!editable || !onChange) return
    onChange({
      ...draft,
      [field]: value,
      ...(field === 'currentSituation' ? { questionsForDoctor: undefined } : {}),
    })
  }

  function fieldValue(
    field: Extract<
      CommunicationCardField,
      'visitPurpose' | 'currentSituation' | 'informationForDoctor'
    >,
  ): string {
    const value = draft[field] ?? ''
    const legacyQuestions = draft.questionsForDoctor?.trim()
    if (field !== 'currentSituation' || !legacyQuestions) return value
    return [value.trim(), `想问医生的问题：\n${legacyQuestions}`].filter(Boolean).join('\n\n')
  }

  function renderTextField(
    field: Extract<
      CommunicationCardField,
      'visitPurpose' | 'currentSituation' | 'informationForDoctor'
    >,
    placeholder: string,
  ) {
    const value = fieldValue(field)
    return (
      <div style={styles.section}>
        <div style={styles.sectionHeader}>
          <span style={styles.sectionTitle}>{COMMUNICATION_CARD_FIELD_DISPLAY_LABELS[field]}</span>
        </div>
        {editable ? (
          <textarea
            style={styles.textarea}
            value={value}
            placeholder={placeholder}
            onChange={(e) => updateField(field, e.target.value as CommunicationCardDraft[typeof field])}
          />
        ) : (
          <div className="markdown-body" style={styles.textValue}>
            <A2uiMarkdown content={value || '未填写'} />
          </div>
        )}
      </div>
    )
  }

  return (
    <div style={styles.card}>
      <div style={styles.header}>
        {editable ? (
          <input
            style={styles.titleInput}
            value={draft.title}
            placeholder="请输入卡片标题"
            onChange={(e) => updateField('title', e.target.value)}
          />
        ) : (
          <div style={styles.title}>{draft.title}</div>
        )}
        <div style={styles.headerMeta}>
          {editable ? (
            <input
              style={styles.dateInput}
              value={draft.cardDate}
              placeholder="YYYY-MM-DD"
              onChange={(e) => updateField('cardDate', e.target.value)}
            />
          ) : (
            <span style={styles.datePill}>{draft.cardDate}</span>
          )}
        </div>
      </div>

      {renderTextField('visitPurpose', '例如：这次主要想确认腹泻是否和当前治疗有关')}
      {renderTextField('currentSituation', '例如：乳腺手术后 4 个月，正在用阿贝西利和来曲唑；也可用 Markdown 表格整理')}
      {renderTextField('informationForDoctor', '例如：近期报告、影像光盘、用药清单；如有多条可用 Markdown 列表填写')}
      {footer}
    </div>
  )
}

const glassBg = 'rgba(255,255,255,0.7)'

const styles: Record<string, React.CSSProperties> = {
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: 14,
    padding: 16,
    borderRadius: 18,
    background: glassBg,
    border: '1px solid rgba(255,255,255,0.75)',
    boxShadow: '0 10px 28px rgba(212, 135, 108, 0.14), 0 2px 10px rgba(0, 0, 0, 0.05)',
    backdropFilter: 'blur(14px)',
    WebkitBackdropFilter: 'blur(14px)',
  },
  header: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  title: {
    fontSize: 'calc(var(--font-size-chat) + 4px)',
    lineHeight: 1.4,
    fontWeight: 700,
    color: 'var(--color-text)',
  },
  titleInput: {
    width: '100%',
    fontSize: 'calc(var(--font-size-chat) + 4px)',
    lineHeight: 1.4,
    fontWeight: 700,
    color: 'var(--color-text)',
    border: '1px solid rgba(212, 135, 108, 0.18)',
    borderRadius: 12,
    padding: '10px 12px',
    background: 'rgba(255,255,255,0.82)',
    outline: 'none',
  },
  headerMeta: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 8,
  },
  datePill: {
    display: 'inline-flex',
    alignItems: 'center',
    padding: '4px 10px',
    borderRadius: 999,
    background: 'rgba(212, 135, 108, 0.12)',
    color: '#A95B3E',
    fontSize: 'calc(var(--font-size-chat) - 2px)',
    fontWeight: 600,
  },
  dateInput: {
    minWidth: 132,
    padding: '8px 10px',
    borderRadius: 10,
    border: '1px solid rgba(212, 135, 108, 0.18)',
    background: 'rgba(255,255,255,0.82)',
    color: 'var(--color-text)',
    fontSize: 'calc(var(--font-size-chat) - 1px)',
    outline: 'none',
  },
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  sectionHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
  },
  sectionTitle: {
    fontSize: 'calc(var(--font-size-chat) - 1px)',
    fontWeight: 700,
    color: '#A95B3E',
  },
  textValue: {
    fontSize: 'var(--font-size-chat)',
    lineHeight: 1.7,
    color: 'var(--color-text)',
    wordBreak: 'break-word',
  },
  textarea: {
    width: '100%',
    minHeight: 88,
    padding: '10px 12px',
    borderRadius: 12,
    border: '1px solid rgba(212, 135, 108, 0.18)',
    background: 'rgba(255,255,255,0.82)',
    color: 'var(--color-text)',
    fontSize: 'var(--font-size-chat)',
    lineHeight: 1.6,
    resize: 'vertical',
    outline: 'none',
  },
}
