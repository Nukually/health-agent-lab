export const TRACKING_EVENT_SOURCES = ['h5', 'native', 'backend'] as const
export type TrackingEventSource = (typeof TRACKING_EVENT_SOURCES)[number]

export const TRACKING_EVENT_PLATFORMS = ['h5', 'ios', 'android', 'harmony', 'server'] as const
export type TrackingEventPlatform = (typeof TRACKING_EVENT_PLATFORMS)[number]

export interface TrackingEventV2 {
  eventId: string
  eventName: string
  eventVersion: string
  eventTime: string
  source: TrackingEventSource
  platform?: TrackingEventPlatform | null
  installId?: string | null
  userId?: string | null
  appSessionId?: string | null
  webSessionId?: string | null
  traceId?: string | null
  requestId?: string | null
  chatSessionId?: string | null
  entityType?: string | null
  entityId?: string | null
  route?: string | null
  appVersion?: string | null
  buildNumber?: string | number | null
  channel?: string | null
  properties?: Record<string, unknown> | null
}

export interface TrackingEventsRequestV2 {
  events: TrackingEventV2[]
}

export interface TrackingEventRawRecord {
  id: string
  eventId: string
  eventName: string
  eventVersion: string
  source: TrackingEventSource
  platform: TrackingEventPlatform | null
  installId: string | null
  userId: string | null
  appSessionId: string | null
  webSessionId: string | null
  traceId: string | null
  requestId: string | null
  chatSessionId: string | null
  entityType: string | null
  entityId: string | null
  route: string | null
  appVersion: string | null
  buildNumber: string | null
  channel: string | null
  eventTime: string
  receiveTime: string
  properties: Record<string, unknown> | null
  rawPayload: Record<string, unknown> | null
  createdAt: string
}

export type TrackingEventContractField =
  | 'installId'
  | 'appSessionId'
  | 'webSessionId'
  | 'traceId'
  | 'requestId'
  | 'userId'
  | 'chatSessionId'
  | 'entityType'
  | 'entityId'
  | 'route'

export interface TrackingEventContract {
  eventName: string
  owner: 'h5' | 'native' | 'backend'
  sources: readonly TrackingEventSource[]
  requiredFields?: readonly TrackingEventContractField[]
}

const H5_LEGACY_FIELDS = ['webSessionId'] as const
const NATIVE_LAUNCH_FIELDS = ['installId', 'appSessionId'] as const
const BACKEND_USER_FIELDS = ['userId'] as const
const BACKEND_SESSION_FIELDS = ['userId', 'chatSessionId'] as const
const BACKEND_REQUEST_SESSION_FIELDS = ['userId', 'requestId', 'chatSessionId'] as const

export const TRACKING_EVENT_CONTRACTS = [
  { eventName: 'h5_session_started', owner: 'h5', sources: ['h5'], requiredFields: ['webSessionId'] },
  { eventName: 'page_view', owner: 'h5', sources: ['h5'], requiredFields: ['webSessionId', 'route'] },
  { eventName: 'h5_native_bridge_ready', owner: 'h5', sources: ['h5'], requiredFields: ['webSessionId'] },
  { eventName: 'message_play_voice', owner: 'h5', sources: ['h5'], requiredFields: H5_LEGACY_FIELDS },
  { eventName: 'message_copy_text', owner: 'h5', sources: ['h5'], requiredFields: H5_LEGACY_FIELDS },
  { eventName: 'message_copy_link', owner: 'h5', sources: ['h5'], requiredFields: H5_LEGACY_FIELDS },
  { eventName: 'message_favorite_save', owner: 'h5', sources: ['h5'], requiredFields: H5_LEGACY_FIELDS },
  { eventName: 'message_favorite_remove', owner: 'h5', sources: ['h5'], requiredFields: H5_LEGACY_FIELDS },
  { eventName: 'recommended_question_exposed', owner: 'h5', sources: ['h5'], requiredFields: H5_LEGACY_FIELDS },
  { eventName: 'recommended_question_clicked', owner: 'h5', sources: ['h5'], requiredFields: H5_LEGACY_FIELDS },
  { eventName: 'video_resource_follow_started', owner: 'h5', sources: ['h5'], requiredFields: H5_LEGACY_FIELDS },
  { eventName: 'video_resource_follow_progress', owner: 'h5', sources: ['h5'], requiredFields: H5_LEGACY_FIELDS },
  { eventName: 'video_resource_follow_session_ended', owner: 'h5', sources: ['h5'], requiredFields: H5_LEGACY_FIELDS },
  { eventName: 'video_resource_playback_control_tapped', owner: 'h5', sources: ['h5'], requiredFields: H5_LEGACY_FIELDS },
  { eventName: 'video_resource_fullscreen_changed', owner: 'h5', sources: ['h5'], requiredFields: H5_LEGACY_FIELDS },
  { eventName: 'video_resource_save_clicked', owner: 'h5', sources: ['h5'], requiredFields: H5_LEGACY_FIELDS },
  { eventName: 'font_environment_snapshot', owner: 'h5', sources: ['h5'], requiredFields: H5_LEGACY_FIELDS },
  { eventName: 'personal_info_time', owner: 'h5', sources: ['h5'], requiredFields: H5_LEGACY_FIELDS },
  { eventName: 'mobile_app_launch_started', owner: 'native', sources: ['native'], requiredFields: NATIVE_LAUNCH_FIELDS },
  { eventName: 'mobile_h5_ready', owner: 'native', sources: ['native'], requiredFields: NATIVE_LAUNCH_FIELDS },
  { eventName: 'mobile_app_launch_completed', owner: 'native', sources: ['native'], requiredFields: NATIVE_LAUNCH_FIELDS },
  { eventName: 'mobile_webview_load_failed', owner: 'native', sources: ['native'], requiredFields: NATIVE_LAUNCH_FIELDS },
  { eventName: 'app_environment_snapshot', owner: 'native', sources: ['native'], requiredFields: ['installId'] },
  { eventName: 'native_event', owner: 'native', sources: ['native'], requiredFields: ['installId'] },
  { eventName: 'chat_request_completed', owner: 'backend', sources: ['backend'], requiredFields: BACKEND_REQUEST_SESSION_FIELDS },
  { eventName: 'user_login', owner: 'backend', sources: ['backend'], requiredFields: ['userId'] },
  { eventName: 'profile_approval_card_triggered', owner: 'backend', sources: ['backend'], requiredFields: BACKEND_SESSION_FIELDS },
  { eventName: 'profile_approval_card_approved', owner: 'backend', sources: ['backend'], requiredFields: BACKEND_SESSION_FIELDS },
  { eventName: 'profile_approval_card_rejected', owner: 'backend', sources: ['backend'], requiredFields: BACKEND_SESSION_FIELDS },
  { eventName: 'communication_card_triggered', owner: 'backend', sources: ['backend'], requiredFields: BACKEND_SESSION_FIELDS },
  { eventName: 'communication_card_save_clicked', owner: 'backend', sources: ['backend'], requiredFields: BACKEND_SESSION_FIELDS },
  { eventName: 'intervention_material_save_clicked', owner: 'backend', sources: ['backend'], requiredFields: BACKEND_USER_FIELDS },
  { eventName: 'intervention_material_follow_started', owner: 'backend', sources: ['backend'], requiredFields: BACKEND_USER_FIELDS },
  { eventName: 'intervention_material_follow_progress', owner: 'backend', sources: ['backend'], requiredFields: BACKEND_USER_FIELDS },
  { eventName: 'intervention_material_follow_completed', owner: 'backend', sources: ['backend'], requiredFields: BACKEND_USER_FIELDS },
] as const satisfies readonly TrackingEventContract[]

export function getTrackingEventContract(eventName: string): TrackingEventContract | null {
  return TRACKING_EVENT_CONTRACTS.find((contract) => contract.eventName === eventName) ?? null
}

export function validateTrackingEventContract(event: TrackingEventV2): string[] {
  const contract = getTrackingEventContract(event.eventName)
  if (!contract) return [`unknown event ${event.eventName}`]

  const warnings: string[] = []
  if (!contract.sources.includes(event.source)) {
    warnings.push(`source ${event.source} is not allowed for ${event.eventName}`)
  }

  for (const field of contract.requiredFields ?? []) {
    const value = event[field]
    if (value == null || value === '') {
      warnings.push(`missing required field ${field}`)
    }
  }

  return warnings
}
