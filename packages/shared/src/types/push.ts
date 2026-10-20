export type PushPlatform = 'android' | 'ios' | 'harmony'

export type PushProvider = 'jpush' | 'apns' | 'fcm' | 'hms'

export type NotificationPermissionStatus = 'granted' | 'denied' | 'unknown'

export type PushLogStatus = 'pending' | 'sent' | 'failed' | 'skipped'

export type ApnsEnvironment = 'development' | 'production'

export interface PushDeviceRecord {
  id: string
  userId: string
  platform: PushPlatform
  provider: PushProvider
  registrationId: string
  deviceId: string | null
  appVersion: string | null
  apnsEnvironment: ApnsEnvironment | null
  apnsTokenRegistered?: boolean | null
  apnsTokenRegisteredAt?: string | null
  apnsRegistrationError?: string | null
  pushEnabled: boolean
  notificationPermission: NotificationPermissionStatus
  lastSeenAt: string
  unboundAt: string | null
  createdAt: string
  updatedAt: string
}

export interface BindPushDeviceRequest {
  platform: PushPlatform
  provider?: PushProvider
  registrationId: string
  deviceId?: string | null
  appVersion?: string | null
  apnsEnvironment?: ApnsEnvironment | null
  apnsTokenRegistered?: boolean | null
  apnsTokenRegisteredAt?: string | null
  apnsRegistrationError?: string | null
  pushEnabled?: boolean
  notificationPermission?: NotificationPermissionStatus
}

export interface UnbindPushDeviceRequest {
  platform: PushPlatform
  provider?: PushProvider
  registrationId: string
}

export interface UpdatePushPreferencesRequest {
  pushEnabled: boolean
  platform?: PushPlatform
  provider?: PushProvider
  registrationId?: string
}

export interface PushDeviceListResponse {
  items: PushDeviceRecord[]
}
