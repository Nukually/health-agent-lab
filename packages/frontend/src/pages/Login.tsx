import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../services/api.js'
import { useStore } from '../stores/index.js'
import {
  LOGIN_PHONE_ERROR_MESSAGE,
  LOGIN_PHONE_MAX_LENGTH,
  isSupportedLoginPhone,
  normalizeLoginPhoneInput,
  normalizeLoginPhoneTyping,
} from '@health-agent/shared'
import type { ApiResponse, LoginResponse } from '@health-agent/shared'
import AgreementModal from '../components/agreement/AgreementModal.js'
import { LOGIN_AGREEMENT_HTML } from '../assets/agreements/loginAgreement.js'
import { PRIVACY_POLICY_HTML } from '../assets/agreements/privacyPolicy.js'
import { setNativeAuthToken } from '../lib/nativeAuth.js'
import { bindNativePushDevice } from '../lib/nativePush.js'
import {
  captureChannelCodeFromCurrentUrl,
  clearStoredChannelCode,
  readStoredChannelCode,
} from '../utils/channelAttribution.js'
import { captureDoctorInviteFromCurrentUrl, readStoredDoctorInviteId } from '../utils/doctorInvite.js'

export default function Login() {
  const navigate = useNavigate()
  const setAuth = useStore((s) => s.setAuth)

  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  const [step, setStep] = useState<'phone' | 'code'>('phone')
  const [countdown, setCountdown] = useState(0)
  const [sendingCode, setSendingCode] = useState(false)
  const [loggingIn, setLoggingIn] = useState(false)
  const [error, setError] = useState('')
  const [agreed, setAgreed] = useState(false)
  const [agreementStep, setAgreementStep] = useState<0 | 1 | null>(null)
  const isCodeCoolingDown = countdown > 0

  useEffect(() => {
    captureChannelCodeFromCurrentUrl()
    captureDoctorInviteFromCurrentUrl()
  }, [])

  function validatePhone(): string | null {
    if (!phone) return '请输入手机号'
    if (!isSupportedLoginPhone(phone)) return LOGIN_PHONE_ERROR_MESSAGE
    return null
  }

  useEffect(() => {
    if (countdown <= 0) return
    const timer = setTimeout(() => setCountdown((c) => Math.max(c - 1, 0)), 1000)
    return () => clearTimeout(timer)
  }, [countdown])

  async function handleSendCode() {
    const phoneError = validatePhone()
    if (phoneError) { setError(phoneError); return }
    if (isCodeCoolingDown || sendingCode) return
    setError('')
    setSendingCode(true)

    try {
      await api.post<ApiResponse>('/auth/send-code', { phone: normalizeLoginPhoneInput(phone) })
      setStep('code')
      setCountdown(60)
    } catch (err: any) {
      setError(err.message || '发送失败')
      // 后端发送失败/频控时会下发 retryAfterSeconds，据此让「获取验证码」按钮进入倒计时禁用，
      // 避免用户立即重点连环撞阿里云分钟级流控。停留在手机号步骤（验证码并未真正发出）。
      if (typeof err.retryAfterSeconds === 'number' && err.retryAfterSeconds > 0) {
        setCountdown(err.retryAfterSeconds)
      }
    } finally {
      setSendingCode(false)
    }
  }

  async function handleLogin() {
    const phoneError = validatePhone()
    if (phoneError) { setError(phoneError); return }
    if (!code) { setError('请输入验证码'); return }
    if (!agreed) { setError('请先阅读并同意《演示说明》与《数据处理说明》'); return }
    setError('')
    setLoggingIn(true)

    try {
      const channelCode = readStoredChannelCode()
      const res = await api.post<ApiResponse<LoginResponse>>('/auth/login', {
        phone: normalizeLoginPhoneInput(phone),
        code,
        agreementAccepted: agreed,
        ...(channelCode ? { channelCode } : {}),
      })
      const data = res.data!
      setAuth(
        data.token,
        data.user,
        data.needsProfile,
        data.requireCompleteProfile ?? false,
        data.consents ?? [],
        data.features,
        data.userSource ?? null,
      )
      clearStoredChannelCode()
      // 登录成功后检查账号状态：若在冷静期，跳撤销页
      let status: 'active' | 'pending_deletion' = 'active'
      try {
        const sRes = await api.get<{ success: boolean; data: { status: 'active' | 'pending_deletion' } }>(
          '/account/status',
        )
        status = sRes.data.status
      } catch {
        // 忽略错误，默认 active
      }

      if (status === 'pending_deletion') {
        navigate('/deletion-pending', { replace: true })
      } else if (data.needsProfile) {
        syncNativePushAfterLogin(data.token)
        navigate('/profile', { replace: true })
      } else if (readStoredDoctorInviteId()) {
        syncNativePushAfterLogin(data.token)
        navigate('/doctor-bind', { replace: true })
      } else {
        syncNativePushAfterLogin(data.token)
        navigate('/chat', { replace: true })
      }
    } catch (err: any) {
      setError(err.message || '登录失败')
    } finally {
      setLoggingIn(false)
    }
  }

  function syncNativePushAfterLogin(token: string) {
    setNativeAuthToken(token)
      .then((nativeDirectBindEnabled) => {
        if (!nativeDirectBindEnabled) {
          return bindNativePushDevice({ requestPermissionIfNeeded: true })
        }
        return undefined
      })
      .catch(() => undefined)
  }

  return (
    <div style={styles.container}>
      <div style={styles.card}>
        {/* Logo area */}
        <div style={styles.logoArea}>
          <div style={styles.logoCircle}>HA</div>
          <h1 style={styles.title}>Health Agent Lab</h1>
          <p style={styles.subtitle}>Agent 架构与交互技术演示</p>
        </div>

        {/* Form */}
        <div style={styles.form}>
          <div style={styles.inputGroup}>
            <label style={styles.label}>手机号</label>
            <input
              style={styles.input}
              type="tel"
              placeholder="请输入手机号"
              maxLength={LOGIN_PHONE_MAX_LENGTH}
              value={phone}
              onChange={(e) => setPhone(normalizeLoginPhoneTyping(e.target.value))}
            />
          </div>

          {step === 'code' && (
            <div style={styles.inputGroup}>
              <label style={styles.label}>验证码</label>
              <div style={styles.codeRow}>
                <input
                  style={{ ...styles.input, flex: '1 1 0', minWidth: 0 }}
                  type="text"
                  placeholder="请输入验证码"
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                  autoFocus
                />
                <button
                  style={{
                    ...styles.resendBtn,
                    opacity: isCodeCoolingDown || sendingCode || loggingIn ? 0.5 : 1,
                  }}
                  onClick={handleSendCode}
                  disabled={isCodeCoolingDown || sendingCode || loggingIn}
                >
                  {sendingCode ? '发送中...' : isCodeCoolingDown ? `${countdown}s` : '重新发送'}
                </button>
              </div>
            </div>
          )}

          {error && <p style={styles.error}>{error}</p>}

          {step === 'phone' ? (
            <button
              style={{
                ...styles.button,
                opacity: sendingCode || isCodeCoolingDown ? 0.5 : 1,
              }}
              onClick={handleSendCode}
              disabled={sendingCode || isCodeCoolingDown}
            >
              {sendingCode ? '发送中...' : isCodeCoolingDown ? `${countdown}s后重试` : '获取验证码'}
            </button>
          ) : (
            <button
              style={{
                ...styles.button,
                opacity: loggingIn || sendingCode ? 0.5 : 1,
              }}
              onClick={handleLogin}
              disabled={loggingIn || sendingCode}
            >
              {loggingIn ? '登录中...' : '登录'}
            </button>
          )}

          {/* Agreement checkbox */}
          <div style={styles.agreementRow}>
            <input
              type="checkbox"
              checked={agreed}
              onChange={(e) => setAgreed(e.target.checked)}
              className="cx-checkbox"
              style={styles.checkboxSpacing}
              id="agreement-checkbox"
            />
            <span style={styles.agreementText}>
              <label htmlFor="agreement-checkbox" style={styles.agreementLabelText}>已阅读并同意</label>
              <a style={styles.agreementLink} onClick={() => setAgreementStep(0)}>《演示说明》</a>
              <label htmlFor="agreement-checkbox" style={styles.agreementLabelText}>与</label>
              <a style={styles.agreementLink} onClick={() => setAgreementStep(0)}>《数据处理说明》</a>
            </span>
          </div>
        </div>
      </div>

      <AgreementModal
        open={agreementStep === 0}
        title="演示说明"
        htmlContent={LOGIN_AGREEMENT_HTML}
        primaryLabel="下一份《数据处理说明》"
        onPrimary={() => setAgreementStep(1)}
        onClose={() => setAgreementStep(null)}
      />
      <AgreementModal
        open={agreementStep === 1}
        title="数据处理说明"
        htmlContent={PRIVACY_POLICY_HTML}
        primaryLabel="我已阅读并同意"
        onPrimary={() => {
          setAgreed(true)
          setAgreementStep(null)
        }}
        onClose={() => setAgreementStep(null)}
      />
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    padding: '24px',
    background: 'var(--color-bg)',
  },
  card: {
    width: '100%',
    maxWidth: 380,
    background: 'var(--color-bg)',
    borderRadius: 16,
    padding: '40px 24px 32px',
    boxShadow: '0 2px 12px rgba(0,0,0,0.06)',
    animation: 'slideUp 0.4s ease',
  },
  logoArea: {
    textAlign: 'center' as const,
    marginBottom: 32,
  },
  logoCircle: {
    width: 56,
    height: 56,
    borderRadius: 16,
    background: 'var(--color-avatar-bg)',
    color: 'var(--color-primary)',
    fontSize: 26,
    fontWeight: 600,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },
  title: {
    fontSize: 28,
    fontWeight: 400,
    fontFamily: 'var(--font-brand)',
    color: 'var(--color-brand)',
    margin: '0 0 4px',
  },
  subtitle: {
    fontSize: 14,
    color: 'var(--color-text-muted)',
  },
  form: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 16,
  },
  inputGroup: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 6,
  },
  label: {
    fontSize: 14,
    fontWeight: 500,
    color: 'var(--color-text-secondary)',
  },
  input: {
    height: 48,
    borderRadius: 10,
    border: '1px solid var(--color-border)',
    padding: '0 16px',
    fontSize: 16,
    outline: 'none',
    transition: 'border-color 0.2s',
    background: 'var(--color-surface)',
  },
  codeRow: {
    display: 'flex',
    gap: 8,
    width: '100%',
  },
  resendBtn: {
    flexShrink: 0,
    padding: '0 16px',
    height: 48,
    borderRadius: 10,
    border: '1px solid var(--color-border)',
    color: 'var(--color-text-secondary)',
    fontSize: 14,
    fontWeight: 500,
    background: 'transparent',
    cursor: 'pointer',
    whiteSpace: 'nowrap' as const,
  },
  button: {
    height: 48,
    borderRadius: 10,
    background: 'var(--color-primary)',
    color: '#fff',
    fontSize: 16,
    fontWeight: 600,
    border: 'none',
    cursor: 'pointer',
    marginTop: 8,
    transition: 'opacity 0.2s, transform 0.1s',
  },
  error: {
    color: 'var(--color-error)',
    fontSize: 13,
    textAlign: 'center' as const,
  },
  agreementRow: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 8,
    marginTop: 8,
    cursor: 'pointer',
    userSelect: 'none' as const,
  },
  checkboxSpacing: {
    marginTop: 2,
  },
  agreementText: {
    fontSize: 12,
    lineHeight: 1.5,
    color: 'var(--color-text-muted)',
  },
  agreementLink: {
    color: 'var(--color-primary)',
    cursor: 'pointer',
  },
  agreementLabelText: {
    cursor: 'pointer',
  },
}
