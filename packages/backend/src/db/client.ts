import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema/index.js'
import { rootLogger } from '../lib/logger.js'

const logger = rootLogger.child({ module: 'db' })

let db: ReturnType<typeof drizzle<typeof schema>> | null = null
let sql: ReturnType<typeof postgres> | null = null

export function getDb() {
  if (!db) {
    const connectionString = process.env.DATABASE_URL
    if (!connectionString) throw new Error('DATABASE_URL is required')

    sql = postgres(connectionString, { max: 10 })
    db = drizzle(sql, { schema })
    logger.info('database client initialized')
  }
  return db
}

export async function pingDb(): Promise<boolean> {
  if (!sql) getDb() // ensure initialized
  try {
    await sql!`SELECT 1`
    return true
  } catch {
    return false
  }
}

export async function closeDb(): Promise<void> {
  if (sql) {
    await sql.end()
    sql = null
    db = null
  }
}
