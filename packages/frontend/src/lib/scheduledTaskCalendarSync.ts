import type {
  ApiResponse,
  MessageRecord,
  PushPlatform,
  ScheduledTaskCalendarSyncPendingResponse,
  ScheduledTaskCalendarSyncPlan,
  ScheduledTaskCalendarSyncReportRequest,
  ScheduledTaskCalendarSyncReportResponse,
} from '@health-agent/shared'
import { api } from '../services/api.js'
import { getNativeDeviceInfo } from './nativePush.js'
import { getNativeReadyInfo, hasNativeBridge } from './nativeBridge.js'
import {
  createNativeCalendarEvent,
  deleteNativeCalendarEvent,
  type NativeCalendarEventRequest,
} from './nativeSchedule.js'

const DEVICE_KEY_STORAGE = 'cx.schedule.calendar.deviceKey'
let inFlightSync: Promise<void> | null = null

function normalizePlatform(value: unknown): PushPlatform | null {
  return value === 'android' || value === 'ios' || value === 'harmony' ? value : null
}

function stableRandomId(): string {
  try {
    const existing = window.localStorage.getItem(DEVICE_KEY_STORAGE)
    if (existing) return existing
    const next = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`
    window.localStorage.setItem(DEVICE_KEY_STORAGE, next)
    return next
  } catch {
    return 'memory-device'
  }
}

async function resolveCalendarDevice(): Promise<{ platform: PushPlatform; deviceKey: string } | null> {
  if (!hasNativeBridge()) return null
  const [device, ready] = await Promise.all([
    getNativeDeviceInfo({ timeoutMs: 1500 }).catch(() => null),
    Promise.resolve(getNativeReadyInfo()),
  ])
  const raw = device as (typeof device & { deviceId?: string | null }) | null
  const platform = normalizePlatform(device?.platform) ?? normalizePlatform(ready?.platform)
  if (!platform) return null
  const stableId = raw?.deviceId?.trim() || stableRandomId()
  const deviceKey = [
    platform,
    stableId,
    device?.manufacturer ?? '',
    device?.model ?? '',
  ].join(':').slice(0, 256)
  return { platform, deviceKey }
}

function isScheduledTaskOutput(output: unknown): boolean {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return false
  const record = output as Record<string, unknown>
  if (typeof record.scheduledTaskId === 'string' || record.calendarSyncPlan != null) return true

  // 兼容旧版后端已落库消息：早期 add_scheduled_task 的 displayOutput 只有
  // { action, taskId, dueAt, ... }，没有 scheduledTaskId / calendarSyncPlan。
  // 这里仍触发一次 pending 同步；真正要同步哪些未来任务由后端
  // /scheduled-tasks/calendar-sync/pending 按当前用户和设备重新计算。
  const action = record.action
  const looksLikeScheduledTaskAction = action === 'add' || action === 'update' || action === 'delete'
  if (!looksLikeScheduledTaskAction) return false
  return (
    typeof record.taskId === 'number'
    || typeof record.taskId === 'string'
    || typeof record.dueAt === 'string'
    || typeof record.taskName === 'string'
  )
}

async function reportCalendarSync(
  body: ScheduledTaskCalendarSyncReportRequest,
): Promise<void> {
  await api.post<ApiResponse<ScheduledTaskCalendarSyncReportResponse>>(
    '/scheduled-tasks/calendar-sync/report',
    body,
  ).catch(() => undefined)
}

async function deleteExternalIds(externalIds: string[]): Promise<void> {
  for (const externalId of externalIds) {
    const result = await deleteNativeCalendarEvent(externalId)
    if (!result?.deleted) {
      throw new Error(result?.reason || 'deleteCalendarEvent failed')
    }
  }
}

function toNativeEvent(event: NativeCalendarEventRequest): NativeCalendarEventRequest {
  return {
    ...event,
    reminderMinutesBefore: event.reminderMinutesBefore ?? 0,
  }
}

async function createEvents(plan: ScheduledTaskCalendarSyncPlan): Promise<string[]> {
  const events = plan.event
    ? [plan.event]
    : (plan.occurrences ?? [])
  if (events.length === 0) throw new Error('calendar sync plan has no event')

  const externalIds: string[] = []
  for (const event of events) {
    const result = await createNativeCalendarEvent(toNativeEvent(event))
    if (!result?.created && !result?.opened) {
      throw new Error(result?.reason || 'createCalendarEvent failed')
    }
    if (result.externalId) externalIds.push(result.externalId)
  }
  return externalIds
}

async function applyCalendarPlan(
  plan: ScheduledTaskCalendarSyncPlan,
  device: { platform: PushPlatform; deviceKey: string },
): Promise<void> {
  const replaceExternalIds = plan.replaceExternalIds ?? []
  try {
    if (plan.action === 'delete') {
      if (replaceExternalIds.length > 0) await deleteExternalIds(replaceExternalIds)
      await reportCalendarSync({
        scheduledTaskId: plan.scheduledTaskId,
        platform: device.platform,
        deviceKey: device.deviceKey,
        planHash: plan.planHash,
        action: 'delete',
        status: 'deleted',
        externalIds: [],
      })
      return
    }

    if (replaceExternalIds.length > 0) await deleteExternalIds(replaceExternalIds)
    const externalIds = await createEvents(plan)
    await reportCalendarSync({
      scheduledTaskId: plan.scheduledTaskId,
      platform: device.platform,
      deviceKey: device.deviceKey,
      planHash: plan.planHash,
      action: 'upsert',
      status: 'synced',
      externalIds,
    })
  } catch (err) {
    await reportCalendarSync({
      scheduledTaskId: plan.scheduledTaskId,
      platform: device.platform,
      deviceKey: device.deviceKey,
      planHash: plan.planHash,
      action: plan.action,
      status: 'failed',
      externalIds: replaceExternalIds,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

export function syncPendingScheduledTaskCalendars(): Promise<void> {
  if (inFlightSync) return inFlightSync
  inFlightSync = (async () => {
    const device = await resolveCalendarDevice()
    if (!device) return
    const res = await api.post<ApiResponse<ScheduledTaskCalendarSyncPendingResponse>>(
      '/scheduled-tasks/calendar-sync/pending',
      device,
    ).catch(() => null)
    const items = res?.data?.items ?? []
    for (const item of items) {
      await applyCalendarPlan(item, device)
    }
  })().finally(() => {
    inFlightSync = null
  })
  return inFlightSync
}

export function syncScheduledTaskCalendarFromToolOutput(output: unknown): void {
  if (!isScheduledTaskOutput(output)) return
  window.setTimeout(() => {
    syncPendingScheduledTaskCalendars().catch(() => undefined)
  }, 0)
}

export function syncScheduledTaskCalendarsFromMessages(messages: MessageRecord[]): void {
  const hasScheduledTask = messages.some((message) =>
    (message.toolCalls ?? []).some((toolCall) => isScheduledTaskOutput(toolCall.output)),
  )
  if (!hasScheduledTask) return
  window.setTimeout(() => {
    syncPendingScheduledTaskCalendars().catch(() => undefined)
  }, 0)
}
