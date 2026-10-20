/**
 * Stream Watchdog — 流式空闲监控
 *
 * 参考 claude-code ch04: TCP 连接可能静默死亡
 * SDK 的 request timeout 只管到 HTTP 200，之后 body 停止到达无人察觉
 * watchdog 每收到 chunk 重置计时器，超时则 abort
 */

import type { Logger } from '../lib/logger.js'

export interface WatchdogOptions {
  timeoutMs?: number
  warningMs?: number
  logger: Logger
  onTimeout: () => void
}

export function createWatchdog(options: WatchdogOptions) {
  const {
    timeoutMs = 90_000,
    warningMs = 45_000,
    logger,
    onTimeout,
  } = options

  let timer: ReturnType<typeof setTimeout> | null = null
  let warningTimer: ReturnType<typeof setTimeout> | null = null
  let chunkCount = 0
  const startTime = performance.now()

  function armTimers(): void {
    if (timer) clearTimeout(timer)
    if (warningTimer) clearTimeout(warningTimer)

    warningTimer = setTimeout(() => {
      logger.warn(
        { idleMs: warningMs, chunkCount },
        'stream idle warning — no chunks received',
      )
    }, warningMs)

    timer = setTimeout(() => {
      logger.error(
        { timeoutMs, chunkCount, totalMs: Math.round(performance.now() - startTime) },
        'stream watchdog timeout — aborting',
      )
      onTimeout()
    }, timeoutMs)
  }

  function reset(): void {
    chunkCount++
    armTimers()
  }

  function stop(): void {
    if (timer) clearTimeout(timer)
    if (warningTimer) clearTimeout(warningTimer)
    timer = null
    warningTimer = null

    logger.debug(
      { chunkCount, totalMs: Math.round(performance.now() - startTime) },
      'watchdog stopped',
    )
  }

  // Arm the idle/timeout timers immediately so a connection that never
  // produces a chunk still triggers the warning/timeout path.
  armTimers()

  return { reset, stop, getChunkCount: () => chunkCount }
}
