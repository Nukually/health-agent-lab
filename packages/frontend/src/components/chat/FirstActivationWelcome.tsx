import {
  FIRST_ACTIVATION_WELCOME_GREETING,
  FIRST_ACTIVATION_WELCOME_MESSAGE,
  FIRST_ACTIVATION_WELCOME_QUESTION_MEDICATION,
  FIRST_ACTIVATION_WELCOME_QUESTION_PRIMARY,
  FIRST_ACTIVATION_WELCOME_ROLE_DESCRIPTION,
  FIRST_ACTIVATION_WELCOME_SUGGESTION,
  FIRST_ACTIVATION_WELCOME_UPLOAD_HINT,
} from '@health-agent/shared'

interface Props {
  content: string
  streaming?: boolean
}

const SEGMENTS = [
  { key: 'greeting', text: FIRST_ACTIVATION_WELCOME_GREETING, separator: '' },
  { key: 'role', text: FIRST_ACTIVATION_WELCOME_ROLE_DESCRIPTION, separator: '\n\n' },
  { key: 'suggestion', text: FIRST_ACTIVATION_WELCOME_SUGGESTION, separator: '\n\n' },
  { key: 'questionPrimary', text: FIRST_ACTIVATION_WELCOME_QUESTION_PRIMARY, separator: '\n\n' },
  { key: 'questionMedication', text: FIRST_ACTIVATION_WELCOME_QUESTION_MEDICATION, separator: '\n' },
  { key: 'uploadHint', text: FIRST_ACTIVATION_WELCOME_UPLOAD_HINT, separator: '\n\n' },
] as const

type SegmentKey = (typeof SEGMENTS)[number]['key']

function getVisibleSegmentMap(content: string): Record<SegmentKey, string> {
  let remaining = Math.max(0, Math.min(content.length, FIRST_ACTIVATION_WELCOME_MESSAGE.length))
  const result = {
    greeting: '',
    role: '',
    suggestion: '',
    questionPrimary: '',
    questionMedication: '',
    uploadHint: '',
  } satisfies Record<SegmentKey, string>

  for (const segment of SEGMENTS) {
    if (remaining <= 0) break

    const separatorVisible = Math.min(remaining, segment.separator.length)
    remaining -= separatorVisible
    if (remaining <= 0) break

    const visibleTextLength = Math.min(remaining, segment.text.length)
    result[segment.key] = segment.text.slice(0, visibleTextLength)
    remaining -= visibleTextLength
  }

  return result
}

export default function FirstActivationWelcome({ content, streaming = false }: Props) {
  const visible = getVisibleSegmentMap(content)
  const lastVisibleKey = (Object.keys(visible) as SegmentKey[]).reverse().find((key) => visible[key])

  return (
    <div style={styles.wrapper}>
      {visible.greeting && (
        <div style={styles.greeting}>
          {visible.greeting}
          {streaming && lastVisibleKey === 'greeting' && <span style={styles.cursor}>▊</span>}
        </div>
      )}

      {visible.role && (
        <div style={styles.description}>
          {visible.role}
          {streaming && lastVisibleKey === 'role' && <span style={styles.cursor}>▊</span>}
        </div>
      )}

      {visible.suggestion && (
        <div style={styles.note}>
          {visible.suggestion}
          {streaming && lastVisibleKey === 'suggestion' && <span style={styles.cursor}>▊</span>}
        </div>
      )}

      {(visible.questionPrimary || visible.questionMedication) && (
        <div style={styles.list}>
          {visible.questionPrimary && (
            <div style={styles.listItem}>
              <div style={styles.listIcon}>✓</div>
              <div style={styles.listText}>
                {visible.questionPrimary}
                {streaming && lastVisibleKey === 'questionPrimary' && <span style={styles.cursor}>▊</span>}
              </div>
            </div>
          )}
          {visible.questionMedication && (
            <div style={styles.listItem}>
              <div style={styles.listIcon}>✓</div>
              <div style={styles.listText}>
                {visible.questionMedication}
                {streaming && lastVisibleKey === 'questionMedication' && <span style={styles.cursor}>▊</span>}
              </div>
            </div>
          )}
        </div>
      )}

      {visible.uploadHint && (
        <div style={styles.uploadHint}>
          <div style={styles.uploadIcon}>○</div>
          <div style={styles.uploadText}>
            {visible.uploadHint}
            {streaming && lastVisibleKey === 'uploadHint' && <span style={styles.cursor}>▊</span>}
          </div>
        </div>
      )}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  wrapper: {
    display: 'flex',
    flexDirection: 'column',
    gap: 14,
    marginTop: 2,
  },
  greeting: {
    fontSize: 16,
    lineHeight: 1.5,
    fontWeight: 650,
    color: 'var(--color-text)',
    whiteSpace: 'nowrap',
  },
  description: {
    fontSize: 15,
    lineHeight: 1.8,
    color: 'var(--color-text-secondary)',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
  note: {
    fontSize: 14,
    lineHeight: 1.7,
    color: 'var(--color-text)',
    fontWeight: 500,
    padding: '10px 12px',
    borderRadius: 14,
    background: 'rgba(255, 248, 243, 0.92)',
  },
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  },
  listItem: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 10,
  },
  listIcon: {
    flexShrink: 0,
    color: 'var(--color-primary)',
    fontSize: 15,
    fontWeight: 700,
    lineHeight: '24px',
  },
  listText: {
    flex: 1,
    fontSize: 15,
    lineHeight: 1.7,
    color: 'var(--color-text)',
    wordBreak: 'break-word',
  },
  uploadHint: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 10,
  },
  uploadIcon: {
    flexShrink: 0,
    color: 'var(--color-primary)',
    fontWeight: 700,
    fontSize: 16,
    lineHeight: '24px',
  },
  uploadText: {
    flex: 1,
    minWidth: 0,
    fontSize: 14,
    lineHeight: 1.75,
    color: 'var(--color-text-secondary)',
    wordBreak: 'break-word',
  },
  cursor: {
    display: 'inline-block',
    color: 'var(--color-text-muted)',
    animation: 'blink 1s step-end infinite',
    marginLeft: 2,
  },
}
