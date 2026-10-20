import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AliyunSmsSendError, isAliyunSmsSendError } from './sms.js'

// 冷却分级依据 AliyunSmsSendError 的派生字段：
// 阿里云分钟级流控 → 维持满 60s；其它失败 → 10s 短冷却。
// 这两个字段决定 sendVerificationCode catch 里锁的 TTL 与回传前端的 retryAfterSeconds。

test('阿里云分钟级流控判定为 rate limited 且冷却 60s', () => {
  const err = new AliyunSmsSendError('isv.BUSINESS_LIMIT_CONTROL')
  assert.equal(err.isRateLimited, true)
  assert.equal(err.retryAfterSeconds, 60)
})

test('网络/超时等其它失败非 rate limited 且短冷却 10s', () => {
  for (const code of ['NETWORK_ERROR', 'UNKNOWN', 'isv.SMS_SIGNATURE_ILLEGAL']) {
    const err = new AliyunSmsSendError(code)
    assert.equal(err.isRateLimited, false, code)
    assert.equal(err.retryAfterSeconds, 10, code)
  }
})

test('isAliyunSmsSendError 类型守卫', () => {
  assert.equal(isAliyunSmsSendError(new AliyunSmsSendError('UNKNOWN')), true)
  assert.equal(isAliyunSmsSendError(new Error('boom')), false)
  assert.equal(isAliyunSmsSendError(null), false)
})

test('错误 message 不含手机号/验证码，只含错误码', () => {
  const err = new AliyunSmsSendError('isv.BUSINESS_LIMIT_CONTROL')
  assert.match(err.message, /isv\.BUSINESS_LIMIT_CONTROL/)
  assert.doesNotMatch(err.message, /\d{11}/) // 无 11 位手机号
})
