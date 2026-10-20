import { Hono } from 'hono'
import { z } from 'zod'
import type { ApiResponse, InviteBindDoctorResponse, MyDoctorResponse, UnbindDoctorResponse } from '@health-agent/shared'
import { authMiddleware } from '../middleware/auth.js'
import { requireActiveAccount } from '../middleware/active-account.js'
import { getEnv } from '../env.js'
import {
  bindDoctorForUser,
  cancelPatientUnbindForUser,
  confirmDoctorUnbindForUser,
  getBoundDoctorForUser,
  inviteBindDoctorForUser,
  listDoctorBindingsForUser,
  rejectDoctorUnbindForUser,
  requestUnbindDoctorForUser,
} from '../services/doctor-binding.js'
import { getBackendFeatureSnapshotForUser } from '../features.js'

const doctorRoutes = new Hono()

doctorRoutes.use('*', authMiddleware)
doctorRoutes.use('*', requireActiveAccount)

const inviteBindSchema = z.object({
  doctorId: z.string().trim().min(1).max(120),
})

const devBindSchema = z.object({
  doctorId: z.string().trim().min(1),
  name: z.string().trim().min(1),
  avatarUrl: z.string().trim().url().nullable().optional(),
  department: z.string().trim().nullable().optional(),
  title: z.string().trim().nullable().optional(),
})

async function buildMyDoctorResponse(c: any): Promise<MyDoctorResponse> {
  const userId = c.get('userId')
  const [bindings, features] = await Promise.all([
    listDoctorBindingsForUser(userId),
    getBackendFeatureSnapshotForUser({ userId, phone: c.get('jwtPayload').phone }),
  ])
  return {
    bindings,
    binding: bindings[0] ?? null,
    features,
  }
}

async function buildUnbindResponse(c: any, unbound: boolean): Promise<UnbindDoctorResponse> {
  const data = await buildMyDoctorResponse(c)
  return {
    unbound,
    bindings: data.bindings,
    binding: data.binding,
    features: data.features,
  }
}

// GET /api/doctor/me
doctorRoutes.get('/me', async (c) => {
  const payload: ApiResponse<MyDoctorResponse> = {
    success: true,
    data: await buildMyDoctorResponse(c),
  }
  return c.json(payload)
})

// DELETE /api/doctor/bindings/:bindingId — patient requests unbind for one doctor.
doctorRoutes.delete('/bindings/:bindingId', async (c) => {
  const binding = await requestUnbindDoctorForUser(c.get('userId'), c.req.param('bindingId'))
  if (!binding) return c.json({ success: false, error: '绑定关系不存在' }, 404)
  const payload: ApiResponse<UnbindDoctorResponse> = {
    success: true,
    data: await buildUnbindResponse(c, binding.status === 'unbound'),
  }
  return c.json(payload)
})

// POST /api/doctor/bindings/:bindingId/unbind-confirm — patient confirms a doctor initiated unbind.
doctorRoutes.post('/bindings/:bindingId/unbind-confirm', async (c) => {
  const unbound = await confirmDoctorUnbindForUser(c.get('userId'), c.req.param('bindingId'))
  const payload: ApiResponse<UnbindDoctorResponse> = {
    success: true,
    data: await buildUnbindResponse(c, unbound),
  }
  return c.json(payload)
})

// POST /api/doctor/bindings/:bindingId/unbind-reject — patient rejects a doctor initiated unbind.
doctorRoutes.post('/bindings/:bindingId/unbind-reject', async (c) => {
  await rejectDoctorUnbindForUser(c.get('userId'), c.req.param('bindingId'))
  const payload: ApiResponse<UnbindDoctorResponse> = {
    success: true,
    data: await buildUnbindResponse(c, false),
  }
  return c.json(payload)
})

// POST /api/doctor/bindings/:bindingId/unbind-cancel — patient cancels their own unbind request.
doctorRoutes.post('/bindings/:bindingId/unbind-cancel', async (c) => {
  await cancelPatientUnbindForUser(c.get('userId'), c.req.param('bindingId'))
  const payload: ApiResponse<UnbindDoctorResponse> = {
    success: true,
    data: await buildUnbindResponse(c, false),
  }
  return c.json(payload)
})

// DELETE /api/doctor/me — legacy single-doctor unbind endpoint.
doctorRoutes.delete('/me', async (c) => {
  const binding = await getBoundDoctorForUser(c.get('userId'))
  if (binding) await requestUnbindDoctorForUser(c.get('userId'), binding.bindingId)
  return c.json({
    success: true,
    data: await buildUnbindResponse(c, false),
  })
})

// POST /api/doctor/me/unbind-confirm — legacy single-doctor confirm endpoint.
doctorRoutes.post('/me/unbind-confirm', async (c) => {
  const binding = await getBoundDoctorForUser(c.get('userId'))
  const unbound = binding ? await confirmDoctorUnbindForUser(c.get('userId'), binding.bindingId) : false
  return c.json({
    success: true,
    data: await buildUnbindResponse(c, unbound),
  })
})

// POST /api/doctor/me/unbind-cancel — legacy single-doctor cancel endpoint.
doctorRoutes.post('/me/unbind-cancel', async (c) => {
  const binding = await getBoundDoctorForUser(c.get('userId'))
  if (binding) await cancelPatientUnbindForUser(c.get('userId'), binding.bindingId)
  return c.json({
    success: true,
    data: await buildUnbindResponse(c, false),
  })
})

// POST /api/doctor/invite-bind — patient scanned doctor QR code and requests binding.
doctorRoutes.post('/invite-bind', async (c) => {
  const logger = c.get('logger')
  const parsed = inviteBindSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) {
    return c.json({ success: false, error: parsed.error.issues[0]?.message ?? '参数错误' }, 400)
  }

  try {
    const binding = await inviteBindDoctorForUser({
      userId: c.get('userId'),
      doctorId: parsed.data.doctorId,
      logger,
    })
    const features = await getBackendFeatureSnapshotForUser({
      userId: c.get('userId'),
      phone: c.get('jwtPayload').phone,
    })
    const payload: ApiResponse<InviteBindDoctorResponse> = {
      success: true,
      data: { binding, features },
    }
    return c.json(payload)
  } catch (err: any) {
    logger.warn({ err: err?.message ?? String(err), doctorId: parsed.data.doctorId }, 'doctor invite bind failed')
    return c.json({ success: false, error: err?.message ?? '绑定医生失败' }, err?.status ?? 500)
  }
})

// POST /api/doctor/dev-bind — dev/local only, for testing bound-doctor filtering
doctorRoutes.post('/dev-bind', async (c) => {
  const env = getEnv()
  if (env.DEPLOY_ENV !== 'local' && env.DEPLOY_ENV !== 'dev') {
    return c.json({ success: false, error: 'not available' }, 404)
  }

  const parsed = devBindSchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) {
    return c.json({ success: false, error: parsed.error.issues[0]?.message ?? '参数错误' }, 400)
  }

  const binding = await bindDoctorForUser({
    userId: c.get('userId'),
    ...parsed.data,
  })
  const features = await getBackendFeatureSnapshotForUser({
    userId: c.get('userId'),
    phone: c.get('jwtPayload').phone,
  })
  return c.json({
    success: true,
    data: { binding, features },
  })
})

export default doctorRoutes
