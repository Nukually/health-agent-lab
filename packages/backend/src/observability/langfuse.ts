import { createHash, randomUUID } from 'node:crypto'
import { LangfuseSpanProcessor } from '@langfuse/otel'
import { LangfuseClient } from '@langfuse/client'
import {
  LangfuseOtelSpanAttributes,
  startObservation,
  type LangfuseAgent,
  type LangfuseGeneration,
  type LangfuseSpan,
  type LangfuseTool,
  type ObservationLevel,
} from '@langfuse/tracing'
import { NodeSDK } from '@opentelemetry/sdk-node'
import { TraceIdRatioBasedSampler } from '@opentelemetry/sdk-trace-base'
import type { Logger } from '../lib/logger.js'

const DEFAULT_MAX_FIELD_CHARS = 8000
const DEFAULT_FLUSH_AT = 20
const DEFAULT_FLUSH_INTERVAL_SECONDS = 5
const DEFAULT_TIMEOUT_SECONDS = 5

type EnvLike = Record<string, unknown>

export interface LangfuseConfig {
  enabled: boolean
  publicKey?: string
  secretKey?: string
  baseUrl?: string
  environment?: string
  release?: string
  sampleRate: number
  captureRawLLMIO: boolean
  captureThinking: boolean
  maxFieldChars: number
  flushAt: number
  flushIntervalSeconds: number
  timeoutSeconds: number
  promptSyncEnabled: boolean
  systemPromptName: string
  promptLabel?: string
}

export interface LangfuseAgentTrace {
  root: LangfuseAgent | null
  config: LangfuseConfig
  traceId?: string
}

export interface LangfusePromptRef {
  name: string
  version: number
  isFallback: boolean
  promptHash: string
}

interface LangfuseUsageInput {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  promptTokensDetails?: Record<string, number>
  completionTokensDetails?: Record<string, number>
}

type LangfuseUsageDetails = Record<string, number | Record<string, number> | undefined>

type LangfuseParent = LangfuseAgent | LangfuseSpan | LangfuseTool | LangfuseGeneration | null | undefined
type LangfuseGenerationHandle = LangfuseGeneration | ManualLangfuseGeneration
type LangfuseIngestionEvent = {
  id: string
  timestamp: string
  type: 'generation-create' | 'generation-update'
  body: Record<string, unknown>
  metadata?: Record<string, unknown>
}

interface ManualLangfuseGeneration {
  kind: 'manual-generation'
  id: string
  traceId: string
  parentObservationId?: string
}

function isManualLangfuseGeneration(generation: LangfuseGenerationHandle): generation is ManualLangfuseGeneration {
  return (generation as ManualLangfuseGeneration).kind === 'manual-generation'
}

let sdk: NodeSDK | null = null
let promptClient: LangfuseClient | null = null
let ingestionClient: LangfuseClient | null = null
let activeConfig: LangfuseConfig = buildLangfuseConfig({})
const syncedPromptRefs = new Map<string, LangfusePromptRef>()
const pendingIngestionWrites = new Set<Promise<void>>()

function readString(env: EnvLike, key: string): string | undefined {
  const value = env[key]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function readBoolean(env: EnvLike, key: string, defaultValue: boolean): boolean {
  const value = env[key]
  if (typeof value === 'boolean') return value
  if (typeof value !== 'string') return defaultValue
  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off', ''].includes(normalized)) return false
  return defaultValue
}

function readNumber(env: EnvLike, key: string, defaultValue: number, opts?: { min?: number; max?: number }): number {
  const value = env[key]
  const raw = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isFinite(raw)) return defaultValue
  const min = opts?.min ?? -Infinity
  const max = opts?.max ?? Infinity
  return Math.min(Math.max(raw, min), max)
}

export function buildLangfuseConfig(env: EnvLike): LangfuseConfig {
  const requested = readBoolean(env, 'LANGFUSE_ENABLED', false)
  const publicKey = readString(env, 'LANGFUSE_PUBLIC_KEY')
  const secretKey = readString(env, 'LANGFUSE_SECRET_KEY')
  const baseUrl = readString(env, 'LANGFUSE_BASE_URL')
  const enabled = requested && !!publicKey && !!secretKey && !!baseUrl

  return {
    enabled,
    publicKey,
    secretKey,
    baseUrl,
    environment:
      readString(env, 'LANGFUSE_ENVIRONMENT') ??
      readString(env, 'LANGFUSE_TRACING_ENVIRONMENT') ??
      readString(env, 'DEPLOY_ENV') ??
      readString(env, 'NODE_ENV'),
    release: readString(env, 'LANGFUSE_RELEASE'),
    sampleRate: readNumber(env, 'LANGFUSE_SAMPLE_RATE', 1, { min: 0, max: 1 }),
    captureRawLLMIO: readBoolean(env, 'LANGFUSE_CAPTURE_RAW_LLM_IO', false),
    captureThinking: readBoolean(env, 'LANGFUSE_CAPTURE_THINKING', false),
    maxFieldChars: Math.floor(readNumber(env, 'LANGFUSE_MAX_FIELD_CHARS', DEFAULT_MAX_FIELD_CHARS, { min: 512, max: 200_000 })),
    flushAt: Math.floor(readNumber(env, 'LANGFUSE_FLUSH_AT', DEFAULT_FLUSH_AT, { min: 1, max: 1000 })),
    flushIntervalSeconds: readNumber(env, 'LANGFUSE_FLUSH_INTERVAL_SECONDS', DEFAULT_FLUSH_INTERVAL_SECONDS, { min: 1, max: 120 }),
    timeoutSeconds: readNumber(env, 'LANGFUSE_TIMEOUT_SECONDS', DEFAULT_TIMEOUT_SECONDS, { min: 1, max: 60 }),
    promptSyncEnabled: readBoolean(env, 'LANGFUSE_PROMPT_SYNC_ENABLED', false),
    systemPromptName: readString(env, 'LANGFUSE_SYSTEM_PROMPT_NAME') ?? 'health-agent-lab-system-prompt',
    promptLabel: readString(env, 'LANGFUSE_PROMPT_LABEL') ?? readString(env, 'LANGFUSE_ENVIRONMENT') ?? readString(env, 'DEPLOY_ENV'),
  }
}

function truncateString(value: string, maxChars = activeConfig.maxFieldChars): string {
  if (value.length <= maxChars) return value
  const omitted = value.length - maxChars
  return `${value.slice(0, maxChars)}...[TRUNCATED_${omitted}_CHARS]`
}

function maskString(value: string): string {
  return truncateString(value)
    .replace(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+/g, '[IMAGE_DATA_URL_REDACTED]')
    .replace(/(https?:\/\/[^\s"'<>?]+)\?([^\s"'<>]*(?:Signature|OSSAccessKeyId|Expires|X-Amz-Signature|X-Amz-Credential)[^\s"'<>]*)/gi, '$1?[SIGNED_URL_QUERY_REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/(Authorization:\s*)(Basic|Bearer)\s+[A-Za-z0-9._~+/=-]+/gi, '$1$2 [REDACTED]')
    .replace(/(\b1[3-9]\d)\d{4}(\d{4}\b)/g, '$1****$2')
    .replace(/((?:api[_-]?key|secret|token|password|jwt|cookie)\s*[:=]\s*)[^\s,"'}]+/gi, '$1[REDACTED]')
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.replace(/[-_]/g, '').toLowerCase()
  return [
    'token',
    'jwt',
    'authtoken',
    'accesstoken',
    'refreshtoken',
    'idtoken',
    'sessiontoken',
  ].includes(normalized) ||
    /authorization|cookie|secret|password|api[_-]?key|medicalrecord|image_url|base64/i.test(key)
}

export function maskLangfuseData(params: { data: any }): any {
  const seen = new WeakSet<object>()

  const walk = (value: any, keyHint?: string): any => {
    if (typeof keyHint === 'string' && isSensitiveKey(keyHint)) {
      if (typeof value === 'string' && /^https?:\/\//i.test(value)) return maskString(value)
      return '[REDACTED]'
    }
    if (typeof value === 'string') return maskString(value)
    if (value === null || typeof value !== 'object') return value
    if (seen.has(value)) return '[CIRCULAR]'
    seen.add(value)

    if (Array.isArray(value)) return value.map((item) => walk(item))

    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      out[key] = walk(item, key)
    }
    return out
  }

  return walk(params.data)
}

function stableJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return String(value)
  }
}

function shortHash(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex').slice(0, 16)
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function nonZeroHexId(value: string): string {
  return /^0+$/.test(value) ? `1${value.slice(1)}` : value
}

function traceIdFromRequestId(requestId: string): string {
  const normalized = requestId.replace(/-/g, '').toLowerCase()
  if (/^[0-9a-f]{32}$/.test(normalized)) {
    return nonZeroHexId(normalized)
  }
  return nonZeroHexId(hashText(`health-agent-lab:langfuse-trace:${requestId}`).slice(0, 32))
}

export function buildLangfuseTraceContext(input: {
  requestId: string
}): { traceId: string; parentSpanId: string } {
  const parentSpanId = hashText(`health-agent-lab:langfuse-parent:${input.requestId}`).slice(0, 16)
  return {
    traceId: traceIdFromRequestId(input.requestId),
    parentSpanId: nonZeroHexId(parentSpanId),
  }
}

export function summarizeForLangfuse(
  value: unknown,
  opts: { captureRaw: boolean; maxFieldChars?: number },
): unknown {
  if (opts.captureRaw) {
    const masked = maskLangfuseData({ data: value })
    return typeof masked === 'string'
      ? truncateString(masked, opts.maxFieldChars ?? activeConfig.maxFieldChars)
      : masked
  }

  if (value === null || value === undefined) return value
  if (typeof value === 'string') {
    return { kind: 'string', chars: value.length, sha256: shortHash(value) }
  }
  if (Array.isArray(value)) {
    return { kind: 'array', length: value.length, jsonChars: stableJson(value).length, sha256: shortHash(value) }
  }
  if (typeof value === 'object') {
    return {
      kind: 'object',
      keys: Object.keys(value as Record<string, unknown>).slice(0, 20),
      jsonChars: stableJson(value).length,
    }
  }
  return value
}

export function shouldCaptureRawLangfuseIO(
  config: Pick<LangfuseConfig, 'captureRawLLMIO'> & Partial<Pick<LangfuseConfig, 'captureThinking'>>,
  kind: 'llm' | 'thinking' | 'tool',
): boolean {
  if (kind === 'thinking') return config.captureRawLLMIO && config.captureThinking === true
  return config.captureRawLLMIO
}

export function buildLangfuseUsageDetails(usage: LangfuseUsageInput | undefined): LangfuseUsageDetails | undefined {
  if (!usage) return undefined

  const inputTokens = usage.inputTokens ?? 0
  const outputTokens = usage.outputTokens ?? 0
  const totalTokens = usage.totalTokens ?? inputTokens + outputTokens
  const cachedInputTokens = usage.promptTokensDetails?.cached_tokens
  const reasoningOutputTokens = usage.completionTokensDetails?.reasoning_tokens

  const usageDetails: LangfuseUsageDetails = {
    input: typeof cachedInputTokens === 'number'
      ? Math.max(inputTokens - cachedInputTokens, 0)
      : inputTokens,
    output: typeof reasoningOutputTokens === 'number'
      ? Math.max(outputTokens - reasoningOutputTokens, 0)
      : outputTokens,
    total: totalTokens,
  }

  if (typeof cachedInputTokens === 'number') {
    usageDetails.cache_read_input_tokens = cachedInputTokens
  }
  if (typeof reasoningOutputTokens === 'number') {
    usageDetails.output_reasoning_tokens = reasoningOutputTokens
  }

  return usageDetails
}

function promptAttrs(prompt: LangfusePromptRef | null | undefined): Record<string, unknown> {
  if (!prompt || prompt.isFallback) return {}
  return {
    promptName: prompt.name,
    promptVersion: prompt.version,
  }
}

export function buildLangfuseGenerationCreateEvent(input: {
  id: string
  traceId: string
  parentObservationId?: string
  timestamp: Date
  name: string
  model: string
  modelParameters?: Record<string, string | number>
  input?: unknown
  metadata?: Record<string, unknown>
  prompt?: LangfusePromptRef | null
  config: LangfuseConfig
}): LangfuseIngestionEvent {
  return {
    id: randomUUID(),
    timestamp: input.timestamp.toISOString(),
    type: 'generation-create',
    body: {
      id: input.id,
      traceId: input.traceId,
      parentObservationId: input.parentObservationId,
      name: input.name,
      startTime: input.timestamp.toISOString(),
      model: input.model,
      modelParameters: input.modelParameters,
      input: summarizeForLangfuse(input.input, {
        captureRaw: shouldCaptureRawLangfuseIO(input.config, 'llm'),
      }),
      metadata: input.metadata,
      environment: input.config.environment,
      ...promptAttrs(input.prompt),
    },
    metadata: { source: 'health-agent-lab-langfuse-generation' },
  }
}

function buildLangfuseGenerationUpdateEvent(input: {
  id: string
  traceId: string
  timestamp: Date
  output?: unknown
  thinking?: string
  usage?: LangfuseUsageInput
  model?: string
  metadata?: Record<string, unknown>
  prompt?: LangfusePromptRef | null
  config: LangfuseConfig
  error?: unknown
  end?: boolean
}): LangfuseIngestionEvent {
  const usageDetails = buildLangfuseUsageDetails(input.usage)
  return {
    id: randomUUID(),
    timestamp: input.timestamp.toISOString(),
    type: 'generation-update',
    body: {
      id: input.id,
      traceId: input.traceId,
      endTime: input.end ? input.timestamp.toISOString() : undefined,
      model: input.model,
      output: input.end
        ? summarizeForLangfuse(
            {
              content: input.output,
              thinking: input.thinking,
            },
            { captureRaw: shouldCaptureRawLangfuseIO(input.config, 'llm') },
          )
        : undefined,
      usageDetails: usageDetails as { [key: string]: number } | undefined,
      metadata: input.metadata,
      level: levelForError(input.error),
      statusMessage: input.error instanceof Error ? input.error.message : undefined,
      ...promptAttrs(input.prompt),
    },
    metadata: { source: 'health-agent-lab-langfuse-generation' },
  }
}

export function initLangfuse(config: LangfuseConfig, logger: Logger): void {
  activeConfig = config
  if (!config.enabled) {
    logger.info({ requested: false }, 'Langfuse tracing disabled')
    return
  }
  if (sdk) {
    logger.warn('Langfuse tracing already initialized, skipping')
    return
  }

  try {
    sdk = new NodeSDK({
      sampler: new TraceIdRatioBasedSampler(config.sampleRate),
      spanProcessors: [
        new LangfuseSpanProcessor({
          publicKey: config.publicKey,
          secretKey: config.secretKey,
          baseUrl: config.baseUrl,
          environment: config.environment,
          release: config.release,
          flushAt: config.flushAt,
          flushInterval: config.flushIntervalSeconds,
          timeout: config.timeoutSeconds,
          mask: maskLangfuseData,
        }),
      ],
    })
    sdk.start()
    logger.info(
      {
        baseUrl: config.baseUrl,
        environment: config.environment,
        sampleRate: config.sampleRate,
        captureRawLLMIO: config.captureRawLLMIO,
      },
      'Langfuse tracing initialized',
    )
  } catch (err) {
    sdk = null
    logger.warn({ err }, 'failed to initialize Langfuse tracing; continuing without tracing')
  }
}

export async function shutdownLangfuse(logger: Logger): Promise<void> {
  try {
    await Promise.allSettled(Array.from(pendingIngestionWrites))
    await promptClient?.shutdown()
    await ingestionClient?.shutdown()
    await sdk?.shutdown()
  } catch (err) {
    logger.warn({ err }, 'failed to shutdown Langfuse cleanly')
  } finally {
    promptClient = null
    ingestionClient = null
    sdk = null
  }
}

export function getLangfuseConfig(): LangfuseConfig {
  return activeConfig
}

export function isLangfuseEnabled(): boolean {
  return activeConfig.enabled && !!sdk
}

export function getLangfusePromptClient(logger: Logger): LangfuseClient | null {
  if (!activeConfig.enabled) return null
  if (promptClient) return promptClient
  try {
    promptClient = new LangfuseClient({
      publicKey: activeConfig.publicKey,
      secretKey: activeConfig.secretKey,
      baseUrl: activeConfig.baseUrl,
      timeout: activeConfig.timeoutSeconds,
    })
    return promptClient
  } catch (err) {
    logger.warn({ err }, 'failed to initialize Langfuse prompt client')
    return null
  }
}

function getLangfuseIngestionClient(): LangfuseClient | null {
  if (!activeConfig.enabled) return null
  if (ingestionClient) return ingestionClient
  try {
    ingestionClient = new LangfuseClient({
      publicKey: activeConfig.publicKey,
      secretKey: activeConfig.secretKey,
      baseUrl: activeConfig.baseUrl,
      timeout: activeConfig.timeoutSeconds,
    })
    return ingestionClient
  } catch {
    return null
  }
}

function enqueueLangfuseIngestion(event: LangfuseIngestionEvent): boolean {
  const client = getLangfuseIngestionClient()
  if (!client) return false
  const write = client.api.ingestion.batch({ batch: [event as any] })
    .then(() => undefined)
    .catch(() => undefined)
  pendingIngestionWrites.add(write)
  void write.finally(() => pendingIngestionWrites.delete(write))
  return true
}

function levelForError(error?: unknown): ObservationLevel {
  return error ? 'ERROR' : 'DEFAULT'
}

async function fetchLatestTextPrompt(input: {
  name: string
  label?: string
  config: LangfuseConfig
}): Promise<{ name: string; version: number; prompt: string; isFallback: false } | null> {
  if (!input.config.baseUrl || !input.config.publicKey || !input.config.secretKey) return null
  const url = new URL(`/api/public/v2/prompts/${encodeURIComponent(input.name)}`, input.config.baseUrl)
  if (input.label) url.searchParams.set('label', input.label)
  const auth = Buffer.from(`${input.config.publicKey}:${input.config.secretKey}`).toString('base64')
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), input.config.timeoutSeconds * 1000)
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Basic ${auth}` },
      signal: controller.signal,
    })
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`Langfuse prompt lookup failed with status ${res.status}`)
    const body = await res.json() as {
      name?: unknown
      version?: unknown
      prompt?: unknown
    }
    if (
      typeof body.name === 'string' &&
      typeof body.version === 'number' &&
      typeof body.prompt === 'string'
    ) {
      return {
        name: body.name,
        version: body.version,
        prompt: body.prompt,
        isFallback: false,
      }
    }
    return null
  } finally {
    clearTimeout(timeout)
  }
}

export async function syncLangfuseSystemPrompt(input: {
  prompt: string
  logger: Logger
  featureSignature?: string
  promptFromCache?: boolean
  metadata?: Record<string, unknown>
}): Promise<LangfusePromptRef | null> {
  return syncLangfuseTextPrompt({
    name: activeConfig.systemPromptName,
    prompt: input.prompt,
    logger: input.logger,
    source: 'compiled-system-prompt-base',
    tags: ['system-prompt'],
    commitMessagePrefix: 'sync compiled system prompt base',
    metadata: {
      featureSignature: input.featureSignature,
      promptFromCache: input.promptFromCache ?? false,
      ...input.metadata,
    },
  })
}

export async function syncLangfuseTextPrompt(input: {
  name: string
  prompt: string
  logger: Logger
  source: string
  tags?: string[]
  commitMessagePrefix?: string
  metadata?: Record<string, unknown>
}): Promise<LangfusePromptRef | null> {
  const config = activeConfig
  if (!isLangfuseEnabled() || !config.promptSyncEnabled) return null

  const promptHash = hashText(input.prompt)
  const promptName = input.name
  const cacheKey = `${promptName}:${config.promptLabel ?? 'unlabeled'}:${promptHash}`
  const cached = syncedPromptRefs.get(cacheKey)
  if (cached) return cached

  const client = getLangfusePromptClient(input.logger)
  if (!client) return null

  const labels = config.promptLabel ? [config.promptLabel] : undefined
  const tags = [
    'health-agent-lab',
    ...(input.tags ?? []),
    ...(config.environment ? [config.environment] : []),
  ]
  const promptConfig = {
    promptHash,
    promptLength: input.prompt.length,
    environment: config.environment,
    source: input.source,
    ...input.metadata,
  }

  try {
    const latest = await fetchLatestTextPrompt({
      name: promptName,
      label: config.promptLabel,
      config,
    })
    if (latest?.prompt === input.prompt) {
      const ref = { name: latest.name, version: latest.version, isFallback: false, promptHash }
      syncedPromptRefs.set(cacheKey, ref)
      return ref
    }
  } catch (err) {
    input.logger.debug(
      { err, promptName, promptHash: promptHash.slice(0, 16) },
      'latest Langfuse prompt not reusable; creating prompt version',
    )
  }

  try {
    const created = await client.prompt.create({
      name: promptName,
      type: 'text',
      prompt: input.prompt,
      labels,
      tags,
      config: promptConfig,
      commitMessage: `${input.commitMessagePrefix ?? `sync ${promptName}`} ${promptHash.slice(0, 12)}`,
    })
    const ref = {
      name: created.name,
      version: created.version,
      isFallback: created.isFallback,
      promptHash,
    }
    syncedPromptRefs.set(cacheKey, ref)
    input.logger.info(
      {
        promptName: ref.name,
        promptVersion: ref.version,
        promptHash: promptHash.slice(0, 16),
        label: config.promptLabel,
      },
      'Langfuse text prompt synced',
    )
    return ref
  } catch (err) {
    input.logger.warn(
      { err, promptName, promptHash: promptHash.slice(0, 16) },
      'failed to sync text prompt to Langfuse',
    )
    return null
  }
}

export function startLangfuseAgentTrace(input: {
  name?: string
  userId: string
  requestId: string
  sessionId: string
  input?: unknown
  metadata?: Record<string, unknown>
  tags?: string[]
}): LangfuseAgentTrace {
  const config = activeConfig
  if (!isLangfuseEnabled()) return { root: null, config }
  const traceContext = buildLangfuseTraceContext({
    requestId: input.requestId,
  })

  const root = startObservation(
    input.name ?? 'cx.agent.chat',
    {
      input: summarizeForLangfuse(input.input, {
        captureRaw: shouldCaptureRawLangfuseIO(config, 'llm'),
      }),
      metadata: {
        userId: input.userId,
        sessionId: input.sessionId,
        ...input.metadata,
        requestId: input.requestId,
        tags: input.tags,
      },
      environment: config.environment,
    },
    {
      asType: 'agent',
      parentSpanContext: {
        traceId: traceContext.traceId,
        spanId: traceContext.parentSpanId,
        traceFlags: 1,
      },
    },
  )
  root.otelSpan.setAttributes({
    [LangfuseOtelSpanAttributes.TRACE_NAME]: input.name ?? 'cx.agent.chat',
    [LangfuseOtelSpanAttributes.TRACE_USER_ID]: input.userId,
    [LangfuseOtelSpanAttributes.TRACE_SESSION_ID]: input.sessionId,
    [LangfuseOtelSpanAttributes.TRACE_TAGS]: input.tags ?? [],
    [LangfuseOtelSpanAttributes.TRACE_METADATA]: JSON.stringify({
      ...input.metadata,
      requestId: input.requestId,
      traceScope: 'request',
      stableTraceId: traceContext.traceId,
    }),
  })

  return { root, config, traceId: traceContext.traceId }
}

export function finishLangfuseAgentTrace(
  trace: LangfuseAgentTrace | undefined,
  output: { output?: unknown; metadata?: Record<string, unknown>; error?: unknown },
): void {
  if (!trace?.root) return
  try {
    trace.root.update({
      output: summarizeForLangfuse(output.output, {
        captureRaw: shouldCaptureRawLangfuseIO(trace.config, 'llm'),
      }),
      metadata: output.metadata,
      level: levelForError(output.error),
      statusMessage: output.error instanceof Error ? output.error.message : undefined,
    })
    trace.root.end()
  } catch {
    // Tracing must never affect user-facing chat.
  }
}

export function startLangfuseGeneration(
  parent: LangfuseParent,
  input: {
    name: string
    model: string
    modelParameters?: Record<string, string | number>
    input?: unknown
    metadata?: Record<string, unknown>
    prompt?: LangfusePromptRef | null
  },
): LangfuseGenerationHandle | null {
  if (!parent) return null
  const config = activeConfig
  try {
    const startedAt = new Date()
    const manualGeneration: ManualLangfuseGeneration = {
      kind: 'manual-generation',
      id: randomUUID(),
      traceId: parent.traceId,
      parentObservationId: parent.id,
    }
    if (enqueueLangfuseIngestion(buildLangfuseGenerationCreateEvent({
      id: manualGeneration.id,
      traceId: manualGeneration.traceId,
      parentObservationId: manualGeneration.parentObservationId,
      timestamp: startedAt,
      name: input.name,
      model: input.model,
      modelParameters: input.modelParameters,
      input: input.input,
      metadata: input.metadata,
      prompt: input.prompt,
      config,
    }))) {
      return manualGeneration
    }

    return parent.startObservation(
      input.name,
      {
        input: summarizeForLangfuse(input.input, {
          captureRaw: shouldCaptureRawLangfuseIO(config, 'llm'),
        }),
        model: input.model,
        modelParameters: input.modelParameters,
        prompt: input.prompt
          ? {
              name: input.prompt.name,
              version: input.prompt.version,
              isFallback: input.prompt.isFallback,
            }
          : undefined,
        metadata: input.metadata,
        environment: config.environment,
      },
      { asType: 'generation' },
    )
  } catch {
    return null
  }
}

export function updateLangfuseGeneration(
  generation: LangfuseGenerationHandle | null,
  attrs: {
    model?: string
    metadata?: Record<string, unknown>
    prompt?: LangfusePromptRef | null
  },
): void {
  if (!generation) return
  try {
    if (isManualLangfuseGeneration(generation)) {
      enqueueLangfuseIngestion(buildLangfuseGenerationUpdateEvent({
        id: generation.id,
        traceId: generation.traceId,
        timestamp: new Date(),
        model: attrs.model,
        metadata: attrs.metadata,
        prompt: attrs.prompt,
        config: activeConfig,
      }))
      return
    }

    generation.update({
      ...attrs,
      prompt: attrs.prompt
        ? {
            name: attrs.prompt.name,
            version: attrs.prompt.version,
            isFallback: attrs.prompt.isFallback,
          }
        : undefined,
    })
  } catch {
    // no-op
  }
}

export function finishLangfuseGeneration(
  generation: LangfuseGenerationHandle | null,
  output: {
    output?: unknown
    thinking?: string
    usage?: LangfuseUsageInput
    metadata?: Record<string, unknown>
    error?: unknown
  },
): void {
  if (!generation) return
  const config = activeConfig
  try {
    const usageDetails = buildLangfuseUsageDetails(output.usage)
    if (isManualLangfuseGeneration(generation)) {
      enqueueLangfuseIngestion(buildLangfuseGenerationUpdateEvent({
        id: generation.id,
        traceId: generation.traceId,
        timestamp: new Date(),
        output: output.output,
        thinking: output.thinking,
        usage: output.usage,
        metadata: {
          ...output.metadata,
          thinkingCaptured: shouldCaptureRawLangfuseIO(config, 'thinking'),
        },
        config,
        error: output.error,
        end: true,
      }))
      return
    }

    generation.update({
      output: summarizeForLangfuse(
        {
          content: output.output,
          thinking: output.thinking,
        },
        { captureRaw: shouldCaptureRawLangfuseIO(config, 'llm') },
      ),
      usageDetails: usageDetails as { [key: string]: number } | undefined,
      metadata: {
        ...output.metadata,
        thinkingCaptured: shouldCaptureRawLangfuseIO(config, 'thinking'),
      },
      level: levelForError(output.error),
      statusMessage: output.error instanceof Error ? output.error.message : undefined,
    })
    generation.end()
  } catch {
    // no-op
  }
}

export function startLangfuseTool(
  parent: LangfuseParent,
  input: {
    name: string
    input?: unknown
    metadata?: Record<string, unknown>
  },
): LangfuseTool | null {
  if (!parent) return null
  const config = activeConfig
  try {
    return parent.startObservation(
      input.name,
      {
        input: summarizeForLangfuse(input.input, {
          captureRaw: shouldCaptureRawLangfuseIO(config, 'tool'),
        }),
        metadata: input.metadata,
        environment: config.environment,
      },
      { asType: 'tool' },
    )
  } catch {
    return null
  }
}

export function finishLangfuseTool(
  tool: LangfuseTool | null,
  output: {
    output?: unknown
    metadata?: Record<string, unknown>
    error?: unknown
  },
): void {
  if (!tool) return
  const config = activeConfig
  try {
    tool.update({
      output: summarizeForLangfuse(output.output, {
        captureRaw: shouldCaptureRawLangfuseIO(config, 'tool'),
      }),
      metadata: output.metadata,
      level: levelForError(output.error),
      statusMessage: output.error instanceof Error ? output.error.message : undefined,
    })
    tool.end()
  } catch {
    // no-op
  }
}
