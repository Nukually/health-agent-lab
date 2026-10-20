import { Hono } from 'hono'
import { z } from 'zod'
import type {
  ApiResponse,
  InterventionMaterialBulkPromoteResponse,
  InterventionMaterialDetailResponse,
  InterventionMaterialListResponse,
  InterventionMaterialPromoteResponse,
  InterventionMaterialRecord,
  InterventionMaterialSaveRequest,
} from '@health-agent/shared'
import { authMiddleware } from '../middleware/auth.js'
import { requireActiveAccount } from '../middleware/active-account.js'
import { interventionEditorMiddleware } from '../middleware/intervention-editor.js'
import {
  archiveInterventionMaterial,
  bulkPromoteInterventionMaterials,
  createInterventionMaterial,
  getInterventionMaterial,
  listInterventionMaterialsWithEnvPresence,
  promoteInterventionMaterial,
  updateInterventionMaterial,
} from '../services/intervention-material.js'
import { invalidateInterventionRuntimeCatalogCache } from '../services/intervention-material-runtime.js'

const assetInputSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('existing'),
    key: z.string().min(1),
  }),
  z.object({
    kind: z.literal('upload'),
    dataUrl: z.string().startsWith('data:image/'),
  }),
])

const stepSchema = z.object({
  stepIndex: z.number().int().positive(),
  durationSec: z.number().int().positive(),
  displayText: z.string().trim().min(1),
  ttsText: z.string().trim().min(1),
  image: assetInputSchema,
})

const saveSchema = z.object({
  sideEffect: z.string().trim().min(1),
  scene: z.string().trim().min(1),
  actionName: z.string().trim().min(1),
  prepareItems: z.array(z.string()).default([]),
  precheckQuestion: z.string().trim().default(''),
  feedbackQuestion: z.string().trim().default(''),
  effectiveRule: z.string().trim().default(''),
  fallbackAction: z.string().trim().default(''),
  redFlags: z.array(z.string()).default([]),
  safetyNote: z.string().trim().default(''),
  overviewImage: assetInputSchema,
  steps: z.array(stepSchema).min(1),
})

const promoteSchema = z.object({
  targetEnv: z.enum(['sit', 'prod']),
})

function validateSteps(body: InterventionMaterialSaveRequest): string | null {
  const ordered = [...body.steps].sort((a, b) => a.stepIndex - b.stepIndex)
  for (let i = 0; i < ordered.length; i++) {
    if (ordered[i].stepIndex !== i + 1) {
      return '步骤序号必须从 1 开始连续递增'
    }
  }
  return null
}

const interventionMaterialRoutes = new Hono()

interventionMaterialRoutes.use('*', authMiddleware)
interventionMaterialRoutes.use('*', requireActiveAccount)
interventionMaterialRoutes.use('*', interventionEditorMiddleware)

interventionMaterialRoutes.get('/', async (c) => {
  const logger = c.get('logger')
  const includeArchived = c.req.query('includeArchived') === 'true'
  const items = await listInterventionMaterialsWithEnvPresence(logger, includeArchived)
  const payload: ApiResponse<InterventionMaterialListResponse> = {
    success: true,
    data: { items },
  }
  return c.json(payload)
})

interventionMaterialRoutes.post('/sync-all', async (c) => {
  const logger = c.get('logger')
  const parsed = promoteSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) {
    return c.json({ success: false, error: parsed.error.issues[0]?.message ?? '参数错误' }, 400)
  }

  try {
    const result = await bulkPromoteInterventionMaterials(parsed.data.targetEnv, logger)
    invalidateInterventionRuntimeCatalogCache()
    const payload: ApiResponse<InterventionMaterialBulkPromoteResponse> = {
      success: true,
      data: result,
    }
    return c.json(payload)
  } catch (err: any) {
    return c.json({ success: false, error: err?.message ?? '批量发布失败' }, err?.status ?? 500)
  }
})

interventionMaterialRoutes.post('/', async (c) => {
  const logger = c.get('logger')
  const parsed = saveSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) {
    return c.json({ success: false, error: parsed.error.issues[0]?.message ?? '参数错误' }, 400)
  }

  const stepError = validateSteps(parsed.data)
  if (stepError) {
    return c.json({ success: false, error: stepError }, 400)
  }

  try {
    const material = await createInterventionMaterial(parsed.data, logger)
    invalidateInterventionRuntimeCatalogCache()
    const payload: ApiResponse<InterventionMaterialDetailResponse> = {
      success: true,
      data: { material },
    }
    return c.json(payload)
  } catch (err: any) {
    return c.json({ success: false, error: err?.message ?? '保存失败' }, err?.status ?? 500)
  }
})

interventionMaterialRoutes.get('/:materialId', async (c) => {
  const logger = c.get('logger')
  const materialId = c.req.param('materialId')
  const material = await getInterventionMaterial(materialId, logger)
  if (!material) {
    return c.json({ success: false, error: '素材不存在' }, 404)
  }
  const payload: ApiResponse<InterventionMaterialDetailResponse> = {
    success: true,
    data: { material },
  }
  return c.json(payload)
})

interventionMaterialRoutes.put('/:materialId', async (c) => {
  const logger = c.get('logger')
  const materialId = c.req.param('materialId')
  const parsed = saveSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) {
    return c.json({ success: false, error: parsed.error.issues[0]?.message ?? '参数错误' }, 400)
  }

  const stepError = validateSteps(parsed.data)
  if (stepError) {
    return c.json({ success: false, error: stepError }, 400)
  }

  try {
    const material = await updateInterventionMaterial(materialId, parsed.data, logger)
    invalidateInterventionRuntimeCatalogCache()
    const payload: ApiResponse<InterventionMaterialDetailResponse> = {
      success: true,
      data: { material },
    }
    return c.json(payload)
  } catch (err: any) {
    return c.json({ success: false, error: err?.message ?? '更新失败' }, err?.status ?? 500)
  }
})

interventionMaterialRoutes.post('/:materialId/archive', async (c) => {
  const logger = c.get('logger')
  const materialId = c.req.param('materialId')
  try {
    const material = await archiveInterventionMaterial(materialId, logger)
    invalidateInterventionRuntimeCatalogCache()
    const payload: ApiResponse<InterventionMaterialDetailResponse> = {
      success: true,
      data: { material },
    }
    return c.json(payload)
  } catch (err: any) {
    return c.json({ success: false, error: err?.message ?? '归档失败' }, err?.status ?? 500)
  }
})

interventionMaterialRoutes.post('/:materialId/promote', async (c) => {
  const logger = c.get('logger')
  const materialId = c.req.param('materialId')
  const parsed = promoteSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) {
    return c.json({ success: false, error: parsed.error.issues[0]?.message ?? '参数错误' }, 400)
  }

  try {
    const material = await promoteInterventionMaterial(materialId, parsed.data.targetEnv, logger)
    invalidateInterventionRuntimeCatalogCache()
    const payload: ApiResponse<InterventionMaterialPromoteResponse> = {
      success: true,
      data: {
        materialId: material.materialId,
        version: material.version,
        targetEnv: parsed.data.targetEnv,
      },
    }
    return c.json(payload)
  } catch (err: any) {
    return c.json({ success: false, error: err?.message ?? '发布失败' }, err?.status ?? 500)
  }
})

export default interventionMaterialRoutes
