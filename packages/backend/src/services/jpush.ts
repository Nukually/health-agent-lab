import { getEnv } from '../env.js'
import type { Logger } from '../lib/logger.js'

export type JPushPlatform = 'android' | 'ios' | 'hmos'

export interface JPushSendInput {
  platforms: JPushPlatform[]
  registrationIds?: string[]
  aliases?: string[]
  title: string
  alert: string
  extras?: Record<string, string | number | boolean | null | undefined>
  timeToLiveSec?: number
  apnsProduction?: boolean
}

export interface JPushSendResult {
  sendno?: string
  msgId?: string
  raw: Record<string, unknown>
}

export interface JPushReportResult {
  endpoint: string
  ok: boolean
  status: number
  body: unknown
}

export class JPushDisabledError extends Error {
  constructor(message = 'JPush is disabled') {
    super(message)
    this.name = 'JPushDisabledError'
  }
}

export class JPushRequestError extends Error {
  status: number
  body: unknown

  constructor(status: number, body: unknown) {
    super(`JPush request failed: HTTP ${status}`)
    this.name = 'JPushRequestError'
    this.status = status
    this.body = body
  }
}

function compactExtras(extras?: JPushSendInput['extras']): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(extras ?? {})) {
    if (value == null) continue
    const str = String(value)
    if (!str) continue
    out[key] = str.slice(0, 500)
  }
  return out
}

function buildAudience(input: JPushSendInput): Record<string, string[]> {
  const audience: Record<string, string[]> = {}
  const registrationIds = [...new Set(input.registrationIds?.map((s) => s.trim()).filter(Boolean) ?? [])]
  const aliases = [...new Set(input.aliases?.map((s) => s.trim()).filter(Boolean) ?? [])]
  if (registrationIds.length > 0) audience.registration_id = registrationIds
  if (aliases.length > 0) audience.alias = aliases
  return audience
}

function normalizePlatforms(platforms: JPushPlatform[]): JPushPlatform[] {
  return [...new Set(platforms)].filter((platform): platform is JPushPlatform =>
    platform === 'android' || platform === 'ios' || platform === 'hmos',
  )
}

function getJPushAuth(env: ReturnType<typeof getEnv>): string {
  if (!env.JPUSH_APP_KEY || !env.JPUSH_MASTER_SECRET) {
    throw new JPushDisabledError('JPush credentials are not configured')
  }
  return Buffer.from(`${env.JPUSH_APP_KEY}:${env.JPUSH_MASTER_SECRET}`).toString('base64')
}

async function fetchJPushReport(
  path: string,
  init: RequestInit,
): Promise<JPushReportResult> {
  const env = getEnv()
  if (!env.JPUSH_ENABLED) {
    throw new JPushDisabledError()
  }

  const endpoint = `${env.JPUSH_REPORT_BASE_URL.replace(/\/$/, '')}${path}`
  const res = await fetch(endpoint, {
    ...init,
    headers: {
      Authorization: `Basic ${getJPushAuth(env)}`,
      ...(init.headers ?? {}),
    },
  })
  const body = await res.json().catch(() => null)
  return {
    endpoint,
    ok: res.ok,
    status: res.status,
    body,
  }
}

export async function queryJPushReceivedReport(msgIds: string[]): Promise<JPushReportResult | null> {
  const ids = [...new Set(msgIds.map((id) => id.trim()).filter(Boolean))].slice(0, 100)
  if (ids.length === 0) return null

  return fetchJPushReport(
    `/received?msg_ids=${encodeURIComponent(ids.join(','))}`,
    { method: 'GET' },
  )
}

export async function queryJPushMessageStatus(
  msgId: string,
  registrationIds: string[],
): Promise<JPushReportResult | null> {
  const ids = [...new Set(registrationIds.map((id) => id.trim()).filter(Boolean))].slice(0, 1000)
  const trimmedMsgId = msgId.trim()
  if (!/^\d+$/.test(trimmedMsgId) || ids.length === 0) return null

  const registrationIdsJson = ids.map((id) => JSON.stringify(id)).join(',')

  return fetchJPushReport('/status/message', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // JPush requires msg_id as a JSON number, but current msg IDs exceed
    // Number.MAX_SAFE_INTEGER. Build only this tiny payload manually to avoid
    // precision loss while keeping registration IDs JSON-escaped.
    body: `{"msg_id":${trimmedMsgId},"registration_ids":[${registrationIdsJson}]}`,
  })
}

export async function sendJPushNotification(
  input: JPushSendInput,
  logger: Logger,
): Promise<JPushSendResult> {
  const env = getEnv()
  if (!env.JPUSH_ENABLED) {
    throw new JPushDisabledError()
  }
  const auth = getJPushAuth(env)

  const audience = buildAudience(input)
  if (Object.keys(audience).length === 0) {
    throw new Error('JPush audience is empty')
  }

  const platforms = normalizePlatforms(input.platforms)
  if (platforms.length === 0) {
    throw new Error('JPush platform is empty')
  }

  const extras = compactExtras(input.extras)
  const notification: Record<string, unknown> = {}
  if (platforms.includes('android')) {
    notification.android = {
      title: input.title,
      alert: input.alert,
      // App 在前台时也展示通知。否则部分 Android/JPush 版本在前台只回调
      // onNotifyMessageArrived，不弹系统通知，表现为“前台收不到推送”。
      display_foreground: '1',
      extras,
    }
  }
  if (platforms.includes('ios')) {
    notification.ios = {
      alert: {
        title: input.title,
        body: input.alert,
      },
      sound: 'default',
      extras,
    }
  }
  if (platforms.includes('hmos')) {
    notification.hmos = {
      title: input.title,
      alert: input.alert,
      // HarmonyOS 厂商通道要求通知分类；IM 用于对话/提醒类消息。
      category: 'IM',
      // 通知消息；显式设置，避免走透传/静默分支。
      push_type: 0,
      // App 在前台时也展示通知，便于测试和对话提醒场景。
      display_foreground: '1',
      // 指定点击通知打开应用首页，业务路由仍放在 extras.route，由 Native 点击回调转给 H5。
      intent: { url: 'action.system.home' },
      extras,
    }
  }

  const payload = {
    platform: platforms,
    audience,
    notification,
    options: {
      time_to_live: input.timeToLiveSec ?? 86400,
      apns_production: input.apnsProduction ?? env.JPUSH_APNS_PRODUCTION,
    },
  }

  const res = await fetch(`${env.JPUSH_BASE_URL.replace(/\/$/, '')}/v3/push`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })

  const body = await res.json().catch(() => null)
  if (!res.ok) {
    logger.warn({ status: res.status, body }, 'JPush request failed')
    throw new JPushRequestError(res.status, body)
  }

  const raw = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  logger.info({
    msgId: raw.msg_id,
    sendno: raw.sendno,
    platforms,
    apnsProduction: payload.options.apns_production,
  }, 'JPush notification sent')
  return {
    sendno: raw.sendno == null ? undefined : String(raw.sendno),
    msgId: raw.msg_id == null ? undefined : String(raw.msg_id),
    raw,
  }
}
