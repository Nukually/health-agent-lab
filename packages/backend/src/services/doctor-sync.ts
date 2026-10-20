import { eq } from 'drizzle-orm'
import { getDb } from '../db/client.js'
import { doctors } from '../db/schema/index.js'
import { getEnv } from '../env.js'
import type { Logger } from '../lib/logger.js'

interface RemoteDoctorPayload {
  doctorId?: string
  doctorInviteCode?: string | null
  name?: string | null
  title?: string | null
  hospital?: string | null
  department?: string | null
  avatarUrl?: string | null
  phone?: string | null
}

const DOCTOR_SYNC_REQUEST_TIMEOUT_MS = 8000

function trimNullable(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function statusError(message: string, status: number) {
  const err = new Error(message) as Error & { status?: number }
  err.status = status
  return err
}

function maskPhone(phone: string | null): string | null {
  if (!phone) return null
  return phone.replace(/(\d{3})\d{4}(\d{4})/, '$1****$2')
}

function fallbackDoctorName(phone: string | null): string {
  const masked = maskPhone(phone)
  return masked ? `医生 ${masked}` : '医生'
}

export function normalizeRemoteDoctor(doctorId: string, payload: RemoteDoctorPayload) {
  const phone = trimNullable(payload.phone)
  const name = trimNullable(payload.name) ?? fallbackDoctorName(phone)
  return {
    id: trimNullable(payload.doctorId) ?? doctorId,
    doctorInviteCode: trimNullable(payload.doctorInviteCode),
    name,
    title: trimNullable(payload.title),
    hospital: trimNullable(payload.hospital),
    department: trimNullable(payload.department),
    avatarUrl: trimNullable(payload.avatarUrl),
    phone,
  }
}

export async function upsertDoctorProfile(input: {
  id: string
  doctorInviteCode?: string | null
  name: string
  title?: string | null
  hospital?: string | null
  department?: string | null
  avatarUrl?: string | null
  phone?: string | null
}) {
  const db = getDb()
  const now = new Date()
  const [row] = await db.insert(doctors).values({
    id: input.id,
    doctorInviteCode: input.doctorInviteCode ?? null,
    name: input.name,
    title: input.title ?? null,
    hospital: input.hospital ?? null,
    department: input.department ?? null,
    avatarUrl: input.avatarUrl ?? null,
    phone: input.phone ?? null,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: doctors.id,
    set: {
      doctorInviteCode: input.doctorInviteCode ?? null,
      name: input.name,
      title: input.title ?? null,
      hospital: input.hospital ?? null,
      department: input.department ?? null,
      avatarUrl: input.avatarUrl ?? null,
      phone: input.phone ?? null,
      updatedAt: now,
    },
  }).returning()
  return row
}

export async function syncDoctorFromDoctorServer(doctorId: string, logger: Logger) {
  const env = getEnv()
  if (!env.DOCTOR_SERVER_BASE_URL || !env.DOCTOR_SERVER_TOKEN) {
    throw statusError('医生信息同步未配置', 503)
  }

  const payload = await fetchRemoteDoctorProfile({
    doctorId,
    baseUrl: env.DOCTOR_SERVER_BASE_URL,
    token: env.DOCTOR_SERVER_TOKEN,
    logger,
  })
  const normalized = normalizeRemoteDoctor(doctorId, payload)
  if (!trimNullable(payload.name)) {
    logger.warn(
      {
        doctorId,
        remoteDoctorId: trimNullable(payload.doctorId),
        missingFields: ['name'],
        source: env.DOCTOR_SERVER_BASE_URL,
      },
      'doctor sync remote profile missing fields; using fallback values',
    )
  }
  const saved = await upsertDoctorProfile(normalized)
  logger.info({ doctorId: saved.id }, 'doctor profile synced')
  return saved
}

export async function fetchRemoteDoctorProfile(params: {
  doctorId: string
  baseUrl: string
  token: string
  logger: Logger
  timeoutMs?: number
}): Promise<RemoteDoctorPayload> {
  const timeoutMs = params.timeoutMs ?? DOCTOR_SYNC_REQUEST_TIMEOUT_MS
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  const url = `${params.baseUrl.replace(/\/$/, '')}/api/doctor-access/doctors/${encodeURIComponent(params.doctorId)}`

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${params.token}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
    }).catch((err) => {
      params.logger.warn({
        err: err?.name === 'AbortError' ? 'timeout' : (err?.message ?? String(err)),
        doctorId: params.doctorId,
        timeoutMs,
      }, 'doctor sync request failed')
      return null
    })

    if (!res) throw statusError('医生信息同步失败', 502)
    if (!res.ok) {
      params.logger.warn({ doctorId: params.doctorId, status: res.status }, 'doctor sync returned non-OK')
      throw statusError('医生信息同步失败', res.status === 404 ? 404 : 502)
    }

    const payload = await res.json().catch(() => null) as RemoteDoctorPayload | null
    if (!payload || typeof payload !== 'object') {
      throw statusError('医生端返回格式错误', 502)
    }
    return payload
  } finally {
    clearTimeout(timeout)
  }
}

export async function ensureDoctorProfile(doctorId: string, logger: Logger) {
  const db = getDb()
  const existing = await db.query.doctors.findFirst({
    where: eq(doctors.id, doctorId),
  })
  if (
    existing &&
    existing.name &&
    existing.hospital !== undefined &&
    existing.department !== undefined
  ) {
    return existing
  }
  return syncDoctorFromDoctorServer(doctorId, logger)
}
