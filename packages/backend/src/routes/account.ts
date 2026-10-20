/**
 * Account Routes — 账号相关操作
 *
 * /api/account/status                    — 查询注销状态（用于登录后判断是否跳撤销页）
 * /api/account/deletion/send-code        — 发送注销确认短信
 * /api/account/deletion/confirm          — 校验 code + 进入冷静期
 * /api/account/deletion/cancel           — 冷静期内撤销
 * /api/account/medical/send-code         — 发送清档案短信
 * /api/account/medical/purge             — 校验 code + 立即清除健康档案
 */

import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { authMiddleware } from '../middleware/auth.js'
import { rateLimitMiddleware } from '../middleware/rate-limit.js'
import {
  isVerificationCodeResendTooSoonError,
  sendVerificationCode,
  verifyCode,
} from '../services/sms.js'
import {
  requestAccountDeletion,
  cancelAccountDeletion,
  getAccountStatus,
  purgeMedicalData,
} from '../services/account-deletion.js'

const accountRoutes = new Hono()

accountRoutes.use('*', authMiddleware)

const codeSchema = z.object({ code: z.string().regex(/^\d{3,6}$/, '请输入正确的验证码') })

function resendTooSoonResponse(c: Context, retryAfterSeconds: number) {
  c.header('Retry-After', String(retryAfterSeconds))
  return c.json({
    success: false,
    error: '验证码已发送，请 60 秒后再试',
    code: 'SMS_CODE_RESEND_TOO_SOON',
    retryAfterSeconds,
  }, 429)
}

// GET /api/account/status
accountRoutes.get('/status', async (c) => {
  const userId = c.get('userId')
  const info = await getAccountStatus(userId)
  if (!info) return c.json({ success: false, error: '用户不存在' }, 404)
  return c.json({
    success: true,
    data: {
      status: info.status,
      deletionRequestedAt: info.deletionRequestedAt?.toISOString() ?? null,
    },
  })
})

// ============ 账号注销 ============

// POST /api/account/deletion/send-code
accountRoutes.post(
  '/deletion/send-code',
  rateLimitMiddleware({ windowMs: 1_000, max: 1, keyPrefix: 'rl:acct-sms' }),
  async (c) => {
    const logger = c.get('logger')
    const userId = c.get('userId')
    const info = await getAccountStatus(userId)
    if (!info) return c.json({ success: false, error: '用户不存在' }, 404)
    try {
      await sendVerificationCode(info.phone, logger)
    } catch (err) {
      if (isVerificationCodeResendTooSoonError(err)) {
        return resendTooSoonResponse(c, err.retryAfterSeconds)
      }
      throw err
    }
    return c.json({ success: true })
  },
)

// POST /api/account/deletion/confirm
accountRoutes.post(
  '/deletion/confirm',
  rateLimitMiddleware({
    windowMs: 60_000,
    max: 5,
    keyPrefix: 'rl:acct-delete-confirm',
    keyExtractor: (c) => c.get('userId'),
  }),
  async (c) => {
    const logger = c.get('logger')
    const userId = c.get('userId')
    const body = await c.req.json()
    const parsed = codeSchema.safeParse(body)
    if (!parsed.success) {
      return c.json({ success: false, error: parsed.error.issues[0].message }, 400)
    }

    const info = await getAccountStatus(userId)
    if (!info) return c.json({ success: false, error: '用户不存在' }, 404)

    const ok = await verifyCode(info.phone, parsed.data.code, logger)
    if (!ok) return c.json({ success: false, error: '验证码错误或已过期' }, 400)

    await requestAccountDeletion(userId, logger)
    return c.json({ success: true, data: { deletionRequestedAt: new Date().toISOString() } })
  },
)

// POST /api/account/deletion/cancel
accountRoutes.post('/deletion/cancel', async (c) => {
  const logger = c.get('logger')
  const userId = c.get('userId')
  await cancelAccountDeletion(userId, logger)
  return c.json({ success: true })
})

// ============ 健康档案清理 ============

// POST /api/account/medical/send-code
accountRoutes.post(
  '/medical/send-code',
  rateLimitMiddleware({ windowMs: 1_000, max: 1, keyPrefix: 'rl:acct-sms' }),
  async (c) => {
    const logger = c.get('logger')
    const userId = c.get('userId')
    const info = await getAccountStatus(userId)
    if (!info) return c.json({ success: false, error: '用户不存在' }, 404)
    try {
      await sendVerificationCode(info.phone, logger)
    } catch (err) {
      if (isVerificationCodeResendTooSoonError(err)) {
        return resendTooSoonResponse(c, err.retryAfterSeconds)
      }
      throw err
    }
    return c.json({ success: true })
  },
)

// POST /api/account/medical/purge
accountRoutes.post(
  '/medical/purge',
  rateLimitMiddleware({
    windowMs: 60_000,
    max: 5,
    keyPrefix: 'rl:acct-medical-purge',
    keyExtractor: (c) => c.get('userId'),
  }),
  async (c) => {
    const logger = c.get('logger')
    const userId = c.get('userId')
    const body = await c.req.json()
    const parsed = codeSchema.safeParse(body)
    if (!parsed.success) {
      return c.json({ success: false, error: parsed.error.issues[0].message }, 400)
    }

    const info = await getAccountStatus(userId)
    if (!info) return c.json({ success: false, error: '用户不存在' }, 404)

    const ok = await verifyCode(info.phone, parsed.data.code, logger)
    if (!ok) return c.json({ success: false, error: '验证码错误或已过期' }, 400)

    await purgeMedicalData(userId, logger)
    return c.json({ success: true })
  },
)

export default accountRoutes
