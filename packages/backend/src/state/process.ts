/**
 * Process State — 进程级单例
 *
 * 参考 claude-code ch03: bootstrap state 模式
 * - 进程启动时创建，整个生命周期不变
 * - 通过 getter/setter 访问，禁止直接修改
 * - 作为 DAG 叶子节点，不依赖任何业务模块
 */

import OpenAI from 'openai'
import { rootLogger, type Logger } from '../lib/logger.js'

interface ProcessState {
  // LLM — Primary
  llmClient: OpenAI | null
  model: string
  baseUrl: string
  contextWindowSize: number

  // LLM — Backup（默认 Kimi 官方 API 兜底，可通过 env 覆盖）
  backupLLMClient: OpenAI | null
  backupBaseUrl: string
  backupModel: string

  // Metrics (monotonic accumulation)
  totalCostUSD: number
  totalTokensIn: number
  totalTokensOut: number
  totalApiCalls: number
  totalApiDurationMs: number

  // Config
  initialized: boolean

  // Testing
  simulatePrimaryFailure: boolean
}

const STATE: ProcessState = {
  llmClient: null,
  model: 'kimi-k2.5',
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  contextWindowSize: 262_144,
  backupLLMClient: null,
  backupBaseUrl: 'https://api.moonshot.cn/v1',
  backupModel: 'kimi-k2.6',
  totalCostUSD: 0,
  totalTokensIn: 0,
  totalTokensOut: 0,
  totalApiCalls: 0,
  totalApiDurationMs: 0,
  initialized: false,
  simulatePrimaryFailure: false,
}

const logger = rootLogger.child({ module: 'process-state' })

// === Initialization ===

export function initProcessState(config: {
  apiKey: string
  model?: string
  baseUrl?: string
  contextWindowSize?: number
  backupApiKey?: string
  backupBaseUrl?: string
  backupModel?: string
}): void {
  if (STATE.initialized) {
    logger.warn('process state already initialized, skipping')
    return
  }

  STATE.model = config.model || STATE.model
  STATE.baseUrl = config.baseUrl || STATE.baseUrl
  if (config.contextWindowSize) STATE.contextWindowSize = config.contextWindowSize
  STATE.llmClient = new OpenAI({
    apiKey: config.apiKey,
    baseURL: STATE.baseUrl,
  })

  // Backup provider（月之暗面官方 API）
  if (config.backupApiKey) {
    STATE.backupBaseUrl = config.backupBaseUrl || STATE.backupBaseUrl
    STATE.backupModel = config.backupModel || STATE.backupModel
    STATE.backupLLMClient = new OpenAI({
      apiKey: config.backupApiKey,
      baseURL: STATE.backupBaseUrl,
    })
    logger.info(
      { backupBaseUrl: STATE.backupBaseUrl, backupModel: STATE.backupModel },
      'backup LLM provider initialized',
    )
  }

  STATE.initialized = true
  logger.info({ model: STATE.model, baseUrl: STATE.baseUrl }, 'process state initialized')
}

// === LLM Client ===

export function getLLMClient(): OpenAI {
  if (!STATE.llmClient) throw new Error('LLM client not initialized. Call initProcessState first.')
  return STATE.llmClient
}

export function getModel(): string {
  return STATE.model
}

export function getBaseUrl(): string {
  return STATE.baseUrl
}

export function getContextWindowSize(): number {
  return STATE.contextWindowSize
}

// === Backup LLM Client ===

export function getBackupLLMClient(): OpenAI | null {
  return STATE.backupLLMClient
}

export function getBackupModel(): string {
  return STATE.backupModel
}

export function getBackupBaseUrl(): string {
  return STATE.backupBaseUrl
}

// === Simulate Failure (testing) ===

export function setSimulatePrimaryFailure(enabled: boolean): void {
  STATE.simulatePrimaryFailure = enabled
  logger.info({ enabled }, 'simulate primary failure toggled')
}

export function isSimulatingPrimaryFailure(): boolean {
  return STATE.simulatePrimaryFailure
}

// === Metrics (monotonic) ===

export function addApiMetrics(metrics: {
  tokensIn: number
  tokensOut: number
  durationMs: number
  costUSD?: number
}): void {
  STATE.totalTokensIn += metrics.tokensIn
  STATE.totalTokensOut += metrics.tokensOut
  STATE.totalApiCalls += 1
  STATE.totalApiDurationMs += metrics.durationMs
  if (metrics.costUSD) STATE.totalCostUSD += metrics.costUSD

  logger.debug(
    {
      totalCalls: STATE.totalApiCalls,
      totalTokensIn: STATE.totalTokensIn,
      totalTokensOut: STATE.totalTokensOut,
      totalCostUSD: STATE.totalCostUSD.toFixed(4),
    },
    'api metrics updated',
  )
}

export function getMetrics() {
  return {
    totalCostUSD: STATE.totalCostUSD,
    totalTokensIn: STATE.totalTokensIn,
    totalTokensOut: STATE.totalTokensOut,
    totalApiCalls: STATE.totalApiCalls,
    totalApiDurationMs: STATE.totalApiDurationMs,
  }
}

// === Test support ===

export function resetProcessStateForTests(): void {
  STATE.llmClient = null
  STATE.model = 'kimi-k2.5'
  STATE.baseUrl = 'https://dashscope.aliyuncs.com/compatible-mode/v1'
  STATE.contextWindowSize = 262_144
  STATE.backupLLMClient = null
  STATE.backupBaseUrl = 'https://api.moonshot.cn/v1'
  STATE.backupModel = 'kimi-k2.6'
  STATE.totalCostUSD = 0
  STATE.totalTokensIn = 0
  STATE.totalTokensOut = 0
  STATE.totalApiCalls = 0
  STATE.totalApiDurationMs = 0
  STATE.initialized = false
  STATE.simulatePrimaryFailure = false
}
