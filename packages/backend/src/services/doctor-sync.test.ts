import assert from 'node:assert/strict'
import test from 'node:test'
import { fetchRemoteDoctorProfile, normalizeRemoteDoctor } from './doctor-sync.js'

test('normalizeRemoteDoctor uses stable fallback name when remote name is missing', () => {
  const normalized = normalizeRemoteDoctor('doctor-1', {
    doctorId: 'doctor-1',
    name: null,
    phone: '13800000001',
  })

  assert.equal(normalized.name, '医生 138****0001')
  assert.equal(normalized.phone, '13800000001')
})

test('normalizeRemoteDoctor keeps explicit remote name', () => {
  const normalized = normalizeRemoteDoctor('doctor-1', {
    doctorId: 'doctor-1',
    name: '王医生',
    phone: '13800000001',
  })

  assert.equal(normalized.name, '王医生')
})

test('fetchRemoteDoctorProfile fails quickly when doctor server request times out', async () => {
  const originalFetch = globalThis.fetch
  const logger = {
    warn() {},
    info() {},
  } as any

  try {
    globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        })
      })
    }) as typeof fetch

    await assert.rejects(
      fetchRemoteDoctorProfile({
        doctorId: 'doctor-timeout',
        baseUrl: 'https://doctor.example.test',
        token: 'token',
        logger,
        timeoutMs: 5,
      }),
      (err: any) => err?.status === 502 && /同步失败/.test(err.message),
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})
