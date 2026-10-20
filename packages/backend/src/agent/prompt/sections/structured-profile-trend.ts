/**
 * 结构化档案近 7 天趋势 — 动态 section
 *
 * 行=字段、列=日期（D-6..D-0）的紧凑 Markdown 表格，
 * 让主 Agent 感知字段级变化趋势。字段由夜间 cron 个性化生成。
 */

export interface TrendSnapshot {
  profileDate: string
  fields: Record<string, unknown>
}

const MAX_CELL_LEN = 20

function renderCell(v: unknown): string {
  if (v === null || v === undefined) return '-'
  if (typeof v === 'boolean') return v ? '是' : '否'
  if (typeof v === 'number') return String(v)
  if (typeof v === 'string') {
    const s = v.trim()
    if (!s) return '-'
    return s.length > MAX_CELL_LEN ? s.slice(0, MAX_CELL_LEN) + '…' : s
  }
  if (Array.isArray(v)) {
    const s = v.map((x) => (x === null || x === undefined ? '' : String(x))).filter(Boolean).join('/')
    return s.length > MAX_CELL_LEN ? s.slice(0, MAX_CELL_LEN) + '…' : s || '-'
  }
  if (typeof v === 'object') {
    const s = JSON.stringify(v)
    return s.length > MAX_CELL_LEN ? s.slice(0, MAX_CELL_LEN) + '…' : s
  }
  return '-'
}

export function structuredProfileTrend(
  snapshots: TrendSnapshot[] | null | undefined,
): string {
  if (!snapshots || snapshots.length === 0) return ''

  const sorted = [...snapshots].sort((a, b) =>
    a.profileDate < b.profileDate ? -1 : a.profileDate > b.profileDate ? 1 : 0,
  )

  const fieldOrder: string[] = []
  const seen = new Set<string>()
  for (let i = sorted.length - 1; i >= 0; i--) {
    for (const key of Object.keys(sorted[i].fields)) {
      if (!seen.has(key)) {
        seen.add(key)
        fieldOrder.push(key)
      }
    }
  }

  if (fieldOrder.length === 0) return ''

  const header = ['字段', ...sorted.map((s) => s.profileDate)]
  const sep = header.map(() => '---')
  const rows = fieldOrder.map((key) => [
    key,
    ...sorted.map((s) => renderCell(s.fields[key])),
  ])

  const table = [header, sep, ...rows].map((r) => `| ${r.join(' | ')} |`).join('\n')

  return `## 近 ${sorted.length} 天治疗管理字段追踪\n（行=字段，列=日期；"-" 表示该日无记录。用于感知趋势，不要直接复述给用户。）\n\n${table}`
}
