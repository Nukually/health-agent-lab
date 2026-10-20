import {
  FEATURE_KEYS,
  resolveFeatureProfile,
  resolveClientExperienceSnapshot,
  resolveFeatureSnapshot,
  type AppDownloadUrls,
  type ClientExperienceSnapshot,
  type ConsentType,
  type FeatureKey,
  type FeatureSnapshot,
  type LoginResponse,
  type UserChannelSourceInfo,
  type UserConsent,
  type UserProfile,
} from '@health-agent/shared'
import type { StateCreator } from 'zustand'
import { clearNativeAuthToken } from '../../lib/nativeAuth.js'
import { frontendFeatureSnapshot } from '../../features.js'

const TOKEN_KEY = 'cx-token'
const AUTH_USER_KEY = 'cx-auth-user'
const REFRESH_SESSION_MARKER_KEY = 'cx-refresh-session'
const CONSENTS_KEY = 'cx-consents'
const NEEDS_PROFILE_KEY = 'cx-needs-profile'
const REQUIRE_COMPLETE_PROFILE_KEY = 'cx-require-complete-profile'
const FEATURE_SNAPSHOT_KEY = 'cx-feature-snapshot'
const CLIENT_EXPERIENCE_SNAPSHOT_KEY = 'cx-client-experience-snapshot'
const USER_SOURCE_KEY = 'cx-user-source'
const ANONYMOUS_FEATURE_SNAPSHOT = resolveFeatureSnapshot({
  profile: frontendFeatureSnapshot.profile,
  overrides: {
    ...frontendFeatureSnapshot.features,
    myDoctorEntry: false,
    materialUploadAdmin: false,
  },
})
const ANONYMOUS_CLIENT_EXPERIENCE_SNAPSHOT = resolveClientExperienceSnapshot({
  profile: frontendFeatureSnapshot.profile,
  client: { surface: 'h5' },
})
const EMPTY_APP_DOWNLOADS: AppDownloadUrls = {
  android: '',
  ios: '',
  harmony: '',
}

function readStoredConsents(): UserConsent[] {
  try {
    const raw = localStorage.getItem(CONSENTS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeStoredConsents(consents: UserConsent[]) {
  localStorage.setItem(CONSENTS_KEY, JSON.stringify(consents))
}

function readStoredNeedsProfile(): boolean {
  return localStorage.getItem(NEEDS_PROFILE_KEY) === 'true'
}

function writeStoredNeedsProfile(needsProfile: boolean) {
  localStorage.setItem(NEEDS_PROFILE_KEY, needsProfile ? 'true' : 'false')
}

function readStoredRequireCompleteProfile(): boolean {
  return localStorage.getItem(REQUIRE_COMPLETE_PROFILE_KEY) === 'true'
}

function writeStoredRequireCompleteProfile(requireCompleteProfile: boolean) {
  localStorage.setItem(REQUIRE_COMPLETE_PROFILE_KEY, requireCompleteProfile ? 'true' : 'false')
}

function readStoredFeatureSnapshot(): FeatureSnapshot {
  try {
    const raw = localStorage.getItem(FEATURE_SNAPSHOT_KEY)
    if (!raw) return ANONYMOUS_FEATURE_SNAPSHOT
    const parsed = JSON.parse(raw) as { profile?: string; features?: Record<string, unknown> }
    const storedProfile = resolveFeatureProfile(parsed.profile, frontendFeatureSnapshot.profile)
    if (storedProfile !== frontendFeatureSnapshot.profile) {
      localStorage.removeItem(FEATURE_SNAPSHOT_KEY)
      return ANONYMOUS_FEATURE_SNAPSHOT
    }
    const overrides: Partial<Record<FeatureKey, boolean>> = {}
    for (const key of FEATURE_KEYS) {
      const value = parsed.features?.[key]
      if (typeof value === 'boolean') overrides[key] = value
    }
    return resolveFeatureSnapshot({
      profile: storedProfile,
      overrides,
    })
  } catch {
    return ANONYMOUS_FEATURE_SNAPSHOT
  }
}

function writeStoredFeatureSnapshot(features: FeatureSnapshot) {
  localStorage.setItem(FEATURE_SNAPSHOT_KEY, JSON.stringify(features))
}

function readStoredClientExperienceSnapshot(): ClientExperienceSnapshot {
  try {
    const raw = localStorage.getItem(CLIENT_EXPERIENCE_SNAPSHOT_KEY)
    if (!raw) return ANONYMOUS_CLIENT_EXPERIENCE_SNAPSHOT
    const parsed = JSON.parse(raw) as ClientExperienceSnapshot
    if (!parsed || typeof parsed.signature !== 'string') {
      localStorage.removeItem(CLIENT_EXPERIENCE_SNAPSHOT_KEY)
      return ANONYMOUS_CLIENT_EXPERIENCE_SNAPSHOT
    }
    return parsed
  } catch {
    return ANONYMOUS_CLIENT_EXPERIENCE_SNAPSHOT
  }
}

function writeStoredClientExperienceSnapshot(experience: ClientExperienceSnapshot) {
  localStorage.setItem(CLIENT_EXPERIENCE_SNAPSHOT_KEY, JSON.stringify(experience))
}

function readStoredAuthUser(): UserProfile | null {
  try {
    const raw = localStorage.getItem(AUTH_USER_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<UserProfile> | null
    if (!parsed || typeof parsed.id !== 'string') {
      localStorage.removeItem(AUTH_USER_KEY)
      return null
    }
    return {
      id: parsed.id,
      phone: typeof parsed.phone === 'string' ? parsed.phone : '',
      nickname: parsed.nickname ?? null,
      avatarUrl: parsed.avatarUrl ?? null,
      birthday: parsed.birthday ?? null,
      gender: parsed.gender ?? null,
      currentConcern: parsed.currentConcern ?? null,
    }
  } catch {
    localStorage.removeItem(AUTH_USER_KEY)
    return null
  }
}

function writeStoredAuthUser(user: UserProfile) {
  localStorage.setItem(AUTH_USER_KEY, JSON.stringify(user))
}

function readStoredUserSource(): UserChannelSourceInfo | null {
  try {
    const raw = localStorage.getItem(USER_SOURCE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<UserChannelSourceInfo> | null
    if (!parsed || (parsed.type !== 'online' && parsed.type !== null)) return null
    return {
      type: parsed.type,
      channelPartnerName: typeof parsed.channelPartnerName === 'string' ? parsed.channelPartnerName : null,
    }
  } catch {
    localStorage.removeItem(USER_SOURCE_KEY)
    return null
  }
}

function writeStoredUserSource(userSource: UserChannelSourceInfo | null | undefined) {
  if (!userSource) {
    localStorage.removeItem(USER_SOURCE_KEY)
    return
  }
  localStorage.setItem(USER_SOURCE_KEY, JSON.stringify(userSource))
}

export interface AuthSlice {
  authEpoch: number
  token: string | null
  user: UserProfile | null
  features: FeatureSnapshot
  experience: ClientExperienceSnapshot
  appDownloads: AppDownloadUrls
  userSource: UserChannelSourceInfo | null
  needsProfile: boolean
  requireCompleteProfile: boolean
  consents: UserConsent[]

  setAuth: (
    token: string,
    user: UserProfile,
    needsProfile: boolean,
    requireCompleteProfile: boolean,
    consents: UserConsent[],
    features?: FeatureSnapshot,
    userSource?: UserChannelSourceInfo | null,
  ) => void
  syncAuthSession: (data: LoginResponse) => void
  updateAuthUserProfile: (
    profile: Partial<Pick<UserProfile, 'nickname' | 'birthday' | 'gender' | 'currentConcern'>>
  ) => void
  setAccessToken: (token: string) => void
  setFeatureSnapshot: (features: FeatureSnapshot) => void
  setClientExperienceSnapshot: (experience: ClientExperienceSnapshot) => void
  setUserSource: (userSource: UserChannelSourceInfo | null) => void
  setAppDownloads: (appDownloads: AppDownloadUrls) => void
  addConsent: (type: ConsentType, version: string) => void
  skipProfile: () => void
  logout: () => void
}

function createCrossSliceReset() {
  return {
    sessions: [],
    sessionsCursor: null,
    sessionsHasMore: false,
    sessionsLoaded: false,
    loadingSessions: false,
    loadingMoreSessions: false,
    currentSessionId: null,
    messages: [],
    hasMoreMessages: false,
    oldestMessageCursor: null,
    isLoadingOlder: false,
    sessionStreams: {},
    feedbackMap: {},
    favoriteMap: {},
    processDurationMap: {},
    pendingApprovals: [],
    queuedApprovals: [],
    approvalResults: {},
    profileNotices: [],
    lastUserPayload: null,
    userProfile: null,
    medicalProfile: null,
    isLoading: false,
  }
}

export const createAuthSlice: StateCreator<AuthSlice, [], [], AuthSlice> = (set) => ({
  authEpoch: 0,
  token: localStorage.getItem(TOKEN_KEY),
  user: readStoredAuthUser(),
  features: readStoredFeatureSnapshot(),
  experience: readStoredClientExperienceSnapshot(),
  appDownloads: EMPTY_APP_DOWNLOADS,
  userSource: readStoredUserSource(),
  needsProfile: readStoredNeedsProfile(),
  requireCompleteProfile: readStoredRequireCompleteProfile(),
  consents: readStoredConsents(),

  setAuth: (token, user, needsProfile, requireCompleteProfile, consents, features = ANONYMOUS_FEATURE_SNAPSHOT, userSource = null) => {
    localStorage.setItem(TOKEN_KEY, token)
    localStorage.setItem(REFRESH_SESSION_MARKER_KEY, 'true')
    writeStoredAuthUser(user)
    writeStoredConsents(consents)
    writeStoredNeedsProfile(needsProfile)
    writeStoredRequireCompleteProfile(requireCompleteProfile)
    writeStoredFeatureSnapshot(features)
    writeStoredUserSource(userSource)
    ;(set as unknown as (updater: (state: Record<string, unknown>) => Record<string, unknown>) => void)((state) => ({
      authEpoch: Number(state.authEpoch ?? 0) + 1,
      token,
      user,
      features,
      experience: state.experience ?? ANONYMOUS_CLIENT_EXPERIENCE_SNAPSHOT,
      appDownloads: state.appDownloads ?? EMPTY_APP_DOWNLOADS,
      userSource,
      needsProfile,
      requireCompleteProfile,
      consents,
      ...createCrossSliceReset(),
    }))
  },

  syncAuthSession: (data) => {
    localStorage.setItem(TOKEN_KEY, data.token)
    localStorage.setItem(REFRESH_SESSION_MARKER_KEY, 'true')
    writeStoredAuthUser(data.user)
    writeStoredConsents(data.consents ?? [])
    writeStoredNeedsProfile(data.needsProfile)
    writeStoredRequireCompleteProfile(data.requireCompleteProfile ?? false)
    if (data.features) writeStoredFeatureSnapshot(data.features)
    if (data.experience) writeStoredClientExperienceSnapshot(data.experience)
    writeStoredUserSource(data.userSource ?? null)
    set((state) => ({
      token: data.token,
      user: data.user,
      features: data.features ?? state.features,
      experience: data.experience ?? state.experience,
      appDownloads: data.appDownloads ?? state.appDownloads,
      userSource: data.userSource ?? null,
      needsProfile: data.needsProfile,
      requireCompleteProfile: data.requireCompleteProfile ?? false,
      consents: data.consents ?? [],
    }))
  },

  updateAuthUserProfile: (profile) => {
    set((state) => {
      const user = state.user
        ? {
            ...state.user,
            ...profile,
          }
        : state.user
      if (user) writeStoredAuthUser(user)
      return { user }
    })
  },

  setAccessToken: (token) => {
    localStorage.setItem(TOKEN_KEY, token)
    localStorage.setItem(REFRESH_SESSION_MARKER_KEY, 'true')
    set({ token })
  },

  setFeatureSnapshot: (features) => {
    writeStoredFeatureSnapshot(features)
    set({ features })
  },

  setClientExperienceSnapshot: (experience) => {
    writeStoredClientExperienceSnapshot(experience)
    set({ experience })
  },

  setUserSource: (userSource) => {
    writeStoredUserSource(userSource)
    set({ userSource })
  },

  setAppDownloads: (appDownloads) => {
    set({ appDownloads })
  },

  addConsent: (type, version) =>
    set((state) => {
      // 同类型去重后追加最新一条
      const others = state.consents.filter((c) => c.type !== type)
      const next = [...others, { type, version, agreedAt: new Date().toISOString() }]
      writeStoredConsents(next)
      return {
        consents: next,
      }
    }),

  skipProfile: () => {
    writeStoredNeedsProfile(false)
    writeStoredRequireCompleteProfile(false)
    set({ needsProfile: false, requireCompleteProfile: false })
  },

  logout: () => {
    const token = localStorage.getItem(TOKEN_KEY)
    fetch('/api/auth/logout', {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      keepalive: true,
      credentials: 'same-origin',
    }).catch(() => undefined)
    clearNativeAuthToken().catch(() => undefined)

    localStorage.removeItem(TOKEN_KEY)
    localStorage.removeItem(AUTH_USER_KEY)
    localStorage.removeItem(REFRESH_SESSION_MARKER_KEY)
    localStorage.removeItem(CONSENTS_KEY)
    localStorage.removeItem(NEEDS_PROFILE_KEY)
    localStorage.removeItem(REQUIRE_COMPLETE_PROFILE_KEY)
    localStorage.removeItem(FEATURE_SNAPSHOT_KEY)
    localStorage.removeItem(CLIENT_EXPERIENCE_SNAPSHOT_KEY)
    localStorage.removeItem(USER_SOURCE_KEY)
    ;(set as unknown as (updater: (state: Record<string, unknown>) => Record<string, unknown>) => void)((state) => ({
      authEpoch: Number(state.authEpoch ?? 0) + 1,
      token: null,
      user: null,
      features: ANONYMOUS_FEATURE_SNAPSHOT,
      experience: ANONYMOUS_CLIENT_EXPERIENCE_SNAPSHOT,
      appDownloads: EMPTY_APP_DOWNLOADS,
      userSource: null,
      needsProfile: false,
      requireCompleteProfile: false,
      consents: [],
      ...createCrossSliceReset(),
    }))
    // 真正的根因是异步请求竞态：切账号后旧请求晚到会把上一账号的侧栏/消息重新写回 store。
    // 所以这里除了硬刷新，还要先把整个前端会话态同步清零；即便旧 bundle 或未经过 logout
    // 也不会继续复用上一账号的缓存。
    if (typeof window !== 'undefined') {
      window.location.replace('/login')
    }
  },
})
