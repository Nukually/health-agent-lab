import type {
  ApiResponse,
  ClientContext,
  ClientExperienceResponse,
} from '@health-agent/shared'
import { getNativeReadyInfo, hasNativeBridge } from './lib/nativeBridge.js'
import { refreshAccessToken } from './services/api.js'
import { useStore } from './stores/index.js'

function normalizeNavigatorPlatform(): string {
  if (typeof navigator === 'undefined') return 'h5'
  return 'h5'
}

function configuredClientSurface(): string | null {
  return (import.meta as unknown as { env?: { VITE_HEALTH_AGENT_CLIENT_SURFACE?: string } })
    .env?.VITE_HEALTH_AGENT_CLIENT_SURFACE ?? null
}

export function buildClientExperienceContext(): ClientContext {
  const ready = getNativeReadyInfo()
  const nativePlatform = typeof ready?.platform === 'string' ? ready.platform : null
  const nativeBridgeAvailable = hasNativeBridge()
  const configuredSurface = configuredClientSurface()

  return {
    surface: configuredSurface,
    platform: configuredSurface || nativePlatform || normalizeNavigatorPlatform(),
    source: configuredSurface ? 'start_sh' : nativePlatform || nativeBridgeAvailable ? 'native_bridge' : 'navigator',
    appVersion: ready?.appVersion ?? null,
    versionCode: ready?.versionCode ?? null,
    bridgeVersion: ready?.bridgeVersion ?? ready?.version ?? null,
    h5BuildVersion: (import.meta as unknown as { env?: { VITE_CX_BUILD_VERSION?: string } })
      .env?.VITE_CX_BUILD_VERSION ?? null,
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : null,
  }
}

function appendParam(params: URLSearchParams, key: string, value: unknown) {
  if (value === null || value === undefined || value === '') return
  params.set(key, String(value))
}

async function fetchClientExperience(context: ClientContext, token: string | null): Promise<Response | null> {
  const params = new URLSearchParams()
  appendParam(params, 'platform', context.platform)
  appendParam(params, 'surface', context.surface)
  appendParam(params, 'source', context.source)
  appendParam(params, 'appVersion', context.appVersion)
  appendParam(params, 'versionCode', context.versionCode)
  appendParam(params, 'bridgeVersion', context.bridgeVersion)
  appendParam(params, 'h5BuildVersion', context.h5BuildVersion)

  const headers: Record<string, string> = {
    'X-CX-Client-Context': JSON.stringify(context),
  }
  if (token) {
    headers.Authorization = `Bearer ${token}`
  }

  const response = await fetch(`/api/client/experience?${params.toString()}`, {
    credentials: 'same-origin',
    cache: 'no-store',
    headers,
  }).catch(() => null)
  return response
}

export async function refreshClientExperienceSnapshot(): Promise<void> {
  const context = buildClientExperienceContext()
  let token = useStore.getState().token
  let response = await fetchClientExperience(context, token)
  if (response?.status === 401 && token) {
    token = await refreshAccessToken()
    response = await fetchClientExperience(context, token)
  }
  if (!response?.ok) return

  const body = await response.json().catch(() => null) as ApiResponse<ClientExperienceResponse> | null
  const data = body?.data
  if (!data) return

  useStore.getState().setFeatureSnapshot(data.features)
  useStore.getState().setClientExperienceSnapshot(data.experience)
  useStore.getState().setUserSource(data.userSource ?? null)
  if (data.appDownloads) {
    useStore.getState().setAppDownloads(data.appDownloads)
  }
}
