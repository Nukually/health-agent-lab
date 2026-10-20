/**
 * ClearMedicalDataDialog — 清空健康档案二次确认 Modal
 *
 * 流程：风险告知 → 发送短信 → 输入验证码 → 确认清除。
 * 范围：medical_records + medical_documents + OSS 病历图片，不影响对话与账号。
 */

import { useState, useEffect } from 'react'
import { api } from '../../services/api.js'

interface Props {
  open: boolean
  onClose: () => void
  onSuccess: () => void
}

export default function ClearMedicalDataDialog({ open, onClose, onSuccess }: Props) {
  const [step, setStep] = useState<'warn' | 'verify' | 'success'>('warn')
  const [code, setCode] = useState('')
  const [codeSent, setCodeSent] = useState(false)
  const [countdown, setCountdown] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) {
      setStep('warn')
      setCode('')
      setCodeSent(false)
      setCountdown(0)
      setError('')
    }
  }, [open])

  useEffect(() => {
    if (countdown <= 0) return
    const timer = setTimeout(() => setCountdown(countdown - 1), 1000)
    return () => clearTimeout(timer)
  }, [countdown])

  if (!open) return null

  async function sendCode() {
    setLoading(true)
    setError('')
    try {
      await api.post('/account/medical/send-code')
      setCodeSent(true)
      setCountdown(60)
    } catch (err: any) {
      setError(err.message || '发送失败，请重试')
    } finally {
      setLoading(false)
    }
  }

  async function confirmPurge() {
    if (!code.trim()) {
      setError('请输入验证码')
      return
    }
    setLoading(true)
    setError('')
    try {
      await api.post('/account/medical/purge', { code: code.trim() })
      setStep('success')
    } catch (err: any) {
      setError(err.message || '清除失败，请重试')
    } finally {
      setLoading(false)
    }
  }

  function handleNext() {
    setStep('verify')
    if (!codeSent) sendCode()
  }

  function handleDone() {
    onSuccess()
    onClose()
  }

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={styles.dialog} onClick={(e) => e.stopPropagation()}>
        {step === 'warn' && (
          <>
            <h3 style={styles.title}>清空健康档案</h3>
            <p style={styles.text}>执行后将<strong>立即永久删除</strong>以下内容：</p>
            <ul style={styles.list}>
              <li>结构化健康档案（月经状态、肿瘤分型、用药等）</li>
              <li>所有上传的病历文档与病历图片</li>
              <li>云端存储的病历影像文件</li>
            </ul>
            <p style={{ ...styles.text, color: 'var(--color-text-muted)', fontSize: 13 }}>
              您的账号、对话历史与 AI 记忆将保留。
            </p>
            <div style={styles.buttons}>
              <button style={styles.cancelBtn} onClick={onClose}>取消</button>
              <button style={styles.dangerBtn} onClick={handleNext}>我已了解，继续</button>
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
              style={{ ...styles.linkBtn, opacity: countdown > 0 ? 0.5 : 1 }}
              onClick={sendCode}
              disabled={countdown > 0 || loading}
            >
              {countdown > 0 ? `${countdown}s 后可重发` : '重新发送'}
            </button>
            {error && <p style={styles.error}>{error}</p>}
            <div style={styles.buttons}>
              <button style={styles.cancelBtn} onClick={onClose}>取消</button>
              <button
                style={{ ...styles.dangerBtn, opacity: loading || !code.trim() ? 0.5 : 1 }}
                onClick={confirmPurge}
                disabled={loading || !code.trim()}
              >
                {loading ? '清除中…' : '确认清除'}
              </button>
            </div>
          </>
        )}

        {step === 'success' && (
          <>
            <h3 style={styles.title}>健康档案已清空</h3>
            <p style={styles.text}>所有医疗档案与病历图片已永久删除。</p>
            <div style={styles.buttons}>
              <button style={styles.primaryBtn} onClick={handleDone}>知道了</button>
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
    letterSpacing: 4,
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
