/**
 * DeleteAccountWizard — 账号注销多步 Modal
 *
 * 流程：风险告知（30s 阅读）→ 手动输入"确认注销" → 短信验证 → 进入 15 天冷静期。
 */

import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../../services/api.js'
import { useStore } from '../../stores/index.js'
import { unbindNativePushDevice } from '../../lib/nativePush.js'

const CONFIRM_PHRASE = '确认注销'

interface Props {
  open: boolean
  onClose: () => void
}

type Step = 'warn' | 'phrase' | 'verify' | 'done'

export default function DeleteAccountWizard({ open, onClose }: Props) {
  const navigate = useNavigate()
  const logout = useStore((s) => s.logout)

  const [step, setStep] = useState<Step>('warn')
  const [readCountdown, setReadCountdown] = useState(10)
  const [phrase, setPhrase] = useState('')
  const [code, setCode] = useState('')
  const [codeSent, setCodeSent] = useState(false)
  const [resendCountdown, setResendCountdown] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) {
      setStep('warn')
      setReadCountdown(10)
      setPhrase('')
      setCode('')
      setCodeSent(false)
      setResendCountdown(0)
      setError('')
    }
  }, [open])

  useEffect(() => {
    if (step !== 'warn' || readCountdown <= 0) return
    const t = setTimeout(() => setReadCountdown(readCountdown - 1), 1000)
    return () => clearTimeout(t)
  }, [step, readCountdown])

  useEffect(() => {
    if (resendCountdown <= 0) return
    const t = setTimeout(() => setResendCountdown(resendCountdown - 1), 1000)
    return () => clearTimeout(t)
  }, [resendCountdown])

  if (!open) return null

  async function sendCode() {
    setLoading(true)
    setError('')
    try {
      await api.post('/account/deletion/send-code')
      setCodeSent(true)
      setResendCountdown(60)
    } catch (err: any) {
      setError(err.message || '发送失败，请重试')
    } finally {
      setLoading(false)
    }
  }

  async function confirmDeletion() {
    if (!code.trim()) {
      setError('请输入验证码')
      return
    }
    setLoading(true)
    setError('')
    try {
      await api.post('/account/deletion/confirm', { code: code.trim() })
      setStep('done')
    } catch (err: any) {
      setError(err.message || '提交失败，请重试')
    } finally {
      setLoading(false)
    }
  }

  function goToPhrase() {
    setStep('phrase')
  }

  function goToVerify() {
    setStep('verify')
    if (!codeSent) sendCode()
  }

  function finalizeAndLogout() {
    unbindNativePushDevice({ keepalive: true })
      .catch(() => undefined)
      .finally(() => {
        logout()
        navigate('/login', { replace: true })
        onClose()
      })
  }

  return (
    <div style={styles.overlay} onClick={step === 'done' ? undefined : onClose}>
      <div style={styles.dialog} onClick={(e) => e.stopPropagation()}>
        {step === 'warn' && (
          <>
            <h3 style={styles.title}>注销账号</h3>
            <p style={styles.warnText}>注销账号是不可撤销的重大操作，请仔细阅读：</p>
            <ul style={styles.list}>
              <li>账号信息、昵称、手机号绑定</li>
              <li>所有对话历史与 AI 记忆画像</li>
              <li>健康档案、病历文档、病历图片</li>
              <li>消息评价、分享链接</li>
            </ul>
            <p style={styles.warnText}>
              提交后将进入 <strong>15 天冷静期</strong>。冷静期内再次登录可撤销；到期后数据<strong>永久删除，无法恢复</strong>。
            </p>
            <div style={styles.buttons}>
              <button style={styles.cancelBtn} onClick={onClose}>取消</button>
              <button
                style={{ ...styles.dangerBtn, opacity: readCountdown > 0 ? 0.5 : 1 }}
                onClick={goToPhrase}
                disabled={readCountdown > 0}
              >
                {readCountdown > 0 ? `请阅读 ${readCountdown}s` : '我已阅读，继续'}
              </button>
            </div>
          </>
        )}

        {step === 'phrase' && (
          <>
            <h3 style={styles.title}>请输入「{CONFIRM_PHRASE}」</h3>
            <p style={styles.text}>为避免误触，请手动输入以下文字以确认您的意图。</p>
            <input
              style={styles.input}
              placeholder={CONFIRM_PHRASE}
              value={phrase}
              onChange={(e) => setPhrase(e.target.value)}
              autoFocus
            />
            <div style={styles.buttons}>
              <button style={styles.cancelBtn} onClick={onClose}>取消</button>
              <button
                style={{ ...styles.dangerBtn, opacity: phrase.trim() === CONFIRM_PHRASE ? 1 : 0.5 }}
                onClick={goToVerify}
                disabled={phrase.trim() !== CONFIRM_PHRASE}
              >
                下一步
              </button>
            </div>
          </>
        )}

        {step === 'verify' && (
          <>
            <h3 style={styles.title}>短信验证</h3>
            <p style={styles.text}>验证码已发送至您的注册手机号。</p>
            <input
              style={styles.input}
              placeholder="请输入 6 位验证码"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              inputMode="numeric"
              autoFocus
            />
            <button
              style={{ ...styles.linkBtn, opacity: resendCountdown > 0 ? 0.5 : 1 }}
              onClick={sendCode}
              disabled={resendCountdown > 0 || loading}
            >
              {resendCountdown > 0 ? `${resendCountdown}s 后可重发` : '重新发送'}
            </button>
            {error && <p style={styles.error}>{error}</p>}
            <div style={styles.buttons}>
              <button style={styles.cancelBtn} onClick={onClose}>取消</button>
              <button
                style={{ ...styles.dangerBtn, opacity: loading || !code.trim() ? 0.5 : 1 }}
                onClick={confirmDeletion}
                disabled={loading || !code.trim()}
              >
                {loading ? '提交中…' : '确认注销'}
              </button>
            </div>
          </>
        )}

        {step === 'done' && (
          <>
            <h3 style={styles.title}>已进入冷静期</h3>
            <p style={styles.text}>
              您的账号将于 <strong>15 天</strong> 后被永久删除。
            </p>
            <p style={{ ...styles.text, color: 'var(--color-text-muted)', fontSize: 13 }}>
              在此期间使用原手机号重新登录即可撤销注销，您的全部数据将被恢复。
            </p>
            <div style={styles.buttons}>
              <button style={styles.primaryBtn} onClick={finalizeAndLogout}>我知道了</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    background: 'rgba(0,0,0,0.45)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
    padding: 24,
  },
  dialog: {
    background: 'var(--color-bg)',
    borderRadius: 16,
    padding: '24px 20px',
    width: '100%',
    maxWidth: 360,
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 12,
    boxShadow: '0 12px 40px rgba(0,0,0,0.16)',
  },
  title: {
    fontSize: 17,
    fontWeight: 600,
    margin: 0,
    color: 'var(--color-text)',
  },
  text: {
    fontSize: 14,
    lineHeight: 1.6,
    color: 'var(--color-text)',
    margin: 0,
  },
  warnText: {
    fontSize: 14,
    lineHeight: 1.6,
    color: 'var(--color-text)',
    margin: 0,
  },
  list: {
    margin: 0,
    paddingLeft: 20,
    fontSize: 14,
    lineHeight: 1.8,
    color: 'var(--color-text)',
  },
  input: {
    height: 44,
    borderRadius: 10,
    border: '1px solid var(--color-border)',
    padding: '0 12px',
    fontSize: 16,
    background: 'var(--color-surface)',
    color: 'var(--color-text)',
    outline: 'none',
  },
  linkBtn: {
    background: 'none',
    border: 'none',
    color: 'var(--color-primary)',
    fontSize: 13,
    cursor: 'pointer',
    alignSelf: 'flex-end' as const,
    padding: 0,
  },
  buttons: {
    display: 'flex',
    gap: 10,
    marginTop: 4,
  },
  cancelBtn: {
    flex: 1,
    height: 44,
    borderRadius: 10,
    border: '1px solid var(--color-border)',
    background: 'var(--color-surface)',
    color: 'var(--color-text)',
    fontSize: 15,
    cursor: 'pointer',
  },
  dangerBtn: {
    flex: 1,
    height: 44,
    borderRadius: 10,
    border: 'none',
    background: '#d93025',
    color: '#fff',
    fontSize: 15,
    fontWeight: 600,
    cursor: 'pointer',
  },
  primaryBtn: {
    flex: 1,
    height: 44,
    borderRadius: 10,
    border: 'none',
    background: 'var(--color-primary)',
    color: '#fff',
    fontSize: 15,
    fontWeight: 600,
    cursor: 'pointer',
  },
  error: {
    fontSize: 13,
    color: '#d93025',
    margin: 0,
  },
}
