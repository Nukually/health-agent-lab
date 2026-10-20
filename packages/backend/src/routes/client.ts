import { Hono } from 'hono'
import type { Context } from 'hono'
import { z } from 'zod'
import {
  resolveClientExperienceSnapshot,
  type ApiResponse,
  type ClientContext,
  type ClientExperienceResponse,
  type FeatureSnapshot,
} from '@health-agent/shared'
import { getEnv, type Env } from '../env.js'
import { getBackendFeatureSnapshot, getBackendFeatureSnapshotForUser } from '../features.js'
import { verifyToken } from '../services/auth.js'
import { getUserChannelSourceInfo } from '../services/channel.js'

const clientRoutes = new Hono()

const clientContextSchema = z.object({
  surface: z.string().trim().max(40).nullable().optional(),
  platform: z.string().trim().max(40).nullable().optional(),
  source: z.string().trim().max(40).nullable().optional(),
  appVersion: z.string().trim().max(80).nullable().optional(),
  versionCode: z.union([z.string().trim().max(80), z.number()]).nullable().optional(),
  bridgeVersion: z.string().trim().max(40).nullable().optional(),
  h5BuildVersion: z.string().trim().max(80).nullable().optional(),
  userAgent: z.string().trim().max(512).nullable().optional(),
}) satisfies z.ZodType<ClientContext>

function parseHeaderContext(raw: string | undefined): Partial<ClientContext> {
  if (!raw) return {}
  try {
    const parsed = clientContextSchema.partial().safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : {}
  } catch {
    return {}
  }
}

function parseQueryContext(c: Context): Partial<ClientContext> {
  const parsed = clientContextSchema.partial().safeParse({
    surface: c.req.query('surface') || undefined,
    platform: c.req.query('platform') || undefined,
    source: c.req.query('source') || undefined,
    appVersion: c.req.query('appVersion') || undefined,
    versionCode: c.req.query('versionCode') || undefined,
    bridgeVersion: c.req.query('bridgeVersion') || undefined,
    h5BuildVersion: c.req.query('h5BuildVersion') || undefined,
    userAgent: c.req.query('userAgent') || undefined,
  })
  return parsed.success ? parsed.data : {}
}

async function resolveClientContext(c: Context): Promise<{
  features: FeatureSnapshot
  userSource: Awaited<ReturnType<typeof getUserChannelSourceInfo>> | null
} | null> {
  const authHeader = c.req.header('Authorization')
  if (!authHeader) {
    return {
      features: getBackendFeatureSnapshot(),
      userSource: null,
    }
  }
  if (!authHeader.startsWith('Bearer ')) return null

  const token = authHeader.slice(7)
  try {
    const payload = verifyToken(token)
    const [features, userSource] = await Promise.all([
      getBackendFeatureSnapshotForUser({
        userId: payload.userId,
        phone: payload.phone,
      }),
      getUserChannelSourceInfo(payload.userId),
    ])
    return { features, userSource }
  } catch (err) {
    c.get('logger')?.warn({ err: err instanceof Error ? err.message : String(err) }, 'client experience auth failed')
    return null
  }
}

function firstConfiguredUrl(...values: Array<string | undefined>): string {
  for (const value of values) {
    const normalized = typeof value === 'string' ? value.trim() : ''
    if (normalized) return normalized
  }
  return ''
}

export function resolveClientAppDownloads(env: Pick<
  Env,
  | 'HEALTH_AGENT_ANDROID_APK_URL'
  | 'HEALTH_AGENT_TESTFLIGHT_URL'
  | 'HEALTH_AGENT_HARMONY_BETA_URL'
  | 'VITE_HEALTH_AGENT_ANDROID_APK_URL'
  | 'VITE_HEALTH_AGENT_TESTFLIGHT_URL'
  | 'VITE_HEALTH_AGENT_HARMONY_BETA_URL'
>) {
  return {
    android: firstConfiguredUrl(env.HEALTH_AGENT_ANDROID_APK_URL, env.VITE_HEALTH_AGENT_ANDROID_APK_URL),
    ios: firstConfiguredUrl(env.HEALTH_AGENT_TESTFLIGHT_URL, env.VITE_HEALTH_AGENT_TESTFLIGHT_URL),
    harmony: firstConfiguredUrl(env.HEALTH_AGENT_HARMONY_BETA_URL, env.VITE_HEALTH_AGENT_HARMONY_BETA_URL),
  }
}

clientRoutes.get('/experience', async (c) => {
  const headerContext = parseHeaderContext(c.req.header('X-CX-Client-Context'))
  const queryContext = parseQueryContext(c)
  const userAgent = c.req.header('user-agent') || null
  const clientContext: ClientContext = {
    userAgent,
    ...headerContext,
    ...queryContext,
  }
  const resolved = await resolveClientContext(c)
  if (!resolved) {
    return c.json({ success: false, error: '登录已过期，请重新登录' }, 401)
  }
  const experience = resolveClientExperienceSnapshot({
    profile: resolved.features.profile,
    client: clientContext,
  })
  const payload: ApiResponse<ClientExperienceResponse> = {
    success: true,
    data: {
      features: resolved.features,
      experience,
      userSource: resolved.userSource,
      appDownloads: resolveClientAppDownloads(getEnv()),
    },
  }

  return c.json(payload)
})

export default clientRoutes
