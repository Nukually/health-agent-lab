import {
  featureSignature,
  resolveFeatureProfile,
  resolveFeatureSnapshot,
  type FeatureSubject,
  type FeatureProfile,
  type FeatureSnapshot,
} from '@health-agent/shared'
import { getEnv } from './env.js'
import { getDoctorEntryDoctorIdForUser } from './services/doctor-binding.js'

function parsePhoneAllowlist(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  )
}

function defaultProfileFromDeployEnv(): FeatureProfile {
  const env = getEnv()
  if (env.DEPLOY_ENV === 'prod') return 'prod'
  if (env.DEPLOY_ENV === 'sit') return 'sit'
  return 'dev'
}

export function isMaterialUploadAdminSubjectAllowed(subject: FeatureSubject | null | undefined): boolean {
  const env = getEnv()
  const allowlist = parsePhoneAllowlist(env.INTERVENTION_EDITOR_PHONES)
  if (allowlist.size === 0) {
    return env.DEPLOY_ENV === 'local'
  }
  return Boolean(subject?.phone && allowlist.has(subject.phone))
}

export function getBackendFeatureSnapshot(subject?: FeatureSubject | null): FeatureSnapshot {
  const env = getEnv()
  const profile = env.DEPLOY_ENV === 'prod'
    ? 'prod'
    : resolveFeatureProfile(env.HEALTH_AGENT_FEATURE_PROFILE, defaultProfileFromDeployEnv())

  const base = resolveFeatureSnapshot({ profile })
  if (!subject) {
    return base
  }

  const overrides = base.features.materialUploadAdmin
    ? { materialUploadAdmin: isMaterialUploadAdminSubjectAllowed(subject) }
    : undefined

  return resolveFeatureSnapshot({
    profile,
    subject,
    overrides,
  })
}

export async function getBackendFeatureSnapshotForUser(subject: {
  userId: string
  phone?: string | null
}): Promise<FeatureSnapshot> {
  const doctorId = await getDoctorEntryDoctorIdForUser(subject.userId)
  return getBackendFeatureSnapshot({ ...subject, doctorId })
}

export function getBackendFeatureSignature(): string {
  return featureSignature(getBackendFeatureSnapshot())
}
