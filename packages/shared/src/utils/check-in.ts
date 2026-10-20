export function resolveCheckInCardTitle(input: {
  titleTemplate?: string | null
  categoryName?: string | null
}): string {
  const fallback = input.categoryName?.trim() || '打卡记录'
  const template = input.titleTemplate?.trim() || fallback
  if (/\{[^{}]+\}/.test(template)) return fallback
  return template
}
