import { Hono } from 'hono'
import { z } from 'zod'
import type {
  ApiResponse,
  ChannelAgentResponse,
  ChannelPartnerResponse,
  ChannelQrCodeBulkCreateResponse,
} from '@health-agent/shared'
import { channelAdminMiddleware } from '../middleware/channel-admin.js'
import {
  createChannelQrCodes,
  exportChannelQrCodesWorkbook,
  upsertChannelAgent,
  upsertChannelPartner,
} from '../services/channel.js'

const channelStatusSchema = z.enum(['active', 'inactive'])

const partnerSchema = z.object({
  code: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
  name: z.string().trim().min(1).max(120),
  status: channelStatusSchema.optional().default('active'),
})

const agentSchema = z.object({
  code: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
  name: z.string().trim().min(1).max(120),
  status: channelStatusSchema.optional().default('active'),
})

const bulkQrSchema = z.object({
  partnerId: z.string().uuid(),
  agentId: z.string().uuid(),
  count: z.number().int().min(1).max(500),
})

const channelAdminRoutes = new Hono()

channelAdminRoutes.use('*', channelAdminMiddleware)

channelAdminRoutes.post('/partners', async (c) => {
  const parsed = partnerSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) {
    return c.json({ success: false, error: parsed.error.issues[0]?.message ?? '参数错误' }, 400)
  }

  const partner = await upsertChannelPartner(parsed.data)
  const payload: ApiResponse<ChannelPartnerResponse> = {
    success: true,
    data: { partner },
  }
  return c.json(payload)
})

channelAdminRoutes.post('/partners/:partnerId/agents', async (c) => {
  const partnerId = c.req.param('partnerId')
  const parsed = agentSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!z.string().uuid().safeParse(partnerId).success) {
    return c.json({ success: false, error: '代理商 ID 不合法' }, 400)
  }
  if (!parsed.success) {
    return c.json({ success: false, error: parsed.error.issues[0]?.message ?? '参数错误' }, 400)
  }

  try {
    const agent = await upsertChannelAgent({ partnerId, ...parsed.data })
    const payload: ApiResponse<ChannelAgentResponse> = {
      success: true,
      data: { agent },
    }
    return c.json(payload)
  } catch (err: any) {
    return c.json({ success: false, error: err?.message ?? '创建代理员失败' }, err?.status ?? 500)
  }
})

channelAdminRoutes.post('/qr-codes/bulk', async (c) => {
  const logger = c.get('logger')
  const parsed = bulkQrSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) {
    return c.json({ success: false, error: parsed.error.issues[0]?.message ?? '参数错误' }, 400)
  }

  try {
    const items = await createChannelQrCodes(parsed.data, logger)
    const payload: ApiResponse<ChannelQrCodeBulkCreateResponse> = {
      success: true,
      data: { items },
    }
    return c.json(payload)
  } catch (err: any) {
    return c.json({ success: false, error: err?.message ?? '生成二维码失败' }, err?.status ?? 500)
  }
})

channelAdminRoutes.get('/qr-codes/export.xlsx', async (c) => {
  const logger = c.get('logger')
  const wb = await exportChannelQrCodesWorkbook(logger)
  const buffer = await wb.xlsx.writeBuffer()
  const filename = `channel_qr_codes_${new Date().toISOString().slice(0, 10)}.xlsx`

  c.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  c.header('Content-Disposition', `attachment; filename="${filename}"`)
  return c.body(buffer)
})

export default channelAdminRoutes
