import { Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { z } from 'zod'
import {
  CONSENT_VERSIONS,
  LOGIN_PHONE_ERROR_MESSAGE,
  hasCompleteUserProfile,
  isSupportedLoginPhone,
  normalizeLoginPhoneInput,
} from '@health-agent/shared'
import {
  isAliyunSmsSendError,
  isVerificationCodeResendTooSoonError,
  sendVerificationCode,
  verifyCode,
} from '../services/sms.js'
import {
  createRefreshSession,
  findOrCreateUser,
  findUserById,
  findUserByPhone,
  REFRESH_SESSION_TTL_SECONDS,
  REFRESH_TOKEN_COOKIE_NAME,
  refreshAccessSession,
  revokeRefreshSession,
  signToken,
  type AuthUser,
  type RefreshSessionMeta,
} from '../services/auth.js'
import { hasConsent, listConsents, recordConsent } from '../services/consent.js'
import { authMiddleware } from '../middleware/auth.js'
import { rateLimitMiddleware } from '../middleware/rate-limit.js'
import { getEnv } from '../env.js'
import { parseDeviceName } from '../lib/user-agent.js'
import { getUserChannelSourceInfo, resolveChannelAttribution } from '../services/channel.js'
import { getBackendFeatureSnapshotForUser } from '../features.js'

const authRoutes = new Hono()

const LOGIN_CONSENT_REQUIRED_ERROR = '请先阅读并同意《演示说明》与《数据处理说明》'
const LOGIN_CONSENT_TYPE = 'login_agreement'
const REFRESH_COOKIE_PATH = '/api/auth'

const phoneFieldSchema = z.string()
  .transform(normalizeLoginPhoneInput)
  .refine(isSupportedLoginPhone, LOGIN_PHONE_ERROR_MESSAGE)

const phoneSchema = z.object({
  phone: phoneFieldSchema,
})

const sendCodeSchema = phoneSchema

const loginSchema = z.object({
  phone: phoneFieldSchema,
  code: z.string().min(1, '请输入验证码'),
  agreementAccepted: z.boolean().optional().default(false),
  channelCode: z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/).optional(),
})

function getConsentMeta(c: { req: { header: (name: string) => string | undefined } }) {
  return {
    ipAddress:
      c.req.header('x-forwarded-for')?.split(',')[0].trim() ||
      c.req.header('x-real-ip') ||
      undefined,
    userAgent: c.req.header('user-agent') || undefined,
  }
}

function getRefreshMeta(c: { req: { header: (name: string) => string | undefined } }): RefreshSessionMeta {
  const userAgent = c.req.header('user-agent') ?? null
  return {
    deviceName: parseDeviceName(userAgent),
    userAgent,
  }
}

function setRefreshSessionCookie(
  c: Parameters<typeof setCookie>[0],
  token: string,
  expiresAt: Date,
) {
  setCookie(c, REFRESH_TOKEN_COOKIE_NAME, token, {
    path: REFRESH_COOKIE_PATH,
    httpOnly: true,
    secure: getEnv().NODE_ENV === 'production',
    sameSite: 'Lax',
    maxAge: REFRESH_SESSION_TTL_SECONDS,
    expires: expiresAt,
  })
}

function clearRefreshSessionCookie(c: Parameters<typeof deleteCookie>[0]) {
  deleteCookie(c, REFRESH_TOKEN_COOKIE_NAME, {
    path: REFRESH_COOKIE_PATH,
  })
}

async function buildAuthResponse(user: AuthUser, token: string, requireCompleteProfile: boolean) {
  const consents = await listConsents(user.id)
  const userSource = await getUserChannelSourceInfo(user.id)
  return {
    token,
    user: {
      id: user.id,
      phone: user.phone,
      nickname: user.nickname,
      avatarUrl: user.avatarUrl,
      birthday: user.birthday,
      gender: user.gender,
      currentConcern: user.currentConcern,
    },
    userSource,
    needsProfile: !user.currentConcern,
    requireCompleteProfile,
    consents,
    features: await getBackendFeatureSnapshotForUser({
      userId: user.id,
      phone: user.phone,
    }),
  }
}

// POST /api/auth/login-consent-status — 查询手机号是否已同意当前登录协议版本（保留给旧客户端/调试）
// 注意：只返回协议状态，不返回用户是否存在；配合限流降低枚举风险。
authRoutes.post(
  '/login-consent-status',
  rateLimitMiddleware({ windowMs: 1_000, max: 3, keyPrefix: 'rl:login-consent-status' }),
  async (c) => {
    const body = await c.req.json()

    const parsed = phoneSchema.safeParse(body)
    if (!parsed.success) {
      return c.json({ success: false, error: parsed.error.issues[0].message }, 400)
    }

    const user = await findUserByPhone(parsed.data.phone)
    const hasCurrentLoginConsent = user
      ? await hasConsent(user.id, LOGIN_CONSENT_TYPE, CONSENT_VERSIONS.login_agreement)
      : false

    return c.json({ success: true, data: { hasCurrentLoginConsent } })
  },
)

// POST /api/auth/send-code
authRoutes.post(
  '/send-code',
  rateLimitMiddleware({ windowMs: 1_000, max: 1, keyPrefix: 'rl:sms' }),
  async (c) => {
    const logger = c.get('logger')
    const body = await c.req.json()

    const parsed = sendCodeSchema.safeParse(body)
    if (!parsed.success) {
      return c.json({ success: false, error: parsed.error.issues[0].message }, 400)
    }

    try {
      await sendVerificationCode(parsed.data.phone, logger, { purpose: 'login' })
    } catch (err) {
      if (isVerificationCodeResendTooSoonError(err)) {
        c.header('Retry-After', String(err.retryAfterSeconds))
        return c.json({
          success: false,
          error: '操作过于频繁，请稍后再试',
          code: 'SMS_CODE_RESEND_TOO_SOON',
          retryAfterSeconds: err.retryAfterSeconds,
        }, 429)
      }

      // 不记录完整手机号；err 经 sms 服务包装为 AliyunSmsSendError（仅含错误码，无原始栈）。
      // 失败已写入冷却锁，retryAfterSeconds 透传给前端控制倒计时。
      const retryAfterSeconds = isAliyunSmsSendError(err) ? err.retryAfterSeconds : undefined
      logger.error(
        { err, aliyunCode: isAliyunSmsSendError(err) ? err.aliyunCode : undefined },
        'send verification code failed',
      )
      return c.json(
        {
          success: false,
          error: '短信发送失败，请稍后重试',
          ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
        },
        500,
      )
    }

    return c.json({ success: true })
  },
)

// POST /api/auth/login
authRoutes.post(
  '/login',
  rateLimitMiddleware({ windowMs: 1_000, max: 1, keyPrefix: 'rl:login' }),
  async (c) => {
    const logger = c.get('logger')
    const body = await c.req.json()

    const parsed = loginSchema.safeParse(body)
    if (!parsed.success) {
      return c.json({ success: false, error: parsed.error.issues[0].message }, 400)
    }

    const { phone, code, agreementAccepted, channelCode } = parsed.data
    if (!agreementAccepted) {
      return c.json({ success: false, error: LOGIN_CONSENT_REQUIRED_ERROR }, 400)
    }

    const valid = await verifyCode(phone, code, logger)
    if (!valid) {
      return c.json({ success: false, error: '验证码错误或已过期' }, 400)
    }

    const userAgent = c.req.header('user-agent') ?? null
    const channelAttribution = await resolveChannelAttribution(channelCode, logger)
    const user = await findOrCreateUser(phone, logger, {
      deviceName: parseDeviceName(userAgent),
      userAgent,
    }, channelAttribution, c.get('trackingContext'))
    await recordConsent(
      user.id,
      LOGIN_CONSENT_TYPE,
      CONSENT_VERSIONS.login_agreement,
      getConsentMeta(c),
      logger,
    )

    const token = signToken({ userId: user.id, phone: user.phone })
    const refreshSession = await createRefreshSession(user.id, logger, getRefreshMeta(c))
    setRefreshSessionCookie(c, refreshSession.token, refreshSession.expiresAt)

    logger.info({ userId: user.id, isNew: user.isNew }, 'login success')

    return c.json({
      success: true,
      data: await buildAuthResponse(user, token, user.isNew && !hasCompleteUserProfile(user)),
    })
  },
)

// POST /api/auth/refresh — 使用 HttpOnly refresh cookie 静默换发 access token
authRoutes.post(
  '/refresh',
  rateLimitMiddleware({ windowMs: 1_000, max: 10, keyPrefix: 'rl:auth-refresh' }),
  async (c) => {
    const logger = c.get('logger')
    const refreshToken = getCookie(c, REFRESH_TOKEN_COOKIE_NAME)
    const result = refreshToken
      ? await refreshAccessSession(refreshToken, logger, getRefreshMeta(c))
      : null

    if (!result) {
      clearRefreshSessionCookie(c)
      return c.json({ success: false, error: '登录已过期，请重新登录' }, 401)
    }

    setRefreshSessionCookie(c, result.refreshToken, result.refreshExpiresAt)
    return c.json({
      success: true,
      data: await buildAuthResponse(result.user, result.accessToken, false),
    })
  },
)

// POST /api/auth/bootstrap-session — 迁移旧客户端：用仍有效的 access token 补发 refresh cookie
authRoutes.post(
  '/bootstrap-session',
  rateLimitMiddleware({ windowMs: 1_000, max: 3, keyPrefix: 'rl:auth-bootstrap' }),
  authMiddleware,
  async (c) => {
    const logger = c.get('logger')
    const userId = c.get('userId')
    const user = await findUserById(userId)
    if (!user) return c.json({ success: false, error: '用户不存在' }, 404)

    const token = signToken({ userId: user.id, phone: user.phone })
    const refreshSession = await createRefreshSession(user.id, logger, getRefreshMeta(c))
    setRefreshSessionCookie(c, refreshSession.token, refreshSession.expiresAt)

    return c.json({
      success: true,
      data: await buildAuthResponse(user, token, false),
    })
  },
)

// POST /api/auth/logout — 撤销当前 refresh session，并清除 HttpOnly cookie
authRoutes.post('/logout', async (c) => {
  const logger = c.get('logger')
  const refreshToken = getCookie(c, REFRESH_TOKEN_COOKIE_NAME)
  await revokeRefreshSession(refreshToken, logger)
  clearRefreshSessionCookie(c)
  return c.json({ success: true })
})

export default authRoutes
