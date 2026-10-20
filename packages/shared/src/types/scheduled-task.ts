import type { PushPlatform } from './push.js'
import type {
  ScheduledProactiveMessagePurpose,
  ScheduledProactiveMessageStatus,
} from './intervention-material.js'

export type ScheduledProactiveMessageScheduleType = 'once' | 'cron'

export type ScheduledTaskCalendarSyncAction = 'upsert' | 'delete'

export type ScheduledTaskCalendarSyncStatus = 'pending' | 'synced' | 'failed' | 'deleted'

export interface ScheduledTaskScheduleSummary {
  type: ScheduledProactiveMessageScheduleType
  nextDueAt: string
  timezone: string
  cronExpression?: string | null
}

export interface ScheduledTaskCalendarEventRequest {
  title: string
  startTime: number
  endTime?: number
  allDay?: boolean
  description?: string
  notes?: string
  location?: string
  reminderMinutesBefore?: number | number[]
  recurrenceRule?: string
}

export interface ScheduledTaskCalendarSyncPlan {
  action: ScheduledTaskCalendarSyncAction
  scheduledTaskId: string
  planHash: string
  schedule: ScheduledTaskScheduleSummary
  event?: ScheduledTaskCalendarEventRequest
  occurrences?: ScheduledTaskCalendarEventRequest[]
  replaceExternalIds?: string[]
}

export interface ScheduledTaskCalendarSyncPendingRequest {
  platform: PushPlatform
  deviceKey: string
}

export interface ScheduledTaskCalendarSyncPendingResponse {
  items: ScheduledTaskCalendarSyncPlan[]
}

export interface ScheduledTaskCalendarSyncReportRequest {
  scheduledTaskId: string
  platform: PushPlatform
  deviceKey: string
  planHash: string
  action: ScheduledTaskCalendarSyncAction
  status: Extract<ScheduledTaskCalendarSyncStatus, 'synced' | 'failed' | 'deleted'>
  externalIds?: string[]
  error?: string | null
}

export interface ScheduledTaskCalendarSyncReportResponse {
  saved: boolean
}

export interface ScheduledTaskManageItem {
  id: string
  taskName: string
  message: string
  purpose: ScheduledProactiveMessagePurpose
  scheduleType: ScheduledProactiveMessageScheduleType
  dueAt: string
  cronExpression?: string | null
  timezone: string
  status: ScheduledProactiveMessageStatus
  createdAt: string
  updatedAt: string
  appNotifyEnabled: boolean
  calendarSyncEnabled: boolean
}

export interface ScheduledTaskListResponse {
  periodic: ScheduledTaskManageItem[]
  timeline: ScheduledTaskManageItem[]
}

export interface ScheduledTaskUpdateRequest {
  taskName?: string
  message?: string
  scheduleType?: ScheduledProactiveMessageScheduleType
  dueAt?: string
  cronExpression?: string | null
  timezone?: string | null
  appNotifyEnabled?: boolean
  calendarSyncEnabled?: boolean
}

export interface ScheduledTaskMutationResponse {
  item: ScheduledTaskManageItem
}
