import { api } from '../services/api.js'
import type { ApiResponse, BoundDoctor, InviteBindDoctorResponse } from '@health-agent/shared'

const DOCTOR_INVITE_ID_KEY = 'cx-doctor-invite-id'
const DOCTOR_INVITE_EXPIRES_AT_KEY = 'cx-doctor-invite-expires-at'
const DOCTOR_ID_PATTERN = /^[A-Za-z0-9_-]{1,120}$/
const INVITE_TTL_MS = 24 * 60 * 60 * 1000

export type DoctorInviteBindResult =
  | { ok: true; binding: BoundDoctor }
  | { ok: false; error: string }

let inFlightBind: Promise<DoctorInviteBindResult> | null = null

export function normalizeDoctorInviteId(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  if (!trimmed) return null
  return DOCTOR_ID_PATTERN.test(trimmed) ? trimmed : null
}

export function storeDoctorInviteId(doctorId: string): string | null {
  if (typeof window === 'undefined') return null
  const normalized = normalizeDoctorInviteId(doctorId)
  if (!normalized) return null
  localStorage.setItem(DOCTOR_INVITE_ID_KEY, normalized)
  localStorage.setItem(DOCTOR_INVITE_EXPIRES_AT_KEY, String(Date.now() + INVITE_TTL_MS))
  return normalized
}

export function captureDoctorInviteFromCurrentUrl(): string | null {
  if (typeof window === 'undefined') return null
  const params = new URLSearchParams(window.location.search)
  const doctorId = normalizeDoctorInviteId(params.get('doctorId'))
  if (!doctorId) return null
  return storeDoctorInviteId(doctorId)
}

export function readStoredDoctorInviteId(): string | null {
  if (typeof window === 'undefined') return null
  const expiresAt = Number(localStorage.getItem(DOCTOR_INVITE_EXPIRES_AT_KEY) ?? 0)
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    clearStoredDoctorInviteId()
    return null
  }
  return normalizeDoctorInviteId(localStorage.getItem(DOCTOR_INVITE_ID_KEY))
}

export function clearStoredDoctorInviteId() {
  if (typeof window === 'undefined') return
  localStorage.removeItem(DOCTOR_INVITE_ID_KEY)
  localStorage.removeItem(DOCTOR_INVITE_EXPIRES_AT_KEY)
}

export async function bindStoredDoctorInvite(): Promise<DoctorInviteBindResult> {
  if (inFlightBind) return inFlightBind
  const doctorId = readStoredDoctorInviteId()
  if (!doctorId) return { ok: false, error: '邀请链接已失效，请联系医生重新生成二维码' }

  inFlightBind = api.post<ApiResponse<InviteBindDoctorResponse>>('/doctor/invite-bind', { doctorId })
    .then((res) => {
      const binding = res.data?.binding
      if (res.success && binding) {
        clearStoredDoctorInviteId()
        return { ok: true, binding } as const
      }
      return { ok: false, error: res.error || '绑定失败，请联系医生重新生成二维码' } as const
    })
    .catch((err) => {
      console.warn('[doctor-invite] bind failed', err?.message ?? err)
      return { ok: false, error: err?.message || '绑定失败，请联系医生重新生成二维码' } as const
    })
    .finally(() => {
      inFlightBind = null
    })

  return inFlightBind
}
