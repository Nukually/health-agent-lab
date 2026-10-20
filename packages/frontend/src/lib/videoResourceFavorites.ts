import type { MedicalRiskVideoResource } from '@health-agent/shared'

export const VIDEO_RESOURCE_FAVORITES_KEY = 'cx:video-resource-favorites'
const FOLLOW_SESSIONS_LIMIT = 20

export type VideoResourceFollowTrigger = 'start' | 'continue' | 'restart'

export interface SavedVideoResourceFollowSession {
  index: number
  startedAt: string
  endedAt: string
  durationSec: number
  startPlayheadSec: number
  endPlayheadSec: number
  trigger: VideoResourceFollowTrigger
}

export interface SavedVideoResourceFavorite {
  id: string
  resource: MedicalRiskVideoResource
  savedAt: string
  followedSec: number
  playheadSec: number
  completedAt: string | null
  followCount: number
  followSessions: SavedVideoResourceFollowSession[]
}

export function getVideoResourceFavoriteId(resource: Pick<MedicalRiskVideoResource, 'providerVideoId' | 'url'>): string {
  return resource.providerVideoId ?? resource.url
}

function isSavedVideoResourceFollowSession(value: unknown): value is SavedVideoResourceFollowSession {
  if (!value || typeof value !== 'object') return false
  const raw = value as Record<string, unknown>
  return typeof raw.index === 'number'
    && typeof raw.startedAt === 'string'
    && typeof raw.endedAt === 'string'
    && typeof raw.durationSec === 'number'
    && typeof raw.startPlayheadSec === 'number'
    && typeof raw.endPlayheadSec === 'number'
    && (raw.trigger === 'start' || raw.trigger === 'continue' || raw.trigger === 'restart')
}

function normalizeVideoResourceFavorite(value: unknown): SavedVideoResourceFavorite | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const resource = raw.resource as Record<string, unknown> | undefined
  const id = raw.id
  const savedAt = raw.savedAt
  const followedSec = raw.followedSec
  const playheadSec = raw.playheadSec
  const completedAt = raw.completedAt
  if (
    typeof id !== 'string'
    || typeof savedAt !== 'string'
    || typeof followedSec !== 'number'
    || (typeof playheadSec !== 'number' && playheadSec !== undefined)
    || (typeof completedAt !== 'string' && completedAt !== null)
    || !resource
    || resource.kind !== 'video_resource'
    || typeof resource.title !== 'string'
    || typeof resource.url !== 'string'
    || typeof resource.durationSec !== 'number'
  ) {
    return null
  }

  const followSessions = Array.isArray(raw.followSessions)
    ? raw.followSessions.filter(isSavedVideoResourceFollowSession).slice(-FOLLOW_SESSIONS_LIMIT)
    : []
  const followCount = typeof raw.followCount === 'number'
    ? Math.max(0, Math.floor(raw.followCount))
    : followSessions.length
  return {
    id,
    resource: resource as unknown as MedicalRiskVideoResource,
    savedAt,
    followedSec: Math.max(0, Math.floor(followedSec)),
    playheadSec: Math.max(0, Math.floor(playheadSec ?? followedSec)),
    completedAt: typeof completedAt === 'string' ? completedAt : null,
    followCount,
    followSessions,
  }
}

export function readVideoResourceFavorites(): SavedVideoResourceFavorite[] {
  try {
    const raw = window.localStorage.getItem(VIDEO_RESOURCE_FAVORITES_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed)
      ? parsed.map(normalizeVideoResourceFavorite).filter((item): item is SavedVideoResourceFavorite => !!item)
      : []
  } catch {
    return []
  }
}

function readRawVideoResourceFavorites(): unknown[] {
  try {
    const raw = window.localStorage.getItem(VIDEO_RESOURCE_FAVORITES_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function hasVideoResourceFavorite(
  resource: Pick<MedicalRiskVideoResource, 'providerVideoId' | 'url'>,
): boolean {
  const id = getVideoResourceFavoriteId(resource)
  return readRawVideoResourceFavorites().some((item) => {
    if (typeof item === 'string') return item === id
    return normalizeVideoResourceFavorite(item)?.id === id
  })
}

export function writeVideoResourceFavorites(values: SavedVideoResourceFavorite[]): void {
  try {
    window.localStorage.setItem(VIDEO_RESOURCE_FAVORITES_KEY, JSON.stringify(values))
  } catch {
    // localStorage unavailable; keep current page state only.
  }
}

export function findVideoResourceFavorite(
  resource: Pick<MedicalRiskVideoResource, 'providerVideoId' | 'url'>,
): SavedVideoResourceFavorite | null {
  const id = getVideoResourceFavoriteId(resource)
  return readVideoResourceFavorites().find((item) => item.id === id) ?? null
}

export function ensureVideoResourceFavoriteSnapshot(
  resource: MedicalRiskVideoResource,
): SavedVideoResourceFavorite | null {
  const existing = findVideoResourceFavorite(resource)
  if (existing) return existing
  return hasVideoResourceFavorite(resource) ? saveVideoResourceFavorite(resource) : null
}

export function saveVideoResourceFavorite(
  resource: MedicalRiskVideoResource,
  patch: Partial<Pick<SavedVideoResourceFavorite, 'followedSec' | 'playheadSec' | 'completedAt' | 'followCount' | 'followSessions'>> = {},
): SavedVideoResourceFavorite {
  const id = getVideoResourceFavoriteId(resource)
  const items = readVideoResourceFavorites()
  const existing = items.find((item) => item.id === id)
  const followSessions = (patch.followSessions ?? existing?.followSessions ?? []).slice(-FOLLOW_SESSIONS_LIMIT)
  const next: SavedVideoResourceFavorite = {
    id,
    resource,
    savedAt: existing?.savedAt ?? new Date().toISOString(),
    followedSec: Math.max(0, Math.floor(patch.followedSec ?? existing?.followedSec ?? 0)),
    playheadSec: Math.max(0, Math.floor(patch.playheadSec ?? existing?.playheadSec ?? existing?.followedSec ?? 0)),
    completedAt: patch.completedAt ?? existing?.completedAt ?? null,
    followCount: Math.max(0, Math.floor(patch.followCount ?? existing?.followCount ?? followSessions.length)),
    followSessions,
  }
  writeVideoResourceFavorites([
    next,
    ...items.filter((item) => item.id !== id),
  ])
  return next
}

export function updateVideoResourceFavoriteProgress(
  resource: MedicalRiskVideoResource,
  followedSec: number,
  playheadSec = followedSec,
  completed = false,
): SavedVideoResourceFavorite | null {
  const existing = findVideoResourceFavorite(resource)
  if (!existing) return null
  return saveVideoResourceFavorite(resource, {
    followedSec: Math.max(existing.followedSec, Math.max(0, Math.floor(followedSec))),
    playheadSec: Math.max(0, Math.floor(playheadSec)),
    completedAt: completed ? new Date().toISOString() : existing.completedAt,
  })
}

export function removeVideoResourceFavorite(id: string): void {
  writeVideoResourceFavorites(readVideoResourceFavorites().filter((item) => item.id !== id))
}
