export function parseDeviceName(ua: string | null | undefined): string {
  if (!ua) return '未知'
  if (/iPad/i.test(ua)) return 'iPad'
  if (/iPhone|iOS/i.test(ua)) return 'iOS'
  if (/Android/i.test(ua)) return 'Android'
  if (/Windows/i.test(ua)) return 'Windows'
  if (/Mac OS X/i.test(ua)) return 'macOS'
  if (/Linux/i.test(ua)) return 'Linux'
  return '其他'
}
