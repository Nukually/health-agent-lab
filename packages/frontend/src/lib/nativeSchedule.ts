import { ensureNativeBridgeBootstrap, getNativeReadyInfo, hasNativeBridge, nativeCall } from './nativeBridge.js'

/**
 * Native 日程能力调用结果。
 *
 * 注意：
 * - Android 闹钟仍通过系统 Intent 打开确认页；日历优先通过 Calendar Provider 直接写入，成功时会返回 `externalId`；
 *   如果无权限、无可写日历或厂商 ROM 限制直写，则降级打开系统日历新增页。
 * - iOS 日历可直接写入系统日历，成功时通常是 `created: true`、`externalId` 有值；
 *   iOS 系统 Clock 闹钟无公开创建 API，会返回 `unsupported: true`。
 * - Harmony 闹钟/日历通过系统提醒/日历能力写入，成功时通常返回 `created: true`。
 */
export interface NativeScheduleResult {
  created?: boolean
  deleted?: boolean
  opened?: boolean
  platform?: string
  target?: 'alarm' | 'calendar' | string
  externalId?: string
  unsupported?: boolean
  reason?: string
}

/**
 * 创建系统闹钟的 H5 入参。
 *
 * 后端/LLM 如需触发 native 闹钟能力，不应直接调用 native；应把该结构化参数下发给 H5，
 * 再由 H5 在用户确认/点击后调用 `createNativeAlarm()`。
 */
export interface NativeAlarmRequest {
  /**
   * 闹钟标题。Android 会写入 `AlarmClock.EXTRA_MESSAGE`。
   * 为空时 native 会兜底使用 `message`，再为空则使用“Health Agent Lab提醒”。
   */
  title?: string
  /**
   * 闹钟提示文案/标题兜底。当前 Android 会在 `title` 为空时作为闹钟 message 使用。
   */
  message?: string
  /**
   * Unix 毫秒时间戳。native 会按设备本地时区转换为 hour/minute。
   *
   * Android 系统闹钟 Intent 本身只支持“时/分”，不保证精确指定日期；
   * 如需“某年某月某日某时”的明确提醒，更建议用 `createNativeCalendarEvent()`。
   *
   * `timestamp` 存在时优先级高于 `hour/minute`。
   */
  timestamp?: number
  /**
   * 本地 24 小时制小时，范围 0-23。仅当不传 `timestamp` 时使用。
   */
  hour?: number
  /**
   * 本地分钟，范围 0-59。仅当不传 `timestamp` 时使用。
   */
  minute?: number
  /**
   * 周期闹钟的星期配置，ISO weekday：1=周一，...，7=周日。
   *
   * - 不传或空数组：一次性闹钟
   * - `[1,2,3,4,5]`：工作日重复
   * - `[1,2,3,4,5,6,7]`：每天重复
   */
  daysOfWeek?: number[]
  /**
   * Android only。默认 false，表示打开系统闹钟确认页，让用户确认创建。
   *
   * 即使传 true，是否跳过 UI 也取决于系统闹钟 App/厂商 ROM，可能被忽略或仍打开确认页。
   * 业务默认建议使用 false。
   */
  skipUi?: boolean
}

/**
 * 创建系统日历事件的 H5 入参。
 *
 * 后端/LLM 如需触发 native 日历能力，不应直接调用 native；应把该结构化参数下发给 H5，
 * 再由 H5 在用户确认/点击后调用 `createNativeCalendarEvent()`。
 */
export interface NativeCalendarEventRequest {
  /**
   * 日历事件标题。为空时部分 native 侧会兜底为“Health Agent Lab提醒”。
   */
  title: string
  /**
   * 事件开始时间，Unix 毫秒时间戳。
   */
  startTime: number
  /**
   * 事件结束时间，Unix 毫秒时间戳。
   * 不传时 native 默认 `startTime + 30min`。
   */
  endTime?: number
  /**
   * 是否全天事件。
   */
  allDay?: boolean
  /**
   * 事件描述。Android/iOS 都会尽量写入系统日历描述/备注字段。
   */
  description?: string
  /**
   * 事件备注。当前作为 description 的补充/兜底字段。
   */
  notes?: string
  /**
   * 事件地点。
   */
  location?: string
  /**
   * 日历提醒提前分钟数。
   *
   * iOS/Harmony/Android 日历桥会尽量写入系统日历提醒。
   *
   * 示例：
   * - `10`：提前 10 分钟提醒
   * - `[5, 30]`：提前 5 分钟和 30 分钟提醒
   */
  reminderMinutesBefore?: number | number[]
  /**
   * RFC 5545 RRULE 主体，如 `FREQ=DAILY` / `FREQ=WEEKLY;BYDAY=MO,WE`。
   */
  recurrenceRule?: string
}

function hasNativeScheduleBridge(method: 'createAlarm' | 'createCalendarEvent' | 'deleteCalendarEvent'): boolean {
  if (!hasNativeBridge()) return false
  const modules = getNativeReadyInfo()?.modules
  return Array.isArray(modules?.schedule) && modules.schedule.includes(method)
}

function debugNativeSchedule(message: string, data?: unknown): void {
  if (typeof window === 'undefined') return
  try {
    if (window.localStorage.getItem('cx.debug.nativeSchedule') !== '1') return
  } catch {
    return
  }
  console.info('[native-schedule]', message, JSON.stringify(data ?? {}))
}

/**
 * 调用 native 创建/打开系统闹钟。
 *
 * H5 暴露接口：
 * - module: `schedule`
 * - method: `createAlarm`
 *
 * Android 当前实现：
 * - 使用 `AlarmClock.ACTION_SET_ALARM`
 * - 支持一次性闹钟：不传 `daysOfWeek`
 * - 支持周期闹钟：传 `daysOfWeek`
 * - 默认打开系统确认页，返回 `{ opened: true, created: false }`
 *
 * 返回值约定：
 * - `null`：native bridge 不存在、能力未暴露或调用异常；H5 可降级为普通提示/业务弹窗。
 * - `unsupported: true`：当前平台明确不支持该能力。
 *
 * 后端调用建议：
 * - 后端只生成/下发 `NativeAlarmRequest` 参数，不直接调用本方法。
 * - H5 收到后应在用户主动确认后调用，避免无感创建系统提醒。
 *
 * @example
 * ```ts
 * await createNativeAlarm({
 *   title: '用药提醒',
 *   hour: 8,
 *   minute: 30,
 *   daysOfWeek: [1, 2, 3, 4, 5],
 *   skipUi: false,
 * })
 * ```
 */
export async function createNativeAlarm(
  request: NativeAlarmRequest,
  options?: { timeoutMs?: number },
): Promise<NativeScheduleResult | null> {
  ensureNativeBridgeBootstrap()
  if (!hasNativeScheduleBridge('createAlarm')) {
    debugNativeSchedule('createAlarm skipped: bridge unavailable')
    return null
  }

  try {
    const result = await nativeCall<NativeScheduleResult>('schedule', 'createAlarm', request, {
      timeoutMs: options?.timeoutMs ?? 8000,
    })
    debugNativeSchedule('createAlarm result', result)
    return result
  } catch (err) {
    const error = err as { code?: string; message?: string }
    debugNativeSchedule('createAlarm failed', { code: error.code, message: error.message })
    return null
  }
}

/**
 * 调用 native 创建/打开系统日历事件。
 *
 * H5 暴露接口：
 * - module: `schedule`
 * - method: `createCalendarEvent`
 *
 * Android 当前实现：
 * - 优先申请日历权限并使用 Calendar Provider 直接写入
 * - 直写成功返回 `{ created: true, opened: false, externalId }`
 * - 无权限、无可写日历或厂商 ROM 限制直写时，降级使用 `Intent.ACTION_INSERT` 打开系统日历新增页
 * - 成功拉起系统页返回 `{ created: false, opened: true }`，此时用户需要在系统日历页手动保存，且不会返回 `externalId`
 *
 * iOS 当前实现：
 * - 使用 EventKit 申请日历权限并写入系统日历
 * - 成功返回 `{ created: true, opened: false, externalId }`
 *
 * Harmony 当前实现：
 * - 申请提醒/日历权限后写入系统提醒/日历
 * - 成功返回 `{ created: true, opened: false, externalId }`
 *
 * 返回值约定：
 * - `null`：native bridge 不存在、能力未暴露或调用异常；H5 可降级为普通提示/业务弹窗。
 * - `unsupported: true`：当前平台明确不支持该能力。
 *
 * 后端调用建议：
 * - 后端只生成/下发 `NativeCalendarEventRequest` 参数，不直接调用本方法。
 * - H5 收到后可在移动端做 best-effort 拉起系统日历页；失败不影响 APP 内提醒。
 *
 * @example
 * ```ts
 * await createNativeCalendarEvent({
 *   title: '复诊提醒',
 *   startTime: new Date('2026-05-20T08:30:00+08:00').getTime(),
 *   endTime: new Date('2026-05-20T09:00:00+08:00').getTime(),
 *   description: '乳腺科复诊',
 *   location: '医院',
 *   reminderMinutesBefore: 30,
 * })
 * ```
 */
export async function createNativeCalendarEvent(
  request: NativeCalendarEventRequest,
  options?: { timeoutMs?: number },
): Promise<NativeScheduleResult | null> {
  ensureNativeBridgeBootstrap()
  if (!hasNativeScheduleBridge('createCalendarEvent')) {
    debugNativeSchedule('createCalendarEvent skipped: bridge unavailable')
    return null
  }

  try {
    const result = await nativeCall<NativeScheduleResult>('schedule', 'createCalendarEvent', request, {
      timeoutMs: options?.timeoutMs ?? 8000,
    })
    debugNativeSchedule('createCalendarEvent result', result)
    return result
  } catch (err) {
    const error = err as { code?: string; message?: string }
    debugNativeSchedule('createCalendarEvent failed', { code: error.code, message: error.message })
    return null
  }
}

export async function deleteNativeCalendarEvent(
  externalId: string,
  options?: { timeoutMs?: number },
): Promise<NativeScheduleResult | null> {
  ensureNativeBridgeBootstrap()
  if (!hasNativeScheduleBridge('deleteCalendarEvent')) {
    debugNativeSchedule('deleteCalendarEvent skipped: bridge unavailable')
    return null
  }

  try {
    const result = await nativeCall<NativeScheduleResult>('schedule', 'deleteCalendarEvent', { externalId }, {
      timeoutMs: options?.timeoutMs ?? 8000,
    })
    debugNativeSchedule('deleteCalendarEvent result', result)
    return result
  } catch (err) {
    const error = err as { code?: string; message?: string }
    debugNativeSchedule('deleteCalendarEvent failed', { code: error.code, message: error.message })
    return null
  }
}
