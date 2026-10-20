// === User Consent (用户协议 / 隐私政策 / 健康档案二次授权) ===

export type ConsentType = 'login_agreement' | 'health_profile'

export const CONSENT_TYPES = {
  LOGIN: 'login_agreement' as const,
  HEALTH_PROFILE: 'health_profile' as const,
}

// 版本升级后：前端 version 与用户最近记录不匹配，会重新触发授权流程
export const CONSENT_VERSIONS: Record<ConsentType, string> = {
  login_agreement: 'demo-2026-10-20',
  health_profile: 'demo-2026-10-20',
}

export interface UserConsent {
  type: ConsentType
  version: string
  agreedAt: string
}

export interface AcceptConsentRequest {
  type: ConsentType
  version: string
}
