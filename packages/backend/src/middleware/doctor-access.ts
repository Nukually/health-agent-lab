import { createMiddleware } from 'hono/factory'
import { getEnv } from '../env.js'

const BEARER_PREFIX = 'Bearer '

export const doctorAccessMiddleware = createMiddleware(async (c, next) => {
  const logger = c.get('logger')
  const configuredToken = getEnv().DOCTOR_ACCESS_TOKEN

  if (!configuredToken) {
    logger.warn('doctor access token is not configured')
    return c.json({ success: false, error: '医生端访问未配置' }, 403)
  }

  const auth = c.req.header('authorization') ?? ''
  const token = auth.startsWith(BEARER_PREFIX) ? auth.slice(BEARER_PREFIX.length) : ''
  if (!token || token !== configuredToken) {
    logger.warn('doctor access blocked: invalid token')
    return c.json({ success: false, error: '无权限访问' }, 401)
  }

  await next()
})

export const requireDoctorIdHeader = createMiddleware(async (c, next) => {
  const doctorId = c.req.header('x-doctor-id')?.trim()
  if (!doctorId) {
    return c.json({ success: false, error: '缺少 X-Doctor-Id' }, 400)
  }
  await next()
})
