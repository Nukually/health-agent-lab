import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema/index.js'
import { getDb } from './client.js'
import { rootLogger } from '../lib/logger.js'

const logger = rootLogger.child({ module: 'tracking-db' })

let trackingDb: ReturnType<typeof drizzle<typeof schema>> | null = null
let trackingSql: ReturnType<typeof postgres> | null = null

export function getTrackingDb() {
  const connectionString = process.env.TRACKING_DATABASE_URL
  if (!connectionString) return getDb()

  if (!trackingDb) {
    trackingSql = postgres(connectionString, { max: 10 })
    trackingDb = drizzle(trackingSql, { schema })
    logger.info('tracking database client initialized')
  }
  return trackingDb
}

export async function closeTrackingDb(): Promise<void> {
  if (trackingSql) {
    await trackingSql.end()
    trackingSql = null
    trackingDb = null
  }
}
