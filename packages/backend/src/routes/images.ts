import { Hono } from 'hono'
import { z } from 'zod'
import type { ImageAssetUploadResponse } from '@health-agent/shared'
import { authMiddleware } from '../middleware/auth.js'
import { requireActiveAccount } from '../middleware/active-account.js'
import { rateLimitMiddleware } from '../middleware/rate-limit.js'
import { createImageAssetFromFile, type ImageAssetPurpose } from '../services/image-asset.js'

const imageRoutes = new Hono()

imageRoutes.use('*', authMiddleware)
imageRoutes.use('*', requireActiveAccount)

const uploadSchema = z.object({
  purpose: z.enum(['chat', 'medical']).default('chat'),
})

function valuesOf(value: unknown): unknown[] {
  if (value == null) return []
  return Array.isArray(value) ? value : [value]
}

function firstString(value: unknown): string | undefined {
  return valuesOf(value).find((item): item is string => typeof item === 'string')
}

imageRoutes.post(
  '/upload',
  rateLimitMiddleware({
    windowMs: 10_000,
    max: 10,
    keyPrefix: 'rl:image-upload',
    keyExtractor: (c) => c.get('userId'),
  }),
  async (c) => {
    const logger = c.get('logger')
    const userId = c.get('userId')
    const form = await c.req.parseBody({ all: true })
    const parsed = uploadSchema.safeParse({ purpose: firstString(form.purpose) ?? 'chat' })
    if (!parsed.success) {
      return c.json({ success: false, error: parsed.error.issues[0]?.message }, 400)
    }

    const files = [...valuesOf(form.images), ...valuesOf(form.image), ...valuesOf(form.file)]
      .filter((item): item is File => item instanceof File && item.size > 0)

    if (files.length === 0) {
      return c.json({ success: false, error: '请选择图片' }, 400)
    }
    if (files.length > 10) {
      return c.json({ success: false, error: '一次最多上传 10 张图片' }, 400)
    }

    try {
      const assets = await Promise.all(
        files.map((file) =>
          createImageAssetFromFile(userId, file, parsed.data.purpose as ImageAssetPurpose, logger),
        ),
      )
      const data: ImageAssetUploadResponse = { assets }
      return c.json({ success: true, data })
    } catch (err: any) {
      if (typeof err?.status === 'number') {
        return c.json({ success: false, error: err.message }, err.status)
      }
      logger.error({ err }, 'image upload failed')
      return c.json({ success: false, error: '图片上传失败，请稍后重试' }, 500)
    }
  },
)

export default imageRoutes
