/**
 * Active Account Middleware — 拦截处于"待注销"状态的用户
 *
 * 必须挂在 authMiddleware 之后（依赖 c.get('userId')）。
 * 所有业务路由（chat/sessions/medical/export/feedback/share）应挂载此中间件，
 * 但 /api/account 与 /api/auth 不挂（用户在冷静期内仍需能查询状态与撤销）。
 */

import { createMiddleware } from 'hono/factory'
import { getAccountStatus } from '../services/account-deletion.js'

export const ACCOUNT_PENDING_DELETION_CODE = 'ACCOUNT_PENDING_DELETION'

export const requireActiveAccount = createMiddleware(async (c, next) => {
  const userId = c.get('userId')
  const logger = c.get('logger')

  const info = await getAccountStatus(userId)
  if (!info) {
    logger.warn({ userId }, 'active account check: user not found')
    return c.json({ success: false, error: '用户不存在' }, 404)
  }

  if (info.status === 'pending_deletion') {
    logger.info({ userId }, 'blocked: account pending deletion')
    return c.json(
      {
        success: false,
        code: ACCOUNT_PENDING_DELETION_CODE,
        error: '账号正在注销流程中，请先撤销后再操作',
        data: {
          deletionRequestedAt: info.deletionRequestedAt?.toISOString() ?? null,
        },
      },
      403,
    )
  }

  await next()
})
