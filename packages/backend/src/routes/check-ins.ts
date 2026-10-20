import { Hono } from 'hono'
import { z } from 'zod'
import type {
  ApiResponse,
  CheckInCardResponse,
  CheckInCardSaveResponse,
  CheckInCommitResponse,
  CheckInRecord,
  CheckInRecordListResponse,
  CheckInRecordUpdateResponse,
  CheckInSchemaListResponse,
} from '@health-agent/shared'
import { isFeatureEnabled } from '@health-agent/shared'
import { authMiddleware } from '../middleware/auth.js'
import { requireActiveAccount } from '../middleware/active-account.js'
import { getBackendFeatureSnapshot } from '../features.js'
import {
  cancelCheckInCard,
  commitCheckInDraft,
  deleteCheckInRecord,
  getCheckInCard,
  getCheckInRecord,
  listCheckInRecords,
  listCheckInSchemas,
  saveCheckInCard,
  updateCheckInRecord,
} from '../services/check-in.js'
import { rootLogger } from '../lib/logger.js'

const checkInRoutes = new Hono()

checkInRoutes.use('*', authMiddleware)
checkInRoutes.use('*', requireActiveAccount)
checkInRoutes.use('*', async (c, next) => {
  if (!isFeatureEnabled(getBackendFeatureSnapshot(), 'checkInRecords')) {
    return c.json({ success: false, error: 'not available' }, 404)
  }
  await next()
})

const recordListQuerySchema = z.object({
  categoryKey: z.string().trim().max(80).optional(),
  cursor: z.string().trim().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
})

const recordedAtDateSchema = z.string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'recordedAt 必须使用 YYYY-MM-DD 格式')
  .optional()
  .nullable()

const commitBodySchema = z.object({
  draftToken: z.string().trim().min(1).optional(),
  checkInCardId: z.string().trim().uuid().optional(),
  values: z.record(z.unknown()).optional().default({}),
  note: z.string().max(2000).optional().nullable(),
  tags: z.array(z.string()).max(24).optional(),
})

const cardSaveBodySchema = z.object({
  values: z.record(z.unknown()).optional(),
  note: z.string().max(2000).optional().nullable(),
  tags: z.array(z.string()).max(24).optional(),
})

const recordUpdateBodySchema = z.object({
  values: z.record(z.unknown()).optional(),
  note: z.string().max(2000).optional().nullable(),
  tags: z.array(z.string()).max(24).optional(),
  recordedAt: recordedAtDateSchema,
})

checkInRoutes.get('/schemas', async (c) => {
  const userId = c.get('userId')
  const schemas = await listCheckInSchemas(userId)
  const payload: ApiResponse<CheckInSchemaListResponse> = {
    success: true,
    data: { schemas },
  }
  return c.json(payload)
})

checkInRoutes.get('/records', async (c) => {
  const userId = c.get('userId')
  const parsed = recordListQuerySchema.safeParse({
    categoryKey: c.req.query('categoryKey') || undefined,
    cursor: c.req.query('cursor') || undefined,
    limit: c.req.query('limit') || undefined,
  })
  if (!parsed.success) {
    return c.json({ success: false, error: parsed.error.issues[0]?.message ?? '参数错误' }, 400)
  }
  const data = await listCheckInRecords({
    userId,
    categoryKey: parsed.data.categoryKey,
    cursor: parsed.data.cursor,
    limit: parsed.data.limit,
  })
  const payload: ApiResponse<CheckInRecordListResponse> = { success: true, data }
  return c.json(payload)
})

checkInRoutes.get('/records/:id', async (c) => {
  const userId = c.get('userId')
  const id = c.req.param('id')
  const record = await getCheckInRecord(userId, id)
  if (!record) return c.json({ success: false, error: '打卡记录不存在' }, 404)
  const payload: ApiResponse<CheckInRecord> = { success: true, data: record }
  return c.json(payload)
})

checkInRoutes.patch('/records/:id', async (c) => {
  const userId = c.get('userId')
  const id = c.req.param('id')
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ success: false, error: '请求体不是合法 JSON' }, 400)
  }
  const parsed = recordUpdateBodySchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ success: false, error: parsed.error.issues[0]?.message ?? '参数错误' }, 400)
  }
  try {
    const record = await updateCheckInRecord({
      userId,
      recordId: id,
      values: parsed.data.values as any,
      note: parsed.data.note,
      tags: parsed.data.tags,
      recordedAt: parsed.data.recordedAt,
    })
    if (!record) return c.json({ success: false, error: '打卡记录不存在' }, 404)
    const payload: ApiResponse<CheckInRecordUpdateResponse> = {
      success: true,
      data: { record },
    }
    return c.json(payload)
  } catch (err: any) {
    return c.json({ success: false, error: err?.message ?? '更新失败' }, 400)
  }
})

checkInRoutes.get('/cards/:id', async (c) => {
  const userId = c.get('userId')
  const id = c.req.param('id')
  const card = await getCheckInCard(userId, id)
  if (!card) return c.json({ success: false, error: '打卡卡片不存在' }, 404)
  const payload: ApiResponse<CheckInCardResponse> = { success: true, data: { card } }
  return c.json(payload)
})

checkInRoutes.post('/cards/:id/save', async (c) => {
  const userId = c.get('userId')
  const id = c.req.param('id')
  const log = (c.get('logger') as any) ?? rootLogger.child({ module: 'check-in.card-save' })
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ success: false, error: '请求体不是合法 JSON' }, 400)
  }
  const parsed = cardSaveBodySchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ success: false, error: parsed.error.issues[0]?.message ?? '参数错误' }, 400)
  }
  try {
    const result = await saveCheckInCard({
      userId,
      cardId: id,
      values: parsed.data.values as any,
      note: parsed.data.note ?? undefined,
      tags: parsed.data.tags,
    }, log)
    const payload: ApiResponse<CheckInCardSaveResponse> = {
      success: true,
      data: {
        ...result,
        recordId: result.record.id,
      },
    }
    return c.json(payload)
  } catch (err: any) {
    return c.json({ success: false, error: err?.message ?? '保存失败' }, 400)
  }
})

checkInRoutes.post('/cards/:id/cancel', async (c) => {
  const userId = c.get('userId')
  const id = c.req.param('id')
  try {
    const result = await cancelCheckInCard(userId, id)
    if (!result) return c.json({ success: false, error: '打卡卡片不存在' }, 404)
    const payload: ApiResponse<CheckInCardResponse> = {
      success: true,
      data: { card: result.card },
    }
    return c.json(payload)
  } catch (err: any) {
    return c.json({ success: false, error: err?.message ?? '取消失败' }, 400)
  }
})

checkInRoutes.delete('/records/:id', async (c) => {
  const userId = c.get('userId')
  const id = c.req.param('id')
  const deleted = await deleteCheckInRecord(userId, id)
  if (!deleted) return c.json({ success: false, error: '打卡记录不存在' }, 404)
  return c.json({ success: true, data: { deleted: true } })
})

checkInRoutes.post('/records/commit', async (c) => {
  const userId = c.get('userId')
  const log = (c.get('logger') as any) ?? rootLogger.child({ module: 'check-in.commit' })
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ success: false, error: '请求体不是合法 JSON' }, 400)
  }
  const parsed = commitBodySchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ success: false, error: parsed.error.issues[0]?.message ?? '参数错误' }, 400)
  }
  try {
    const record = await commitCheckInDraft(
      {
        userId,
        draftToken: parsed.data.draftToken,
        checkInCardId: parsed.data.checkInCardId,
        values: parsed.data.values as any,
        note: parsed.data.note ?? null,
        tags: parsed.data.tags ?? [],
      },
      log,
    )
    const payload: ApiResponse<CheckInCommitResponse> = {
      success: true,
      data: { record },
    }
    return c.json(payload)
  } catch (err: any) {
    return c.json({ success: false, error: err?.message ?? '保存失败' }, 400)
  }
})

export default checkInRoutes
