import { Hono } from 'hono'
import { getEnv } from '../env.js'
import { exportConversations } from '../services/export.js'

const exportRoutes = new Hono()

// Guard: test token auth, non-production only
exportRoutes.use('*', async (c, next) => {
  const env = getEnv()
  if (env.DEPLOY_ENV === 'prod' || !env.ENABLE_EXPORT_ROUTES) {
    return c.json({ success: false, error: 'export API disabled' }, 403)
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

// GET /api/export/conversations?phone=xxx&userId=xxx&startDate=xxx&endDate=xxx
exportRoutes.get('/conversations', async (c) => {
  const logger = c.get('logger')
  const { phone, userId, startDate, endDate } = c.req.query()

  if (!phone && !userId && !startDate && !endDate) {
    return c.json({ success: false, error: 'at least one filter is required (phone, userId, startDate, or endDate)' }, 400)
  }

  try {
    const wb = await exportConversations({ phone, userId, startDate, endDate }, logger)

    const buffer = await wb.xlsx.writeBuffer()

    const tag = phone || userId || 'all'
    const filename = `conversations_${tag}_${new Date().toISOString().slice(0, 10)}.xlsx`

    c.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    c.header('Content-Disposition', `attachment; filename="${filename}"`)

    return c.body(buffer as ArrayBuffer)
  } catch (err: any) {
    logger.error({ err: err.message }, 'export failed')
    return c.json({ success: false, error: err.message }, 500)
  }
})

export default exportRoutes
