import { eq } from 'drizzle-orm'
import { isFeatureEnabled } from '@health-agent/shared'
import { getConnInfo } from '@hono/node-server/conninfo'
import { createMiddleware } from 'hono/factory'
import { getEnv } from '../env.js'
import { getDb } from '../db/client.js'
import { users } from '../db/schema/index.js'
import { getBackendFeatureSnapshot } from '../features.js'

function normalizeIp(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return ''
  if (trimmed.startsWith('::ffff:')) {
    return trimmed.slice('::ffff:'.length)
  }
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed.slice(1, -1)
  }
  const ipv4WithPort = trimmed.match(/^(\d+\.\d+\.\d+\.\d+):\d+$/)
  if (ipv4WithPort) return ipv4WithPort[1]
  return trimmed
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part) || part < 0 || part > 255)) {
    return false
  }
  if (parts[0] === 10) return true
  if (parts[0] === 127) return true
  if (parts[0] === 192 && parts[1] === 168) return true
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true
  if (parts[0] === 169 && parts[1] === 254) return true
  return false
}

function isPrivateIp(ip: string): boolean {
  const normalized = normalizeIp(ip)
  if (!normalized) return false
  if (normalized === '::1' || normalized === 'localhost') return true
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true
  if (normalized.startsWith('fe80:')) return true
  return isPrivateIpv4(normalized)
}

function extractClientIp(headers: Headers, fallbackIp?: string | null): string | null {
  const forwardedFor = headers.get('x-forwarded-for')
  if (forwardedFor) {
    const first = forwardedFor.split(',')[0]?.trim()
    if (first) return normalizeIp(first)
  }

  const realIp = headers.get('x-real-ip')
  if (realIp) return normalizeIp(realIp)

  const forwarded = headers.get('forwarded')
  if (forwarded) {
    const match = forwarded.match(/for="?([^;,\s"]+)/i)
    if (match?.[1]) return normalizeIp(match[1])
  }

  return fallbackIp ? normalizeIp(fallbackIp) : null
}

export const interventionEditorMiddleware = createMiddleware(async (c, next) => {
  const env = getEnv()
  const logger = c.get('logger')

  if (env.DEPLOY_ENV === 'local') {
    const connInfo = getConnInfo(c)
    const fallbackIp = connInfo.remote.address || null
    const clientIp = extractClientIp(c.req.raw.headers, fallbackIp)
    if (!clientIp || !isPrivateIp(clientIp)) {
      logger.warn({ clientIp }, 'intervention editor blocked: non-lan access')
      return c.json({ success: false, error: '仅允许局域网访问' }, 403)
    }
  }

  const userId = c.get('userId')
  const db = getDb()
  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { phone: true },
  })

  const features = getBackendFeatureSnapshot({
    userId,
    phone: user?.phone ?? null,
  })

  if (!isFeatureEnabled(features, 'materialUploadAdmin')) {
    logger.warn({ userId, phone: user?.phone ?? null }, 'intervention editor blocked: user not allowed')
    return c.json({ success: false, error: '无权限访问素材上传台' }, 403)
  }

  await next()
})
