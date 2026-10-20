import type {
  CheckInAttachment,
  CheckInRenderedA2uiSchema,
  CheckInRenderedBlock,
  CheckInRenderedKeyValueItem,
  CheckInRenderedMetricItem,
} from '@health-agent/shared'

function isRenderedSchema(value: unknown): value is CheckInRenderedA2uiSchema {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return record.kind === 'check_in_record' && Array.isArray(record.blocks)
}

function statusColor(status?: string): string {
  if (status === 'critical') return '#b91c1c'
  if (status === 'abnormal') return '#c2410c'
  if (status === 'normal') return '#15803d'
  return 'var(--color-primary-dark)'
}

function MetricGrid({ items }: { items: CheckInRenderedMetricItem[] }) {
  if (!items.length) return null
  return (
    <div style={styles.metricGrid}>
      {items.map((item) => (
        <div key={item.key} style={styles.metricItem}>
          <span style={styles.metricLabel}>{item.label}</span>
          <strong style={{ ...styles.metricValue, color: statusColor(item.status) }}>
            {item.value}{item.unit ? <small style={styles.metricUnit}>{item.unit}</small> : null}
          </strong>
        </div>
      ))}
    </div>
  )
}

function KvList({ items }: { items: CheckInRenderedKeyValueItem[] }) {
  if (!items.length) return null
  return (
    <div style={styles.kvList}>
      {items.map((item) => (
        <div key={item.key} style={styles.kvRow}>
          <span style={styles.kvLabel}>{item.label}</span>
          <span style={styles.kvValue}>{item.value}</span>
        </div>
      ))}
    </div>
  )
}

function ImageGallery({ images }: { images: CheckInAttachment[] }) {
  if (!images.length) return null
  return (
    <div style={styles.imageGrid}>
      {images.map((image, index) => (
        <img
          key={`${image.url}-${index}`}
          src={image.url}
          alt={image.name ?? `打卡图片 ${index + 1}`}
          style={styles.image}
        />
      ))}
    </div>
  )
}

function renderBlock(block: CheckInRenderedBlock, index: number) {
  if (block.type === 'metric_grid') return <MetricGrid key={index} items={block.items} />
  if (block.type === 'kv_list') return <KvList key={index} items={block.items} />
  if (block.type === 'note') return <p key={index} style={styles.note}>{block.text}</p>
  if (block.type === 'image_gallery') return <ImageGallery key={index} images={block.images} />
  if (block.type === 'tags') {
    return (
      <div key={index} style={styles.tags}>
        {block.items.map((item) => <span key={item} style={styles.tag}>{item}</span>)}
      </div>
    )
  }
  return null
}

export default function A2uiSchemaRenderer({
  schema,
}: {
  schema: unknown
}) {
  if (!isRenderedSchema(schema)) return null
  return (
    <article style={styles.card}>
      <div style={styles.header}>
        <div>
          <h3 style={styles.title}>{schema.title}</h3>
        </div>
      </div>
      <div style={styles.blocks}>
        {schema.blocks.map((block, index) => renderBlock(block, index))}
      </div>
    </article>
  )
}

const styles: Record<string, React.CSSProperties> = {
  card: {
    width: '100%',
    borderRadius: 8,
    border: '1px solid rgba(184, 112, 90, 0.18)',
    background: 'rgba(255, 250, 246, 0.92)',
    padding: 14,
    boxSizing: 'border-box',
  },
  header: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
    marginBottom: 12,
  },
  title: {
    margin: 0,
    fontSize: 16,
    lineHeight: '22px',
    color: 'var(--color-text)',
    letterSpacing: 0,
  },
  blocks: {
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  metricGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    gap: 8,
  },
  metricItem: {
    borderRadius: 8,
    background: '#fff',
    border: '1px solid rgba(184, 112, 90, 0.12)',
    padding: '10px 11px',
    minWidth: 0,
  },
  metricLabel: {
    display: 'block',
    fontSize: 12,
    lineHeight: '16px',
    color: 'var(--color-text-muted)',
    marginBottom: 4,
  },
  metricValue: {
    display: 'block',
    fontSize: 20,
    lineHeight: '26px',
    letterSpacing: 0,
    wordBreak: 'break-word',
  },
  metricUnit: {
    marginLeft: 2,
    fontSize: 12,
    fontWeight: 600,
  },
  kvList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  kvRow: {
    display: 'grid',
    gridTemplateColumns: '88px minmax(0, 1fr)',
    gap: 10,
    fontSize: 14,
    lineHeight: '20px',
  },
  kvLabel: {
    color: 'var(--color-text-muted)',
  },
  kvValue: {
    color: 'var(--color-text)',
    wordBreak: 'break-word',
    whiteSpace: 'pre-wrap',
  },
  note: {
    margin: 0,
    borderRadius: 8,
    background: '#fff',
    padding: '10px 11px',
    fontSize: 14,
    lineHeight: '22px',
    color: 'var(--color-text)',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
  tags: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 6,
  },
  tag: {
    borderRadius: 999,
    padding: '4px 8px',
    background: 'rgba(245, 166, 35, 0.12)',
    color: 'var(--color-primary-dark)',
    fontSize: 12,
    lineHeight: '16px',
  },
  imageGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
    gap: 6,
  },
  image: {
    width: '100%',
    aspectRatio: '1',
    borderRadius: 8,
    objectFit: 'cover',
    background: '#fff',
  },
}
