import {
  DEFAULT_FEATURE_PROFILE,
  resolveFeatureProfile,
  type FeatureProfile,
} from './features.js'

export type ClientSurface = 'h5' | 'ios' | 'android' | 'harmony'

export type UiReleaseId = 'current' | 'main-20260524'

export type UiVariantKey = 'default' | 'legacy-20260524'

export type ChatContractVersion = 'chat.v1'
export type MessageContractVersion = 'message.v1'

export interface ContractVersion {
  chat: ChatContractVersion
  message: MessageContractVersion
}

export interface ClientContext {
  surface?: ClientSurface | string | null
  platform?: string | null
  source?: string | null
  appVersion?: string | null
  versionCode?: string | number | null
  bridgeVersion?: string | null
  h5BuildVersion?: string | null
  userAgent?: string | null
}

export interface ClientExperienceSnapshot {
  profile: FeatureProfile
  surface: ClientSurface
  uiReleaseId: UiReleaseId
  uiVariant: UiVariantKey
  contractVersion: ContractVersion
  legacyUiRef?: string
  signature: string
}

export interface ResolveClientExperienceSnapshotInput {
  profile?: FeatureProfile | string | null
  client?: ClientContext | null
}

export const CURRENT_UI_RELEASE_ID: UiReleaseId = 'current'
export const LEGACY_20260524_UI_RELEASE_ID: UiReleaseId = 'main-20260524'
export const LEGACY_20260524_UI_REF = '47bfd404c8c77ecf1db548de23de58d7375e49bf'

const DEFAULT_CONTRACT_VERSION: ContractVersion = {
  chat: 'chat.v1',
  message: 'message.v1',
}

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

export function resolveClientSurface(client: ClientContext | null | undefined): ClientSurface {
  const explicit = normalizeText(client?.surface)
  if (explicit === 'h5' || explicit === 'web' || explicit === 'browser') return 'h5'
  if (explicit === 'ios' || explicit === 'iphone' || explicit === 'ipad') return 'ios'
  if (explicit === 'android') return 'android'
  if (explicit === 'harmony' || explicit === 'harmonyos' || explicit === 'openharmony') return 'harmony'

  const platform = normalizeText(client?.platform)
  if (platform === 'ios' || platform === 'iphone' || platform === 'ipad') return 'ios'
  if (platform === 'android') return 'android'
  if (platform === 'harmony' || platform === 'harmonyos' || platform === 'hmos' || platform === 'openharmony') {
    return 'harmony'
  }

  const ua = client?.userAgent ?? ''
  if (/HarmonyOS|OpenHarmony|ArkWeb/i.test(ua)) return 'harmony'
  if (/Android/i.test(ua)) return 'android'
  if (/iPad|iPhone|iPod/i.test(ua)) return 'ios'
  return 'h5'
}

function resolveUiRelease(): Pick<ClientExperienceSnapshot, 'uiReleaseId' | 'uiVariant' | 'legacyUiRef'> {
  return {
    uiReleaseId: CURRENT_UI_RELEASE_ID,
    uiVariant: 'default',
  }
}

export function clientExperienceSignature(snapshot: Omit<ClientExperienceSnapshot, 'signature'>): string {
  return [
    'client-experience-v1',
    snapshot.profile,
    snapshot.surface,
    snapshot.uiReleaseId,
    snapshot.uiVariant,
    snapshot.contractVersion.chat,
    snapshot.contractVersion.message,
  ].join(':')
}

export function resolveClientExperienceSnapshot(
  input: ResolveClientExperienceSnapshotInput = {},
): ClientExperienceSnapshot {
  const profile = resolveFeatureProfile(input.profile, DEFAULT_FEATURE_PROFILE)
  const surface = resolveClientSurface(input.client)
  const release = resolveUiRelease()
  const base = {
    profile,
    surface,
    ...release,
    contractVersion: DEFAULT_CONTRACT_VERSION,
  }

  return {
    ...base,
    signature: clientExperienceSignature(base),
  }
}

export const DEFAULT_CLIENT_EXPERIENCE_SNAPSHOT = resolveClientExperienceSnapshot({
  profile: DEFAULT_FEATURE_PROFILE,
  client: { surface: 'h5' },
})
