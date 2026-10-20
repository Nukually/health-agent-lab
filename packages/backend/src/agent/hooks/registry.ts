/**
 * Hook 注册表
 *
 * 按事件分桶存储 handler。执行器为每个事件类型提供一个 runXxx() 入口，
 * 在各自语义下合并 hook 结果（pre_model_call 聚合 reminders，pre_tool_use 取首个 deny/rewrite）。
 * 单 hook throw 被隔离，不中断主流程。
 */

import type {
  HookEvent,
  HookHandler,
  PreModelCallContext,
  PreToolUseContext,
  PostToolUseContext,
  PreCompactContext,
  PostCompactContext,
  MessageEndContext,
  PreToolUseResult,
  PreModelCallRunResult,
  PostModelResponseContext,
  PostModelResponseResult,
} from './types.js'

interface Entry<E extends HookEvent> {
  name: string
  fn: HookHandler<E>
}

const registry: { [E in HookEvent]: Entry<E>[] } = {
  pre_model_call: [],
  post_model_response: [],
  pre_tool_use: [],
  post_tool_use: [],
  pre_compact: [],
  post_compact: [],
  message_end: [],
}

export function registerHook<E extends HookEvent>(
  event: E,
  name: string,
  fn: HookHandler<E>,
): void {
  registry[event].push({ name, fn } as Entry<E>)
}

/** 仅用于测试 / 重置（生产路径不会调用） */
export function clearHooks(event?: HookEvent): void {
  if (event) {
    registry[event] = []
    return
  }
  ;(Object.keys(registry) as HookEvent[]).forEach((e) => {
    registry[e] = []
  })
}

export function listHooks<E extends HookEvent>(event: E): string[] {
  return registry[event].map((e) => e.name)
}

/** pre_model_call：先允许改写最近 user，再聚合所有 hook 返回的 reminders */
export async function runPreModelCall(ctx: PreModelCallContext): Promise<PreModelCallRunResult> {
  const reminders: string[] = []
  let lastUserContentRewritten = false
  for (const h of registry.pre_model_call) {
    try {
      const r = await h.fn(ctx)
      if (r && 'rewriteLastUserContent' in r && r.rewriteLastUserContent !== undefined && ctx.lastUserMessage) {
        ctx.lastUserMessage.content = r.rewriteLastUserContent
        lastUserContentRewritten = true
      }
      if (r && Array.isArray(r.reminders)) {
        for (const s of r.reminders) {
          if (typeof s === 'string' && s.length > 0) reminders.push(s)
        }
      }
    } catch (err) {
      ctx.logger.error({ err, hook: h.name, event: 'pre_model_call' }, 'hook error (isolated)')
    }
  }
  return { reminders, lastUserContentRewritten }
}

/** post_model_response：返回首个 deny；否则仅观察。 */
export async function runPostModelResponse(
  ctx: PostModelResponseContext,
): Promise<PostModelResponseResult> {
  for (const h of registry.post_model_response) {
    try {
      const r = await h.fn(ctx)
      if (r?.deny) {
        ctx.logger.warn(
          { hook: h.name, reason: r.deny.reason },
          'model response denied by hook',
        )
        return r
      }
    } catch (err) {
      ctx.logger.error({ err, hook: h.name, event: 'post_model_response' }, 'hook error (isolated)')
    }
  }
  return {}
}

/**
 * pre_tool_use：返回首个 deny 立即短路；否则依次应用 rewrite（后一个 hook 看到前一个的改写结果）。
 * 注意：ctx.input 会被改写 hook 原地更新，以便后续 hook / executor 读到最新值。
 */
export async function runPreToolUse(ctx: PreToolUseContext): Promise<PreToolUseResult> {
  for (const h of registry.pre_tool_use) {
    try {
      const r = (await h.fn(ctx)) as PreToolUseResult | void
      if (r?.deny) {
        ctx.logger.info(
          { hook: h.name, tool: ctx.toolName, reason: r.deny.reason },
          'tool denied by hook',
        )
        return { deny: r.deny }
      }
      if (r && 'rewrite' in r && r.rewrite !== undefined) {
        ctx.input = r.rewrite
      }
    } catch (err) {
      ctx.logger.error({ err, hook: h.name, event: 'pre_tool_use' }, 'hook error (isolated)')
    }
  }
  return { rewrite: ctx.input }
}

/** observational — 执行所有 handler，忽略返回值 */
async function runObservational<E extends HookEvent>(
  event: E,
  ctx: any,
): Promise<void> {
  for (const h of registry[event]) {
    try {
      await (h.fn as any)(ctx)
    } catch (err) {
      ctx.logger.error({ err, hook: h.name, event }, 'hook error (isolated)')
    }
  }
}

export const runPostToolUse = (ctx: PostToolUseContext): Promise<void> =>
  runObservational('post_tool_use', ctx)
export const runPreCompact = (ctx: PreCompactContext): Promise<void> =>
  runObservational('pre_compact', ctx)
export const runPostCompact = (ctx: PostCompactContext): Promise<void> =>
  runObservational('post_compact', ctx)
export const runMessageEnd = (ctx: MessageEndContext): Promise<void> =>
  runObservational('message_end', ctx)
