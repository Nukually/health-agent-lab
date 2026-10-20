import { Hono } from 'hono'
import type { Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import { getEnv } from '../env.js'
import { initProcessState, getMetrics, setSimulatePrimaryFailure, isSimulatingPrimaryFailure, getBackupLLMClient } from '../state/process.js'
import { createSessionState, addMessage, type ChatMessage } from '../state/session.js'
import { agentLoop } from '../agent/loop.js'
import { assembleSystemPrompt } from '../agent/prompt/assembler.js'
import { getAgentTools } from '../agent/tools/index.js'
import { getBackendFeatureSnapshot } from '../features.js'
import { getInterventionRuntimeCatalog } from '../services/intervention-material-runtime.js'
import { saveMessage, loadSessionMessages, getSessionMessages } from '../services/message.js'
import { createSession, listSessions, getSession, deleteSession } from '../services/session.js'
import { getFullProfile } from '../services/user.js'
import { estimateMessagesTokens } from '../utils/tokens.js'
import { rateLimitMiddleware } from '../middleware/rate-limit.js'
import { resolveClientEnvironment } from '../services/client-environment.js'
import {
  finishLangfuseAgentTrace,
  syncLangfuseSystemPrompt,
  startLangfuseAgentTrace,
  type LangfuseAgentTrace,
} from '../observability/langfuse.js'

const testRoutes = new Hono()

const TEST_USER_ID = '00000000-0000-0000-0000-000000000001'
const TEST_ONESHOT_MAX_IMAGES = 10
const TEST_ONESHOT_MAX_IMAGE_BYTES = 10 * 1024 * 1024
const testOneShotGlobalRateLimit = rateLimitMiddleware({
  windowMs: 1_000,
  max: 5,
  keyPrefix: 'rl:test:oneshot',
  keyExtractor: () => 'all',
  enabledInNonProd: true,
})

interface TestOneShotInput {
  content: string
  title?: string
  images: string[]
}

function valuesOf(value: unknown): unknown[] {
  if (value == null) return []
  return Array.isArray(value) ? value : [value]
}

function firstString(value: unknown): string | undefined {
  return valuesOf(value).find((item): item is string => typeof item === 'string')
}

function collectImageReferences(value: unknown): string[] {
  return valuesOf(value)
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
}

function getImageMime(file: File): string | null {
  if (file.type.startsWith('image/')) return file.type

  const lowerName = file.name.toLowerCase()
  if (lowerName.endsWith('.jpg') || lowerName.endsWith('.jpeg')) return 'image/jpeg'
  if (lowerName.endsWith('.png')) return 'image/png'
  if (lowerName.endsWith('.webp')) return 'image/webp'
  if (lowerName.endsWith('.gif')) return 'image/gif'

  return null
}

async function fileToDataUrl(file: File): Promise<string> {
  const mime = getImageMime(file)
  if (!mime) {
    throw Object.assign(new Error('only image files are supported'), { status: 400 })
  }
  if (file.size > TEST_ONESHOT_MAX_IMAGE_BYTES) {
    throw Object.assign(new Error('single image must be <= 10MB'), { status: 400 })
  }

  const buffer = Buffer.from(await file.arrayBuffer())
  return `data:${mime};base64,${buffer.toString('base64')}`
}

async function parseOneShotInput(c: Context): Promise<TestOneShotInput> {
  const contentType = c.req.header('content-type')?.toLowerCase() ?? ''

  if (contentType.includes('multipart/form-data') || contentType.includes('application/x-www-form-urlencoded')) {
    const form = await c.req.parseBody({ all: true })
    const content = firstString(form.content) ?? firstString(form.message) ?? ''
    const title = firstString(form.title)
    const rawImages = [...valuesOf(form.images), ...valuesOf(form.image)]

    const images: string[] = []
    for (const item of rawImages) {
      if (typeof item === 'string') {
        const trimmed = item.trim()
        if (trimmed) {
          if (images.length >= TEST_ONESHOT_MAX_IMAGES) {
            throw Object.assign(new Error(`too many images, max ${TEST_ONESHOT_MAX_IMAGES}`), { status: 400 })
          }
          images.push(trimmed)
        }
        continue
      }
      if (item instanceof File && item.size > 0) {
        if (images.length >= TEST_ONESHOT_MAX_IMAGES) {
          throw Object.assign(new Error(`too many images, max ${TEST_ONESHOT_MAX_IMAGES}`), { status: 400 })
        }
        images.push(await fileToDataUrl(item))
      }
    }

    return { content, title, images }
  }

  const body = await c.req.json().catch(() => ({}))
  const content = typeof body.content === 'string'
    ? body.content
    : typeof body.message === 'string'
      ? body.message
      : ''
  const title = typeof body.title === 'string' ? body.title : undefined
  const images = [
    ...collectImageReferences(body.images),
    ...collectImageReferences(body.image),
  ]

  return { content, title, images }
}

function buildOneShotUserMessage(content: string, images: string[]): ChatMessage {
  if (images.length === 0) {
    return { role: 'user', content, untrustedInput: true }
  }

  return {
    role: 'user',
    content: [
      ...(content ? [{ type: 'text' as const, text: content }] : []),
      ...images.map((url) => ({ type: 'image_url' as const, image_url: { url } })),
    ],
    untrustedInput: true,
  }
}

function startTestChatLangfuseTrace(input: {
  route: '/api/test/chat/send' | '/api/test/chat/oneshot'
  requestId: string
  sessionId: string
  content: string
  imageCount: number
  promptLength: number
  toolCount: number
  promptFromCache?: boolean
}): LangfuseAgentTrace {
  return startLangfuseAgentTrace({
    name: 'cx.agent.chat.test',
    userId: TEST_USER_ID,
    requestId: input.requestId,
    sessionId: input.sessionId,
    input: {
      content: input.content,
      imageCount: input.imageCount,
    },
    metadata: {
      route: input.route,
      requestId: input.requestId,
      promptLength: input.promptLength,
      toolCount: input.toolCount,
      promptFromCache: input.promptFromCache ?? false,
    },
    tags: ['test-route', 'chatbot'],
  })
}

function contentForTrace(message: ChatMessage | undefined): unknown {
  if (!message) return null
  if (typeof message.content === 'string') return message.content
  return { contentKind: 'multimodal', parts: message.content.length }
}

function parseTraceEventData(data: string): unknown {
  try {
    return JSON.parse(data)
  } catch {
    return data
  }
}

function errorFromTraceEventData(data: unknown): Error | undefined {
  if (!data) return undefined
  if (typeof data === 'object' && data !== null && 'message' in data) {
    const message = (data as { message?: unknown }).message
    return new Error(typeof message === 'string' ? message : 'chat test emitted error event')
  }
  return new Error('chat test emitted error event')
}

// Guard: explicitly enabled on non-prod deployments only
testRoutes.use('*', async (c, next) => {
  const env = getEnv()
  if (env.DEPLOY_ENV === 'prod' || !env.ENABLE_TEST_ROUTES) {
    return c.json({ success: false, error: 'test API disabled' }, 403)
  }

  if (!env.TEST_TOKEN) {
    return c.json({ success: false, error: 'test token not configured' }, 403)
  }

  const token = c.req.header('X-Test-Token')
  if (token !== env.TEST_TOKEN) {
    return c.json({ success: false, error: 'invalid test token' }, 401)
  }

  await next()
})

// POST /api/test/chat/send — full SSE chat without login
testRoutes.post('/chat/send', async (c) => {
  const logger = c.get('logger')

  const body = await c.req.json().catch(() => ({}))
  const content = body.content || body.message || ''
  if (!content) {
    return c.json({ success: false, error: 'content is required' }, 400)
  }

  const env = getEnv()
  initProcessState({
    apiKey: env.LLM_API_KEY,
    model: env.LLM_MODEL,
    baseUrl: env.LLM_BASE_URL,
  })

  // Create or reuse session
  let sessionId = body.sessionId
  if (!sessionId) {
    const session = await createSession(TEST_USER_ID, 'Test Session', logger)
    sessionId = session.id
  }

  const existingMessages = await loadSessionMessages(sessionId, logger)
  const { user: testUserInfo, medical: testMedical } = await getFullProfile(TEST_USER_ID, logger).catch(() => ({ user: null, medical: null }))

  // Load session summary if continuing existing conversation
  let existingSummary: string | null = null
  if (body.sessionId) {
    const existing = await getSession(sessionId, logger)
    existingSummary = existing?.summary ?? null
  }

  const userMessage: ChatMessage = { role: 'user', content, untrustedInput: true }

  const existingTokens = estimateMessagesTokens(existingMessages)
  const sessionState = createSessionState({
    sessionId,
    userId: TEST_USER_ID,
    logger,
    existingMessages,
    tokenCount: existingTokens,
    summary: existingSummary,
  })
  addMessage(sessionState, userMessage)

  userMessage.dbId = await saveMessage(sessionId, userMessage, logger)

  return streamSSE(c, async (stream) => {
    let langfuseTrace: LangfuseAgentTrace | undefined
    let langfuseTraceFinished = false
    const finishTrace = (payload: Parameters<typeof finishLangfuseAgentTrace>[1]) => {
      if (langfuseTraceFinished) return
      langfuseTraceFinished = true
      finishLangfuseAgentTrace(langfuseTrace, payload)
    }

    try {
      await stream.writeSSE({ event: 'session', data: JSON.stringify({ sessionId }) })

      const features = getBackendFeatureSnapshot()
      const tools = getAgentTools(features)
      const interventionCatalog = await getInterventionRuntimeCatalog(logger)
      const assembled = assembleSystemPrompt({
        userInfo: testUserInfo,
        profileData: testMedical?.profileData || null,
        medicalDocs: [],
        interventionCatalog,
        profileMemory: null,
        todayMemory: null,
        structuredProfileTrend: null,
        summary: sessionState.summary,
        features,
        logger,
      })
      langfuseTrace = startTestChatLangfuseTrace({
        route: '/api/test/chat/send',
        requestId: c.get('requestId'),
        sessionId,
        content,
        imageCount: 0,
        promptLength: assembled.prompt.length,
        toolCount: tools.length,
      })
      const langfusePrompt = await syncLangfuseSystemPrompt({
        prompt: assembled.promptManagementPrompt,
        logger,
        promptFromCache: false,
        metadata: { sessionId, route: '/api/test/chat/send' },
      })
      let agentError: unknown = null
      for await (const event of agentLoop({
        session: sessionState,
        userInfo: testUserInfo,
        profileData: testMedical?.profileData || null,
        clientEnvironment: resolveClientEnvironment({ userAgent: c.req.header('user-agent') || null }),
        systemPrompt: assembled.prompt,
        systemCachePrefixLength: assembled.staticPrefixLength,
        tools,
        docIdMap: assembled.docIdMap,
        communicationCardIdMap: assembled.communicationCardIdMap,
        interventionCodeMap: interventionCatalog.codeMap,
        eventsReminder: '',
        requestReminders: assembled.dynamicPromptReminder ? [assembled.dynamicPromptReminder] : [],
        rejectedFields: new Set(),
        langfuseTrace,
        langfusePrompt,
        logger,
      })) {
        if (event.type === 'error') {
          agentError = parseTraceEventData(event.data)
        }
        await stream.writeSSE({ event: event.type, data: event.data })
      }

      const assistantMsg = sessionState.messages[sessionState.messages.length - 1]
      if (assistantMsg?.role === 'assistant') {
        await saveMessage(sessionId, assistantMsg, logger)
      }
      finishTrace({
        output: contentForTrace(assistantMsg),
        metadata: { sawError: !!agentError, agentError, route: '/api/test/chat/send' },
        error: errorFromTraceEventData(agentError),
      })
    } catch (err) {
      finishTrace({
        metadata: { sawError: true, route: '/api/test/chat/send' },
        error: err,
      })
      throw err
    }
  })
})

// POST /api/test/chat/oneshot — 零上下文单轮对话，每次新建独立 session 便于回溯
async function handleChatOneShot(c: Context) {
  const logger = c.get('logger')

  let input: TestOneShotInput
  try {
    input = await parseOneShotInput(c)
  } catch (err) {
    return c.json({ success: false, error: (err as Error).message }, 400)
  }

  if (!input.content.trim() && input.images.length === 0) {
    return c.json({ success: false, error: 'content or image is required' }, 400)
  }
  if (input.images.length > TEST_ONESHOT_MAX_IMAGES) {
    return c.json({ success: false, error: `too many images, max ${TEST_ONESHOT_MAX_IMAGES}` }, 400)
  }

  const env = getEnv()
  initProcessState({
    apiKey: env.LLM_API_KEY,
    model: env.LLM_MODEL,
    baseUrl: env.LLM_BASE_URL,
  })

  const title = input.title || (
    input.content.trim()
      ? `[oneshot] ${input.content.trim().slice(0, 20)}`
      : `[oneshot] ${input.images.length} image(s)`
  )
  const session = await createSession(TEST_USER_ID, title, logger)
  const sessionId = session.id

  const userMessage = buildOneShotUserMessage(input.content, input.images)

  const sessionState = createSessionState({
    sessionId,
    userId: TEST_USER_ID,
    logger,
    existingMessages: [],
    tokenCount: 0,
    summary: null,
  })
  addMessage(sessionState, userMessage)

  userMessage.dbId = await saveMessage(sessionId, userMessage, logger)

  return streamSSE(c, async (stream) => {
    let langfuseTrace: LangfuseAgentTrace | undefined
    let langfuseTraceFinished = false
    const finishTrace = (payload: Parameters<typeof finishLangfuseAgentTrace>[1]) => {
      if (langfuseTraceFinished) return
      langfuseTraceFinished = true
      finishLangfuseAgentTrace(langfuseTrace, payload)
    }

    try {
      await stream.writeSSE({ event: 'session', data: JSON.stringify({ sessionId }) })

      const interventionCatalog = await getInterventionRuntimeCatalog(logger)
      const features = getBackendFeatureSnapshot()
      const tools = getAgentTools(features)
      const assembled = assembleSystemPrompt({
        userInfo: null,
        profileData: null,
        medicalDocs: [],
        interventionCatalog,
        profileMemory: null,
        todayMemory: null,
        structuredProfileTrend: null,
        summary: null,
        features,
        logger,
      })
      langfuseTrace = startTestChatLangfuseTrace({
        route: '/api/test/chat/oneshot',
        requestId: c.get('requestId'),
        sessionId,
        content: input.content,
        imageCount: input.images.length,
        promptLength: assembled.prompt.length,
        toolCount: tools.length,
      })
      const langfusePrompt = await syncLangfuseSystemPrompt({
        prompt: assembled.promptManagementPrompt,
        logger,
        promptFromCache: false,
        metadata: { sessionId, route: '/api/test/chat/oneshot' },
      })
      let agentError: unknown = null
      for await (const event of agentLoop({
        session: sessionState,
        userInfo: null,
        profileData: null,
        clientEnvironment: resolveClientEnvironment({ userAgent: c.req.header('user-agent') || null }),
        systemPrompt: assembled.prompt,
        systemCachePrefixLength: assembled.staticPrefixLength,
        tools,
        docIdMap: assembled.docIdMap,
        communicationCardIdMap: assembled.communicationCardIdMap,
        interventionCodeMap: interventionCatalog.codeMap,
        eventsReminder: '',
        requestReminders: assembled.dynamicPromptReminder ? [assembled.dynamicPromptReminder] : [],
        rejectedFields: new Set(),
        langfuseTrace,
        langfusePrompt,
        logger,
      })) {
        if (event.type === 'error') {
          agentError = parseTraceEventData(event.data)
        }
        await stream.writeSSE({ event: event.type, data: event.data })
      }

      const assistantMsg = sessionState.messages[sessionState.messages.length - 1]
      if (assistantMsg?.role === 'assistant') {
        await saveMessage(sessionId, assistantMsg, logger)
      }
      finishTrace({
        output: contentForTrace(assistantMsg),
        metadata: { sawError: !!agentError, agentError, route: '/api/test/chat/oneshot' },
        error: errorFromTraceEventData(agentError),
      })
    } catch (err) {
      finishTrace({
        metadata: { sawError: true, route: '/api/test/chat/oneshot' },
        error: err,
      })
      throw err
    }
  })
}

testRoutes.post('/chat/oneshot', testOneShotGlobalRateLimit, handleChatOneShot)
testRoutes.post('/chat/one-shot', testOneShotGlobalRateLimit, handleChatOneShot)

// POST /api/test/sessions
testRoutes.post('/sessions', async (c) => {
  const logger = c.get('logger')
  const body = await c.req.json().catch(() => ({}))
  const session = await createSession(TEST_USER_ID, body.title || 'Test Session', logger)
  return c.json({ success: true, data: session })
})

// GET /api/test/sessions
testRoutes.get('/sessions', async (c) => {
  const logger = c.get('logger')
  const { items, hasMore, nextCursor } = await listSessions(TEST_USER_ID, logger)
  return c.json({ success: true, data: { items, hasMore, nextCursor } })
})

// GET /api/test/sessions/:id — includes full message trajectory
testRoutes.get('/sessions/:id', async (c) => {
  const logger = c.get('logger')
  const sessionId = c.req.param('id')

  const session = await getSession(sessionId, logger)
  if (!session) {
    return c.json({ success: false, error: 'session not found' }, 404)
  }

  // 测试接口场景默认取最新 100 条，够复现绝大多数 case；如需更早历史再带 before cursor
  const { messages: msgs, hasMore, oldestCreatedAt } = await getSessionMessages(
    sessionId,
    logger,
    { limit: 100 },
  )

  return c.json({
    success: true,
    data: { ...session, messages: msgs, hasMore, oldestCreatedAt },
  })
})

// DELETE /api/test/sessions/:id
testRoutes.delete('/sessions/:id', async (c) => {
  const logger = c.get('logger')
  const sessionId = c.req.param('id')
  await deleteSession(sessionId, TEST_USER_ID, logger)
  return c.json({ success: true })
})

// GET /api/test/metrics — 进程级 LLM 调用指标
testRoutes.get('/metrics', (c) => {
  return c.json({ success: true, data: getMetrics() })
})

// POST /api/test/simulate-failure — 开关主 provider 模拟故障
testRoutes.post('/simulate-failure', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const enabled = body.enabled === true
  setSimulatePrimaryFailure(enabled)
  return c.json({ success: true, data: { simulatePrimaryFailure: enabled } })
})

// GET /api/test/provider-status — 查看当前 provider 状态
testRoutes.get('/provider-status', (c) => {
  return c.json({
    success: true,
    data: {
      simulatePrimaryFailure: isSimulatingPrimaryFailure(),
      hasBackupProvider: !!getBackupLLMClient(),
    },
  })
})

export default testRoutes
