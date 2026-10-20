/**
 * DeletionPending — 注销冷静期拦截页
 *
 * 当用户账号处于 pending_deletion 状态时，所有业务页面都会被引导到此页。
 * 提供"撤销注销"按钮恢复账号。
 */

import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../services/api.js'
import { useStore } from '../stores/index.js'
import { unbindNativePushDevice } from '../lib/nativePush.js'

interface StatusData {
  status: 'active' | 'pending_deletion'
  deletionRequestedAt: string | null
}

export default function DeletionPending() {
  const navigate = useNavigate()
  const logout = useStore((s) => s.logout)

  const [daysRemaining, setDaysRemaining] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    async function check() {
      try {
        const res = await api.get<{ success: boolean; data: StatusData }>('/account/status')
        if (res.data.status === 'active') {
          navigate('/chat', { replace: true })
          return
        }
        if (res.data.deletionRequestedAt) {
          const requested = new Date(res.data.deletionRequestedAt).getTime()
          const expireAt = requested + 15 * 24 * 60 * 60 * 1000
          const remain = Math.max(0, Math.ceil((expireAt - Date.now()) / (24 * 60 * 60 * 1000)))
          setDaysRemaining(remain)
        }
      } catch {
        // 未登录或其他错误 — 登出回登录页
        logout()
        navigate('/login', { replace: true })
      }
    }
    check()
  }, [navigate, logout])

  async function handleCancel() {
    setLoading(true)
    setError('')
    try {
      await api.post('/account/deletion/cancel')
      navigate('/chat', { replace: true })
    } catch (err: any) {
      setError(err.message || '撤销失败，请重试')
      setLoading(false)
    }
  }

  function handleLogout() {
    unbindNativePushDevice({ keepalive: true })
      .catch(() => undefined)
      .finally(() => {
        logout()
        navigate('/login', { replace: true })
      })
  }

  return (
    <div style={styles.container}>
      <div style={styles.card}>
        <div style={styles.iconWrap}>
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#d93025" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
        </div>
        <h1 style={styles.title}>账号正在注销中</h1>
        {daysRemaining !== null && (
          <p style={styles.text}>
            {daysRemaining > 0
              ? <>距离永久删除还剩 <strong>{daysRemaining}</strong> 天</>
              : <>即将被永久删除</>}
          </p>
        )}
        <p style={styles.subtext}>
          撤销注销即可恢复全部数据，继续使用账号。
        </p>
        {error && <p style={styles.error}>{error}</p>}
        <button
          style={{ ...styles.primaryBtn, opacity: loading ? 0.5 : 1 }}
          onClick={handleCancel}
          disabled={loading}
        >
          {loading ? '撤销中…' : '撤销注销'}
        </button>
        <button style={styles.secondaryBtn} onClick={handleLogout}>
          退出登录
        </button>
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    height: '100%',
    background: 'var(--color-bg-page)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  card: {
    width: '100%',
    maxWidth: 360,
    background: 'var(--color-bg)',
    borderRadius: 16,
    padding: '32px 24px',
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    gap: 12,
    boxShadow: '0 4px 24px rgba(0,0,0,0.06)',
  },
  iconWrap: {
    width: 64,
    height: 64,
    borderRadius: '50%',
    background: 'rgba(217, 48, 37, 0.08)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4,
  },
  title: {
    fontSize: 20,
    fontWeight: 600,
    margin: 0,
    color: 'var(--color-text)',
  },
  text: {
    fontSize: 15,
    color: 'var(--color-text)',
    margin: 0,
    textAlign: 'center' as const,
  },
  subtext: {
    fontSize: 13,
    color: 'var(--color-text-muted)',
    margin: 0,
    textAlign: 'center' as const,
    lineHeight: 1.6,
  },
  primaryBtn: {
    width: '100%',
    height: 48,
    borderRadius: 12,
    background: 'var(--color-primary)',
    color: '#fff',
    fontSize: 16,
    fontWeight: 600,
    border: 'none',
    cursor: 'pointer',
    marginTop: 12,
  },
  secondaryBtn: {
    width: '100%',
    height: 44,
    borderRadius: 12,
    background: 'none',
    color: 'var(--color-text-muted)',
    fontSize: 14,
    border: 'none',
    cursor: 'pointer',
  },
  error: {
    fontSize: 13,
    color: '#d93025',
    margin: 0,
    textAlign: 'center' as const,
  },
}
