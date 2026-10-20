import type { MedicalLiteratureSource } from '@health-agent/shared'

interface Props {
  source: MedicalLiteratureSource | null
  onClose: () => void
}

interface ContentProps {
  source: MedicalLiteratureSource
  onClose?: () => void
}

function normalizeMedicalLiteratureChunkContent(content: string): string {
  return content
    .replace(/\\(?:mathrm|text)\s*\{\s*([^{}]+?)\s*\}/g, (_, inner: string) => {
      const trimmed = inner.trim()
      return /^[A-Za-z\s]+$/.test(trimmed) ? trimmed.replace(/\s+/g, '') : trimmed
    })
    .replace(/\\leqslant|\\leq|\\le/g, '≤')
    .replace(/\\geqslant|\\geq|\\ge/g, '≥')
    .replace(/\\times/g, '×')
    .replace(/\\pm/g, '±')
    .replace(/\\approx/g, '≈')
    .replace(/\\neq/g, '≠')
    .replace(/\\cdot/g, '·')
    .replace(/\\mu/g, 'μ')
    .replace(/\\%/g, '%')
    .replace(/\\(?:left|right)\s*/g, '')
    .replace(/\\[,;:!]\s*/g, ' ')
    .replace(/([\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])/g, '$1')
    .replace(/\/\?+\s*mm\s*3\b/gi, '/mm³')
    .replace(/\/\s*mm\s*\^?\s*3\b/gi, '/mm³')
    .replace(/\b(\d(?:\s+\d)+)\s*(kg|mg|g|μg|ug|mm|cm|mL|ml|L|%)\b/g, (_, digits: string, unit: string) => `${digits.replace(/\s+/g, '')}${unit}`)
    .replace(/\s*(【[^】]{1,24}】)\s*/g, '\n$1\n')
    .replace(/(^|[\n。；;])\s*([（(][1-9]\d{0,1}[）)])\s*/g, (_, prefix: string, index: string) => `${prefix}\n${index} `)
    .replace(/(^|[\n。；;])\s*([1-9]\d{0,1})\.(?=\D)/g, (_, prefix: string, index: string) => `${prefix}\n${index}.`)
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function MedicalLiteratureSourceContent({ source, onClose }: ContentProps) {
  const meta = [
    source.journal,
    source.pubYear != null ? String(source.pubYear) : '',
    source.doi ? `DOI: ${source.doi}` : '',
  ].filter(Boolean)

  return (
    <>
      <div style={styles.header}>
        <div style={styles.titleWrap}>
          <div style={styles.eyebrow}>引用 [{source.id}]</div>
          <h3 style={styles.title}>{source.title}</h3>
          {source.articleClass && (
            <div style={styles.typeBadge}>
              <DocBadgeIcon />
              {source.articleClass}
            </div>
          )}
        </div>
        {onClose && (
          <button type="button" onClick={onClose} style={styles.closeBtn} aria-label="关闭资料详情">
            <span style={styles.closeIcon}>×</span>
          </button>
        )}
      </div>

      {meta.length > 0 && (
        <div style={styles.metaRow}>
          {meta.map((item) => (
            <span key={item} style={styles.metaItem}>{item}</span>
          ))}
        </div>
      )}

      <div style={styles.chunkList}>
        {source.chunks.map((chunk, index) => (
          <section key={`${chunk.sourceRank}-${index}`} style={styles.chunk}>
            <div style={styles.content}>{normalizeMedicalLiteratureChunkContent(chunk.content)}</div>
          </section>
        ))}
      </div>
    </>
  )
}

export default function MedicalLiteratureSourceDialog({ source, onClose }: Props) {
  if (!source) return null

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="医学资料详情"
        style={styles.modal}
        onClick={(event) => event.stopPropagation()}
      >
        <MedicalLiteratureSourceContent source={source} onClose={onClose} />
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed',
    inset: 0,
    zIndex: 3000,
    background: 'rgba(24, 24, 24, 0.42)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 22,
  },
  modal: {
    width: 'min(680px, 100%)',
    maxHeight: '80vh',
    overflow: 'auto',
    background: 'linear-gradient(180deg, #FFFDFC 0%, #FFF8F2 100%)',
    borderRadius: 24,
    padding: '22px 22px 24px',
    border: '1px solid rgba(226, 216, 207, 0.72)',
  },
  header: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 16,
  },
  titleWrap: {
    minWidth: 0,
    flex: 1,
  },
  eyebrow: {
    fontSize: 15,
    lineHeight: '22px',
    color: '#C66E50',
    fontWeight: 800,
    marginBottom: 8,
  },
  title: {
    margin: 0,
    color: 'var(--color-text)',
    fontSize: 24,
    lineHeight: '34px',
    fontWeight: 800,
    letterSpacing: 0,
  },
  typeBadge: {
    marginTop: 10,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '4px 8px',
    borderRadius: 12,
    color: '#C66E50',
    background: 'rgba(255, 241, 232, 0.92)',
    border: '1px solid rgba(232, 196, 176, 0.68)',
    fontSize: 12,
    lineHeight: '18px',
    fontWeight: 700,
  },
  closeBtn: {
    width: 46,
    height: 46,
    border: '1px solid rgba(232, 196, 176, 0.56)',
    borderRadius: 23,
    background: 'rgba(255, 252, 248, 0.9)',
    color: '#C66E50',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    flexShrink: 0,
    boxShadow: '0 8px 22px rgba(154, 102, 74, 0.08)',
    padding: 0,
  },
  closeIcon: {
    fontSize: 30,
    lineHeight: 1,
    display: 'block',
    transform: 'translateY(-1px)',
  },
  metaRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 12,
  },
  metaItem: {
    fontSize: 12,
    lineHeight: '18px',
    color: '#8F7D72',
    background: 'rgba(246, 239, 233, 0.86)',
    border: '1px solid rgba(232, 221, 212, 0.76)',
    borderRadius: 10,
    padding: '4px 8px',
  },
  chunkList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    marginTop: 14,
  },
  chunk: {
    borderTop: '1px solid rgba(226, 216, 207, 0.82)',
    paddingTop: 12,
  },
  content: {
    whiteSpace: 'pre-wrap',
    color: 'var(--color-text)',
    fontSize: 'var(--font-size-chat)',
    lineHeight: 1.82,
    wordBreak: 'break-word',
  },
}

function DocBadgeIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <path d="M8 13h8" />
      <path d="M8 17h5" />
    </svg>
  )
}
