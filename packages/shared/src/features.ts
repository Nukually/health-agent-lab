export type FeatureProfile = 'dev' | 'sit' | 'prod'

export type FeatureKey =
  | 'healthEducationPlaza'
  | 'myDoctorEntry'
  | 'healthEducationFavorites'
  | 'materialUploadAdmin'
  | 'agentScheduledTasks'
  | 'interventionCompletionReminderOffer'
  | 'checkInRecords'
  | 'llmContextDashboard'
  | 'chatTtsControl'
  | 'nativeDebugEntry'
  | 'h5AppDownloadBanner'
  | 'MEMORY_ENABLE_PERSIST'

export interface FeatureSubject {
  userId?: string | null
  phone?: string | null
  doctorId?: string | null
  [key: string]: unknown
}

export interface FeatureSnapshot {
  profile: FeatureProfile
  features: Record<FeatureKey, boolean>
}

export interface ResolveFeatureSnapshotInput {
  profile?: FeatureProfile | string | null
  overrides?: Partial<Record<FeatureKey, boolean>> | null
  subject?: FeatureSubject | null
}

export const FEATURE_PROFILES = ['dev', 'sit', 'prod'] as const satisfies readonly FeatureProfile[]

export const FEATURE_KEYS = [
  'healthEducationPlaza',
  'myDoctorEntry',
  'healthEducationFavorites',
  'materialUploadAdmin',
  'agentScheduledTasks',
  'interventionCompletionReminderOffer',
  'checkInRecords',
  'llmContextDashboard',
  'chatTtsControl',
  'nativeDebugEntry',
  'h5AppDownloadBanner',
  'MEMORY_ENABLE_PERSIST',
] as const satisfies readonly FeatureKey[]

// Prompt cache signature tracks the existing prompt/tool-impacting feature surface.
// Pure frontend entry switches stay in FeatureSnapshot but do not reset agent prefix cache.
const FEATURE_SIGNATURE_KEYS = [
  'healthEducationPlaza',
  'healthEducationFavorites',
  'materialUploadAdmin',
  'agentScheduledTasks',
  'checkInRecords',
  'llmContextDashboard',
  'MEMORY_ENABLE_PERSIST',
] as const satisfies readonly FeatureKey[]

export const DEFAULT_FEATURE_PROFILE: FeatureProfile = 'dev'

const FEATURE_DEFAULTS: Record<FeatureProfile, Record<FeatureKey, boolean>> = {
  dev: {
    healthEducationPlaza: true,
    myDoctorEntry: false,
    healthEducationFavorites: true,
    materialUploadAdmin: true,
    agentScheduledTasks: true,
    interventionCompletionReminderOffer: true,
    checkInRecords: true,
    llmContextDashboard: true,
    chatTtsControl: true,
    nativeDebugEntry: true,
    h5AppDownloadBanner: false,
    MEMORY_ENABLE_PERSIST: false,
  },
  sit: {
    healthEducationPlaza: true,
    myDoctorEntry: false,
    healthEducationFavorites: true,
    materialUploadAdmin: false,
    agentScheduledTasks: true,
    interventionCompletionReminderOffer: true,
    checkInRecords: true,
    llmContextDashboard: false,
    chatTtsControl: true,
    nativeDebugEntry: false,
    h5AppDownloadBanner: false,
    MEMORY_ENABLE_PERSIST: false,
  },
  prod: {
    healthEducationPlaza: false,
    myDoctorEntry: false,
    healthEducationFavorites: false,
    materialUploadAdmin: false,
    agentScheduledTasks: true,
    interventionCompletionReminderOffer: false,
    checkInRecords: true,
    llmContextDashboard: false,
    chatTtsControl: true,
    nativeDebugEntry: false,
    h5AppDownloadBanner: false,
    MEMORY_ENABLE_PERSIST: false,
  },
}

export function resolveFeatureProfile(
  value: FeatureProfile | string | null | undefined,
  fallback: FeatureProfile = DEFAULT_FEATURE_PROFILE,
): FeatureProfile {
  return FEATURE_PROFILES.includes(value as FeatureProfile)
    ? value as FeatureProfile
    : fallback
}

function hasDoctorSubject(subject: FeatureSubject | null | undefined): boolean {
  return typeof subject?.doctorId === 'string' && subject.doctorId.trim().length > 0
}

export function resolveFeatureSnapshot(input: ResolveFeatureSnapshotInput = {}): FeatureSnapshot {
  const profile = resolveFeatureProfile(input.profile)
  const defaults = FEATURE_DEFAULTS[profile]
  const features = { ...defaults }

  if (input.subject) {
    features.myDoctorEntry = hasDoctorSubject(input.subject)
  }

  for (const key of FEATURE_KEYS) {
    const override = input.overrides?.[key]
    if (typeof override === 'boolean') {
      features[key] = override
    }
  }

  return { profile, features }
}

export const DEFAULT_FEATURE_SNAPSHOT = resolveFeatureSnapshot({
  profile: DEFAULT_FEATURE_PROFILE,
})

export function isFeatureEnabled(snapshot: FeatureSnapshot, key: FeatureKey): boolean {
  return snapshot.features[key] === true
}

export function featureSignature(snapshot: FeatureSnapshot): string {
  const bits = FEATURE_SIGNATURE_KEYS
    .map((key) => `${key}:${snapshot.features[key] ? '1' : '0'}`)
    .join(',')
  return `feature-v1:${snapshot.profile}:${bits}`
}
