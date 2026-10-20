/**
 * useSSE — SSE streaming hook
 *
 * Uses fetch + ReadableStream (not EventSource, which doesn't support POST)
 * Parses SSE format: "event: xxx\ndata: yyy\n\n"
 *
 * 多会话并发：每次 send() 分配稳定 requestKey，对应独立 AbortController。
 * 切换/新建会话不再无差别 abort 其他流；用户点停止按钮时，调用方按
 * requestKey 精准 abort 当前视图的流。后端根据 client abort 决定是否
 * 打断 agent loop；不 abort 则正常跑完并落库。
 */

import { useCallback, useRef } from 'react'
import { useStore } from '../stores/index.js'
import { bootstrapRefreshSessionIfNeeded, refreshAccessToken } from '../services/api.js'
import { getTrackingContextHeaders } from '../services/trackingContext.js'
import {
  ERROR_CODES,
  type RecommendedQuestionInteraction,
  type StreamEventType,
  type ToolApprovalPayload,
  type ScheduleConfirmationPayload,
  type ProfileAutoUpdatedPayload,
  type AssistantOutputRetractedPayload,
  type CommunicationCardAttachedPayload,
  type MedicalDocumentSaveSuggestionPayload,
} from '@health-agent/shared'
import { reportClientError } from '../utils/clientErrorReport.js'
import { buildClientEnvironmentHint } from '../utils/clientEnvironment.js'

interface SSECallbacks {
  onSessionId?: (sessionId: string) => void
  onCompactionStart?: () => void
  onCompactionEnd?: (data: { messagesCompacted: number; messagesRetained: number }) => void
  onThinkingStart?: () => void
  onThinkingDelta?: (content: string) => void
  onThinkingEnd?: () => void
  onToolCallStart?: (data: { toolCallId: string; name: string; input?: unknown }) => void
  onToolCallEnd?: (data: { toolCallId: string; name: string; output?: unknown; durationMs: number }) => void
  onToolApprovalRequired?: (payload: ToolApprovalPayload) => void
  onScheduleConfirmationRequired?: (payload: ScheduleConfirmationPayload) => void
  onProfileAutoUpdated?: (payload: ProfileAutoUpdatedPayload) => void
  onMedicalDocumentSaveSuggestion?: (payload: MedicalDocumentSaveSuggestionPayload) => void
  onTextDelta?: (content: string) => void
  onIterationStart?: (data: { iteration: number }) => void
  onDocumentAttached?: (data: { docIds: string[]; shortIds: string[]; titles: Array<string | null> }) => void
  onCommunicationCardAttached?: (data: CommunicationCardAttachedPayload) => void
  onAnswerStart?: () => void
  onMessageEnd?: (data: { messageId: string; inputTokens: number; outputTokens: number; totalMs: number; interrupted?: boolean }) => void
  onAssistantOutputRetracted?: (payload: AssistantOutputRetractedPayload) => void
  onError?: (error: { message: string; code?: string; status?: number; recoverByReload?: boolean }) => void
  onDone?: () => void
}

type ControllersRef = React.MutableRefObject<Map<string, AbortController>>

export function useSSE() {
  const controllersRef = useRef<Map<string, AbortController>>(new Map())
  const counterRef = useRef(0)

  const send = useCallback((
    content: string,
    sessionId: string | null,
    callbacks: SSECallbacks,
    images?: string[],
    imageAssetIds?: string[],
    firstActivation?: boolean,
    retryLatestUserMessage?: boolean,
    recommendedQuestion?: RecommendedQuestionInteraction,
    discardUserTurnsFromEnd?: number,
  ): string => {
    const requestKey = `sse-req-${++counterRef.current}`
    const controller = new AbortController()
    controllersRef.current.set(requestKey, controller)

    void runStream(
      controllersRef,
      requestKey,
      controller,
      content,
      sessionId,
      callbacks,
      images,
      imageAssetIds,
      firstActivation,
      retryLatestUserMessage,
      recommendedQuestion,
      discardUserTurnsFromEnd,
    )
    return requestKey
  }, [])

  // 按 requestKey 精准中止；不传则中止所有（留作组件 unmount 兜底，正常业务不用）
  // reason 用于区分 manual(用户点停止) / unmount / switch 等场景，便于日志分析
  const abort = useCallback((key?: string, reason: string = 'manual') => {
    if (key) {
      const c = controllersRef.current.get(key)
      c?.abort(reason)
      controllersRef.current.delete(key)
      return
    }
    for (const c of controllersRef.current.values()) c.abort(reason)
    controllersRef.current.clear()
  }, [])

  return { send, abort }
}

async function runStream(
  controllersRef: ControllersRef,
  requestKey: string,
  controller: AbortController,
  content: string,
  sessionId: string | null,
  callbacks: SSECallbacks,
  images: string[] | undefined,
  imageAssetIds: string[] | undefined,
  firstActivation: boolean | undefined,
  retryLatestUserMessage: boolean | undefined,
  recommendedQuestion: RecommendedQuestionInteraction | undefined,
  discardUserTurnsFromEnd: number | undefined,
): Promise<void> {
  try {
    await bootstrapRefreshSessionIfNeeded()
    let token = useStore.getState().token
    const body: Record<string, unknown> = { content }
    if (sessionId) body.sessionId = sessionId
    if (images?.length) body.images = images
    if (imageAssetIds?.length) body.imageAssetIds = imageAssetIds
    if (firstActivation) body.firstActivation = true
    if (retryLatestUserMessage) body.retryLatestUserMessage = true
    if (discardUserTurnsFromEnd) body.discardUserTurnsFromEnd = discardUserTurnsFromEnd
    if (recommendedQuestion) body.recommendedQuestion = recommendedQuestion
    body.clientEnvironment = buildClientEnvironmentHint()
    const serializedBody = JSON.stringify(body)

    const postStream = (authToken: string | null) => fetch('/api/chat/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...getTrackingContextHeaders(),
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      },
      body: serializedBody,
      signal: controller.signal,
      credentials: 'same-origin',
    })

    let response = await postStream(token)
    if (response.status === 401) {
      token = await refreshAccessToken()
      if (token) response = await postStream(token)
    }

    if (!response.ok) {
      const err = await response.json().catch(() => ({ error: 'Unknown error' }))
      callbacks.onError?.({
        message: err.error || `HTTP ${response.status}`,
        code: err.code,
        status: response.status,
      })
      return
    }

    if (!response.body) {
      callbacks.onError?.({ message: 'No response body' })
      return
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })

      const parts = buffer.split('\n\n')
      buffer = parts.pop() || ''

      for (const part of parts) {
        if (!part.trim()) continue

        let event = ''
        let data = ''

        for (const line of part.split('\n')) {
          if (line.startsWith('event:')) {
            event = line.slice(6).trim()
          } else if (line.startsWith('data:')) {
            data = line.slice(5).trim()
          }
        }

        if (!event) continue
        handleSSEEvent(event as StreamEventType | 'session', data, callbacks)
      }
    }

    callbacks.onDone?.()
  } catch (err: any) {
    // 用户手动停止走 onDone 安全网做 finalize/reset；
    // 真正的网络中断则走 onError，给用户一个明确的网络提示。
    if (err.name === 'AbortError') {
      // signal.reason 来自 abort(key, reason) 的传值：manual / unmount / switch…
      // 若 reason 缺失且非 manual 语义，归为 network（运行时连接断开触发的 AbortError）
      const reason = (controller.signal.reason as string | undefined) || 'network'
      // eslint-disable-next-line no-console
      console.info('[sse] aborted', { requestKey, reason })
      if (reason === 'network') {
        // 只上报非用户主动的中断，避免日志噪声
        reportClientError(
          { name: 'AbortError', message: 'stream aborted by network', stack: err.stack },
          { phase: 'stream-network-abort' },
        )
        callbacks.onError?.({
          message: 'stream aborted by network',
          code: ERROR_CODES.NETWORK_ERROR,
        })
        return
      }
      callbacks.onDone?.()
      return
    }
    reportClientError(err, { phase: 'fetch-or-reader' })
    const message = err.message || 'Network error'
    const lowered = message.toLowerCase()
    const isLikelyNetworkError =
      lowered.includes('network') ||
      lowered.includes('load failed') ||
      lowered.includes('illegal access') ||
      lowered.includes('failed to fetch') ||
      lowered.includes('fetch')
    const recoverByReload =
      lowered === 'load failed' ||
      lowered === 'illegal access'
    callbacks.onError?.({
      message,
      code: isLikelyNetworkError ? ERROR_CODES.NETWORK_ERROR : undefined,
      recoverByReload,
    })
  } finally {
    const existing = controllersRef.current.get(requestKey)
    if (existing === controller) controllersRef.current.delete(requestKey)
  }
}

function handleSSEEvent(
  event: StreamEventType | 'session',
  data: string,
  callbacks: SSECallbacks,
) {
  switch (event) {
    case 'session': {
      const parsed = tryParse(data)
      if (parsed?.sessionId) callbacks.onSessionId?.(parsed.sessionId)
      break
    }
    case 'compaction_start':
      callbacks.onCompactionStart?.()
      break
    case 'compaction_end': {
      const parsed = tryParse(data)
      callbacks.onCompactionEnd?.(parsed || { messagesCompacted: 0, messagesRetained: 0 })
      break
    }
    case 'thinking_start':
      callbacks.onThinkingStart?.()
      break
    case 'thinking_delta': {
      const parsed = tryParse(data)
      if (parsed?.content) callbacks.onThinkingDelta?.(parsed.content)
      break
    }
    case 'thinking_end':
      callbacks.onThinkingEnd?.()
      break
    case 'tool_call_start': {
      const parsed = tryParse(data)
      if (parsed) callbacks.onToolCallStart?.(parsed)
      break
    }
    case 'tool_call_end': {
      const parsed = tryParse(data)
      if (parsed) callbacks.onToolCallEnd?.(parsed)
      break
    }
    case 'tool_approval_required': {
      const parsed = tryParse(data)
      if (parsed) callbacks.onToolApprovalRequired?.(parsed)
      break
    }
    case 'schedule_confirmation_required': {
      const parsed = tryParse(data)
      if (parsed) callbacks.onScheduleConfirmationRequired?.(parsed)
      break
    }
    case 'profile_auto_updated': {
      const parsed = tryParse(data)
      if (parsed) callbacks.onProfileAutoUpdated?.(parsed)
      break
    }
    case 'medical_document_save_suggestion': {
      const parsed = tryParse(data)
      if (parsed) callbacks.onMedicalDocumentSaveSuggestion?.(parsed)
      break
    }
    case 'text_delta': {
      const parsed = tryParse(data)
      if (parsed?.content) callbacks.onTextDelta?.(parsed.content)
      break
    }
    case 'iteration_start': {
      const parsed = tryParse(data)
      if (parsed) callbacks.onIterationStart?.(parsed)
      break
    }
    case 'document_attached': {
      const parsed = tryParse(data)
      if (parsed) callbacks.onDocumentAttached?.(parsed)
      break
    }
    case 'communication_card_attached': {
      const parsed = tryParse(data)
      if (parsed) callbacks.onCommunicationCardAttached?.(parsed)
      break
    }
    case 'answer_start':
      callbacks.onAnswerStart?.()
      break
    case 'message_end': {
      const parsed = tryParse(data)
      if (parsed) callbacks.onMessageEnd?.(parsed)
      break
    }
    case 'assistant_output_retracted': {
      const parsed = tryParse(data)
      if (parsed) callbacks.onAssistantOutputRetracted?.(parsed)
      break
    }
    case 'error': {
      const parsed = tryParse(data)
      callbacks.onError?.(parsed || { message: data })
      break
    }
  }
}

function tryParse(data: string): any {
  try {
    return JSON.parse(data)
  } catch {
    return null
  }
}
