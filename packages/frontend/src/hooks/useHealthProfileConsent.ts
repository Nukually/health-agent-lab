/**
 * useHealthProfileConsent — 健康档案二次授权守卫 Hook
 *
 * 用法：
 *   const { guard, dialogProps } = useHealthProfileConsent()
 *   <button onClick={() => guard(doWork, rollback)}>...</button>
 *   {...} <HealthProfileConsentDialog {...dialogProps} />
 *
 * 已授权 → 直接调 onAgree；未授权 → 展示 Dialog，同意后落库再 onAgree，拒绝 onReject。
 */

import { useState, useCallback } from 'react'
import { api } from '../services/api.js'
import { useStore } from '../stores/index.js'
import { CONSENT_VERSIONS, type ApiResponse, type UserConsent } from '@health-agent/shared'

interface Pending {
  onAgree: () => void
  onReject: () => void
}

export function useHealthProfileConsent() {
  const token = useStore((s) => s.token)
  const consents = useStore((s) => s.consents)
  const addConsent = useStore((s) => s.addConsent)

  const [pending, setPending] = useState<Pending | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [checkingRemote, setCheckingRemote] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const hasConsent = consents.some(
    (c) => c.type === 'health_profile' && c.version === CONSENT_VERSIONS.health_profile,
  )

  const guard = useCallback(
    (onAgree: () => void, onReject: () => void = () => {}) => {
      if (hasConsent) {
        onAgree()
        return
      }
      if (pending || submitting || checkingRemote) return
      setError(null)

      if (token && consents.length === 0) {
        setCheckingRemote(true)
        void api.get<ApiResponse<{ consents: UserConsent[] }>>('/auth/consents')
          .then((res) => {
            const remoteConsents = res.data?.consents ?? []
            const remoteHasConsent = remoteConsents.some(
              (c) =>
                c.type === 'health_profile' &&
                c.version === CONSENT_VERSIONS.health_profile,
            )

            if (remoteHasConsent) {
              addConsent('health_profile', CONSENT_VERSIONS.health_profile)
              onAgree()
              return
            }

            setPending({ onAgree, onReject })
          })
          .catch(() => {
            setPending({ onAgree, onReject })
          })
          .finally(() => {
            setCheckingRemote(false)
          })
        return
      }

      setPending({ onAgree, onReject })
    },
    [addConsent, checkingRemote, consents.length, hasConsent, pending, submitting, token],
  )

  const handleAgree = useCallback(async () => {
    if (!pending || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      await api.post('/auth/accept-consent', {
        type: 'health_profile',
        version: CONSENT_VERSIONS.health_profile,
      })
      addConsent('health_profile', CONSENT_VERSIONS.health_profile)
      const { onAgree } = pending
      setPending(null)
      onAgree()
    } catch {
      setError('授权提交失败，请重试')
    } finally {
      setSubmitting(false)
    }
  }, [pending, submitting, addConsent])

  const handleReject = useCallback(() => {
    if (!pending || submitting) return
    const { onReject } = pending
    setError(null)
    setPending(null)
    onReject()
  }, [pending, submitting])

  return {
    guard,
    hasConsent,
    dialogProps: {
      open: pending !== null,
      loading: submitting,
      error,
      onAgree: handleAgree,
      onReject: handleReject,
    },
  }
}
