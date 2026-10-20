import dotenv from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: resolve(__dirname, '../../../../.env') })

import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { is } from 'drizzle-orm'
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core'
import postgres from 'postgres'
import * as schema from './schema/index.js'

/**
 * 从 Drizzle schema 自动导出期望的「表 -> 列集合」。
 * 作为部署冒烟的权威期望，避免手维护清单漂移。
 */
function expectedSchema(): Map<string, Set<string>> {
  const expected = new Map<string, Set<string>>()
  for (const value of Object.values(schema)) {
    if (!is(value, PgTable)) continue
    const config = getTableConfig(value)
    expected.set(config.name, new Set(config.columns.map((column) => column.name)))
  }
  return expected
}

async function main() {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    console.error('DATABASE_URL is required')
    process.exit(1)
  }

  const sql = postgres(connectionString, { max: 1 })

  // 连通性预检
  try {
    await sql`SELECT 1`
    console.log('Database connection OK')
  } catch (err) {
    console.error('Cannot connect to database:', (err as Error).message)
    process.exit(1)
  }

  const db = drizzle(sql)

  // 迁移前计数（Drizzle 把元数据表放在 drizzle schema 下）
  const beforeCount = await sql`
    SELECT count(*)::int as c FROM drizzle.__drizzle_migrations
  `.then(r => r[0].c).catch(() => 0)

  // 执行迁移（__dirname 相对路径，不依赖 CWD）
  const migrationsPath = resolve(__dirname, '../../drizzle')
  console.log('Running migrations...')
  await migrate(db, { migrationsFolder: migrationsPath })

  // 迁移后计数 + 报告
  const afterRows = await sql`
    SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at
  `
  const applied = afterRows.length - beforeCount
  if (applied > 0) {
    console.log(`Migrations complete: ${applied} new migration(s) applied`)
    for (const row of afterRows.slice(-applied)) {
      console.log(`  - ${row.hash}`)
    }
  } else {
    console.log('Migrations complete: database already up to date')
  }

  // Schema 验证 — 逐表逐列比对 Drizzle schema 与实际库结构。
  // 只查表存在性会漏掉「迁移被静默跳过导致漏列」（如 journal 顺序错乱），
  // 这里把缺表/缺列都视为部署失败，避免线上跑到该列才 500。
  const expected = expectedSchema()
  const columnRows = await sql`
    SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = 'public'
  `
  const actualColumns = new Map<string, Set<string>>()
  for (const row of columnRows) {
    const set = actualColumns.get(row.table_name) ?? new Set<string>()
    set.add(row.column_name)
    actualColumns.set(row.table_name, set)
  }

  const problems: string[] = []
  for (const [table, columns] of expected) {
    const actual = actualColumns.get(table)
    if (!actual) {
      problems.push(`缺表: ${table}`)
      continue
    }
    const missingColumns = [...columns].filter((column) => !actual.has(column))
    if (missingColumns.length > 0) {
      problems.push(`表 ${table} 缺列: ${missingColumns.join(', ')}`)
    }
  }
  if (problems.length > 0) {
    console.error('SCHEMA VALIDATION FAILED:')
    for (const problem of problems) console.error('  -', problem)
    process.exit(1)
  }
  console.log(`Schema validation passed (${expected.size} 张表，列已逐列校验)`)

  await sql.end()
}

main().catch((err) => {
  console.error('Migration failed:', err)
  process.exit(1)
})
