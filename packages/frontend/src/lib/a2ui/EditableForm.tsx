import { useMemo, useState } from 'react'
import {
  resolveCheckInCardTitle,
  type CheckInA2uiSchema,
  type CheckInAttachment,
  type CheckInFieldDefinition,
  type CheckInValues,
} from '@health-agent/shared'
import ImageLightbox from '../../components/ImageLightbox.js'

type FieldChangeValue = string | number | boolean | null

function asPrimitive(value: unknown): FieldChangeValue {
  if (value && typeof value === 'object' && !Array.isArray(value) && 'value' in value) {
    return (value as { value: unknown }).value as FieldChangeValue
  }
  return value as FieldChangeValue
}

function hasRequiredValue(value: unknown): boolean {
  const raw = asPrimitive(value)
  if (raw === null || raw === undefined) return false
  if (typeof raw === 'string') return raw.trim().length > 0
  if (typeof raw === 'number') return Number.isFinite(raw)
  if (typeof raw === 'boolean') return true
  return false
}

function estimateTextAreaRows(value: string): number {
  if (!value.trim()) return 1
  const hardLines = value.split(/\r?\n/).length
  const softLines = Math.ceil(value.length / 18)
  return Math.min(6, Math.max(1, hardLines, softLines))
}

export function findMissingCheckInRequiredFieldLabels(
  schema: CheckInA2uiSchema,
  values: CheckInValues,
): string[] {
  return schema.fields
    .filter((field) => field.required)
    .filter((field) => !hasRequiredValue(values[field.key]))
    .map((field) => field.label)
}

export interface CheckInEditableFormProps {
  schema: CheckInA2uiSchema
  values: CheckInValues
  attachments: CheckInAttachment[]
  note: string
  tags: string[]
  /** UI 提示文本,通常是"等你核对后保存" */
  helperText?: string
  /** 提交按钮文案 */
  submitLabel?: string
  /** 顶部状态文案;设为 null 时隐藏状态 chip */
  statusLabel?: string | null
  /** 只读展示原表单现场,禁用交互并隐藏保存按钮 */
  readOnly?: boolean
  submitting?: boolean
  errorMessage?: string | null
  onChangeValue: (key: string, value: FieldChangeValue) => void
  onChangeNote: (note: string) => void
  onCancel?: () => void
  onSubmit: () => void
}

export default function CheckInEditableForm(props: CheckInEditableFormProps) {
  const {
    schema, values, attachments, note,
    helperText, submitLabel = '保存打卡', statusLabel = '待保存',
    readOnly = false, submitting = false, errorMessage,
    onChangeValue, onChangeNote, onCancel, onSubmit,
  } = props

  const fields = useMemo(() => schema.fields, [schema])
  const imageUrls = useMemo(() => attachments.map((image) => image.url), [attachments])
  const [localErrorMessage, setLocalErrorMessage] = useState<string | null>(null)
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null)
  const displayedErrorMessage = errorMessage ?? localErrorMessage
  const title = resolveCheckInCardTitle({
    titleTemplate: schema.titleTemplate,
    categoryName: schema.categoryName,
  })

  function handleSubmit() {
    const missing = findMissingCheckInRequiredFieldLabels(schema, values)
    if (missing.length) {
      setLocalErrorMessage(`请先填写必填项:${missing.join('、')}`)
      return
    }
    setLocalErrorMessage(null)
    onSubmit()
  }

  return (
    <article style={styles.card}>
      <header style={styles.header}>
        <h3 style={styles.title}>{title}</h3>
        {statusLabel ? <span style={styles.statusChip}>{statusLabel}</span> : null}
      </header>
      {helperText ? <p style={styles.helper}>{helperText}</p> : null}

      <div style={styles.fields}>
        {fields.map((field) => (
          <FieldRow
            key={field.key}
            field={field}
            value={asPrimitive(values[field.key])}
            readOnly={readOnly}
            onChange={(v) => {
              setLocalErrorMessage(null)
              onChangeValue(field.key, v)
            }}
          />
        ))}
      </div>

      <label style={styles.noteLabel}>
        <span style={styles.kvLabel}>备注</span>
        <textarea
          style={styles.noteInput}
          rows={3}
          value={note}
          disabled={readOnly}
          onChange={(e) => {
            setLocalErrorMessage(null)
            onChangeNote(e.target.value)
          }}
          placeholder="可补充本次的状态、感受、注意事项..."
        />
      </label>

      {attachments.length ? (
        <div style={styles.attachments}>
          <div style={styles.attachmentsLabel}>图片信息</div>
          <div style={styles.imageGrid}>
            {attachments.map((image, idx) => (
              <button
                key={`${image.url}-${idx}`}
                type="button"
                style={styles.imageButton}
                onClick={() => setLightboxIndex(idx)}
                title={`查看图片信息 ${idx + 1}`}
                aria-label={`查看图片信息 ${idx + 1}`}
              >
                <img src={image.url} alt={`图片信息 ${idx + 1}`} style={styles.image} />
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {lightboxIndex !== null && imageUrls.length ? (
        <ImageLightbox
          images={imageUrls}
          initialIndex={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
        />
      ) : null}

      {displayedErrorMessage ? <div style={styles.error}>{displayedErrorMessage}</div> : null}

      {!readOnly ? (
        <footer style={styles.footer}>
          {onCancel ? (
            <button type="button" style={styles.cancelBtn} onClick={onCancel} disabled={submitting}>
              取消
            </button>
          ) : null}
          <button type="button" style={styles.submitBtn} onClick={handleSubmit} disabled={submitting}>
            {submitting ? '保存中...' : submitLabel}
          </button>
        </footer>
      ) : null}
    </article>
  )
}

function FieldRow({
  field,
  value,
  readOnly,
  onChange,
}: {
  field: CheckInFieldDefinition
  value: FieldChangeValue
  readOnly: boolean
  onChange: (v: FieldChangeValue) => void
}) {
  const labelText = field.required ? `${field.label} *` : field.label
  if (field.type === 'number') {
    const numericValue = value === null || value === undefined || value === '' ? '' : String(value)
    return (
      <div style={styles.fieldRow}>
        <label style={styles.kvLabel}>{labelText}</label>
        <div style={styles.numberWrap}>
          <input
            type="number"
            inputMode="decimal"
            style={styles.input}
            value={numericValue}
            disabled={readOnly}
            onChange={(e) => {
              const raw = e.target.value
              if (raw === '') return onChange(null)
              const num = Number(raw)
              onChange(Number.isFinite(num) ? num : null)
            }}
            placeholder={field.unit ? `输入数值(${field.unit})` : '输入数值'}
          />
          {field.unit ? <span style={styles.unitTag}>{field.unit}</span> : null}
        </div>
      </div>
    )
  }
  if (field.type === 'boolean') {
    const checked = value === true
    return (
      <div style={styles.fieldRow}>
        <label style={styles.kvLabel}>{labelText}</label>
        <div style={styles.choiceGroup}>
          <button
            type="button"
            style={{ ...styles.choice, ...(checked ? styles.choiceActive : null) }}
            disabled={readOnly}
            onClick={() => onChange(true)}
          >是</button>
          <button
            type="button"
            style={{ ...styles.choice, ...(checked === false && value !== null ? styles.choiceActive : null) }}
            disabled={readOnly}
            onClick={() => onChange(false)}
          >否</button>
        </div>
      </div>
    )
  }
  if (field.type === 'choice') {
    const selected = typeof value === 'string' ? value : ''
    return (
      <div style={styles.fieldRow}>
        <label style={styles.kvLabel}>{labelText}</label>
        <div style={styles.choiceGroup}>
          {(field.options ?? []).map((opt) => (
            <button
              key={opt}
              type="button"
              style={{ ...styles.choice, ...(selected === opt ? styles.choiceActive : null) }}
              disabled={readOnly}
              onClick={() => onChange(opt)}
            >{opt}</button>
          ))}
        </div>
      </div>
    )
  }
  if (field.type === 'date') {
    const dateValue = typeof value === 'string' ? value : ''
    return (
      <div style={styles.fieldRow}>
        <label style={styles.kvLabel}>{labelText}</label>
        <input
          type="date"
          style={styles.input}
          value={dateValue}
          disabled={readOnly}
          onChange={(e) => onChange(e.target.value || null)}
        />
      </div>
    )
  }
  // text
  const textValue = value == null ? '' : String(value)
  return (
    <div style={{ ...styles.fieldRow, ...styles.fieldRowMultiline }}>
      <label style={styles.kvLabel}>{labelText}</label>
      <textarea
        rows={estimateTextAreaRows(textValue)}
        style={styles.textArea}
        value={textValue}
        disabled={readOnly}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  card: {
    width: '100%',
    borderRadius: 8,
    border: '1px dashed rgba(184, 112, 90, 0.32)',
    background: 'rgba(255, 250, 246, 0.92)',
    padding: 14,
    boxSizing: 'border-box',
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  title: {
    margin: 0,
    fontSize: 16,
    lineHeight: '22px',
    color: 'var(--color-text)',
  },
  statusChip: {
    display: 'inline-flex',
    alignItems: 'center',
    padding: '2px 8px',
    borderRadius: 999,
    background: 'rgba(245, 166, 35, 0.16)',
    color: 'var(--color-primary-dark)',
    fontSize: 12,
    fontWeight: 600,
  },
  helper: {
    margin: 0,
    color: 'var(--color-text-muted)',
    fontSize: 13,
    lineHeight: '20px',
  },
  fields: {
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  fieldRow: {
    display: 'grid',
    gridTemplateColumns: '88px minmax(0, 1fr)',
    gap: 10,
    alignItems: 'center',
    fontSize: 14,
    lineHeight: '22px',
  },
  fieldRowMultiline: {
    alignItems: 'flex-start',
  },
  kvLabel: {
    color: 'var(--color-text-muted)',
  },
  numberWrap: {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  unitTag: {
    color: 'var(--color-text-muted)',
    fontSize: 13,
  },
  input: {
    width: '100%',
    boxSizing: 'border-box',
    padding: '6px 10px',
    borderRadius: 6,
    border: '1px solid rgba(184, 112, 90, 0.22)',
    background: '#fff',
    fontSize: 14,
    lineHeight: '20px',
    color: 'var(--color-text)',
  },
  textArea: {
    width: '100%',
    boxSizing: 'border-box',
    padding: '6px 10px',
    borderRadius: 6,
    border: '1px solid rgba(184, 112, 90, 0.22)',
    background: '#fff',
    fontSize: 14,
    lineHeight: '20px',
    color: 'var(--color-text)',
    resize: 'vertical' as const,
    fontFamily: 'inherit',
    whiteSpace: 'pre-wrap' as const,
    overflowWrap: 'break-word' as const,
  },
  choiceGroup: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 6,
  },
  choice: {
    padding: '6px 12px',
    borderRadius: 999,
    border: '1px solid rgba(184, 112, 90, 0.22)',
    background: '#fff',
    color: 'var(--color-text)',
    fontSize: 13,
    cursor: 'pointer',
  },
  choiceActive: {
    background: 'rgba(245, 166, 35, 0.18)',
    borderColor: 'var(--color-primary)',
    color: 'var(--color-primary-dark)',
    fontWeight: 600,
  },
  noteLabel: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  noteInput: {
    width: '100%',
    boxSizing: 'border-box',
    padding: '8px 10px',
    borderRadius: 6,
    border: '1px solid rgba(184, 112, 90, 0.22)',
    background: '#fff',
    fontSize: 14,
    lineHeight: '20px',
    color: 'var(--color-text)',
    resize: 'vertical' as const,
    fontFamily: 'inherit',
  },
  attachments: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  attachmentsLabel: {
    color: 'var(--color-text-muted)',
    fontSize: 13,
  },
  imageGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
    gap: 6,
  },
  imageButton: {
    width: '100%',
    aspectRatio: '1',
    padding: 0,
    border: 'none',
    borderRadius: 8,
    background: '#fff',
    cursor: 'zoom-in',
    overflow: 'hidden',
  },
  image: {
    width: '100%',
    height: '100%',
    display: 'block',
    borderRadius: 8,
    objectFit: 'cover' as const,
  },
  error: {
    padding: 8,
    borderRadius: 6,
    background: 'rgba(194, 65, 12, 0.08)',
    border: '1px solid rgba(194, 65, 12, 0.24)',
    color: '#9a3412',
    fontSize: 13,
  },
  footer: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: 8,
    marginTop: 4,
  },
  cancelBtn: {
    padding: '8px 14px',
    borderRadius: 999,
    border: '1px solid rgba(184, 112, 90, 0.24)',
    background: '#fff',
    color: 'var(--color-text)',
    fontSize: 14,
    cursor: 'pointer',
  },
  submitBtn: {
    padding: '8px 16px',
    borderRadius: 999,
    border: 'none',
    background: 'var(--color-primary)',
    color: '#fff',
    fontSize: 14,
    fontWeight: 600,
    cursor: 'pointer',
  },
}
