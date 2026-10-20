/**
 * LLM Client Factory — Provider-agnostic 工厂
 *
 * 参考 claude-code ch04: getAnthropicClient() 模式
 * 环境变量驱动 provider 选择，返回统一接口
 * 当前只有智谱，但接口已预留切换能力
 */

import { getModel, addApiMetrics } from '../state/process.js'
import { llmCallStream } from '../lib/llm.js'
import { classifyLLMError } from '../lib/llm-errors.js'
import { createWatchdog } from './watchdog.js'
import type { ChatParams, LLMStreamEvent, LLMResponse, LLMUsage, LLMUpstreamRetryAttempt } from './types.js'
import { SSE_EVENTS, ERROR_CODES } from '@health-agent/shared'
import type { Logger } from '../lib/logger.js'
import {
  finishLangfuseGeneration,
  startLangfuseGeneration,
  updateLangfuseGeneration,
} from '../observability/langfuse.js'

export const LLM_STREAM_TIMEOUT_ABORT_REASON = 'llm_stream_timeout' as const

const OPEN_THINKING = '<thinking>'
const CLOSE_THINKING = '</thinking>'
const OPEN_THINKING_TAGS = [OPEN_THINKING, '<think>'] as const
const CLOSE_THINKING_TAGS = [CLOSE_THINKING, '</think>'] as const
const FINAL_TAG = '<final_answer>'
const CLOSE_TAG = '</final_answer>'
const THINKING_PHASE_MARKER_RE = /<\|[^|<>\n]+\|>/
const PARTIAL_THINKING_PHASE_MARKER_SUFFIX_RE = /<\|[^|<>\n]*(?:\|?)$/

type PreambleProtocolToken =
  | { kind: 'thinking-open'; index: number; token: string }
  | { kind: 'thinking-phase'; index: number; token: string }
  | { kind: 'final-answer'; index: number; token: string }

function firstFixedToken(
  buf: string,
  tags: readonly string[],
  kind: PreambleProtocolToken['kind'],
): PreambleProtocolToken | null {
  let found: PreambleProtocolToken | null = null
  for (const tag of tags) {
    const index = buf.indexOf(tag)
    if (index < 0) continue
    if (!found || index < found.index) found = { kind, index, token: tag }
  }
  return found
}

function earlierProtocolToken(
  current: PreambleProtocolToken | null,
  candidate: PreambleProtocolToken | null,
): PreambleProtocolToken | null {
  if (!candidate) return current
  if (!current || candidate.index < current.index) return candidate
  return current
}

export function findFirstPreambleProtocolToken(buf: string): PreambleProtocolToken | null {
  let found = firstFixedToken(buf, OPEN_THINKING_TAGS, 'thinking-open')
  found = earlierProtocolToken(found, firstFixedToken(buf, [FINAL_TAG], 'final-answer'))

  const phaseMatch = THINKING_PHASE_MARKER_RE.exec(buf)
  if (phaseMatch?.index != null) {
    found = earlierProtocolToken(found, {
      kind: 'thinking-phase',
      index: phaseMatch.index,
      token: phaseMatch[0],
    })
  }

  return found
}

function findFirstThinkingCloseToken(buf: string): { index: number; token: string } | null {
  const found = firstFixedToken(buf, CLOSE_THINKING_TAGS, 'thinking-open')
  return found ? { index: found.index, token: found.token } : null
}

function longestPartialSuffix(buf: string, tags: readonly string[]): number {
  let maxLen = 0
  for (const tag of tags) {
    const upper = Math.min(tag.length - 1, buf.length)
    for (let i = 1; i <= upper; i++) {
      if (buf.endsWith(tag.slice(0, i)) && i > maxLen) maxLen = i
    }
  }
  return maxLen
}

export function longestPreambleProtocolPartialSuffix(buf: string): number {
  const phaseSuffix = buf.match(PARTIAL_THINKING_PHASE_MARKER_SUFFIX_RE)?.[0].length ?? 0
  return Math.max(
    longestPartialSuffix(buf, [...OPEN_THINKING_TAGS, FINAL_TAG]),
    phaseSuffix,
  )
}

export function normalizeStreamStopReason(
  upstreamStopReason: string,
  validToolCallCount: number,
): string {
  if (validToolCallCount > 0) return 'tool_calls'
  if (upstreamStopReason === 'tool_calls' || upstreamStopReason === 'function_call') return 'stop'
  return upstreamStopReason
}

interface OpenAICompatibleUsage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  input_tokens?: number
  output_tokens?: number
  cached_tokens?: number
  cache_read_input_tokens?: number
  prompt_cache_hit_tokens?: number
  cache_creation_input_tokens?: number
  prompt_tokens_details?: Record<string, unknown>
  completion_tokens_details?: Record<string, unknown>
}

const toFiniteNumber = (value: unknown): number | undefined => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return value
}

function collectNumericDetails(details: Record<string, unknown> | undefined): Record<string, number> | undefined {
  if (!details) return undefined
  const numericDetails = Object.fromEntries(
    Object.entries(details).filter((entry): entry is [string, number] => typeof entry[1] === 'number'),
  )
  return Object.keys(numericDetails).length > 0 ? numericDetails : undefined
}

export function normalizeLLMUsage(chunkUsage: OpenAICompatibleUsage | undefined): LLMUsage | null {
  if (!chunkUsage) return null
  const promptDetails = chunkUsage.prompt_tokens_details
  const cacheCreationValue = promptDetails?.cache_creation
  const cacheCreation = cacheCreationValue && typeof cacheCreationValue === 'object'
    ? cacheCreationValue as Record<string, unknown>
    : undefined

  return {
    inputTokens: toFiniteNumber(chunkUsage.prompt_tokens) ?? toFiniteNumber(chunkUsage.input_tokens) ?? 0,
    outputTokens: toFiniteNumber(chunkUsage.completion_tokens) ?? toFiniteNumber(chunkUsage.output_tokens) ?? 0,
    totalTokens: toFiniteNumber(chunkUsage.total_tokens),
    promptTokensDetails: collectNumericDetails(promptDetails),
    completionTokensDetails: collectNumericDetails(chunkUsage.completion_tokens_details),
    cachedTokens:
      toFiniteNumber(promptDetails?.cached_tokens) ??
      toFiniteNumber(chunkUsage.cached_tokens) ??
      toFiniteNumber(chunkUsage.cache_read_input_tokens) ??
      toFiniteNumber(chunkUsage.prompt_cache_hit_tokens) ??
      0,
    cacheCreationInputTokens:
      toFiniteNumber(promptDetails?.cache_creation_input_tokens) ??
      toFiniteNumber(cacheCreation?.cache_creation_input_tokens) ??
      toFiniteNumber(cacheCreation?.ephemeral_5m_input_tokens) ??
      toFiniteNumber(chunkUsage.cache_creation_input_tokens) ??
      0,
  }
}

/**
 * queryModel — 核心 async generator
 *
 * 编排完整 API 调用生命周期：
 * 1. 构建请求参数
 * 2. 流式调用 + watchdog 监控
 * 3. 将 OpenAI-format stream events 转换为自定义 StreamEvent
 * 4. yield 给上层 (agent loop → SSE endpoint)
 */
export async function* queryModel(
  params: ChatParams,
  logger: Logger,
): AsyncGenerator<LLMStreamEvent, LLMResponse | undefined> {
  const model = params.model || getModel()
  const requestStart = performance.now()

  logger.info(
    { model, messageCount: params.messages.length, maxTokens: params.maxTokens },
    'LLM request starting',
  )

  const requestParams: Record<string, unknown> = {
    model,
    messages: [
      { role: 'system' as const, content: params.system },
      ...params.messages,
    ],
    max_tokens: params.maxTokens ?? 8000,
    temperature: params.temperature ?? 0.6,
    stream: true,
    stream_options: { include_usage: true },
  }

  if (params.tools?.length) {
    requestParams.tools = params.tools
  }

  if (typeof params.enableThinking === 'boolean') {
    requestParams.enable_thinking = params.enableThinking
  }

  const langfuseGeneration = startLangfuseGeneration(params.langfuseTrace?.root, {
    name: 'llm.chat.completions',
    model,
    modelParameters: {
      maxTokens: requestParams.max_tokens as number,
      temperature: requestParams.temperature as number,
      enableThinking: typeof params.enableThinking === 'boolean' ? String(params.enableThinking) : 'default',
      toolCount: params.tools?.length ?? 0,
    },
    input: requestParams,
    prompt: params.langfusePrompt,
    metadata: {
      ...params.langfuseMetadata,
      langfusePromptName: params.langfusePrompt?.name,
      langfusePromptVersion: params.langfusePrompt?.version,
      langfusePromptHash: params.langfusePrompt?.promptHash.slice(0, 16),
      requestedModel: model,
      messageCount: params.messages.length,
      hasTools: Boolean(params.tools?.length),
    },
  })
  let langfuseGenerationEnded = false
  const endLangfuseGeneration = (payload: Parameters<typeof finishLangfuseGeneration>[1]) => {
    if (langfuseGenerationEnded) return
    langfuseGenerationEnded = true
    finishLangfuseGeneration(langfuseGeneration, payload)
  }

  let abortController: AbortController | undefined
  let removeAbortListener: (() => void) | undefined
  if (params.signal) {
    const parentSignal = params.signal
    abortController = new AbortController()
    const abortFromParent = () => {
      if (!abortController?.signal.aborted) {
        abortController?.abort(parentSignal.reason)
      }
    }
    if (parentSignal.aborted) {
      abortFromParent()
    } else {
      parentSignal.addEventListener('abort', abortFromParent, { once: true })
      removeAbortListener = () => parentSignal.removeEventListener('abort', abortFromParent)
    }
  }

  // Accumulate response pieces
  let fullContent = ''
  let fullThinking = ''
  // thinkingOpen = 已 yield THINKING_START 且尚未 yield THINKING_END（不区分来源：
  // reasoning_content 流式 thinking 模式，或 content 内 <thinking>…</thinking> 非思考模式）
  let thinkingOpen = false
  let usage: LLMUsage = { inputTokens: 0, outputTokens: 0 }
  let stopReason = 'stop'
  let rawResponse: unknown = null
  let finalAnswerDetected = false

  // Content 流状态机：识别 <thinking>…</thinking><final_answer>… 三个外壳标签，
  // 将 content 分发成 THINKING_DELTA / TEXT_DELTA，外壳标签本身被剥离不出前端。
  // - thinking 模式：reasoning_content 走 THINKING_DELTA，content 通常只剩 <final_answer>…
  //   状态机停留 preamble，见 <final_answer> 进 answer，行为等价旧实现。
  // - 非思考模式：content 里依次出现 <thinking>…</thinking><final_answer>…
  //   状态机 preamble → thinking → between → answer 全程生效。
  type ContentPhase = 'preamble' | 'thinking' | 'between' | 'answer'
  let contentPhase: ContentPhase = 'preamble'
  let tagBuffer = ''

  const buildRawAssistantContent = (): string => {
    const parts: string[] = []
    if (fullThinking) {
      parts.push(`${OPEN_THINKING}\n${fullThinking}\n${CLOSE_THINKING}`)
    }
    if (fullContent) {
      parts.push(finalAnswerDetected ? `${FINAL_TAG}\n${fullContent}` : fullContent)
    }
    return parts.join('\n')
  }

  // Tool call accumulation
  const accumulatedToolCalls: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }> = []
  const toolCallArgBuffers = new Map<number, string>()
  // 已经通过 SSE 通知前端 tool_call_start 的 toolCallId 集合（用于 dedup，避免重复 emit）
  const notifiedToolCallStart = new Set<string>()

  const getAbortReason = () => abortController?.signal.reason ?? params.signal?.reason
  const isAborted = (error?: unknown) => {
    const name = error && typeof error === 'object' && 'name' in error
      ? (error as { name?: unknown }).name
      : undefined
    return name === 'AbortError' ||
      params.signal?.aborted === true ||
      abortController?.signal.aborted === true
  }
  const collectPartialToolCalls = () => {
    // Flush 工具调用 args buffer（可能是一个处于中途的 tool_call）
    for (const [idx, args] of toolCallArgBuffers) {
      if (accumulatedToolCalls[idx]) {
        accumulatedToolCalls[idx].function.arguments = args
      }
    }
    // arguments 不是合法 JSON 的视为未完成 → 整项丢弃，避免污染下一轮
    return accumulatedToolCalls.filter((tc) => {
      if (!tc) return false
      try {
        JSON.parse(tc.function.arguments)
        return true
      } catch {
        return false
      }
    })
  }
  const buildInterruptedResponse = (
    totalMs: number,
    partialToolCalls: typeof accumulatedToolCalls,
  ): LLMResponse => {
    logger.info(
      {
        totalMs,
        model,
        contentLength: fullContent.length,
        thinkingLength: fullThinking.length,
        partialToolCallCount: partialToolCalls.length,
        rawAccumulatedToolCount: accumulatedToolCalls.length,
      },
      'LLM request interrupted by client',
    )

    rawResponse = {
      model,
      usage,
      stopReason: 'interrupted',
      upstreamRequestId,
      upstreamRetryAttempts,
      totalMs,
      rawAssistantContent: buildRawAssistantContent(),
      finalAnswerDetected,
    }

    return {
      content: fullContent,
      thinking: fullThinking || undefined,
      toolCalls: partialToolCalls.length > 0 ? partialToolCalls : undefined,
      usage,
      stopReason: 'interrupted',
      rawResponse,
      finalAnswerDetected,
      upstreamRetryAttempts,
      interrupted: true,
    }
  }

  let upstreamRequestId: string | null = null
  let upstreamRetryAttempts: LLMUpstreamRetryAttempt[] = []
  let langfuseUpstreamProvider: string | undefined
  let langfuseUpstreamModel: string | undefined
  const buildErrorPayload = (message: string, code: string): string => JSON.stringify({
    message,
    code,
    upstreamRetryAttempts: upstreamRetryAttempts.length ? upstreamRetryAttempts : undefined,
  })
  try {
    if (abortController?.signal.aborted) {
      const totalMs = Math.round(performance.now() - requestStart)
      const interruptedResponse = buildInterruptedResponse(totalMs, collectPartialToolCalls())
      yield {
        type: SSE_EVENTS.MESSAGE_END,
        data: JSON.stringify({
          messageId: crypto.randomUUID(),
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cachedTokens: usage.cachedTokens ?? 0,
          cacheCreationInputTokens: usage.cacheCreationInputTokens ?? 0,
          totalMs,
          interrupted: true,
        }),
      }
      endLangfuseGeneration({
        output: interruptedResponse.content,
        thinking: interruptedResponse.thinking,
        usage: interruptedResponse.usage,
        metadata: { stopReason: 'interrupted', totalMs },
      })
      return interruptedResponse
    }

    const {
      stream,
      requestId,
      provider: upstreamProvider,
      model: upstreamModel,
      upstreamRetryAttempts: retryAttempts = [],
    } = await llmCallStream(requestParams, abortController?.signal, logger, upstreamRetryAttempts, {
      dashscopeSystemCachePrefixLength: params.systemCachePrefixLength,
    })
    upstreamRequestId = requestId
    upstreamRetryAttempts = retryAttempts
    langfuseUpstreamProvider = upstreamProvider
    langfuseUpstreamModel = upstreamModel
    updateLangfuseGeneration(langfuseGeneration, {
      model: upstreamModel,
      prompt: params.langfusePrompt,
      metadata: {
        ...params.langfuseMetadata,
        langfusePromptName: params.langfusePrompt?.name,
        langfusePromptVersion: params.langfusePrompt?.version,
        langfusePromptHash: params.langfusePrompt?.promptHash.slice(0, 16),
        provider: upstreamProvider,
        upstreamModel,
        upstreamRequestId,
        upstreamRetryAttempts,
      },
    })

    // Watchdog monitors for stalled streams
    const watchdog = createWatchdog({
      logger,
      onTimeout: () => {
        abortController?.abort(LLM_STREAM_TIMEOUT_ABORT_REASON)
      },
    })

    let firstChunkLogged = false
    let firstThinkingLogged = false
    let firstAnswerLogged = false
    let answerStartEmitted = false
    let firstChunkMs: number | null = null

    const startAnswerEvents = (trigger: 'tag' | 'fallback-no-tag'): LLMStreamEvent[] => {
      const events: LLMStreamEvent[] = []
      if (thinkingOpen) {
        thinkingOpen = false
        events.push({ type: SSE_EVENTS.THINKING_END, data: '' })
      }
      if (!firstAnswerLogged) {
        logger.info(
          { firstAnswerMs: Math.round(performance.now() - requestStart), trigger },
          'first answer chunk (TTFT-answer)',
        )
        firstAnswerLogged = true
      }
      if (!answerStartEmitted) {
        events.push({ type: SSE_EVENTS.ANSWER_START, data: '' })
        answerStartEmitted = true
      }
      return events
    }

    try {
      for await (const chunk of stream as any as AsyncIterable<Record<string, unknown>>) {
        if (abortController?.signal.aborted) break

        if (!firstChunkLogged) {
          firstChunkMs = Math.round(performance.now() - requestStart)
          logger.info({ firstChunkMs }, 'first chunk received (TTFT)')
          firstChunkLogged = true
        }
        watchdog.reset()

        // usage 可能随最后一个 choices 为空的 chunk 下发（stream_options.include_usage），
        // 必须在 choices 早退之前读取，避免尾 chunk 被直接 continue 掉
        const normalizedUsage = normalizeLLMUsage((chunk as { usage?: OpenAICompatibleUsage }).usage)
        if (normalizedUsage) usage = normalizedUsage

        const choices = (chunk as { choices?: Array<Record<string, unknown>> }).choices
        if (!choices?.length) continue

        const delta = choices[0].delta as Record<string, unknown> | undefined
        if (!delta) continue

        // Handle thinking content (thinking 模式专属：reasoning_content 带外流式)
        const reasoning = delta.reasoning_content as string | undefined
        if (reasoning) {
          if (!firstThinkingLogged) {
            logger.info(
              { firstThinkingMs: Math.round(performance.now() - requestStart) },
              'first thinking chunk (TTFT-thinking)',
            )
            firstThinkingLogged = true
          }
          if (!thinkingOpen) {
            thinkingOpen = true
            yield { type: SSE_EVENTS.THINKING_START, data: '' }
          }
          fullThinking += reasoning
          yield { type: SSE_EVENTS.THINKING_DELTA, data: JSON.stringify({ content: reasoning }) }
        }

        // Handle content stream via 4-phase state machine（见 contentPhase 定义处说明）
        const content = delta.content as string | undefined
        if (content) {
          tagBuffer += content

          // 每轮循环消费一个可识别的状态转移；无法推进时退出等下一个 chunk
          let progressed = true
          while (progressed) {
            progressed = false

            if (contentPhase === 'preamble') {
              // 寻找最早出现的 <thinking>/<think>、<final_answer>，或漏了外层标签的 <|阶段|>。
              const firstToken = findFirstPreambleProtocolToken(tagBuffer)
              if (firstToken) {
                const preTag = tagBuffer.slice(0, firstToken.index)
                if (preTag && firstToken.kind !== 'thinking-phase') {
                  // preamble 的非标签正文：协议兜底当作 TEXT_DELTA 吐出，避免丢 token
                  if (thinkingOpen) {
                    thinkingOpen = false
                    yield { type: SSE_EVENTS.THINKING_END, data: '' }
                  }
                  fullContent += preTag
                  yield { type: SSE_EVENTS.TEXT_DELTA, data: JSON.stringify({ content: preTag }) }
                }

                if (firstToken.kind === 'thinking-open' || firstToken.kind === 'thinking-phase') {
                  contentPhase = 'thinking'
                  if (!thinkingOpen) {
                    thinkingOpen = true
                    yield { type: SSE_EVENTS.THINKING_START, data: '' }
                  }
                  if (firstToken.kind === 'thinking-phase' && preTag) {
                    fullThinking += preTag
                    yield { type: SSE_EVENTS.THINKING_DELTA, data: JSON.stringify({ content: preTag }) }
                  }
                  tagBuffer = firstToken.kind === 'thinking-phase'
                    ? tagBuffer.slice(firstToken.index)
                    : tagBuffer.slice(firstToken.index + firstToken.token.length)
                } else {
                  tagBuffer = tagBuffer.slice(firstToken.index + firstToken.token.length)
                  contentPhase = 'answer'
                  finalAnswerDetected = true
                  for (const event of startAnswerEvents('tag')) yield event
                }
                progressed = true
              } else {
                // 无完整标签：若末尾像协议半截，整段等下个 chunk，避免先进入 answer
                // 后再收到 "<|阶段|>" / "<final_answer>" 剩余部分导致协议泄漏。
                const partialLen = longestPreambleProtocolPartialSuffix(tagBuffer)
                if (partialLen > 0) break
                const safeLen = tagBuffer.length - partialLen
                if (safeLen > 0) {
                  const safe = tagBuffer.slice(0, safeLen)
                  if (safe.trim()) {
                    contentPhase = 'answer'
                    for (const event of startAnswerEvents('fallback-no-tag')) yield event
                    fullContent += safe
                    yield { type: SSE_EVENTS.TEXT_DELTA, data: JSON.stringify({ content: safe }) }
                  }
                  tagBuffer = tagBuffer.slice(safeLen)
                }
              }
            } else if (contentPhase === 'thinking') {
              const closeToken = findFirstThinkingCloseToken(tagBuffer)
              if (closeToken) {
                const before = tagBuffer.slice(0, closeToken.index)
                if (before) {
                  fullThinking += before
                  yield { type: SSE_EVENTS.THINKING_DELTA, data: JSON.stringify({ content: before }) }
                }
                tagBuffer = tagBuffer.slice(closeToken.index + closeToken.token.length)
                contentPhase = 'between'
                if (thinkingOpen) {
                  thinkingOpen = false
                  yield { type: SSE_EVENTS.THINKING_END, data: '' }
                }
                progressed = true
              } else {
                const partialLen = longestPartialSuffix(tagBuffer, CLOSE_THINKING_TAGS)
                const safeLen = tagBuffer.length - partialLen
                if (safeLen > 0) {
                  const safe = tagBuffer.slice(0, safeLen)
                  fullThinking += safe
                  yield { type: SSE_EVENTS.THINKING_DELTA, data: JSON.stringify({ content: safe }) }
                  tagBuffer = tagBuffer.slice(safeLen)
                }
              }
            } else if (contentPhase === 'between') {
              // </thinking> 和 <final_answer> 之间通常只应是空白；若模型漏了
              // <final_answer> 但已经开始正文，则以 </thinking> 为边界直接进入答案。
              const fIdx = tagBuffer.indexOf(FINAL_TAG)
              if (fIdx >= 0) {
                tagBuffer = tagBuffer.slice(fIdx + FINAL_TAG.length)
                contentPhase = 'answer'
                finalAnswerDetected = true
                for (const event of startAnswerEvents('tag')) yield event
                progressed = true
              } else {
                const partialLen = longestPartialSuffix(tagBuffer, [FINAL_TAG])
                const safeLen = tagBuffer.length - partialLen
                if (safeLen > 0) {
                  const safe = tagBuffer.slice(0, safeLen)
                  if (safe.trim()) {
                    contentPhase = 'answer'
                    for (const event of startAnswerEvents('fallback-no-tag')) yield event
                    fullContent += safe
                    yield { type: SSE_EVENTS.TEXT_DELTA, data: JSON.stringify({ content: safe }) }
                  }
                  tagBuffer = tagBuffer.slice(safeLen)
                }
              }
            } else if (contentPhase === 'answer') {
              // 去掉 </final_answer>（若误写），其余原样吐出
              const cleaned = tagBuffer.replace(CLOSE_TAG, '')
              if (cleaned) {
                fullContent += cleaned
                yield { type: SSE_EVENTS.TEXT_DELTA, data: JSON.stringify({ content: cleaned }) }
              }
              tagBuffer = ''
            }
          }
        }

        // Handle tool calls — 累积式解析（streaming 分块传输）
        const toolCallDeltas = delta.tool_calls as Array<{
          index: number
          id?: string
          function?: { name?: string; arguments?: string }
        }> | undefined
        if (toolCallDeltas?.length) {
          for (const tcd of toolCallDeltas) {
            const idx = tcd.index ?? 0
            if (tcd.id) {
              accumulatedToolCalls[idx] = {
                id: tcd.id,
                type: 'function',
                function: {
                  name: tcd.function?.name || '',
                  arguments: tcd.function?.arguments || '',
                },
              }
              toolCallArgBuffers.set(idx, tcd.function?.arguments || '')
            } else if (tcd.function?.arguments) {
              const existing = toolCallArgBuffers.get(idx) || ''
              toolCallArgBuffers.set(idx, existing + tcd.function.arguments)
              if (tcd.function.name && accumulatedToolCalls[idx]) {
                accumulatedToolCalls[idx].function.name = tcd.function.name
              }
            }
            // 一旦 (id, name) 齐全就提前通知前端 tool_call 已开始 streaming，
            // 让 UI 立即占位（骨架屏 / 进度条）。loop.ts 还会再发一次 TOOL_CALL_START，
            // 前端按 toolCallId dedup 同一 active step。
            const acc = accumulatedToolCalls[idx]
            if (acc && acc.id && acc.function.name && !notifiedToolCallStart.has(acc.id)) {
              notifiedToolCallStart.add(acc.id)
              yield {
                type: SSE_EVENTS.TOOL_CALL_START,
                data: JSON.stringify({
                  toolCallId: acc.id,
                  name: acc.function.name,
                }),
              }
            }
          }
        }

        // Handle finish reason
        const finishReason = choices[0].finish_reason as string | undefined
        if (finishReason) {
          stopReason = finishReason
        }
      }
    } finally {
      watchdog.stop()
    }

    // Flush 剩余 tagBuffer（未见到期望关闭标签）—— 依 contentPhase 归位到合适流
    if (tagBuffer) {
      if (contentPhase === 'thinking') {
        // <thinking> 开了没关：把残余当 thinking 收尾，避免丢 token
        fullThinking += tagBuffer
        yield { type: SSE_EVENTS.THINKING_DELTA, data: JSON.stringify({ content: tagBuffer }) }
      } else if (contentPhase === 'answer') {
        for (const event of startAnswerEvents(finalAnswerDetected ? 'tag' : 'fallback-no-tag')) yield event
        fullContent += tagBuffer
        yield { type: SSE_EVENTS.TEXT_DELTA, data: JSON.stringify({ content: tagBuffer }) }
      } else {
        // preamble / between：非空残余当作最终答案兜底；纯空白丢弃。
        if (tagBuffer.trim()) {
          for (const event of startAnswerEvents('fallback-no-tag')) yield event
          fullContent += tagBuffer
          yield { type: SSE_EVENTS.TEXT_DELTA, data: JSON.stringify({ content: tagBuffer }) }
        }
      }
      tagBuffer = ''
    }

    // Close thinking if still open（reasoning_content 未关 / <thinking> 开了没关）
    if (thinkingOpen) {
      thinkingOpen = false
      yield { type: SSE_EVENTS.THINKING_END, data: '' }
    }

    // Finalize accumulated tool calls
    for (const [idx, args] of toolCallArgBuffers) {
      if (accumulatedToolCalls[idx]) {
        accumulatedToolCalls[idx].function.arguments = args
      }
    }
    const finalToolCalls = accumulatedToolCalls.filter((tc) => {
      return Boolean(tc?.id && tc.function?.name)
    })

    // Normalize finish_reason. Some compatible providers can occasionally finish with
    // tool_calls/function_call but stream no valid tool call delta; treat that as a
    // malformed text completion so the missing-final-answer recovery path can run.
    const upstreamRequestedToolCall = stopReason === 'tool_calls' || stopReason === 'function_call'
    const normalizedStopReason = normalizeStreamStopReason(stopReason, finalToolCalls.length)
    if (upstreamRequestedToolCall && normalizedStopReason !== 'tool_calls') {
      logger.warn(
        {
          upstreamStopReason: stopReason,
          rawAccumulatedToolCount: accumulatedToolCalls.length,
          validToolCallCount: finalToolCalls.length,
          contentLength: fullContent.length,
          thinkingLength: fullThinking.length,
        },
        'LLM finished as tool_calls but no valid tool calls were streamed; treating as text completion',
      )
    }
    stopReason = normalizedStopReason

    const totalMs = Math.round(performance.now() - requestStart)

    const abortReason = getAbortReason()
    if (isAborted() && abortReason === LLM_STREAM_TIMEOUT_ABORT_REASON) {
      logger.error(
        { totalMs, model, upstreamRequestId, abortReason },
        'LLM stream timed out by watchdog',
      )
      yield {
        type: SSE_EVENTS.ERROR,
        data: buildErrorPayload('LLM stream timed out', ERROR_CODES.LLM_STREAM_TIMEOUT),
      }
      endLangfuseGeneration({
        output: fullContent,
        thinking: fullThinking || undefined,
        usage,
        metadata: { stopReason: 'timeout', totalMs, upstreamRequestId, provider: langfuseUpstreamProvider, upstreamModel: langfuseUpstreamModel },
        error: new Error('LLM stream timed out'),
      })
      return undefined
    }

    if (isAborted()) {
      const interruptedResponse = buildInterruptedResponse(totalMs, collectPartialToolCalls())
      yield {
        type: SSE_EVENTS.MESSAGE_END,
        data: JSON.stringify({
          messageId: crypto.randomUUID(),
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cachedTokens: usage.cachedTokens ?? 0,
          cacheCreationInputTokens: usage.cacheCreationInputTokens ?? 0,
          totalMs,
          interrupted: true,
        }),
      }
      endLangfuseGeneration({
        output: interruptedResponse.content,
        thinking: interruptedResponse.thinking,
        usage: interruptedResponse.usage,
        metadata: { stopReason: 'interrupted', totalMs, upstreamRequestId, provider: langfuseUpstreamProvider, upstreamModel: langfuseUpstreamModel },
      })
      return interruptedResponse
    }

    // Only emit message_end for non-tool-call completions
    // (tool_calls will continue the agent loop, message_end comes after final text)
    if (stopReason !== 'tool_calls') {
      yield {
        type: SSE_EVENTS.MESSAGE_END,
        data: JSON.stringify({
          messageId: crypto.randomUUID(),
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cachedTokens: usage.cachedTokens ?? 0,
          cacheCreationInputTokens: usage.cacheCreationInputTokens ?? 0,
          totalMs,
        }),
      }
    }

    // 生成阶段 TPS：排除首 chunk 前的等待，反映模型真实吐字速度
    const genMs = firstChunkMs !== null ? Math.max(totalMs - firstChunkMs, 1) : totalMs
    const tpsOut = usage.outputTokens > 0
      ? Math.round((usage.outputTokens / genMs) * 1000 * 100) / 100
      : 0

    logger.info(
      {
        model,
        upstreamRequestId,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cachedTokens: usage.cachedTokens ?? 0,
        cacheCreationInputTokens: usage.cacheCreationInputTokens ?? 0,
        totalMs,
        tpsOut,
        stopReason,
        contentLength: fullContent.length,
        thinkingLength: fullThinking.length,
        toolCallCount: finalToolCalls.length,
      },
      'LLM request completed',
    )

    addApiMetrics({
      tokensIn: usage.inputTokens,
      tokensOut: usage.outputTokens,
      durationMs: totalMs,
    })

    rawResponse = {
      model,
      usage,
      stopReason,
      upstreamRequestId,
      upstreamRetryAttempts,
      totalMs,
      tpsOut,
      rawAssistantContent: buildRawAssistantContent(),
      finalAnswerDetected,
    }

    endLangfuseGeneration({
      output: fullContent,
      thinking: fullThinking || undefined,
      usage,
      metadata: {
        stopReason,
        totalMs,
        tpsOut,
        upstreamRequestId,
        provider: langfuseUpstreamProvider,
        upstreamModel: langfuseUpstreamModel,
        toolCallCount: finalToolCalls.length,
        finalAnswerDetected,
        upstreamRetryAttempts,
      },
    })

    return {
      content: fullContent,
      thinking: fullThinking || undefined,
      toolCalls: finalToolCalls.length > 0 ? finalToolCalls : undefined,
      usage,
      outputTps: tpsOut,
      stopReason,
      rawResponse,
      finalAnswerDetected,
      upstreamRetryAttempts,
    }
  } catch (error) {
    const totalMs = Math.round(performance.now() - requestStart)

    // Close thinking if still open
    if (thinkingOpen) {
      thinkingOpen = false
      yield { type: SSE_EVENTS.THINKING_END, data: '' }
    }

    // Abort 来源分流：用户主动中断要保留部分结果；watchdog 超时是上游流故障，必须显式报错。
    const abortReason = getAbortReason()
    const aborted = isAborted(error)
    if (aborted && abortReason === LLM_STREAM_TIMEOUT_ABORT_REASON) {
      logger.error(
        { totalMs, model, upstreamRequestId, abortReason },
        'LLM stream timed out by watchdog',
      )
      yield {
        type: SSE_EVENTS.ERROR,
        data: buildErrorPayload('LLM stream timed out', ERROR_CODES.LLM_STREAM_TIMEOUT),
      }
      endLangfuseGeneration({
        output: fullContent,
        thinking: fullThinking || undefined,
        usage,
        metadata: { stopReason: 'timeout', totalMs, upstreamRequestId, provider: langfuseUpstreamProvider, upstreamModel: langfuseUpstreamModel },
        error: new Error('LLM stream timed out'),
      })
      return undefined
    }

    if (aborted) {
      const interruptedResponse = buildInterruptedResponse(totalMs, collectPartialToolCalls())
      yield {
        type: SSE_EVENTS.MESSAGE_END,
        data: JSON.stringify({
          messageId: crypto.randomUUID(),
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cachedTokens: usage.cachedTokens ?? 0,
          cacheCreationInputTokens: usage.cacheCreationInputTokens ?? 0,
          totalMs,
          interrupted: true,
        }),
      }
      endLangfuseGeneration({
        output: interruptedResponse.content,
        thinking: interruptedResponse.thinking,
        usage: interruptedResponse.usage,
        metadata: { stopReason: 'interrupted', totalMs, upstreamRequestId, provider: langfuseUpstreamProvider, upstreamModel: langfuseUpstreamModel },
      })
      return interruptedResponse
    }

    const classified = classifyLLMError(error)
    const errorRequestId =
      upstreamRequestId ??
      ((error as { request_id?: string; _request_id?: string })?.request_id ??
        (error as { _request_id?: string })?._request_id ??
        null)
    logger.error(
      { err: error, totalMs, model, errorCode: classified.code, upstreamRequestId: errorRequestId },
      'LLM request failed',
    )

    yield {
      type: SSE_EVENTS.ERROR,
      data: buildErrorPayload(classified.debugMessage, classified.code),
    }

    endLangfuseGeneration({
      output: fullContent,
      thinking: fullThinking || undefined,
      usage,
      metadata: {
        errorCode: classified.code,
        totalMs,
        upstreamRequestId: errorRequestId,
        provider: langfuseUpstreamProvider,
        upstreamModel: langfuseUpstreamModel,
        upstreamRetryAttempts,
      },
      error,
    })

    return undefined
  } finally {
    removeAbortListener?.()
  }
}
