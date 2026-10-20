import { pgTable, uuid, varchar, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core'
import { users } from './users.js'

/**
 * user_consents — 用户授权记录表
 *
 * consent_type:
 *   - login_agreement — 登录前的《用户协议》+《隐私政策》
 *   - health_profile  — 采集健康档案前的二次授权同意书
 *
 * version 对应前端 CONSENT_VERSIONS 常量。协议升级后 bump 版本即触发重新授权。
 * UNIQUE (user_id, consent_type, version) 保证同一用户对同一版本只记录一次。
 */
export const userConsents = pgTable(
  'user_consents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    consentType: varchar('consent_type', { length: 32 }).notNull(),
    version: varchar('version', { length: 16 }).notNull(),
    agreedAt: timestamp('agreed_at', { withTimezone: true }).notNull().defaultNow(),
    ipAddress: varchar('ip_address', { length: 64 }),
    userAgent: varchar('user_agent', { length: 500 }),
  },
  (t) => ({
    uniqUserTypeVer: uniqueIndex('uniq_user_consent_type_version').on(
      t.userId,
      t.consentType,
      t.version,
    ),
    idxUserType: index('idx_user_consents_user_type').on(t.userId, t.consentType),
  }),
)
