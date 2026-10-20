import { createMiddleware } from 'hono/factory'
import type { RecommendedQuestionInteraction } from '@health-agent/shared'
import { rootLogger, type Logger } from '../lib/logger.js'
import { safeRecordAnalyticsEvent } from '../services/analytics.js'
import {
  safeTrackBackendEvent,
  trackingRequestContextFromHeaders,
  type TrackingRequestContext,
} from '../services/tracking.js'

const CHAT_REQUEST_METRIC_PATHS = new Set(['/api/chat/send', '/api/chat/send-sync'])

// Augment Hono context variables
declare module 'hono' {
  interface ContextVariableMap {
    requestId: string
    logger: Logger
    trackingContext: TrackingRequestContext
    // Streaming routes (e.g. /api/chat/send) set this so the completion log
    // waits for the SSE stream to actually finish. Hono's streamSSE resolves
    // the handler when the Response is sent, not when the stream ends — so
    // without this, durationMs only covers handler-return time.
    streamDone?: Promise<void>
    // Per-request metrics that streaming handlers want merged into the
    // 'request completed' log line (e.g. process/answer TTFT).
    chatMetrics?: {
      sessionId?: string | null
      processTtftMs: number | null
      answerTtftMs: number | null
      outputTps?: number | null
      llmRetryCount?: number | null
      recommendedQuestion?: RecommendedQuestionInteraction | null
    }
  }
}

export const requestIdMiddleware = createMiddleware(async (c, next) => {
  const requestId = crypto.randomUUID()
  const logger = rootLogger.child({ requestId })

  c.set('requestId', requestId)
  c.set('logger', logger)
  c.set('trackingContext', trackingRequestContextFromHeaders(
    (name) => c.req.header(name),
    requestId,
  ))

  c.header('X-Request-Id', requestId)

  const start = performance.now()
  const startedAt = new Date()

  logger.info(
    { method: c.req.method, path: c.req.path },
    'request started',
  )

  await next()

  const logCompletion = () => {
    const durationMs = Math.round(performance.now() - start)
    const endedAt = new Date()
    const chatMetrics = c.get('chatMetrics')
    // Use enriched logger (may include userId from auth middleware)
    const recommendedQuestion = chatMetrics?.recommendedQuestion ?? null
    c.get('logger').info(
      { method: c.req.method, path: c.req.path, status: c.res.status, durationMs, ...(chatMetrics ?? {}) },
      'request completed',
    )
    const userId = c.get('userId')
    if (
      userId &&
      c.req.method === 'POST' &&
      CHAT_REQUEST_METRIC_PATHS.has(c.req.path)
    ) {
      const event = {
        userId,
        eventName: 'chat_request_completed',
        dedupeKey: requestId,
        sessionId: chatMetrics?.sessionId ?? null,
        entityType: 'api_route',
        entityId: c.req.path,
        startedAt,
        endedAt,
        durationMs,
        properties: {
          method: c.req.method,
          path: c.req.path,
          status: c.res.status,
          processTtftMs: chatMetrics?.processTtftMs ?? null,
          answerTtftMs: chatMetrics?.answerTtftMs ?? null,
          outputTps: chatMetrics?.outputTps ?? null,
          llmRetryCount: chatMetrics?.llmRetryCount ?? null,
          entrypoint: recommendedQuestion ? 'recommended_question' : 'manual',
          recommendedQuestion,
        },
      } as const
      void safeRecordAnalyticsEvent(event, c.get('logger'))
      safeTrackBackendEvent(
        event,
        c.get('logger'),
        c.get('trackingContext'),
      )
    }
  }

  const streamDone = c.get('streamDone')
  if (streamDone) {
    // Log AFTER stream finishes, but DO NOT await here — that would block
    // the middleware chain from returning the Response to the Node adapter,
    // which in turn prevents the SSE body from being piped to the client,
    // which prevents the streamSSE callback from making progress once its
    // write buffer fills → classic deadlock. Attach a .then instead.
    streamDone.then(logCompletion, logCompletion)
  } else {
    logCompletion()
  }
})
