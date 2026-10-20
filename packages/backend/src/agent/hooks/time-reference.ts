const SHANGHAI_TIME_ZONE = 'Asia/Shanghai'
const WEEKDAYS = ['星期天', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']

type TextContent = string | Array<{ type: string; text?: string }>

const shanghaiDateFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: SHANGHAI_TIME_ZONE,
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
})

const lunarDateFormatter = new Intl.DateTimeFormat('zh-CN-u-ca-chinese', {
  timeZone: SHANGHAI_TIME_ZONE,
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
})

function textOf(content: TextContent): string {
  if (typeof content === 'string') return content
  return content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

function shanghaiToday(now: Date): Date {
  const parts = shanghaiDateFormatter.formatToParts(now)
  const year = Number(parts.find((part) => part.type === 'year')?.value)
  const month = Number(parts.find((part) => part.type === 'month')?.value)
  const day = Number(parts.find((part) => part.type === 'day')?.value)
  return new Date(Date.UTC(year, month - 1, day))
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date)
  next.setUTCDate(next.getUTCDate() + days)
  return next
}

function addMonths(date: Date, months: number): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1))
}

function formatDate(date: Date): string {
  return `${date.getUTCFullYear()}年${date.getUTCMonth() + 1}月${date.getUTCDate()}日 ${WEEKDAYS[date.getUTCDay()]}`
}

function formatMonth(date: Date): string {
  return `${date.getUTCFullYear()}年${date.getUTCMonth() + 1}月`
}

function weekMonday(date: Date): Date {
  const weekday = date.getUTCDay()
  return addDays(date, -(weekday === 0 ? 6 : weekday - 1))
}

function weekdayInRelativeWeek(today: Date, offsetWeeks: number, targetWeekday: number): Date {
  const monday = addDays(weekMonday(today), offsetWeeks * 7)
  return addDays(monday, targetWeekday === 0 ? 6 : targetWeekday - 1)
}

function weekRange(today: Date, offsetWeeks: number): string {
  const monday = addDays(weekMonday(today), offsetWeeks * 7)
  return `${formatDate(monday)} 至 ${formatDate(addDays(monday, 6))}`
}

function lunarParts(date: Date): { month: string; day: number } {
  const parts = lunarDateFormatter.formatToParts(date)
  return {
    month: parts.find((part) => part.type === 'month')?.value ?? '',
    day: Number(parts.find((part) => part.type === 'day')?.value),
  }
}

function findLunarDate(year: number, lunarMonth: string, lunarDay: number): Date | null {
  const date = new Date(Date.UTC(year, 0, 1))
  while (date.getUTCFullYear() === year) {
    const parts = lunarParts(date)
    if (parts.month === lunarMonth && parts.day === lunarDay) return new Date(date)
    date.setUTCDate(date.getUTCDate() + 1)
  }
  return null
}

function qingming(year: number): Date {
  const yy = year % 100
  const day = Math.floor(yy * 0.2422 + 4.81) - Math.floor(yy / 4)
  return new Date(Date.UTC(year, 3, day))
}

function nthWeekdayOfMonth(year: number, month: number, weekday: number, nth: number): Date {
  const first = new Date(Date.UTC(year, month - 1, 1))
  const offset = (weekday - first.getUTCDay() + 7) % 7
  return new Date(Date.UTC(year, month - 1, 1 + offset + (nth - 1) * 7))
}

function festivalYear(text: string, festival: RegExp, currentYear: number): { year: number; prefix: string } {
  const name = festival.source
  if (new RegExp(`(?:明年|下一年|下年).{0,2}(?:${name})|(?:${name}).{0,2}(?:明年|下一年|下年)`).test(text)) {
    return { year: currentYear + 1, prefix: '明年' }
  }
  if (new RegExp(`(?:去年|上一年|上年).{0,2}(?:${name})|(?:${name}).{0,2}(?:去年|上一年|上年)`).test(text)) {
    return { year: currentYear - 1, prefix: '去年' }
  }
  return { year: currentYear, prefix: '今年' }
}

function addLine(lines: string[], seen: Set<string>, key: string, line: string): void {
  if (seen.has(key)) return
  seen.add(key)
  lines.push(line)
}

function parseChineseDayCount(value: string): number | null {
  const digits: Record<string, number> = {
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  }
  if (value === '十') return 10
  const tenIndex = value.indexOf('十')
  if (tenIndex < 0) return digits[value] ?? null

  const beforeTen = value.slice(0, tenIndex)
  const afterTen = value.slice(tenIndex + 1)
  const tens = beforeTen ? digits[beforeTen] : 1
  const ones = afterTen ? digits[afterTen] : 0
  return tens && ones != null ? tens * 10 + ones : null
}

function parseDayCount(value: string): number | null {
  if (/^\d+$/.test(value)) {
    const count = Number(value)
    return Number.isSafeInteger(count) && count > 0 ? count : null
  }
  return parseChineseDayCount(value)
}

export function buildTimeReferenceReminder(content: TextContent, now = new Date()): string | null {
  const text = textOf(content)
  if (!text.trim()) return null

  const today = shanghaiToday(now)
  const lines: string[] = []
  const seen = new Set<string>()

  for (const [label, pattern, offset] of [
    ['大前天', /大前天/, -3],
    ['前天', /(?:^|[^大])前天/, -2],
    ['昨天', /昨天|昨日/, -1],
    ['今天', /今天|今日/, 0],
    ['明天', /明天|明日/, 1],
    ['后天', /(?:^|[^大])后天/, 2],
    ['大后天', /大后天/, 3],
  ] as const) {
    if (label === '今天') continue
    if (pattern.test(text)) addLine(lines, seen, label, `${label}：${formatDate(addDays(today, offset))}`)
  }

  for (const match of text.matchAll(/(\d+|[一二两三四五六七八九十]{1,3})\s*天(?:之)?(前|后)/g)) {
    const count = parseDayCount(match[1])
    if (!count) continue
    const label = `${match[1]}天${match[2]}`
    const offset = match[2] === '前' ? -count : count
    addLine(lines, seen, `day-offset:${offset}`, `${label}：${formatDate(addDays(today, offset))}`)
  }

  for (const [label, pattern, offset] of [
    ['上个月', /上个月|上月|上个自然月/, -1],
    ['这个月', /这个月|本月|当月/, 0],
    ['下个月', /下个月|下月|下个自然月/, 1],
  ] as const) {
    if (pattern.test(text)) addLine(lines, seen, label, `${label}：${formatMonth(addMonths(today, offset))}`)
  }

  for (const [label, pattern, offset] of [
    ['上一年', /上一年|上年|去年/, -1],
    ['今年', /今年|本年/, 0],
    ['下一年', /下一年|下年|明年/, 1],
  ] as const) {
    if (pattern.test(text)) addLine(lines, seen, label, `${label}：${today.getUTCFullYear() + offset}年`)
  }

  const weekGroups = [
    ['上周', /上(?:周|星期|礼拜)/, -1],
    ['这周', /(?:这|本)(?:周|星期|礼拜)/, 0],
    ['下周', /下(?:周|星期|礼拜)/, 1],
  ] as const
  const weekdays = [
    ['一', /[一1]/, 1],
    ['二', /[二2]/, 2],
    ['三', /[三3]/, 3],
    ['四', /[四4]/, 4],
    ['五', /[五5]/, 5],
    ['六', /[六6]/, 6],
    ['日', /[日天7]/, 0],
  ] as const
  for (const [weekLabel, weekPattern, offset] of weekGroups) {
    for (const [dayLabel, dayPattern, weekday] of weekdays) {
      if (!new RegExp(`${weekPattern.source}${dayPattern.source}`).test(text)) continue
      const label = `${weekLabel}${dayLabel}`
      addLine(lines, seen, label, `${label}：${formatDate(weekdayInRelativeWeek(today, offset, weekday))}`)
    }
  }
  for (const [label, pattern, offset] of [
    ['上周', /上周|上星期|上礼拜/, -1],
    ['这周', /这周|本周|这星期|本星期|这礼拜|本礼拜/, 0],
    ['下周', /下周|下星期|下礼拜/, 1],
  ] as const) {
    if (pattern.test(text)) addLine(lines, seen, label, `${label}：${weekRange(today, offset)}`)
  }

  const lunar = (month: string, day: number) => (year: number) => findLunarDate(year, month, day)
  const festivals: Array<[string, RegExp, (year: number) => Date | null]> = [
    ['元旦', /元旦/, (year) => new Date(Date.UTC(year, 0, 1))],
    ['春节', /春节|过年|农历新年/, lunar('正月', 1)],
    ['除夕', /除夕|年三十|大年三十/, (year) => {
      const springFestival = findLunarDate(year, '正月', 1)
      return springFestival ? addDays(springFestival, -1) : null
    }],
    ['元宵', /元宵|元宵节/, lunar('正月', 15)],
    ['情人节', /情人节/, (year) => new Date(Date.UTC(year, 1, 14))],
    ['妇女节', /妇女节|三八节/, (year) => new Date(Date.UTC(year, 2, 8))],
    ['清明', /清明|清明节/, qingming],
    ['劳动节', /劳动节|五一/, (year) => new Date(Date.UTC(year, 4, 1))],
    ['母亲节', /母亲节/, (year) => nthWeekdayOfMonth(year, 5, 0, 2)],
    ['儿童节', /儿童节|六一/, (year) => new Date(Date.UTC(year, 5, 1))],
    ['父亲节', /父亲节/, (year) => nthWeekdayOfMonth(year, 6, 0, 3)],
    ['端午', /端午|端午节/, lunar('五月', 5)],
    ['七夕', /七夕|七夕节/, lunar('七月', 7)],
    ['中秋', /中秋|中秋节/, lunar('八月', 15)],
    ['国庆', /国庆|国庆节/, (year) => new Date(Date.UTC(year, 9, 1))],
    ['重阳', /重阳|重阳节/, lunar('九月', 9)],
    ['圣诞', /圣诞|圣诞节/, (year) => new Date(Date.UTC(year, 11, 25))],
    ['腊八', /腊八|腊八节/, lunar('腊月', 8)],
  ]
  for (const [label, pattern, resolveDate] of festivals) {
    if (!pattern.test(text)) continue
    const target = festivalYear(text, pattern, today.getUTCFullYear())
    const date = resolveDate(target.year)
    if (date) addLine(lines, seen, label, `${label}：${target.prefix}${label}是 ${formatDate(date)}`)
  }

  return lines.length > 0 ? lines.join('\n') : null
}
