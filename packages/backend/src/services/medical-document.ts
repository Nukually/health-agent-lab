/**
 * Medical Document Service — 病历文档 CRUD
 */

import { and, eq, desc } from 'drizzle-orm'
import { getDb } from '../db/client.js'
import { medicalDocuments } from '../db/schema/index.js'
import { deleteMedicalFileKeys, signUrl } from '../lib/oss.js'
import type { MedicalDocument, DocumentMeta } from '@health-agent/shared'
import type { Logger } from '../lib/logger.js'

/**
 * Agent 内部扩展类型：额外带 base64 伴生对象 OSS key 数组（未签名，直接用 fetchBase64 读）。
 * 不进入 shared 类型，避免泄漏到前端 API。
 */
export interface MedicalDocumentWithBase64 extends MedicalDocument {
  base64Keys: string[]
}

export type DeleteDocumentImageResult =
  | { status: 'not_found' }
  | { status: 'invalid_image_index' }
  | { status: 'last_image' }
  | {
      status: 'deleted'
      document: MedicalDocument
      deletedImageKey: string
      deletedBase64Key: string | null
    }

function parseJsonArray(raw: string | null): string[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

/** 序列化数据库行为 API 响应格式，imageUrls 转签名 URL */
function serialize(row: typeof medicalDocuments.$inferSelect): MedicalDocument {
  const rawUrls: string[] = parseJsonArray(row.imageUrls)
  return {
    id: row.id,
    userId: row.userId,
    documentDate: row.documentDate,
    uploadedAt: row.uploadedAt.toISOString(),
    title: row.title,
    documentType: row.documentType as MedicalDocument['documentType'],
    hospital: row.hospital,
    ocrText: row.ocrText,
    imageUrls: rawUrls.map(signUrl),
    rawTextUrl: row.rawTextUrl ? signUrl(row.rawTextUrl) : null,
    pageCount: row.pageCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

/** agent 专用序列化：多带一份 base64 伴生对象 key */
function serializeWithBase64(row: typeof medicalDocuments.$inferSelect): MedicalDocumentWithBase64 {
  return {
    ...serialize(row),
    base64Keys: parseJsonArray(row.base64Urls),
  }
}

export async function createDocument(
  userId: string,
  data: {
    ocrText: string
    imageUrls: string[]
    /** base64 伴生对象 OSS key 数组，与 imageUrls 一一对应；为空数组表示该文档走旧管线（历史数据） */
    base64Urls: string[]
    rawTextUrl: string | null
    meta: DocumentMeta
  },
  logger: Logger,
): Promise<MedicalDocument> {
  const db = getDb()

  const [row] = await db
    .insert(medicalDocuments)
    .values({
      userId,
      documentDate: data.meta.documentDate,
      title: data.meta.title,
      documentType: data.meta.documentType,
      hospital: data.meta.hospital,
      ocrText: data.ocrText,
      imageUrls: JSON.stringify(data.imageUrls),
      base64Urls: data.base64Urls.length > 0 ? JSON.stringify(data.base64Urls) : null,
      rawTextUrl: data.rawTextUrl,
      pageCount: data.imageUrls.length,
    })
    .returning()

  logger.info({ docId: row.id, title: data.meta.title }, 'medical document created')
  return serialize(row)
}

export async function listDocuments(
  userId: string,
  logger: Logger,
): Promise<MedicalDocument[]> {
  const db = getDb()

  const rows = await db
    .select()
    .from(medicalDocuments)
    .where(eq(medicalDocuments.userId, userId))
    .orderBy(desc(medicalDocuments.documentDate), desc(medicalDocuments.uploadedAt))

  logger.debug({ count: rows.length }, 'listed medical documents')
  return rows.map(serialize)
}

export async function getDocument(
  userId: string,
  docId: string,
  logger: Logger,
): Promise<MedicalDocument | null> {
  const db = getDb()

  const row = await db.query.medicalDocuments.findFirst({
    where: (t, { and, eq: e }) => and(e(t.id, docId), e(t.userId, userId)),
  })

  if (!row) return null
  return serialize(row)
}

export async function deleteDocument(
  userId: string,
  docId: string,
  logger: Logger,
): Promise<MedicalDocument | null> {
  const db = getDb()

  const result = await db
    .delete(medicalDocuments)
    .where(and(eq(medicalDocuments.id, docId), eq(medicalDocuments.userId, userId)))
    .returning()

  const [row] = result
  if (!row) return null

  const imageKeys = parseJsonArray(row.imageUrls)
  const base64Keys = parseJsonArray(row.base64Urls)
  const objectKeys = [...imageKeys, ...base64Keys, row.rawTextUrl].filter((key): key is string => Boolean(key))
  if (objectKeys.length > 0) {
    try {
      const ossResult = await deleteMedicalFileKeys(objectKeys)
      if (ossResult.errors.length > 0) {
        logger.warn({ docId, errors: ossResult.errors.length }, 'medical document oss delete partially failed')
      }
    } catch (err: any) {
      logger.warn({ docId, err: err?.message }, 'medical document oss delete failed')
    }
  }

  logger.info({ docId }, 'medical document deleted')
  return serialize(row)
}

export async function deleteDocumentImage(
  userId: string,
  docId: string,
  imageIndex: number,
  logger: Logger,
): Promise<DeleteDocumentImageResult> {
  const db = getDb()
  const row = await db.query.medicalDocuments.findFirst({
    where: (t, { and, eq: e }) => and(e(t.id, docId), e(t.userId, userId)),
  })

  if (!row) return { status: 'not_found' }

  const imageKeys = parseJsonArray(row.imageUrls)
  const base64Keys = parseJsonArray(row.base64Urls)
  if (!Number.isInteger(imageIndex) || imageIndex < 0 || imageIndex >= imageKeys.length) {
    return { status: 'invalid_image_index' }
  }
  if (imageKeys.length <= 1) return { status: 'last_image' }

  const deletedImageKey = imageKeys[imageIndex]
  const deletedBase64Key = base64Keys[imageIndex] ?? null
  const nextImageKeys = imageKeys.filter((_, index) => index !== imageIndex)
  const nextBase64Keys = base64Keys.length > 0
    ? base64Keys.filter((_, index) => index !== imageIndex)
    : []

  const [updated] = await db
    .update(medicalDocuments)
    .set({
      imageUrls: JSON.stringify(nextImageKeys),
      base64Urls: nextBase64Keys.length > 0 ? JSON.stringify(nextBase64Keys) : null,
      pageCount: nextImageKeys.length,
      updatedAt: new Date(),
    })
    .where(and(eq(medicalDocuments.id, docId), eq(medicalDocuments.userId, userId)))
    .returning()

  if (!updated) return { status: 'not_found' }

  const objectKeys = [deletedImageKey, deletedBase64Key].filter((key): key is string => Boolean(key))
  if (objectKeys.length > 0) {
    try {
      const ossResult = await deleteMedicalFileKeys(objectKeys)
      if (ossResult.errors.length > 0) {
        logger.warn({ docId, imageIndex, errors: ossResult.errors.length }, 'medical document image oss delete partially failed')
      }
    } catch (err: any) {
      logger.warn({ docId, imageIndex, err: err?.message }, 'medical document image oss delete failed')
    }
  }

  logger.info({ docId, imageIndex, remaining: nextImageKeys.length }, 'medical document image deleted')
  return {
    status: 'deleted',
    document: serialize(updated),
    deletedImageKey,
    deletedBase64Key,
  }
}

/** Agent 工具用：按 ID 列表获取病历文档（带 base64 伴生 key） */
export async function getDocumentsByIds(
  userId: string,
  ids: string[],
  logger: Logger,
): Promise<MedicalDocumentWithBase64[]> {
  if (!ids.length) return []
  const db = getDb()

  const rows = await db
    .select()
    .from(medicalDocuments)
    .where(eq(medicalDocuments.userId, userId))
    .orderBy(desc(medicalDocuments.documentDate))

  // 只返回指定 ID 且属于该用户的文档
  const idSet = new Set(ids)
  const matched = rows.filter((r) => idSet.has(r.id))

  logger.info({ requested: ids.length, found: matched.length }, 'fetched medical docs by IDs')
  return matched.map(serializeWithBase64)
}

/**
 * Agent 工具用：按关键词搜索用户病历文档。
 * 新管线不再产完整 ocrText，关键词匹配改走 title / hospital / documentType 三字段。
 */
export async function searchDocuments(
  userId: string,
  opts: { query?: string; documentType?: string; limit?: number },
  logger: Logger,
): Promise<MedicalDocument[]> {
  const db = getDb()
  const limit = opts.limit || 5

  let rows = await db
    .select()
    .from(medicalDocuments)
    .where(eq(medicalDocuments.userId, userId))
    .orderBy(desc(medicalDocuments.documentDate), desc(medicalDocuments.uploadedAt))
    .limit(limit * 2) // 取多一些，后续过滤

  if (opts.documentType) {
    rows = rows.filter((r) => r.documentType === opts.documentType)
  }
  if (opts.query) {
    const q = opts.query.toLowerCase()
    rows = rows.filter(
      (r) =>
        r.title?.toLowerCase().includes(q) ||
        r.hospital?.toLowerCase().includes(q) ||
        r.documentType?.toLowerCase().includes(q),
    )
  }

  return rows.slice(0, limit).map(serialize)
}
