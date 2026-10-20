/**
 * LLM Fallback — Primary / Backup provider 自动切换
 *
 * 默认配置：
 * - Primary: 百炼 DashScope（kimi-k2.5，enable_thinking）
 * - Backup:  Kimi 官方 API（kimi-k2.6，thinking）
 *
 * 但实现本身按 baseURL 识别 provider，对主备方向不做硬编码。
 * 策略：always-try-primary-first，失败后 fallback 到 backup
 */

import type OpenAI from 'openai'
import {
  getLLMClient,
  getBaseUrl,
  getBackupLLMClient,
  getBackupBaseUrl,
  getBackupModel,
  isSimulatingPrimaryFailure,
} from '../state/process.js'
import type { Logger } from './logger.js'
import type { LLMUpstreamRetryAttempt } from '../api/types.js'

// ─── Retry 常量（从 api/client.ts 迁入） ───

const RETRYABLE_STATUS = new Set([429, 500, 502, 503])
const MAX_RETRIES = 1
const RETRY_BASE_MS = 1000

type ProviderKind = 'dashscope' | 'moonshot' | 'other'
interface ProviderBuildOptions {
  dashscopeSystemCachePrefixLength?: number
}

function requestOptions(signal?: AbortSignal) {
  return signal ? { signal } : undefined
}

function withEphemeralCacheControl(content: unknown): unknown | null {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content, cache_control: { type: 'ephemeral' } }]
  }

  if (!Array.isArray(content)) return null

  let textBlockIdx = -1
  for (let i = content.length - 1; i >= 0; i--) {
    const block = content[i]
    if (
      block &&
      typeof block === 'object' &&
      (block as { type?: unknown }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string'
    ) {
      textBlockIdx = i
      break
    }
  }
  if (textBlockIdx < 0) return null

  const nextContent = [...content]
  nextContent[textBlockIdx] = {
    ...(nextContent[textBlockIdx] as Record<string, unknown>),
    cache_control: { type: 'ephemeral' },
  }
  return nextContent
}

function withSystemPrefixCacheControl(content: unknown, prefixLength: number | undefined): unknown | null {
  if (typeof content !== 'string') return null
  if (!prefixLength || prefixLength !== content.length) return null

  return [{ type: 'text', text: content, cache_control: { type: 'ephemeral' } }]
}

export function withDashScopeExplicitCacheControl(
  params: Record<string, unknown>,
  opts: ProviderBuildOptions = {},
): Record<string, unknown> {
  const messages = params.messages
  if (!Array.isArray(messages)) return params

  let nextMessages: unknown[] | null = null
  const ensureNextMessages = () => {
    if (!nextMessages) nextMessages = [...messages]
    return nextMessages
  }

  const firstMessage = messages[0]
  if (firstMessage && typeof firstMessage === 'object') {
    const record = firstMessage as Record<string, unknown>
    if (record.role === 'system') {
      const content = withSystemPrefixCacheControl(
        record.content,
        opts.dashscopeSystemCachePrefixLength,
      )
      if (content) {
        ensureNextMessages()[0] = { ...record, content }
      }
    }
  }

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (!message || typeof message !== 'object') continue
    const record = message as Record<string, unknown>
    if (record.role !== 'user') continue

    const content = withEphemeralCacheControl(record.content)
    if (!content) continue

    ensureNextMessages()[i] = { ...record, content }
    break
  }

  return nextMessages ? { ...params, messages: nextMessages } : params
}

function detectProvider(baseUrl: string): ProviderKind {
  const lower = baseUrl.toLowerCase()
  if (lower.includes('dashscope.aliyuncs.com')) return 'dashscope'
  if (lower.includes('api.moonshot.cn')) return 'moonshot'
  return 'other'
}

/** Moonshot 当前不能直接承接 qwen 系列请求；这类请求要直接走 backup。 */
function canServeRequestedModel(provider: ProviderKind, model: string): boolean {
  if (provider === 'moonshot' && model.startsWith('qwen')) return false
  return true
}

function resolveThinkingEnabled(
  params: Record<string, unknown>,
  targetProvider: ProviderKind,
  sourceProvider: ProviderKind,
): boolean | undefined {
  const enableThinking = params.enable_thinking
  if (typeof enableThinking === 'boolean') return enableThinking

  // DashScope Kimi 在本项目里的“不显式传 enable_thinking”语义等价于非思考模式。
  // 当请求从 DashScope fallback 到 Moonshot 时，显式补成 disabled，避免 provider 默认值漂移。
  if (targetProvider === 'moonshot' && sourceProvider === 'dashscope') {
    return false
  }

  return undefined
}

/**
 * 映射 fallback 目标模型：
 * - backup=DashScope：qwen 保持原模型；其余走配置的 backupModel（例如 kimi-k2.6 -> kimi-k2.5）
 * - backup=Moonshot：统一走配置的 backupModel（例如 qwen3.5-flash -> kimi-k2.6）
 */
function mapModelForBackup(
  model: string,
  backupProvider: ProviderKind,
  backupModel: string,
): string | null {
  if (backupProvider === 'dashscope') {
    if (model.startsWith('qwen')) return model
    return backupModel || null
  }
  if (backupProvider === 'moonshot') {
    return backupModel || null
  }
  return backupModel || model || null
}

function stripImageDetailForProvider(messages: unknown): unknown {
  if (!Array.isArray(messages)) return messages
  return messages.map((message) => {
    if (!message || typeof message !== 'object') return message
    const record = message as Record<string, unknown>
    if (!Array.isArray(record.content)) return message

    let changed = false
    const content = record.content.map((block) => {
      if (
        block &&
        typeof block === 'object' &&
        (block as { type?: unknown }).type === 'image_url' &&
        (block as { image_url?: unknown }).image_url &&
        typeof (block as { image_url?: unknown }).image_url === 'object'
      ) {
        const imageUrl = { ...(block as { image_url: Record<string, unknown> }).image_url }
        if (!('detail' in imageUrl)) return block
        changed = true
        delete imageUrl.detail
        return { ...(block as Record<string, unknown>), image_url: imageUrl }
      }
      return block
    })

    return changed ? { ...record, content } : message
  })
}

/**
 * 构造 provider 请求参数：
 * - DashScope：使用 enable_thinking，剥离 Moonshot 的 thinking
 * - Moonshot：使用 thinking，剥离 DashScope 的 enable_thinking
 */
function buildParamsForProvider(
  params: Record<string, unknown>,
  provider: ProviderKind,
  targetModel: string,
  sourceProvider: ProviderKind,
  opts: ProviderBuildOptions = {},
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...params, model: targetModel }
  const thinkingEnabled = resolveThinkingEnabled(params, provider, sourceProvider)

  if (provider === 'moonshot') {
    delete next.enable_thinking
    next.messages = stripImageDetailForProvider(next.messages)
    if (typeof thinkingEnabled === 'boolean') {
      next.thinking = { type: thinkingEnabled ? 'enabled' : 'disabled' }
    } else {
      delete next.thinking
    }

    // Kimi 官方 K2.5/K2.6 对 temperature 取值做了约束：
    // thinking=enabled 固定为 1.0，thinking=disabled 固定为 0.6。
    if (typeof next.temperature === 'number') {
      next.temperature = thinkingEnabled === false ? 0.6 : 1.0
    }
    return next
  }

  if (provider === 'dashscope') {
    delete next.thinking
    next.messages = stripImageDetailForProvider(next.messages)
    if (typeof thinkingEnabled === 'boolean') {
      next.enable_thinking = thinkingEnabled
    }
    return withDashScopeExplicitCacheControl(next, opts)
  }

  return next
}

function buildBackupRequest(
  params: Record<string, unknown>,
  sourceProvider: ProviderKind,
  opts: ProviderBuildOptions = {},
) {
  const backupClient = getBackupLLMClient()
  if (!backupClient) return null

  const originalModel = params.model as string
  const backupProvider = detectProvider(getBackupBaseUrl())
  const mappedModel = mapModelForBackup(originalModel, backupProvider, getBackupModel())
  if (!mappedModel) return null

  return {
    backupClient,
    backupProvider,
    backupModel: mappedModel,
    backupParams: buildParamsForProvider(params, backupProvider, mappedModel, sourceProvider, opts),
  }
}

// ─── Fallback 触发判断 ───

function getErrorStatus(err: unknown): number | undefined {
  const status = (err as any)?.status ?? (err as any)?.statusCode
  if (typeof status === 'number') return status
  const cause = (err as any)?.cause
  if (cause && cause !== err) return getErrorStatus(cause)
  return undefined
}

function getErrorCode(err: unknown): string | undefined {
  const code = (err as any)?.code
  if (typeof code === 'string' && code) return code
  if (err instanceof Error && err.name) return err.name
  const cause = (err as any)?.cause
  if (cause && cause !== err) return getErrorCode(cause)
  return undefined
}

function buildApiRetryReason(err: unknown, prefix = 'api'): string {
  const status = getErrorStatus(err)
  if (typeof status === 'number') return `${prefix}_http_${status}`
  const code = getErrorCode(err)
  if (code) return `${prefix}_${code.toLowerCase()}`
  return `${prefix}_unknown`
}

function recordUpstreamRetryAttempt(
  attempts: LLMUpstreamRetryAttempt[],
  input: Omit<LLMUpstreamRetryAttempt, 'retryAttempt'>,
): void {
  attempts.push({
    ...input,
    retryAttempt: attempts.length + 1,
  })
}

/** 判断错误是否应触发 fallback 到 backup provider */
export function isFallbackTrigger(err: unknown): boolean {
  const status = (err as any)?.status ?? (err as any)?.statusCode
  if (typeof status === 'number') {
    // 429 rate limit, 500/502/503 server error, 408 timeout
    if ([429, 500, 502, 503, 408].includes(status)) return true
    // 403 余额不足
    if (status === 403) {
      const errType = (err as any)?.error?.type ?? (err as any)?.type ?? ''
      if (errType === 'exceeded_current_quota_error') return true
    }
  }

  // 网络连接错误
  const code = (err as any)?.code
  if (typeof code === 'string') {
    if (['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN'].includes(code)) {
      return true
    }
  }

  // OpenAI SDK 封装的连接错误
  if (err instanceof Error && err.name === 'APIConnectionError') return true

  // 递归检查 cause
  const cause = (err as any)?.cause
  if (cause && cause !== err) return isFallbackTrigger(cause)

  return false
}

// ─── 流式调用（含重试 + fallback） ───

/** 单 client 的流式创建 + 瞬态重试 */
async function createStreamWithRetry(
  client: OpenAI,
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
  logger: Logger,
  provider: ProviderKind,
  retryAttempts: LLMUpstreamRetryAttempt[],
) {
  let lastError: unknown
  const model = params.model as string
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const { data: stream, response } = await client.chat.completions
        .create(params as any, requestOptions(signal))
        .withResponse()
      const requestId =
        response.headers.get('x-request-id') ??
        response.headers.get('x-dashscope-request-id') ??
        null
      return { stream, requestId, provider, model, upstreamRetryAttempts: retryAttempts }
    } catch (err: any) {
      lastError = err
      const status = err?.status ?? err?.statusCode
      if (attempt < MAX_RETRIES && typeof status === 'number' && RETRYABLE_STATUS.has(status)) {
        const delayMs = RETRY_BASE_MS * (attempt + 1)
        const reason = buildApiRetryReason(err)
        recordUpstreamRetryAttempt(retryAttempts, {
          reason,
          provider,
          model,
          status,
        })
        logger.warn(
          {
            provider,
            model,
            status,
            reason,
            retryAttempt: attempt + 1,
            delayMs,
          },
          'retrying LLM request',
        )
        await new Promise((r) => setTimeout(r, delayMs))
        continue
      }
      throw err
    }
  }
  throw lastError
}

/**
 * 流式调用 — primary + retry，失败后 fallback 到 backup
 * 返回 OpenAI streaming response
 */
export async function llmCallStream(
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
  logger: Logger,
  retryAttempts: LLMUpstreamRetryAttempt[] = [],
  options: ProviderBuildOptions = {},
) {
  const primaryClient = getLLMClient()
  const model = params.model as string
  const primaryProvider = detectProvider(getBaseUrl())
  const primaryParams = buildParamsForProvider(params, primaryProvider, model, primaryProvider, options)

  if (!canServeRequestedModel(primaryProvider, model)) {
    const backupRequest = buildBackupRequest(params, primaryProvider, options)
    if (!backupRequest) throw new Error(`Primary provider cannot serve model: ${model}`)

    logger.info(
      {
        originalModel: model,
        backupModel: backupRequest.backupModel,
        backupProvider: backupRequest.backupProvider,
      },
      'primary provider cannot serve model, routing directly to backup',
    )

    return createStreamWithRetry(
      backupRequest.backupClient,
      backupRequest.backupParams,
      signal,
      logger,
      backupRequest.backupProvider,
      retryAttempts,
    )
  }

  // 模拟故障（测试用）
  if (isSimulatingPrimaryFailure()) {
    const fakeErr = new Error('Simulated primary provider failure') as any
    fakeErr.status = 503
    logger.warn('simulating primary provider failure for testing')

    const backupRequest = buildBackupRequest(params, primaryProvider, options)
    if (!backupRequest) throw fakeErr

    logger.warn(
      {
        originalModel: model,
        backupModel: backupRequest.backupModel,
        backupProvider: backupRequest.backupProvider,
      },
      'fallback to backup provider (simulated failure)',
    )

    recordUpstreamRetryAttempt(retryAttempts, {
      reason: 'api_fallback_simulated_failure',
      provider: backupRequest.backupProvider,
      model: backupRequest.backupModel,
      status: fakeErr.status,
      fallback: true,
    })
    return createStreamWithRetry(
      backupRequest.backupClient,
      backupRequest.backupParams,
      signal,
      logger,
      backupRequest.backupProvider,
      retryAttempts,
    )
  }

  try {
    return await createStreamWithRetry(
      primaryClient,
      primaryParams,
      signal,
      logger,
      primaryProvider,
      retryAttempts,
    )
  } catch (err) {
    if (!isFallbackTrigger(err)) throw err

    const backupRequest = buildBackupRequest(params, primaryProvider, options)
    if (!backupRequest) throw err

    logger.warn(
      {
        originalModel: model,
        backupModel: backupRequest.backupModel,
        backupProvider: backupRequest.backupProvider,
        error: (err as Error).message,
        status: (err as any)?.status,
      },
      'primary LLM failed, falling back to backup provider (stream)',
    )

    recordUpstreamRetryAttempt(retryAttempts, {
      reason: buildApiRetryReason(err, 'api_fallback'),
      provider: backupRequest.backupProvider,
      model: backupRequest.backupModel,
      status: getErrorStatus(err),
      fallback: true,
    })
    return createStreamWithRetry(
      backupRequest.backupClient,
      backupRequest.backupParams,
      signal,
      logger,
      backupRequest.backupProvider,
      retryAttempts,
    )
  }
}

// ─── 非流式调用（含 fallback） ───

/**
 * 非流式调用 — primary 失败后 fallback 到 backup
 * 直接透传 OpenAI chat.completions.create 参数
 *
 * options.forceBackup=true 时跳过 primary，直接走 backup provider
 */
export async function llmCall(
  params: Record<string, unknown>,
  logger: Logger,
  options?: { forceBackup?: boolean },
): Promise<OpenAI.Chat.Completions.ChatCompletion> {
  const primaryClient = getLLMClient()
  const model = params.model as string
  const primaryProvider = detectProvider(getBaseUrl())
  const primaryParams = buildParamsForProvider(params, primaryProvider, model, primaryProvider)

  if (options?.forceBackup) {
    const backupRequest = buildBackupRequest(params, primaryProvider)
    if (!backupRequest) {
      throw new Error(`forceBackup requested but backup provider is unavailable for model: ${model}`)
    }

    logger.info(
      {
        originalModel: model,
        backupModel: backupRequest.backupModel,
        backupProvider: backupRequest.backupProvider,
      },
      'forceBackup: routing LLM call to backup provider',
    )

    return backupRequest.backupClient.chat.completions.create(backupRequest.backupParams as any)
  }

  if (!canServeRequestedModel(primaryProvider, model)) {
    const backupRequest = buildBackupRequest(params, primaryProvider)
    if (!backupRequest) throw new Error(`Primary provider cannot serve model: ${model}`)

    logger.info(
      {
        originalModel: model,
        backupModel: backupRequest.backupModel,
        backupProvider: backupRequest.backupProvider,
      },
      'primary provider cannot serve model, routing directly to backup',
    )

    return backupRequest.backupClient.chat.completions.create(backupRequest.backupParams as any)
  }

  // 模拟故障（测试用）
  if (isSimulatingPrimaryFailure()) {
    const fakeErr = new Error('Simulated primary provider failure') as any
    fakeErr.status = 503
    logger.warn('simulating primary provider failure for testing')

    const backupRequest = buildBackupRequest(params, primaryProvider)
    if (!backupRequest) throw fakeErr

    logger.warn(
      {
        originalModel: model,
        backupModel: backupRequest.backupModel,
        backupProvider: backupRequest.backupProvider,
      },
      'fallback to backup provider (simulated failure)',
    )

    return backupRequest.backupClient.chat.completions.create(backupRequest.backupParams as any)
  }

  try {
    return await primaryClient.chat.completions.create(primaryParams as any)
  } catch (err) {
    if (!isFallbackTrigger(err)) throw err

    const backupRequest = buildBackupRequest(params, primaryProvider)
    if (!backupRequest) throw err

    logger.warn(
      {
        originalModel: model,
        backupModel: backupRequest.backupModel,
        backupProvider: backupRequest.backupProvider,
        error: (err as Error).message,
        status: (err as any)?.status,
      },
      'primary LLM failed, falling back to backup provider',
    )

    return backupRequest.backupClient.chat.completions.create(backupRequest.backupParams as any)
  }
}

/**
 * 非流式调用 — 仅走 primary provider，不触发 backup fallback。
 *
 * 用于明确要求固定供应商/固定模型池的场景，例如病历解读协会工具里
 * 3 个专家模型都必须走百炼 primary，以免 fallback 到 Moonshot 后模型族漂移。
 */
export async function llmCallPrimaryOnly(
  params: Record<string, unknown>,
  logger: Logger,
): Promise<OpenAI.Chat.Completions.ChatCompletion> {
  const primaryClient = getLLMClient()
  const model = params.model as string
  const primaryProvider = detectProvider(getBaseUrl())
  const primaryParams = buildParamsForProvider(params, primaryProvider, model, primaryProvider)

  logger.info(
    { model, provider: primaryProvider },
    'primary-only LLM call starting',
  )

  return primaryClient.chat.completions.create(primaryParams as any)
}
