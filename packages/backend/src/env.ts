import { z } from 'zod'
import { parseSmsLoginCodeAllowlist } from './utils/sms-login-allowlist.js'

const envBoolean = z.preprocess(
  (v) => {
    if (typeof v !== 'string') return v
    const normalized = v.trim().toLowerCase()
    if (['false', '0', '', 'no', 'off'].includes(normalized)) return false
    if (['true', '1', 'yes', 'on'].includes(normalized)) return true
    return v
  },
  z.boolean(),
)

const optionalNonEmptyString = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
  z.string().min(1).optional(),
)

const optionalUrl = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
  z.string().url().optional(),
)

const envSchema = z.object({
  // LLM
  LLM_API_KEY: z.string().min(1),
  LLM_MODEL: z.string().default('kimi-k2.5'),
  LLM_BASE_URL: z.string().url().default('https://dashscope.aliyuncs.com/compatible-mode/v1'),
  LLM_CONTEXT_WINDOW: z.coerce.number().default(262144),
  OCR_MODEL: z.string().optional(), // 病历 OCR 模型，默认用 LLM_MODEL（支持视觉），开通 qwen-vl-ocr 后可切换
  RECOMMENDED_QUESTION_MODEL: z.string().default('qwen3.6-flash'),
  // 实验开关：false = 关闭 enable_thinking，模型把思考和答案都写进 content，
  // 由 api/client.ts 的状态机按 <thinking>/</thinking>/<final_answer> 剥离分发
  LLM_ENABLE_THINKING: envBoolean.default(true),

  // LLM Backup（默认 Kimi 官方 API 兜底；Moonshot 路径会自动转换 thinking 参数）
  LLM_BACKUP_API_KEY: z.string().optional(),
  LLM_BACKUP_BASE_URL: z.string().url().default('https://api.moonshot.cn/v1'),
  LLM_BACKUP_MODEL: z.string().default('kimi-k2.6'),
  MEDICAL_RAG_QUERY_URL: optionalUrl,

  // Database
  DATABASE_URL: z.string().min(1),
  TRACKING_DATABASE_URL: optionalUrl,
  TRACKING_V2_ENABLED: envBoolean.default(true),
  TRACKING_V2_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(1),

  // Redis — 优先 REDIS_HOST（避免密码特殊字符的 URL 编码问题），其次 REDIS_URL，都没有则内存 fallback
  REDIS_URL: z.string().optional(),
  REDIS_HOST: z.string().optional(),
  REDIS_PORT: z.coerce.number().default(6379),
  REDIS_PASSWORD: z.string().optional(),
  REDIS_DB: z.coerce.number().default(0),

  // Auth
  JWT_SECRET: z.string().min(8),
  TEST_TOKEN: optionalNonEmptyString,

  APP_BASE_URL: z.string().url().default('http://localhost:5174/'),

  // CORS
  CORS_ORIGIN: z.string().default('*'),

  // Server
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().default(13010),
  NODE_ENV: z.enum(['development', 'production', 'test']),
  DEPLOY_ENV: z.enum(['local', 'dev', 'sit', 'prod']),
  HEALTH_AGENT_FEATURE_PROFILE: z.enum(['dev', 'sit', 'prod']).optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  LOG_PRETTY: envBoolean.default(false),
  ENABLE_TEST_ROUTES: envBoolean.default(false),
  ENABLE_EXPORT_ROUTES: envBoolean.default(false),
  ENABLE_DEBUG_ROUTES: envBoolean.default(false),

  // Memory
  MEMORY_REVIEW_ENABLED: envBoolean.default(true),
  MEMORY_RECALL_ENABLED: envBoolean.default(true),
  MEMORY_PROFILE_REFRESH_ENABLED: envBoolean.default(true),
  MEMORY_EMBEDDING_MODEL: z.string().default('text-embedding-v4'),
  MEMORY_RECALL_TIMEOUT_MS: z.coerce.number().int().min(200).max(10000).default(1800),
  MEMORY_RECALL_MIN_SCORE: z.coerce.number().min(0).max(1).default(0.2),
  MEMORY_DUPLICATE_MIN_SCORE: z.coerce.number().min(0).max(1).default(0.9),

  // Intervention efficacy analysis（干预方案疗效分析 cron）
  EFFICACY_ANALYSIS_ENABLED: envBoolean.default(true),
  EFFICACY_INACTIVE_HOURS: z.coerce.number().int().min(1).max(72).default(3),
  EFFICACY_ANALYSIS_MODEL: z.string().default('deepseek-v4-pro'),

  // Intervention plan demand merge（干预方案需求合并 cron）
  INTERVENTION_DEMAND_MERGE_ENABLED: envBoolean.default(true),
  INTERVENTION_DEMAND_MERGE_MODEL: z.string().default('deepseek-v4-pro'),

  // 产品指南里的移动端下载入口（服务端运行时读取；不配置则工具返回未配置）
  HEALTH_AGENT_ANDROID_APK_URL: optionalUrl,
  HEALTH_AGENT_TESTFLIGHT_URL: optionalUrl,
  HEALTH_AGENT_HARMONY_BETA_URL: optionalUrl,
  // 兼容前端构建时变量名，便于同一份 .env 同时供 Vite 和后端产品指南使用。
  VITE_HEALTH_AGENT_ANDROID_APK_URL: optionalUrl,
  VITE_HEALTH_AGENT_TESTFLIGHT_URL: optionalUrl,
  VITE_HEALTH_AGENT_HARMONY_BETA_URL: optionalUrl,

  // OSS（病历图片 + OCR 文本存储）
  OSS_ACCESS_KEY_ID: z.string().optional(),
  OSS_ACCESS_KEY_SECRET: z.string().optional(),
  OSS_BUCKET: z.string().optional(),
  OSS_ENDPOINT: z.string().optional(),
  OSS_BUCKET_DEV: z.string().optional(),
  OSS_BUCKET_SIT: z.string().optional(),
  OSS_BUCKET_PROD: z.string().optional(),
  OSS_ACCESS_KEY_ID_SIT: z.string().optional(),
  OSS_ACCESS_KEY_SECRET_SIT: z.string().optional(),
  OSS_ACCESS_KEY_ID_PROD: z.string().optional(),
  OSS_ACCESS_KEY_SECRET_PROD: z.string().optional(),
  OSS_KEY_PREFIX: z.string().optional(),

  // 干预素材上传台
  INTERVENTION_EDITOR_PHONES: z.string().optional(),
  INTERVENTION_TTS_VOICE: z.string().optional(),

  // 百度千帆 web_search（用于低风险干预资源召回；不配置则跳过外部搜索）
  BAIDU_WEB_SEARCH_API_KEY: z.string().optional(),
  BAIDU_WEB_SEARCH_ENDPOINT: z.string().url().default('https://qianfan.baidubce.com/v2/ai_search/web_search'),

  // 渠道二维码管理 API Key（保护 /api/channel-admin/*；不配置则接口返回 403）
  CHANNEL_ADMIN_API_KEY: z.string().optional(),

  // 医生端联动：患者端同步医生信息 + 患教内容读取。
  DOCTOR_SERVER_BASE_URL: optionalUrl,
  DOCTOR_SERVER_TOKEN: optionalNonEmptyString,
  DOCTOR_ACCESS_TOKEN: z.string().optional(),
  DOCTOR_ACCESS_IMAGE_URL_EXPIRES_SECONDS: z.coerce.number().int().min(60).max(3600).default(600),

  // 阿里云短信（DEPLOY_ENV=sit / prod 必填；local / dev 使用固定码 123 不实际发送）
  ALIYUN_SMS_ACCESS_KEY_ID: z.string().optional(),
  ALIYUN_SMS_ACCESS_KEY_SECRET: z.string().optional(),
  ALIYUN_SMS_SIGN_NAME: z.string().optional(),
  ALIYUN_SMS_TEMPLATE_CODE: z.string().optional(),
  ALIYUN_SMS_ENDPOINT: z.string().default('dysmsapi.aliyuncs.com'),
  // 阿里云 SMS 读响应超时（毫秒）。SDK 默认 3000ms 对用户在等的同步发码偏短，
  // 网络抖动易触发 ReadTimeout，放宽到 5000ms。
  ALIYUN_SMS_READ_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  // 临时开关：sit / prod 环境也走固定码 123（内测期用，正式放量前置 false 或删除）
  // 注：z.coerce.boolean() 会把 "false" 也当成 true（Boolean("false") === true），
  // 这里用 preprocess 手动识别 "false" / "0" / "" 为 false
  SMS_USE_FIXED_CODE: envBoolean.default(false),
  // 登录验证码人工白名单：phone=6位验证码，逗号分隔。仅用于 /api/auth/send-code。
  SMS_LOGIN_CODE_ALLOWLIST: z.string().optional(),

  // 语音服务 Provider 切换（TTS / ASR 可独立切换，dev/sit/prod 默认火山）
  TTS_PROVIDER: z.enum(['volcengine', 'aliyun']).default('volcengine'),
  ASR_PROVIDER: z.enum(['volcengine', 'aliyun']).default('volcengine'),

  // 火山引擎豆包语音（双向流式 TTS + 流式 ASR）
  VOLCENGINE_APP_ID: z.string().optional(),
  // 新版控制台鉴权头 X-Api-Key（ark-xxx 形式）
  VOLCENGINE_API_KEY: z.string().optional(),
  // 旧版控制台鉴权头 X-Api-Access-Key；新版可省略，保留用于兼容
  VOLCENGINE_ACCESS_TOKEN: z.string().optional(),
  VOLCENGINE_SECRET_KEY: z.string().optional(),
  VOLCENGINE_TTS_VOICE: z.string().default('zh_female_vv_uranus_bigtts'),
  VOLCENGINE_TTS_ENDPOINT: z.string().url().default('wss://openspeech.bytedance.com/api/v3/tts/bidirection'),
  // 豆包语音合成 2.0 = seed-tts-2.0；1.0 = seed-tts-1.0；声音复刻 = seed-icl-2.0
  VOLCENGINE_TTS_RESOURCE_ID: z.string().default('seed-tts-2.0'),
  VOLCENGINE_ASR_ENDPOINT: z.string().url().default('wss://openspeech.bytedance.com/api/v3/sauc/bigmodel'),
  // 豆包流式语音识别 2.0 小时版；1.0 为 volc.bigasr.sauc.duration
  VOLCENGINE_ASR_RESOURCE_ID: z.string().default('volc.seedasr.sauc.duration'),
  // 火山 ASR 热词词表 ID（在火山语音控制台创建热词文件后复制其热词ID）；为空则不启用热词
  VOLCENGINE_ASR_BOOSTING_TABLE_ID: z.string().optional(),

  // Push — 极光推送（Android 当前使用；iOS 可复用 JPush registration_id 或后续切 APNs provider）
  JPUSH_ENABLED: envBoolean.default(false),
  JPUSH_APP_KEY: z.string().optional(),
  JPUSH_MASTER_SECRET: z.string().optional(),
  JPUSH_BASE_URL: z.string().url().default('https://api.jpush.cn'),
  JPUSH_REPORT_BASE_URL: z.string().url().default('https://report.jpush.cn/v3'),
  JPUSH_APNS_PRODUCTION: envBoolean.default(false),

  // Langfuse observability（默认关闭；配置完整且 LANGFUSE_ENABLED=true 时启用）
  LANGFUSE_ENABLED: envBoolean.default(false),
  LANGFUSE_PUBLIC_KEY: z.string().optional(),
  LANGFUSE_SECRET_KEY: z.string().optional(),
  LANGFUSE_BASE_URL: z.string().url().optional(),
  LANGFUSE_ENVIRONMENT: z.string().optional(),
  LANGFUSE_TRACING_ENVIRONMENT: z.string().optional(),
  LANGFUSE_RELEASE: z.string().optional(),
  LANGFUSE_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(1),
  LANGFUSE_CAPTURE_RAW_LLM_IO: envBoolean.default(false),
  LANGFUSE_CAPTURE_THINKING: envBoolean.default(false),
  LANGFUSE_MAX_FIELD_CHARS: z.coerce.number().int().min(512).max(200000).default(8000),
  LANGFUSE_FLUSH_AT: z.coerce.number().int().min(1).max(1000).default(20),
  LANGFUSE_FLUSH_INTERVAL_SECONDS: z.coerce.number().min(1).max(120).default(5),
  LANGFUSE_TIMEOUT_SECONDS: z.coerce.number().min(1).max(60).default(5),
  LANGFUSE_PROMPT_SYNC_ENABLED: envBoolean.default(false),
  LANGFUSE_SYSTEM_PROMPT_NAME: z.string().default('health-agent-lab-system-prompt'),
  LANGFUSE_PROMPT_LABEL: z.string().optional(),
}).superRefine((env, ctx) => {
  const testRoutesEnabled =
    env.ENABLE_TEST_ROUTES || env.ENABLE_EXPORT_ROUTES || env.ENABLE_DEBUG_ROUTES
  const defaultTestTokens = new Set(['cx-test-token-dev', 'cx-test-token'])

  if (testRoutesEnabled && !env.TEST_TOKEN) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['TEST_TOKEN'],
      message: 'TEST_TOKEN is required when test/export/debug routes are enabled',
    })
  }

  if (
    testRoutesEnabled &&
    env.DEPLOY_ENV !== 'dev' &&
    env.DEPLOY_ENV !== 'local' &&
    env.TEST_TOKEN &&
    defaultTestTokens.has(env.TEST_TOKEN)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['TEST_TOKEN'],
      message: 'default TEST_TOKEN is not allowed when test/export/debug routes are enabled',
    })
  }

  if (env.JPUSH_ENABLED) {
    if (!env.JPUSH_APP_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JPUSH_APP_KEY'],
        message: 'JPUSH_ENABLED=true 时必须配置 JPUSH_APP_KEY',
      })
    }
    if (!env.JPUSH_MASTER_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JPUSH_MASTER_SECRET'],
        message: 'JPUSH_ENABLED=true 时必须配置 JPUSH_MASTER_SECRET',
      })
    }
  }

  if (env.LANGFUSE_ENABLED) {
    for (const key of ['LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY', 'LANGFUSE_BASE_URL'] as const) {
      if (!env[key]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} is required when LANGFUSE_ENABLED=true`,
        })
      }
    }
  }

  if (env.DEPLOY_ENV === 'prod') {
    if (env.NODE_ENV !== 'production') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['NODE_ENV'],
        message: 'NODE_ENV must be production when DEPLOY_ENV=prod',
      })
    }

    if (testRoutesEnabled) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ENABLE_TEST_ROUTES'],
        message: 'test/export/debug routes must stay disabled in prod',
      })
    }

    if (!env.REDIS_HOST && !env.REDIS_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['REDIS_HOST'],
        message: 'Redis is required when DEPLOY_ENV=prod',
      })
    }

    if (env.SMS_USE_FIXED_CODE) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SMS_USE_FIXED_CODE'],
        message: 'SMS_USE_FIXED_CODE must be false when DEPLOY_ENV=prod',
      })
    }
  }

  try {
    parseSmsLoginCodeAllowlist(env.SMS_LOGIN_CODE_ALLOWLIST)
  } catch (err) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['SMS_LOGIN_CODE_ALLOWLIST'],
      message: err instanceof Error ? err.message : 'invalid SMS_LOGIN_CODE_ALLOWLIST',
    })
  }

  if ((env.DEPLOY_ENV === 'sit' || env.DEPLOY_ENV === 'prod') && !env.SMS_USE_FIXED_CODE) {
    const requiredSmsKeys = [
      'ALIYUN_SMS_ACCESS_KEY_ID',
      'ALIYUN_SMS_ACCESS_KEY_SECRET',
      'ALIYUN_SMS_SIGN_NAME',
      'ALIYUN_SMS_TEMPLATE_CODE',
    ] as const

    for (const key of requiredSmsKeys) {
      if (!env[key]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} is required when DEPLOY_ENV=${env.DEPLOY_ENV} and SMS_USE_FIXED_CODE=false`,
        })
      }
    }
  }

})

export type Env = z.infer<typeof envSchema>

let _env: Env | null = null

export function getEnv(): Env {
  if (!_env) {
    const result = envSchema.safeParse(process.env)
    if (!result.success) {
      console.error('Invalid environment variables:', result.error.flatten().fieldErrors)
      process.exit(1)
    }
    _env = result.data
  }
  return _env
}
