/**
 * Prefix Tracker — LLM prefix 稳定性观测
 *
 * 项目铁律："多轮对话 LLM prefix 严格不变，除非触发 compaction"。
 * 违反则击穿上游 KV cache，成本 + 首 token 延迟倍增。
 *
 * 设计要点：
 * - 每轮 LLM 调用前后异步打点（microtask），绝不阻塞主链路
 * - Redis 只存两个 string key：
 *     `prefix:last:{sessionId}`   — 上一轮发出去的完整 payload 指纹（system + messages + tools）
 *     `prefix:status:{sessionId}` — 当前状态灯（供 Debug 面板读）
 * - 告警详情只走 logger.warn（带完整上下文），不在 Redis 里堆列表
 * - Redis 不可用时所有方法静默降级（catch 吞掉），绝不抛到主流程
 * - 压缩导致的 prefix 变化是合理的 —— 由 session.prefixChangeExpected 标记，本轮检查时消费并标黄
 */

import type { Logger } from '../lib/logger.js'
import type { LLMMessage, ToolDefinition } from '../api/types.js'
import type { SessionState } from '../state/session.js'
import { getKV } from '../lib/redis.js'
import { hashLLMPayload } from '../utils/prefix-hash.js'

const TTL_SECONDS = 7 * 24 * 3600

export type PrefixStatus = 'stable' | 'changed' | 'compaction' | 'reset' | 'unknown'

interface LastEntry {
  fullHash: string
  messagesLen: number
  iter: number
  at: number
}

interface StatusEntry {
  status: PrefixStatus
  /** 最近一次变化的原因（仅 changed/compaction 有意义） */
  lastReason?: string
  lastIter?: number
  at: number
}

function lastKey(sessionId: string) {
  return `prefix:last:${sessionId}`
}
function statusKey(sessionId: string) {
  return `prefix:status:${sessionId}`
}

async function writeStatus(
  sessionId: string,
  status: PrefixStatus,
  lastReason: string | undefined,
  iter: number,
): Promise<void> {
  try {
    const entry: StatusEntry = {
      status,
      lastReason,
      lastIter: iter,
      at: Date.now(),
    }
    await getKV().set(statusKey(sessionId), JSON.stringify(entry), TTL_SECONDS)
  } catch {
    /* noop — Redis 不可用时降级 */
  }
}

async function readLast(sessionId: string): Promise<LastEntry | null> {
  try {
    const raw = await getKV().get(lastKey(sessionId))
    if (!raw) return null
    return JSON.parse(raw) as LastEntry
  } catch {
    return null
  }
}

async function writeLast(sessionId: string, entry: LastEntry): Promise<void> {
  try {
    await getKV().set(lastKey(sessionId), JSON.stringify(entry), TTL_SECONDS)
  } catch {
    /* noop */
  }
}

export async function clearPrefixBaseline(
  sessionId: string,
  logger: Logger,
  reason = 'manual_reset',
): Promise<void> {
  try {
    await getKV().del(lastKey(sessionId))
    // 'reset' ≠ 'compaction'：这里只是把 baseline 清掉（retry/legacy tool replay 等），
    // 和真正的上下文压缩（compactIfNeeded / reactiveCompact，经 prefixChangeExpected
    // 走 beforeLLMCall 的分支写 'compaction'）分开展示，避免 debug 面板把 baseline
    // 重置误报成"触发压缩"。
    await writeStatus(sessionId, 'reset', reason, 0)
    logger.info({ sessionId, reason }, 'prefix baseline cleared')
  } catch (err) {
    logger.debug({ err, sessionId, reason }, 'prefix baseline clear failed; ignored')
  }
}

/**
 * 在 LLM 调用发起后立即排入 microtask：计算 prefix hash 并与上一轮对比。
 * 主链路此时正在 await HTTP 首 chunk（数百毫秒），hash 计算（1-5ms）完全并行。
 *
 * 同请求内 tool iteration：curr.length > prev.messagesLen，比较 curr[0..prevLen] 切片
 * 跨请求新用户消息：curr.length === prev.messagesLen + 1，同上
 * 压缩：curr.length < prev.messagesLen，由 prefixChangeExpected 标记为合理变化
 */
export function beforeLLMCall(
  session: SessionState,
  system: string,
  snapshot: LLMMessage[],
  tools: Array<Pick<ToolDefinition, 'type' | 'function'>>,
  iter: number,
  logger: Logger,
): void {
  void Promise.resolve().then(async () => {
    const t0 = performance.now()
    try {
      const prev = await readLast(session.sessionId)

      const expected = session.prefixChangeExpected ?? null

      // 首轮：无上一轮参考；同时消费掉“预期变化”标记，避免遗留到下一轮误报。
      if (!prev) {
        session.prefixChangeExpected = null
        await writeStatus(session.sessionId, 'stable', undefined, iter)
        return
      }

      // 压缩预期消费 —— 本轮 prefix 变化是合理的，标黄灯
      if (expected) {
        session.prefixChangeExpected = null
        const status: PrefixStatus =
          expected === 'protocol_retry' || expected === 'prompt_expired'
            ? 'reset'
            : 'compaction'
        await writeStatus(session.sessionId, status, expected, iter)
        logger.info(
          { iter, reason: expected, prevLen: prev.messagesLen, currLen: snapshot.length },
          status === 'reset'
            ? 'prefix: expected reset'
            : 'prefix: expected change after compaction',
        )
        return
      }

      // 异常：消息长度倒退（压缩之外不该发生）
      if (snapshot.length < prev.messagesLen) {
        await writeStatus(session.sessionId, 'changed', 'messages_shrunk', iter)
        logger.warn(
          {
            sessionId: session.sessionId,
            iter,
            prevLen: prev.messagesLen,
            currLen: snapshot.length,
            prevHash: prev.fullHash.slice(0, 16),
          },
          'PREFIX_UNSTABLE: messages array shrunk without compaction',
        )
        return
      }

      // 主路径：取本轮 prefix（长度等于上轮完整发出去的 messages 长度）对比 hash
      const prefixSlice = snapshot.slice(0, prev.messagesLen)
      const prefixHash = hashLLMPayload(system, prefixSlice, tools)

      if (prefixHash === prev.fullHash) {
        await writeStatus(session.sessionId, 'stable', undefined, iter)
      } else {
        await writeStatus(session.sessionId, 'changed', 'prefix_mutated', iter)
        logger.warn(
          {
            sessionId: session.sessionId,
            iter,
            prevHash: prev.fullHash.slice(0, 16),
            currHash: prefixHash.slice(0, 16),
            prevLen: prev.messagesLen,
            currLen: snapshot.length,
            prevIter: prev.iter,
          },
          'PREFIX_UNSTABLE: KV cache miss — prefix bytes changed between rounds',
        )
      }
    } catch (err) {
      logger.debug({ err, iter }, 'prefix tracker before-call failed; ignored')
    } finally {
      const durationMs = Math.round(performance.now() - t0)
      if (durationMs > 20) {
        logger.debug({ durationMs, iter }, 'prefix tracker slow')
      }
    }
  })
}

/**
 * 每轮 LLM 调用成功结束后写 full hash，供下一轮对比。
 * 同样 fire-and-forget，不阻塞 SSE。
 */
export function afterLLMCall(
  session: SessionState,
  system: string,
  snapshot: LLMMessage[],
  tools: Array<Pick<ToolDefinition, 'type' | 'function'>>,
  iter: number,
  logger: Logger,
): void {
  void Promise.resolve().then(async () => {
    try {
      const fullHash = hashLLMPayload(system, snapshot, tools)
      await writeLast(session.sessionId, {
        fullHash,
        messagesLen: snapshot.length,
        iter,
        at: Date.now(),
      })
    } catch (err) {
      logger.debug({ err, iter }, 'prefix tracker after-call failed; ignored')
    }
  })
}

/** 给 Debug API 读取当前状态灯 */
export async function getPrefixState(sessionId: string): Promise<{
  status: PrefixStatus
  lastReason?: string
  lastIter?: number
}> {
  try {
    const raw = await getKV().get(statusKey(sessionId))
    if (!raw) return { status: 'unknown' }
    const entry = JSON.parse(raw) as StatusEntry
    return {
      status: entry.status,
      lastReason: entry.lastReason,
      lastIter: entry.lastIter,
    }
  } catch {
    return { status: 'unknown' }
  }
}
