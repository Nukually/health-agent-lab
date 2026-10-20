import { createRequire } from 'node:module'
import type DysmsapiType from '@alicloud/dysmsapi20170525'
import { Config as OpenApiConfig } from '@alicloud/openapi-client'

// @alicloud SDK 是 CJS 且未打 __esModule 标记，Node ESM 下 default import 会拿到
// 整个 module.exports 而非 class，导致 `new Dysmsapi()` 抛 "is not a constructor"。
// 显式用 createRequire 取 .default，和 scripts/sms-delivery-test/*.cjs 行为保持一致。
const require = createRequire(import.meta.url)
const smsSdk = require('@alicloud/dysmsapi20170525') as {
  default: typeof DysmsapiType
  SendSmsRequest: typeof import('@alicloud/dysmsapi20170525').SendSmsRequest
}
const Dysmsapi = smsSdk.default
const { SendSmsRequest } = smsSdk
import { getKV } from '../lib/redis.js'
import { getEnv } from '../env.js'
import type { Logger } from '../lib/logger.js'
import { getDynamicSmsLoginAllowlistCode, getSmsLoginAllowlistCode } from '../utils/sms-login-allowlist.js'

const CODE_TTL = 5 * 60
const RESEND_COOLDOWN_SECONDS = 60
// 发送失败后的短冷却：避免用户连环重试撞阿里云分钟级流控，又不至于像成功那样要等满 60s。
const FAILED_RESEND_COOLDOWN_SECONDS = 10
const CODE_KEY_PREFIX = 'sms:code:'
const ATTEMPT_KEY_PREFIX = 'sms:attempts:'
const COOLDOWN_KEY_PREFIX = 'sms:cooldown:'
const MAX_VERIFY_ATTEMPTS = 5

let _smsClient: DysmsapiType | null = null

interface SendVerificationCodeOptions {
  purpose?: 'login' | 'account'
}

export class VerificationCodeResendTooSoonError extends Error {
  readonly retryAfterSeconds = RESEND_COOLDOWN_SECONDS

  constructor() {
    super('verification code resend cooldown is active')
    this.name = 'VerificationCodeResendTooSoonError'
  }
}

// 阿里云发送失败的安全错误：只保留错误码/可定位信息，绝不带原始 SDK message/stack
// （其 message 含明文请求 URL，URL 里有完整手机号和验证码）。
export class AliyunSmsSendError extends Error {
  readonly aliyunCode: string
  // 是否命中阿里云分钟级流控；命中时上层按 60s 冷却，避免连环重试继续撞流控。
  readonly isRateLimited: boolean
  // 本次失败实际写入的重发冷却秒数，供上层透传给前端控制倒计时。
  retryAfterSeconds = FAILED_RESEND_COOLDOWN_SECONDS

  constructor(aliyunCode: string) {
    super(`aliyun sms send failed: ${aliyunCode}`)
    this.name = 'AliyunSmsSendError'
    this.aliyunCode = aliyunCode
    this.isRateLimited = aliyunCode === 'isv.BUSINESS_LIMIT_CONTROL'
    if (this.isRateLimited) this.retryAfterSeconds = RESEND_COOLDOWN_SECONDS
  }
}

export function isVerificationCodeResendTooSoonError(
  err: unknown,
): err is VerificationCodeResendTooSoonError {
  return err instanceof VerificationCodeResendTooSoonError
}

export function isAliyunSmsSendError(err: unknown): err is AliyunSmsSendError {
  return err instanceof AliyunSmsSendError
}

function shouldEnforceResendCooldown(deployEnv: string): boolean {
  return deployEnv === 'sit' || deployEnv === 'prod'
}

function getSmsClient(): DysmsapiType {
  if (_smsClient) return _smsClient

  const env = getEnv()
  const accessKeyId = env.ALIYUN_SMS_ACCESS_KEY_ID
  const accessKeySecret = env.ALIYUN_SMS_ACCESS_KEY_SECRET
  if (!accessKeyId || !accessKeySecret) {
    throw new Error('SMS env not configured: ALIYUN_SMS_ACCESS_KEY_ID / ALIYUN_SMS_ACCESS_KEY_SECRET missing')
  }

  _smsClient = new Dysmsapi(
    new OpenApiConfig({
      accessKeyId,
      accessKeySecret,
      endpoint: env.ALIYUN_SMS_ENDPOINT,
      // SDK 默认 readTimeout 3000ms 对同步发码偏短，走 env 可配（默认 5000ms）。
      readTimeout: env.ALIYUN_SMS_READ_TIMEOUT_MS,
    }),
  )
  return _smsClient
}

async function sendViaAliyun(phone: string, code: string, logger: Logger): Promise<void> {
  const env = getEnv()
  const signName = env.ALIYUN_SMS_SIGN_NAME
  const templateCode = env.ALIYUN_SMS_TEMPLATE_CODE
  if (!signName || !templateCode) {
    throw new Error('SMS env not configured: ALIYUN_SMS_SIGN_NAME / ALIYUN_SMS_TEMPLATE_CODE missing')
  }

  const client = getSmsClient()
  const req = new SendSmsRequest({
    phoneNumbers: phone,
    signName,
    templateCode,
    templateParam: JSON.stringify({ code }),
  })

  let body: Awaited<ReturnType<typeof client.sendSms>>['body']
  try {
    const resp = await client.sendSms(req)
    body = resp.body
  } catch (err) {
    // 网络/超时类异常（如 RequestTimeoutError）的 message 含明文请求 URL，
    // URL 里带完整手机号和验证码，绝不能进日志。只记 error 名称，丢弃 message/stack。
    const errName = err instanceof Error ? err.name : 'UnknownError'
    logger.error({ phone, errName }, 'aliyun sms request failed (network/timeout)')
    throw new AliyunSmsSendError('NETWORK_ERROR')
  }

  const aliyunCode = body?.code
  const requestId = body?.requestId

  if (aliyunCode !== 'OK') {
    // aliyunMessage 是阿里云返回的固定提示文案（如「触发分钟级流控」），不含用户隐私，可安全记录。
    logger.error({ phone, aliyunCode, aliyunMessage: body?.message, requestId }, 'aliyun sms send failed')
    throw new AliyunSmsSendError(aliyunCode ?? 'UNKNOWN')
  }

  logger.info({ phone, requestId, bizId: body?.bizId }, 'aliyun sms sent')
}

export async function sendVerificationCode(
  phone: string,
  logger: Logger,
  options: SendVerificationCodeOptions = {},
): Promise<void> {
  const env = getEnv()
  const kv = getKV()
  const cooldownKey = `${COOLDOWN_KEY_PREFIX}${phone}`
  let cooldownLocked = false

  if (shouldEnforceResendCooldown(env.DEPLOY_ENV)) {
    cooldownLocked = await kv.setNX(cooldownKey, '1', RESEND_COOLDOWN_SECONDS)
    if (!cooldownLocked) {
      logger.warn({ phone, retryAfterSeconds: RESEND_COOLDOWN_SECONDS }, 'verification code resend too soon')
      throw new VerificationCodeResendTooSoonError()
    }
  }

  let code: string

  try {
    const loginAllowlistCode = options.purpose === 'login'
      ? (await getDynamicSmsLoginAllowlistCode(kv, phone))
        ?? getSmsLoginAllowlistCode(env.SMS_LOGIN_CODE_ALLOWLIST, phone)
      : null
    const useFixedCode =
      (env.DEPLOY_ENV !== 'prod' && env.DEPLOY_ENV !== 'sit') || env.SMS_USE_FIXED_CODE
    if (loginAllowlistCode) {
      code = loginAllowlistCode
      logger.warn({ phone, deployEnv: env.DEPLOY_ENV }, 'using manual login verification code allowlist')
    } else if (useFixedCode) {
      code = '123'
      logger.info(
        { phone, deployEnv: env.DEPLOY_ENV, smsUseFixedCode: env.SMS_USE_FIXED_CODE },
        'using fixed verification code',
      )
    } else {
      code = String(Math.floor(100000 + Math.random() * 900000))
      await sendViaAliyun(phone, code, logger)
    }

    await kv.set(`${CODE_KEY_PREFIX}${phone}`, code, CODE_TTL)
    await kv.del(`${ATTEMPT_KEY_PREFIX}${phone}`)
    logger.info({ phone, ttl: CODE_TTL, resendCooldownSeconds: RESEND_COOLDOWN_SECONDS }, 'verification code stored')
  } catch (err) {
    if (cooldownLocked) {
      // 失败时不能直接 del 锁，否则用户可立即重试、连环撞阿里云分钟级流控。
      // 阿里云流控（BUSINESS_LIMIT_CONTROL）维持满 60s——本地提前放行也会再被阿里云拒；
      // 其他失败（网络/超时等）降为 10s 短冷却，让用户较快重试又不至于刷爆。
      const keepFullCooldown = err instanceof AliyunSmsSendError && err.isRateLimited
      if (!keepFullCooldown) {
        await kv.set(cooldownKey, '1', FAILED_RESEND_COOLDOWN_SECONDS)
      }
    }
    throw err
  }
}

export async function verifyCode(
  phone: string,
  code: string,
  logger: Logger,
): Promise<boolean> {
  const kv = getKV()
  const key = `${CODE_KEY_PREFIX}${phone}`
  const attemptKey = `${ATTEMPT_KEY_PREFIX}${phone}`

  const stored = await kv.get(key)
  if (!stored) {
    logger.warn({ phone }, 'verification code expired or not found')
    return false
  }

  if (stored !== code) {
    const attempts = await kv.incr(attemptKey)
    if (attempts === 1) {
      await kv.pexpire(attemptKey, CODE_TTL * 1000)
    }

    if (attempts >= MAX_VERIFY_ATTEMPTS) {
      await kv.del(key)
      await kv.del(attemptKey)
      logger.warn({ phone, attempts, maxAttempts: MAX_VERIFY_ATTEMPTS }, 'verification code max attempts exceeded')
      return false
    }

    logger.warn({ phone, attempts, maxAttempts: MAX_VERIFY_ATTEMPTS }, 'verification code mismatch')
    return false
  }

  await kv.del(key)
  await kv.del(attemptKey)
  await kv.del(`${COOLDOWN_KEY_PREFIX}${phone}`)
  logger.info({ phone }, 'verification code verified')
  return true
}
