import { randomUUID } from 'node:crypto'
import { getKV } from '../lib/redis.js'
import type { Logger } from '../lib/logger.js'

export type WsTicketPurpose = 'asr' | 'tts'

export interface WsTicketPayload {
  userId: string
  purpose: WsTicketPurpose
  issuedAt: string
}

export const WS_TICKET_TTL_SECONDS = 60

const WS_TICKET_KEY_PREFIX = 'ws_ticket:'

function keyFor(ticket: string): string {
  return `${WS_TICKET_KEY_PREFIX}${ticket}`
}

export async function issueWsTicket(
  userId: string,
  purpose: WsTicketPurpose,
  logger: Logger,
): Promise<string> {
  const kv = getKV()
  const ticket = randomUUID()
  const payload: WsTicketPayload = {
    userId,
    purpose,
    issuedAt: new Date().toISOString(),
  }

  await kv.set(keyFor(ticket), JSON.stringify(payload), WS_TICKET_TTL_SECONDS)
  logger.info({ userId, purpose, ttl: WS_TICKET_TTL_SECONDS }, 'ws ticket issued')
  return ticket
}

export async function consumeWsTicket(
  ticket: string,
  purpose: WsTicketPurpose,
  logger: Logger,
): Promise<WsTicketPayload | null> {
  const kv = getKV()
  const key = keyFor(ticket)
  const raw = await kv.get(key)

  if (!raw) {
    logger.warn({ purpose }, 'ws ticket missing or expired')
    return null
  }

  const deleted = await kv.delIfValue(key, raw)
  if (!deleted) {
    logger.warn({ purpose }, 'ws ticket already consumed')
    return null
  }

  let payload: WsTicketPayload
  try {
    payload = JSON.parse(raw) as WsTicketPayload
  } catch {
    logger.warn({ purpose }, 'ws ticket payload invalid')
    return null
  }

  if (payload.purpose !== purpose) {
    logger.warn({ userId: payload.userId, expected: purpose, actual: payload.purpose }, 'ws ticket purpose mismatch')
    return null
  }

  logger.info({ userId: payload.userId, purpose }, 'ws ticket consumed')
  return payload
}
