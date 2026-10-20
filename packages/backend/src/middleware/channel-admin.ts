import { createMiddleware } from 'hono/factory'
import { getEnv } from '../env.js'

const CHANNEL_ADMIN_KEY_HEADER = 'X-Channel-Admin-Key'

export const channelAdminMiddleware = createMiddleware(async (c, next) => {
  const logger = c.get('logger')
  const configuredKey = getEnv().CHANNEL_ADMIN_API_KEY

  if (!configuredKey) {
    logger.warn('channel admin api key is not configured')
    return c.json({ success: false, error: '渠道二维码管理未配置' }, 403)
  }

  const requestKey = c.req.header(CHANNEL_ADMIN_KEY_HEADER)
  if (!requestKey || requestKey !== configuredKey) {
    logger.warn('channel admin blocked: invalid api key')
    return c.json({ success: false, error: '无权限访问渠道二维码管理' }, 403)
  }

  await next()
})
