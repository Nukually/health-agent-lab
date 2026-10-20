import { Hono } from 'hono'
import { z } from 'zod'
import { authMiddleware } from '../middleware/auth.js'
import { recordConsent, listConsents } from '../services/consent.js'
import { CONSENT_VERSIONS } from '@health-agent/shared'

const consentRoutes = new Hono()

consentRoutes.use('*', authMiddleware)

const acceptSchema = z.object({
  type: z.enum(['login_agreement', 'health_profile']),
  version: z.string().min(1).max(16),
})

// POST /api/auth/accept-consent — 记录一次授权
consentRoutes.post('/accept-consent', async (c) => {
  const logger = c.get('logger')
  const userId = c.get('userId')
  const body = await c.req.json().catch(() => ({}))

  const parsed = acceptSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ success: false, error: parsed.error.issues[0].message }, 400)
  }

  const { type, version } = parsed.data
  // 版本需与当前前端常量匹配，防止被篡改或老客户端写入过期版本
  if (version !== CONSENT_VERSIONS[type]) {
    logger.warn({ type, version, expected: CONSENT_VERSIONS[type] }, 'consent version mismatch')
    return c.json({ success: false, error: '协议版本不匹配，请刷新页面重试' }, 400)
  }

  const ipAddress =
    c.req.header('x-forwarded-for')?.split(',')[0].trim() ||
    c.req.header('x-real-ip') ||
    undefined
  const userAgent = c.req.header('user-agent') || undefined

  await recordConsent(userId, type, version, { ipAddress, userAgent }, logger)
  return c.json({ success: true })
})

// GET /api/auth/consents — 查询当前用户授权记录
consentRoutes.get('/consents', async (c) => {
  const userId = c.get('userId')
  const consents = await listConsents(userId)
  return c.json({ success: true, data: { consents } })
})

export default consentRoutes
