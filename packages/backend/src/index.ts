import dotenv from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: resolve(__dirname, '../../../.env') })
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { bodyLimit } from 'hono/body-limit'
import { isFeatureEnabled } from '@health-agent/shared'
import { requestIdMiddleware } from './middleware/request-id.js'
import { rateLimitMiddleware } from './middleware/rate-limit.js'
import { errorHandler } from './middleware/error.js'
import { getEnv } from './env.js'
import { rootLogger } from './lib/logger.js'
import { initProcessState, getLLMClient, getModel } from './state/process.js'
import { registerBuiltinHooks } from './agent/hooks/index.js'
import { startCronJobs } from './cron/index.js'
import { authRoutes, consentRoutes, doctorRoutes, doctorAccessRoutes, healthEducationRoutes, chatRoutes, createAsrRoutes, createTtsRoutes, sessionRoutes, imageRoutes, medicalRoutes, testRoutes, exportRoutes, feedbackRoutes, messageFavoriteRoutes, clientErrorRoutes, clientRoutes, shareRoutes, sharedRoutes, accountRoutes, interventionMaterialRoutes, interventionMaterialRuntimeRoutes, internalVideoRuntimeRoutes, analyticsRoutes, trackingRoutes, pushRoutes, scheduledTaskRoutes, todosRoutes, channelAdminRoutes, checkInRoutes } from './routes/index.js'
import { pingDb } from './db/client.js'
import { initWebSocket, getInjectWebSocket } from './ws.js'
import { getBackendFeatureSnapshot } from './features.js'
import { buildLangfuseConfig, initLangfuse, shutdownLangfuse } from './observability/langfuse.js'

const env = getEnv()
const logger = rootLogger.child({ module: 'server' })
const featureSnapshot = getBackendFeatureSnapshot()

initLangfuse(buildLangfuseConfig(env), logger)

// Initialize LLM client at startup (used by chat routes and background jobs)
initProcessState({
  apiKey: env.LLM_API_KEY,
  model: env.LLM_MODEL,
  baseUrl: env.LLM_BASE_URL,
  contextWindowSize: env.LLM_CONTEXT_WINDOW,
  backupApiKey: env.LLM_BACKUP_API_KEY,
  backupBaseUrl: env.LLM_BACKUP_BASE_URL,
  backupModel: env.LLM_BACKUP_MODEL,
})

// Hook 系统：注册内置 hook（上海时间 + output_protocol 提醒）。
// 每轮 LLM 调用前由 loop 串行执行；第三方 hook 可在此之后 registerHook() 追加。
registerBuiltinHooks()

const app = new Hono()
initWebSocket(app)

// Global middleware
app.use(
  '*',
  cors({
    origin: env.CORS_ORIGIN === '*'
      ? '*'
      : env.CORS_ORIGIN.split(',').map((s) => s.trim()),
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: [
      'Content-Type',
      'Authorization',
      'X-Channel-Admin-Key',
      'x-publish-token',
      'X-Install-Id',
      'X-App-Session-Id',
      'X-Web-Session-Id',
      'X-Tracking-Trace-Id',
      'traceparent',
    ],
    maxAge: 600,
    credentials: env.CORS_ORIGIN !== '*',
  }),
)
app.use('*', requestIdMiddleware)
app.use(
  '/api/*',
  rateLimitMiddleware({
    windowMs: 1_000,
    max: 100,
    keyPrefix: 'rl:global',
    keyExtractor: () => 'all',
  }),
)
app.use(
  '*',
  bodyLimit({
    maxSize: 50 * 1024 * 1024, // 50MB，医生端患教多图上传需要更高上限
    onError: (c) => c.json({ success: false, error: '请求体过大' }, 413),
  }),
)
app.onError(errorHandler)

// Health check
app.get('/health', (c) => {
  return c.json({ status: 'ok', service: 'health-agent-lab', timestamp: new Date().toISOString() })
})

// Deep health check — DB + LLM 连通性验证，部署冒烟测试用
app.get('/health/deep', async (c) => {
  const checks: Record<string, 'ok' | 'fail'> = {}

  // DB
  checks.database = (await pingDb()) ? 'ok' : 'fail'

  // LLM client
  try {
    getLLMClient()
    checks.llm = 'ok'
  } catch {
    checks.llm = 'fail'
  }

  const allOk = Object.values(checks).every(v => v === 'ok')
  return c.json(
    { status: allOk ? 'ok' : 'degraded', checks, model: getModel(), timestamp: new Date().toISOString() },
    allOk ? 200 : 503,
  )
})

// API routes
app.route('/api/auth', authRoutes)
app.route('/api/auth', consentRoutes)  // /auth/accept-consent, /auth/consents (JWT)
app.route('/api/chat/asr', createAsrRoutes())  // after initWebSocket, before /api/chat
app.route('/api/chat/tts', createTtsRoutes())  // WebSocket 双向流式 TTS
app.route('/api/chat', chatRoutes)
app.route('/api/doctor', doctorRoutes)
app.route('/api/doctor-access', doctorAccessRoutes)
app.route('/api/health-education', healthEducationRoutes)
app.route('/api/sessions', sessionRoutes)
app.route('/api/images', imageRoutes)
app.route('/api/medical', medicalRoutes)
app.route('/api/test', testRoutes)
app.route('/api/export', exportRoutes)
app.route('/api/feedback', feedbackRoutes)
app.route('/api/message-favorites', messageFavoriteRoutes)
app.route('/api/client-error', clientErrorRoutes)
app.route('/api/client', clientRoutes)
app.route('/api/share', shareRoutes)
app.route('/api/shared', sharedRoutes)
app.route('/api/account', accountRoutes)
app.route('/api/analytics', analyticsRoutes)
app.route('/api/tracking', trackingRoutes)
app.route('/api/push', pushRoutes)
app.route('/api/scheduled-tasks', scheduledTaskRoutes)
app.route('/api/todos', todosRoutes)
app.route('/api/channel-admin', channelAdminRoutes)
app.route('/api/check-ins', checkInRoutes)
app.route('/api/intervention-material-runtime', interventionMaterialRuntimeRoutes)
app.route('/api/internal-videos', internalVideoRuntimeRoutes)
if (isFeatureEnabled(featureSnapshot, 'materialUploadAdmin')) {
  app.route('/api/intervention-materials', interventionMaterialRoutes)
}

// Start server
const server = serve({ fetch: app.fetch, port: env.PORT, hostname: env.HOST }, (info) => {
  logger.info({ port: info.port, env: env.NODE_ENV }, 'server started')
  startCronJobs()
})
getInjectWebSocket()(server)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void shutdownLangfuse(logger).finally(() => {
      process.exit(signal === 'SIGINT' ? 130 : 143)
    })
  })
}

export default app
