import { pgTable, uuid, text, varchar, date, integer, timestamp, index } from 'drizzle-orm/pg-core'
import { users } from './users.js'

export const medicalDocuments = pgTable(
  'medical_documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id),
    // 时间
    documentDate: date('document_date'), // OCR 提取的就诊/检查日期
    uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull().defaultNow(),
    // 内容
    title: varchar('title', { length: 200 }),
    documentType: varchar('document_type', { length: 50 }), // outpatient|pathology|imaging|discharge|lab|other
    hospital: varchar('hospital', { length: 200 }),
    ocrText: text('ocr_text').notNull(),
    // 存储 — image_urls 用 JSON 数组（Drizzle 对 text[] 支持较弱，用 jsonb 更可靠）
    imageUrls: text('image_urls').notNull(), // JSON stringified string[]
    // base64 伴生对象 OSS key 数组（每项对应 imageUrls 同索引图片的 .b64 伴生文件）。
    // 用于 saved_content 工具把原图以 base64 形式注入 LLM，避免 OCR 转录错误传递。
    // Nullable：历史文档（本列加入前）为空，运行时优雅降级回 imageUrls 签名 URL。
    base64Urls: text('base64_urls'), // JSON stringified string[] | null
    rawTextUrl: varchar('raw_text_url', { length: 500 }),
    // 元数据
    pageCount: integer('page_count').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_medical_documents_user_date').on(table.userId, table.documentDate),
  ],
)
