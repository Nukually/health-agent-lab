export const ANALYTICS_EVENT_NAMES = [
  'personal_info_time',
  'profile_approval_card_triggered',
  'profile_approval_card_approved',
  'profile_approval_card_rejected',
  'schedule_confirmation_confirmed',
  'schedule_confirmation_rejected',
  'communication_card_triggered',
  'communication_card_save_clicked',
  'intervention_material_save_clicked',
  'intervention_material_follow_started',
  'intervention_material_follow_progress',
  'intervention_material_follow_completed',
  'video_resource_save_clicked',
  'video_resource_follow_started',
  'video_resource_follow_progress',
  'video_resource_follow_session_ended',
  'video_resource_follow_completed',
  'video_resource_playback_control_tapped',
  'video_resource_fullscreen_changed',
  'user_login',
  'font_environment_snapshot',
  'recommended_question_exposed',
  'recommended_question_clicked',
  'message_copy_text',
  'message_copy_link',
  'message_play_voice',
  'message_favorite_save',
  'message_favorite_remove',
  'chat_request_completed',
] as const

export type AnalyticsEventName = (typeof ANALYTICS_EVENT_NAMES)[number]

export const NATIVE_ANALYTICS_EVENT_NAMES = [
  'mobile_app_launch_started',
  'mobile_app_launch_completed',
  'mobile_h5_ready',
  'mobile_webview_load_failed',
  'app_environment_snapshot',
] as const

export type NativeAnalyticsEventName = (typeof NATIVE_ANALYTICS_EVENT_NAMES)[number]

export type NativeAnalyticsPlatform = 'android' | 'ios' | 'harmony'

export interface NativeAnalyticsGeoContext {
  source?: 'device_coarse' | 'unknown' | null
  country?: string | null
  province?: string | null
  city?: string | null
  precision?: 'country' | 'province' | 'city' | 'unknown' | null
  resolvedAt?: string | null
}

export interface NativeAnalyticsAppContext {
  platform: NativeAnalyticsPlatform
  appSessionId?: string | null
  appVersion?: string | null
  versionCode?: string | number | null
  buildNumber?: string | number | null
  channel?: string | null
}

export interface NativeAnalyticsDeviceContext {
  osVersion?: string | null
  sdkInt?: number | null
  manufacturer?: string | null
  model?: string | null
  webViewVersion?: string | null
  bridgeVersion?: string | null
  bridgeModules?: string[] | null
}

export interface NativeAnalyticsEventItem {
  eventName: NativeAnalyticsEventName
  /** 客户端生成的幂等键；同一 installId + eventName + dedupeKey 只记录一次。 */
  dedupeKey?: string | null
  entityType?: string | null
  entityId?: string | null
  startedAt?: string | null
  endedAt?: string | null
  durationMs?: number | null
  properties?: Record<string, unknown> | null
  geo?: NativeAnalyticsGeoContext | null
}

export interface NativeAnalyticsEventsRequest {
  installId: string
  app: NativeAnalyticsAppContext
  device?: NativeAnalyticsDeviceContext | null
  events: NativeAnalyticsEventItem[]
}

export interface NativeAnalyticsEventRecord {
  id: string
  installId: string
  userId: string | null
  eventName: NativeAnalyticsEventName
  dedupeKey: string | null
  entityType: string | null
  entityId: string | null
  platform: NativeAnalyticsPlatform
  appVersion: string | null
  versionCode: string | null
  buildNumber: string | null
  channel: string | null
  osVersion: string | null
  sdkInt: number | null
  manufacturer: string | null
  model: string | null
  webViewVersion: string | null
  bridgeVersion: string | null
  bridgeModules: string[] | null
  geoSource: string | null
  geoCountry: string | null
  geoProvince: string | null
  geoCity: string | null
  geoPrecision: string | null
  startedAt: string | null
  endedAt: string | null
  durationMs: number | null
  properties: Record<string, unknown> | null
  createdAt: string
}

export interface AnalyticsEventRequest {
  eventName: AnalyticsEventName
  /** 用于客户端/后端幂等去重；同一用户 + eventName + dedupeKey 只记录一次。 */
  dedupeKey?: string | null
  sessionId?: string | null
  entityType?: string | null
  entityId?: string | null
  startedAt?: string | null
  endedAt?: string | null
  durationMs?: number | null
  properties?: Record<string, unknown> | null
}

export interface AnalyticsEventRecord {
  id: string
  userId: string
  eventName: AnalyticsEventName
  dedupeKey: string | null
  sessionId: string | null
  entityType: string | null
  entityId: string | null
  startedAt: string | null
  endedAt: string | null
  durationMs: number | null
  properties: Record<string, unknown> | null
  createdAt: string
}
