export function formatMessageTimestamp(ts: string | number | Date): string {
  const d = new Date(ts)
  const time = formatLocalTime(d, true)

  if (!isSameLocalDate(d, new Date())) {
    return `${formatLocalDate(d)} ${time}`
  }

  return time
}

export function formatDateAwareTimestamp(
  ts: string | number | Date,
  options: { includeSeconds?: boolean } = {},
): string {
  const d = new Date(ts)
  const time = formatLocalTime(d, options.includeSeconds ?? true)

  if (!isSameLocalDate(d, new Date())) {
    return `${formatLocalDate(d)} ${time}`
  }

  return time
}

function isSameLocalDate(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

function formatLocalDate(d: Date): string {
  const m = d.getMonth() + 1
  const day = d.getDate()
  return `${d.getFullYear()}-${pad2(m)}-${pad2(day)}`
}

function formatLocalTime(d: Date, includeSeconds: boolean): string {
  const parts = [d.getHours(), d.getMinutes()]
  if (includeSeconds) parts.push(d.getSeconds())
  return parts.map(pad2).join(':')
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}
