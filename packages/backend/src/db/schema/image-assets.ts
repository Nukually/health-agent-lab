import { pgTable, uuid, varchar, integer, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core'
import { users } from './users.js'
import { messages } from './messages.js'

export const imageAssets = pgTable(
  'image_assets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id),
    purpose: varchar('purpose', { length: 40 }).notNull().default('chat'),
    originalKey: varchar('original_key', { length: 500 }).notNull(),
    modelKey: varchar('model_key', { length: 500 }).notNull(),
    thumbKey: varchar('thumb_key', { length: 500 }).notNull(),
    displayKey: varchar('display_key', { length: 500 }).notNull(),
    mimeType: varchar('mime_type', { length: 80 }).notNull(),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    bytes: integer('bytes').notNull(),
    sha256: varchar('sha256', { length: 64 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_image_assets_user_created').on(table.userId, table.createdAt),
    uniqueIndex('uniq_image_assets_user_hash_purpose').on(table.userId, table.sha256, table.purpose),
  ],
)

export const messageImageAttachments = pgTable(
  'message_image_attachments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    messageId: uuid('message_id').notNull().references(() => messages.id, { onDelete: 'cascade' }),
    assetId: uuid('asset_id').notNull().references(() => imageAssets.id),
    position: integer('position').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('uniq_message_image_attachments_message_position').on(table.messageId, table.position),
    index('idx_message_image_attachments_asset').on(table.assetId),
  ],
)
