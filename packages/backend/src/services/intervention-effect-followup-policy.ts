import type {
  InterventionEffectFollowupStatus,
  InterventionMaterialInteractionEvent,
  InterventionMaterialInteractionSource,
} from '@health-agent/shared'

const FOLLOWUP_DELAY_MS = 2 * 60 * 60 * 1000
const LOCAL_FOLLOWUP_DELAY_MS = 10 * 1000
const FOLLOWUP_MAX_ATTEMPTS = 3
export type EffectFollowupDeployEnv = 'local' | 'dev' | 'sit' | 'prod'

export function shouldScheduleEffectFollowup(params: {
  event: InterventionMaterialInteractionEvent
  source: InterventionMaterialInteractionSource
  existingFollowStartedAt: Date | null | undefined
}): boolean {
  void params
  return false
}

export function getEffectFollowupDelayMs(deployEnv: EffectFollowupDeployEnv): number {
  return deployEnv === 'local' || deployEnv === 'dev'
    ? LOCAL_FOLLOWUP_DELAY_MS
    : FOLLOWUP_DELAY_MS
}

export function calculateEffectFollowupDueAt(now: Date, deployEnv: EffectFollowupDeployEnv): Date {
  return new Date(now.getTime() + getEffectFollowupDelayMs(deployEnv))
}

export function buildEffectFollowupRoute(sessionId: string, messageId: string): string {
  return `/chat/${sessionId}?focusMessageId=${encodeURIComponent(messageId)}`
}

export function nextEffectFollowupFailureStatus(attemptCountAfterFailure: number): InterventionEffectFollowupStatus {
  return attemptCountAfterFailure >= FOLLOWUP_MAX_ATTEMPTS ? 'failed' : 'pending'
}

export function sanitizeEffectFollowupQuestion(raw: string | null | undefined): string {
  const fallback = '练习后现在感觉有没有好一点？如果不适明显加重，请及时联系医生或就医。'
  const trimmed = raw
    ?.replace(/```[\s\S]*?```/g, '')
    .trim()
  if (!trimmed) return fallback

  const normalized = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[-*]\s*/, ''))
    .filter(Boolean)
    .join(' ')
    .replace(/^["'“”]+|["'“”]+$/g, '')
    .slice(0, 120)
    .trim()

  if (!normalized) return fallback
  if (/[<>{}]/.test(normalized)) return fallback
  if (/(乳腺癌|化疗|放疗|靶向|内分泌|他莫昔芬|来曲唑|阿那曲唑|依西美坦|卡培他滨|诊断|处方|用药方案)/.test(normalized)) {
    return fallback
  }
  return normalized
}
