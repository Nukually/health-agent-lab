import type { ErrorHandler } from 'hono'
import { rootLogger } from '../lib/logger.js'

export const errorHandler: ErrorHandler = (err, c) => {
  const logger = c.get('logger') ?? rootLogger
  const requestId = c.get('requestId') ?? 'unknown'

  logger.error(
    { err, requestId, path: c.req.path, method: c.req.method },
    'unhandled error',
  )

  return c.json(
    { success: false, error: 'Internal server error', requestId },
    500,
  )
}
