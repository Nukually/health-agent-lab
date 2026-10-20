import { getKV } from '../lib/redis.js'
import type { Logger } from '../lib/logger.js'

const PREFIX = 'pending-system-reminders:session:'
const TTL_SECONDS = 60 * 60 * 24 * 7

function keyOf(sessionId: string): string {
  return `${PREFIX}${sessionId}`
}

function parseReminders(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
  } catch {
    return []
  }
}

export async function appendPendingSystemReminder(
  sessionId: string,
  reminder: string,
  logger: Logger,
): Promise<void> {
  const text = reminder.trim()
  if (!text) return

  try {
    const raw = await getKV().get(keyOf(sessionId))
    const existing = raw ? JSON.parse(raw) : []
    const next = Array.isArray(existing) ? existing : []
    next.push(text)
    await getKV().set(keyOf(sessionId), JSON.stringify(next), TTL_SECONDS)
    logger.info({ sessionId }, 'pending system reminder appended')
  } catch (err: any) {
    logger.warn({ sessionId, err: err.message }, 'append pending system reminder failed')
  }
}

export async function getPendingSystemReminders(
  sessionId: string,
  logger: Logger,
): Promise<string[]> {
  let raw: string | null = null
  try {
    raw = await getKV().get(keyOf(sessionId))
    if (!raw) return []
  } catch (err: any) {
    logger.warn({ sessionId, err: err.message }, 'get pending system reminders failed')
    return []
  }

  return parseReminders(raw)
}

export async function clearPendingSystemReminders(
  sessionId: string,
  logger: Logger,
): Promise<void> {
  try {
    await getKV().del(keyOf(sessionId))
  } catch (err: any) {
    logger.warn({ sessionId, err: err.message }, 'clear pending system reminders failed')
  }
}

export async function consumePendingSystemReminders(
  sessionId: string,
  logger: Logger,
): Promise<string[]> {
  const reminders = await getPendingSystemReminders(sessionId, logger)
  if (reminders.length > 0) {
    await clearPendingSystemReminders(sessionId, logger)
  }
  return reminders
}
