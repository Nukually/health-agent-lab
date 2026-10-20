import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useStore } from '../stores/index.js'
import {
  bindStoredDoctorInvite,
  captureDoctorInviteFromCurrentUrl,
  readStoredDoctorInviteId,
  storeDoctorInviteId,
} from '../utils/doctorInvite.js'

type BindState = 'checking' | 'need_login' | 'need_profile' | 'binding' | 'success' | 'error'

export default function DoctorBind() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const token = useStore((s) => s.token)
  const needsProfile = useStore((s) => s.needsProfile)
  const [state, setState] = useState<BindState>('checking')
  const [message, setMessage] = useState('正在读取医生邀请...')
  const [doctorId, setDoctorId] = useState<string | null>(null)
  const [inviteLoaded, setInviteLoaded] = useState(false)

  useEffect(() => {
    const current = searchParams.get('doctorId')
    if (current) {
      setDoctorId(storeDoctorInviteId(current))
      setInviteLoaded(true)
      return
    }
    captureDoctorInviteFromCurrentUrl()
    setDoctorId(readStoredDoctorInviteId())
    setInviteLoaded(true)
  }, [searchParams])

  useEffect(() => {
    if (!inviteLoaded) return
    if (!doctorId) {
      setState('error')
      setMessage('邀请链接无效，请联系医生重新生成二维码')
      return
    }
    if (!token) {
      setState('need_login')
      setMessage('请先登录Health Agent Lab，登录后会自动绑定医生')
      return
    }
    if (needsProfile) {
      setState('need_profile')
      setMessage('请先完善基础资料，完成后会自动绑定医生')
      return
    }

    let cancelled = false
    setState('binding')
    setMessage('正在绑定医生...')
    bindStoredDoctorInvite()
      .then((result) => {
        if (cancelled) return
        if (result.ok) {
          if (result.binding.status === 'confirmed') {
            navigate('/my-doctor', { replace: true })
            return
          }
          setState('success')
          setMessage(result.binding.status === 'pending_unbind'
            ? '该医生正在解绑处理中，请在我的医生中查看'
            : result.binding.status === 'rejected'
              ? '该医生暂未接受本次绑定申请，请联系医生后重新扫码'
              : '已提交绑定申请，等待医生确认')
          window.setTimeout(() => {
            navigate('/my-doctor', { replace: true })
          }, 600)
          return
        }
        setState('error')
        setMessage(result.error || '绑定失败，请联系医生重新生成二维码')
      })
      .catch((err: any) => {
        if (cancelled) return
        setState('error')
        setMessage(err?.message || '绑定失败，请联系医生重新生成二维码')
      })
    return () => {
      cancelled = true
    }
  }, [doctorId, inviteLoaded, navigate, needsProfile, token])

  function handlePrimaryAction() {
    if (state === 'need_login') {
      navigate('/login', { replace: true })
      return
    }
    if (state === 'need_profile') {
      navigate('/profile', { replace: true })
      return
    }
    if (state === 'success') {
      navigate('/my-doctor', { replace: true })
      return
    }
    if (state === 'error') {
      navigate('/chat', { replace: true })
    }
  }

  const primaryText =
    state === 'need_login' ? '去登录'
      : state === 'need_profile' ? '去完善资料'
        : state === 'success' ? '查看我的医生'
          : state === 'error' ? '返回聊天'
            : ''

  return (
    <div style={styles.page}>
      <section style={styles.panel}>
        <div style={{
          ...styles.icon,
          ...(state === 'error' ? styles.iconError : state === 'success' ? styles.iconSuccess : {}),
        }}>
          {state === 'error' ? (
            <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
          ) : state === 'success' ? (
            <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 6 9 17l-5-5" />
            </svg>
          ) : (
            <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M16 21v-2a4 4 0 0 0-8 0v2" />
              <circle cx="12" cy="7" r="4" />
              <path d="M19 8v6" />
              <path d="M22 11h-6" />
            </svg>
          )}
        </div>
        <h1 style={styles.title}>医生邀请</h1>
        <p style={styles.message}>{message}</p>
        {(state === 'checking' || state === 'binding') && <div style={styles.loadingBar} />}
        {primaryText && (
          <button style={styles.primaryBtn} onClick={handlePrimaryAction}>
            {primaryText}
          </button>
        )}
      </section>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    height: '100%',
    background: 'var(--color-bg)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  panel: {
    width: '100%',
    maxWidth: 360,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    textAlign: 'center',
    gap: 12,
  },
  icon: {
    width: 68,
    height: 68,
    borderRadius: '50%',
    color: 'var(--color-primary)',
    background: 'var(--color-primary-bg)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconSuccess: {
    color: 'var(--color-success)',
    background: 'rgba(52, 168, 83, 0.1)',
  },
  iconError: {
    color: 'var(--color-error)',
    background: 'rgba(217, 48, 37, 0.08)',
  },
  title: {
    margin: '8px 0 0',
    fontSize: 22,
    fontWeight: 700,
    color: 'var(--color-text)',
  },
  message: {
    minHeight: 44,
    margin: 0,
    fontSize: 15,
    lineHeight: 1.6,
    color: 'var(--color-text-muted)',
  },
  loadingBar: {
    width: 120,
    height: 3,
    borderRadius: 999,
    background: 'linear-gradient(90deg, transparent, var(--color-primary), transparent)',
    animation: 'pulse 1.2s ease-in-out infinite',
  },
  primaryBtn: {
    width: '100%',
    height: 46,
    border: 'none',
    borderRadius: 14,
    background: 'var(--color-primary)',
    color: '#fff',
    fontSize: 16,
    fontWeight: 600,
    cursor: 'pointer',
    marginTop: 8,
  },
}
