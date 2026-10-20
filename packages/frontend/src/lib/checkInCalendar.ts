function padDatePart(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

export function dayKeyOf(value: string | Date): string {
  const date = typeof value === 'string' ? new Date(value) : value
  if (Number.isNaN(date.getTime())) return ''
  return `${date.getFullYear()}-${padDatePart(date.getMonth() + 1)}-${padDatePart(date.getDate())}`
}

export function isFutureCalendarDay(dateKey: string, todayKey: string): boolean {
  return dateKey > todayKey
}

export function calendarRecordMarker(count: number): string | null {
  if (count <= 0) return null
  return count === 1 ? '✓' : String(count)
}

export function monthKeyOf(value: string | Date): string {
  const dayKey = dayKeyOf(value)
  return dayKey ? dayKey.slice(0, 7) : ''
}

export function shiftCalendarMonth(monthKey: string, delta: number): string {
  const match = /^(\d{4})-(\d{2})$/.exec(monthKey)
  const base = match ? new Date(Number(match[1]), Number(match[2]) - 1, 1) : new Date()
  base.setMonth(base.getMonth() + delta)
  return `${base.getFullYear()}-${padDatePart(base.getMonth() + 1)}`
}

export function resolveCalendarMonth(selectedDay: string, todayKey: string): string {
  return monthKeyOf(selectedDay) || monthKeyOf(todayKey)
}

export function resolveSelectedDayForMonth(
  monthKey: string,
  selectedDay: string,
  recordDayKeys: string[],
): string {
  if (selectedDay && monthKeyOf(selectedDay) === monthKey) return selectedDay
  const recordInMonth = recordDayKeys.find((dayKey) => monthKeyOf(dayKey) === monthKey)
  return recordInMonth ?? `${monthKey}-01`
}

export function resolveSelectedCalendarDay(
  selectedDay: string,
  recordDayKeys: string[],
  todayKey: string,
): string {
  if (selectedDay) return selectedDay
  return recordDayKeys.find(Boolean) ?? todayKey
}
