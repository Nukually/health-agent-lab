import { useStore } from '../stores/index.js'
import type { ApiResponse, AppDownloadUrls, ClientExperienceSnapshot, FeatureSnapshot, LoginResponse } from '@health-agent/shared'
import { getTrackingContextHeaders } from './trackingContext.js'

const BASE_URL = '/api'
const REFRESH_SESSION_MARKER_KEY = 'cx-refresh-session'

let refreshPromise: Promise<string | null> | null = null
let bootstrapPromise: Promise<void> | null = null
let bootstrapAttempted = false

function shouldSkipAuthMaintenance(path: string): boolean {
  return path.startsWith('/auth/login') ||
    path.startsWith('/auth/send-code') ||
    path.startsWith('/auth/login-consent-status') ||
    path.startsWith('/auth/refresh') ||
    path.startsWith('/auth/bootstrap-session') ||
    path.startsWith('/auth/logout')
}

function syncFeatureSnapshotFromBody(body: unknown) {
  const features = (body as ApiResponse<{ features?: FeatureSnapshot }> | null)?.data?.features
  if (features) {
    useStore.getState().setFeatureSnapshot(features)
  }
  const experience = (body as ApiResponse<{ experience?: ClientExperienceSnapshot }> | null)?.data?.experience
  if (experience) {
    useStore.getState().setClientExperienceSnapshot(experience)
  }
  const appDownloads = (body as ApiResponse<{ appDownloads?: AppDownloadUrls }> | null)?.data?.appDownloads
  if (appDownloads) {
    useStore.getState().setAppDownloads(appDownloads)
  }
}

async function parseAuthResponse(response: Response): Promise<string | null> {
  const body = await response.json().catch(() => null) as ApiResponse<LoginResponse> | null
  syncFeatureSnapshotFromBody(body)
  const data = body?.data
  const token = data?.token
  if (data && typeof token === 'string' && token.length > 0) {
    useStore.getState().syncAuthSession(data)
  }
  return typeof token === 'string' && token.length > 0 ? token : null
}

export async function refreshAccessToken(): Promise<string | null> {
  if (refreshPromise) return refreshPromise

  refreshPromise = (async () => {
    const response = await fetch(`${BASE_URL}/auth/refresh`, {
      method: 'POST',
      headers: getTrackingContextHeaders(),
      credentials: 'same-origin',
      cache: 'no-store',
    }).catch(() => null)

    if (!response?.ok) {
      localStorage.removeItem(REFRESH_SESSION_MARKER_KEY)
      return null
    }

    const token = await parseAuthResponse(response)
    if (!token) return null

    return token
  })().finally(() => {
    refreshPromise = null
  })

  return refreshPromise
}

export async function bootstrapRefreshSessionIfNeeded(): Promise<void> {
  if (bootstrapAttempted || bootstrapPromise) return bootstrapPromise ?? undefined

  const { token, user } = useStore.getState()
  if (!token) return

  if (localStorage.getItem(REFRESH_SESSION_MARKER_KEY) === 'true') {
    if (user) return
    bootstrapAttempted = true
    bootstrapPromise = refreshAccessToken().then(() => undefined).finally(() => {
      bootstrapPromise = null
    })
    return bootstrapPromise
  }

  bootstrapAttempted = true
  bootstrapPromise = (async () => {
    const response = await fetch(`${BASE_URL}/auth/bootstrap-session`, {
      method: 'POST',
      headers: { ...getTrackingContextHeaders(), Authorization: `Bearer ${token}` },
      credentials: 'same-origin',
      cache: 'no-store',
    }).catch(() => null)

    if (!response?.ok) return

    await parseAuthResponse(response)
  })().finally(() => {
    bootstrapPromise = null
  })

  return bootstrapPromise
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  if (!shouldSkipAuthMaintenance(path)) {
    await bootstrapRefreshSessionIfNeeded()
  }

  const token = useStore.getState().token
  const method = (options.method ?? 'GET').toUpperCase()
  const isFormData = typeof FormData !== 'undefined' && options.body instanceof FormData

  const headers: Record<string, string> = {
    ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
    ...getTrackingContextHeaders(),
    ...(options.headers as Record<string, string>),
  }

  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }
  if (method === 'GET') {
    headers['Cache-Control'] = 'no-cache, no-store, max-age=0'
    headers.Pragma = 'no-cache'
  }

  const response = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers,
    credentials: 'same-origin',
    cache: method === 'GET' ? 'no-store' : options.cache,
  })

  if (response.status === 401 && !shouldSkipAuthMaintenance(path)) {
    const refreshedToken = await refreshAccessToken()
    if (refreshedToken) {
      return request<T>(path, options)
    }
  }

  if (response.status === 401) {
    useStore.getState().logout()
    throw new Error('Unauthorized')
  }

  if (!response.ok) {
    const body = await response.json().catch(() => ({
      error: response.status === 413 ? '请求体过大，请减少图片数量后重试' : `HTTP ${response.status}`,
    }))

    // 账号处于注销冷静期 — 除 /account/deletion/cancel 外的业务接口会收到 403
    // 不走这个路径的页面（如 /deletion-pending 自己调 cancel）需要跳转到冷静期页
    if (response.status === 403 && body.code === 'ACCOUNT_PENDING_DELETION') {
      if (typeof window !== 'undefined' && window.location.pathname !== '/deletion-pending') {
        window.location.replace('/deletion-pending')
      }
    }

    const err = new Error(body.error || `HTTP ${response.status}`) as Error & {
      status: number
      code?: string
      retryAfterSeconds?: number
    }
    err.status = response.status
    err.code = body.code
    if (typeof body.retryAfterSeconds === 'number') err.retryAfterSeconds = body.retryAfterSeconds
    throw err
  }

  const body = await response.json()
  syncFeatureSnapshotFromBody(body)
  return body
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined }),
  postForm: <T>(path: string, body: FormData) =>
    request<T>(path, { method: 'POST', body }),
  postKeepalive: (path: string, body?: unknown) => {
    const token = useStore.getState().token
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...getTrackingContextHeaders(),
    }
    if (token) headers.Authorization = `Bearer ${token}`
    return fetch(`${BASE_URL}${path}`, {
      method: 'POST',
      headers,
      body: body ? JSON.stringify(body) : undefined,
      keepalive: true,
      credentials: 'same-origin',
    }).catch(() => undefined)
  },
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PUT', body: body ? JSON.stringify(body) : undefined }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PATCH', body: body ? JSON.stringify(body) : undefined }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
}
