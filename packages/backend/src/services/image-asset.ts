import { createHash, randomUUID } from 'node:crypto'
import { and, asc, eq, inArray } from 'drizzle-orm'
import sharp from 'sharp'
import type { MessageImageAttachment } from '@health-agent/shared'
import { getDb } from '../db/client.js'
import { imageAssets, messageImageAttachments } from '../db/schema/index.js'
import {
  buildBase64Key,
  fetchBase64,
  signUrl,
  uploadBase64,
  uploadBuffer,
} from '../lib/oss.js'
import type { Logger } from '../lib/logger.js'

export type ImageAssetPurpose = 'chat' | 'medical'
export type ModelImageBlock = { type: 'image_url'; image_url: { url: string; detail: 'high' } }
export interface ModelImageBlockGroup {
  assetId: string
  imageBlocks: ModelImageBlock[]
}

type ImageAssetRow = typeof imageAssets.$inferSelect

const MAX_IMAGE_BYTES = 12 * 1024 * 1024
const THUMB_MAX_DIMENSION = 360
const DISPLAY_MAX_DIMENSION = 1600
const MODEL_MAX_DIMENSION = 4096
const MODEL_SLICE_TARGET_DIMENSION = 2048
const MODEL_SLICE_OVERLAP_RATIO = 0.1
const MODEL_SLICE_LONG_RATIO = 2
const MAX_MODEL_SLICES = 12

const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

function getImageMime(file: File): string | null {
  if (file.type && MIME_TO_EXT[file.type]) return file.type
  const lower = file.name.toLowerCase()
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.gif')) return 'image/gif'
  return null
}

function datePrefix() {
  return new Date().toISOString().slice(0, 10)
}

function toHashBytes(buffer: Buffer): Uint8Array {
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
}

function buildAssetKey(userId: string, variant: 'original' | 'model' | 'display' | 'thumb', ext: string): string {
  return `users/${userId}/images/${datePrefix()}/${randomUUID()}_${variant}.${ext}`
}

function buildModelSliceKey(modelKey: string, index: number, ext: string): string {
  return `${modelKey}.slice-${index + 1}.${ext}`
}

function serializeForClient(row: ImageAssetRow): MessageImageAttachment {
  return {
    assetId: row.id,
    thumbUrl: signUrl(row.thumbKey),
    displayUrl: signUrl(row.displayKey),
    originalUrl: signUrl(row.originalKey),
    width: row.width,
    height: row.height,
  }
}

async function renderJpegVariant(buffer: Buffer, maxDimension: number, quality: number) {
  return sharp(buffer, { limitInputPixels: false })
    .rotate()
    .resize({
      width: maxDimension,
      height: maxDimension,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality, mozjpeg: true })
    .toBuffer({ resolveWithObject: true })
}

async function renderOriginalVariant(buffer: Buffer, mimeType: string) {
  if (mimeType === 'image/png') {
    return {
      ext: 'png',
      contentType: 'image/png',
      ...(await sharp(buffer, { limitInputPixels: false })
        .rotate()
        .png({ compressionLevel: 9 })
        .toBuffer({ resolveWithObject: true })),
    }
  }
  if (mimeType === 'image/webp') {
    return {
      ext: 'webp',
      contentType: 'image/webp',
      ...(await sharp(buffer, { limitInputPixels: false })
        .rotate()
        .webp({ quality: 100 })
        .toBuffer({ resolveWithObject: true })),
    }
  }
  if (mimeType === 'image/gif') {
    return {
      ext: 'gif',
      contentType: 'image/gif',
      data: buffer,
      info: await sharp(buffer, { limitInputPixels: false }).metadata(),
    }
  }
  return {
    ext: 'jpg',
    contentType: 'image/jpeg',
    ...(await sharp(buffer, { limitInputPixels: false })
      .rotate()
      .jpeg({ quality: 100, mozjpeg: true })
      .toBuffer({ resolveWithObject: true })),
  }
}

async function renderModelVariant(buffer: Buffer, mimeType: string) {
  const base = sharp(buffer, { limitInputPixels: false })
    .rotate()
    .resize({
      width: MODEL_MAX_DIMENSION,
      height: MODEL_MAX_DIMENSION,
      fit: 'inside',
      withoutEnlargement: true,
    })

  if (mimeType === 'image/png' || mimeType === 'image/webp') {
    return {
      ext: 'png',
      contentType: 'image/png',
      ...(await base.png({ compressionLevel: 9 }).toBuffer({ resolveWithObject: true })),
    }
  }

  return {
    ext: 'jpg',
    contentType: 'image/jpeg',
    ...(await base.jpeg({ quality: 92, mozjpeg: true }).toBuffer({ resolveWithObject: true })),
  }
}

function getModelSlicePlan(width: number, height: number): Array<{ left: number; top: number; width: number; height: number }> {
  if (!width || !height) return []
  const longSide = Math.max(width, height)
  const shortSide = Math.min(width, height)
  if (longSide <= MODEL_SLICE_TARGET_DIMENSION || longSide / shortSide < MODEL_SLICE_LONG_RATIO) {
    return []
  }

  const alongHeight = height >= width
  const overlap = Math.max(1, Math.round(MODEL_SLICE_TARGET_DIMENSION * MODEL_SLICE_OVERLAP_RATIO))
  const step = MODEL_SLICE_TARGET_DIMENSION - overlap
  const slices: Array<{ left: number; top: number; width: number; height: number }> = []
  let start = 0

  while (start < longSide) {
    let end = Math.min(start + MODEL_SLICE_TARGET_DIMENSION, longSide)
    if (longSide - end > 0 && longSide - end < MODEL_SLICE_TARGET_DIMENSION * 0.25) {
      end = longSide
    }
    const size = end - start
    slices.push(alongHeight
      ? { left: 0, top: start, width, height: size }
      : { left: start, top: 0, width: size, height })
    if (end >= longSide) break
    start = end - overlap
  }

  if (slices.length > MAX_MODEL_SLICES) {
    throw Object.assign(new Error('图片过长，请拆分成多张后上传'), { status: 400 })
  }
  return slices
}

async function renderModelSliceVariants(
  buffer: Buffer,
  width: number,
  height: number,
  preferPng: boolean,
) {
  const slices = getModelSlicePlan(width, height)
  if (slices.length <= 1) return []

  return Promise.all(slices.map(async (slice) => {
    const pipeline = sharp(buffer, { limitInputPixels: false })
      .extract(slice)
      .resize({
        width: MODEL_MAX_DIMENSION,
        height: MODEL_MAX_DIMENSION,
        fit: 'inside',
        withoutEnlargement: true,
      })

    if (preferPng) {
      return {
        ext: 'png',
        contentType: 'image/png',
        ...(await pipeline.png({ compressionLevel: 9 }).toBuffer({ resolveWithObject: true })),
      }
    }
    return {
      ext: 'jpg',
      contentType: 'image/jpeg',
      ...(await pipeline.jpeg({ quality: 92, mozjpeg: true }).toBuffer({ resolveWithObject: true })),
    }
  }))
}

function modelKeysForAsset(row: ImageAssetRow): Array<{ key: string; mimeType: string }> {
  const slicePlan = getModelSlicePlan(row.width, row.height)
  if (slicePlan.length <= 1) {
    return [{
      key: row.modelKey,
      mimeType: row.modelKey.endsWith('.png') ? 'image/png' : 'image/jpeg',
    }]
  }
  const ext = row.modelKey.endsWith('.png') ? 'png' : 'jpg'
  const mimeType = ext === 'png' ? 'image/png' : 'image/jpeg'
  return slicePlan.map((_, index) => ({ key: buildModelSliceKey(row.modelKey, index, ext), mimeType }))
}

export async function createImageAssetFromFile(
  userId: string,
  file: File,
  purpose: ImageAssetPurpose,
  logger: Logger,
): Promise<MessageImageAttachment> {
  const mimeType = getImageMime(file)
  if (!mimeType) throw Object.assign(new Error('仅支持 JPG、PNG、WebP 或 GIF 图片'), { status: 400 })
  if (file.size <= 0) throw Object.assign(new Error('图片文件为空'), { status: 400 })
  if (file.size > MAX_IMAGE_BYTES) throw Object.assign(new Error('单张图片不能超过 12MB'), { status: 400 })

  const buffer = Buffer.from(await file.arrayBuffer())
  return createImageAssetFromBuffer(userId, buffer, mimeType, purpose, logger)
}

export async function createImageAssetFromBuffer(
  userId: string,
  buffer: Buffer,
  mimeType: string,
  purpose: ImageAssetPurpose,
  logger: Logger,
): Promise<MessageImageAttachment> {
  const db = getDb()
  const sha256 = createHash('sha256').update(toHashBytes(buffer)).digest('hex')
  const existing = await db.query.imageAssets.findFirst({
    where: (t, { and: a, eq: e }) => a(e(t.userId, userId), e(t.sha256, sha256), e(t.purpose, purpose)),
  })
  if (existing) return serializeForClient(existing)

  const [original, model, display, thumb] = await Promise.all([
    renderOriginalVariant(buffer, mimeType),
    renderModelVariant(buffer, mimeType),
    renderJpegVariant(buffer, DISPLAY_MAX_DIMENSION, 86),
    renderJpegVariant(buffer, THUMB_MAX_DIMENSION, 72),
  ])

  const originalKey = buildAssetKey(userId, 'original', original.ext)
  const modelKey = buildAssetKey(userId, 'model', model.ext)
  const displayKey = buildAssetKey(userId, 'display', 'jpg')
  const thumbKey = buildAssetKey(userId, 'thumb', 'jpg')
  const originalWidth = original.info.width ?? model.info.width
  const originalHeight = original.info.height ?? model.info.height
  const modelSlices = await renderModelSliceVariants(
    original.data,
    originalWidth,
    originalHeight,
    model.contentType === 'image/png',
  )

  await Promise.all([
    uploadBuffer(originalKey, original.data, original.contentType),
    uploadBuffer(modelKey, model.data, model.contentType),
    uploadBuffer(displayKey, display.data, 'image/jpeg'),
    uploadBuffer(thumbKey, thumb.data, 'image/jpeg'),
    uploadBase64(buildBase64Key(modelKey), model.data.toString('base64')),
    ...modelSlices.flatMap((slice, index) => {
      const key = buildModelSliceKey(modelKey, index, slice.ext)
      return [
        uploadBuffer(key, slice.data, slice.contentType),
        uploadBase64(buildBase64Key(key), slice.data.toString('base64')),
      ]
    }),
  ])

  const [row] = await db.insert(imageAssets).values({
    userId,
    purpose,
    originalKey,
    modelKey,
    thumbKey,
    displayKey,
    mimeType,
    width: originalWidth,
    height: originalHeight,
    bytes: buffer.length,
    sha256,
  }).returning()

  logger.info(
    {
      assetId: row.id,
      purpose,
      width: row.width,
      height: row.height,
      bytes: row.bytes,
      modelSlices: Math.max(1, modelSlices.length),
      shaPrefix: sha256.slice(0, 12),
    },
    'image asset created',
  )
  return serializeForClient(row)
}

export async function getImageAssetsForUser(
  userId: string,
  assetIds: string[],
): Promise<ImageAssetRow[]> {
  if (!assetIds.length) return []
  const db = getDb()
  const rows = await db.query.imageAssets.findMany({
    where: and(
      eq(imageAssets.userId, userId),
      inArray(imageAssets.id, Array.from(new Set(assetIds))),
    ),
  })
  const byId = new Map(rows.map((row) => [row.id, row]))
  return assetIds.map((id) => byId.get(id)).filter((row): row is ImageAssetRow => !!row)
}

export async function getModelImageBlockGroupsForAssetIds(
  userId: string,
  assetIds: string[],
): Promise<ModelImageBlockGroup[]> {
  const rows = await getImageAssetsForUser(userId, assetIds)
  if (rows.length !== assetIds.length) {
    throw Object.assign(new Error('图片不存在或无权访问'), { status: 404 })
  }
  return Promise.all(rows.map(async (row) => {
    const keyedRows = modelKeysForAsset(row)
    const base64s = await Promise.all(keyedRows.map((item) => fetchBase64(buildBase64Key(item.key))))
    return {
      assetId: row.id,
      imageBlocks: keyedRows.map((item, index) => ({
        type: 'image_url' as const,
        image_url: {
          url: `data:${item.mimeType};base64,${base64s[index]}`,
          detail: 'high' as const,
        },
      })),
    }
  }))
}

export async function getModelImageBlocksForAssetIds(
  userId: string,
  assetIds: string[],
): Promise<ModelImageBlock[]> {
  const groups = await getModelImageBlockGroupsForAssetIds(userId, assetIds)
  return groups.flatMap((group) => group.imageBlocks)
}

export async function attachImageAssetsToMessage(
  userId: string,
  messageId: string,
  assetIds: string[],
): Promise<void> {
  if (!assetIds.length) return
  const rows = await getImageAssetsForUser(userId, assetIds)
  if (rows.length !== assetIds.length) {
    throw Object.assign(new Error('图片不存在或无权访问'), { status: 404 })
  }

  const db = getDb()
  await db.insert(messageImageAttachments).values(
    assetIds.map((assetId, position) => ({
      messageId,
      assetId,
      position,
    })),
  )
}

export async function replaceMessageImageAssets(
  userId: string,
  messageId: string,
  assetIds: string[],
): Promise<void> {
  const db = getDb()
  await db.transaction(async (tx) => {
    await tx.delete(messageImageAttachments).where(eq(messageImageAttachments.messageId, messageId))
    if (!assetIds.length) return

    const rows = await tx.query.imageAssets.findMany({
      where: and(
        eq(imageAssets.userId, userId),
        inArray(imageAssets.id, Array.from(new Set(assetIds))),
      ),
    })
    if (rows.length !== new Set(assetIds).size) {
      throw Object.assign(new Error('图片不存在或无权访问'), { status: 404 })
    }
    await tx.insert(messageImageAttachments).values(
      assetIds.map((assetId, position) => ({ messageId, assetId, position })),
    )
  })
}

export async function getClientImageAttachmentsForMessages(
  messageIds: string[],
): Promise<Map<string, MessageImageAttachment[]>> {
  if (!messageIds.length) return new Map()
  const db = getDb()
  const rows = await db
    .select({
      messageId: messageImageAttachments.messageId,
      position: messageImageAttachments.position,
      asset: imageAssets,
    })
    .from(messageImageAttachments)
    .innerJoin(imageAssets, eq(messageImageAttachments.assetId, imageAssets.id))
    .where(inArray(messageImageAttachments.messageId, messageIds))
    .orderBy(asc(messageImageAttachments.position))

  const map = new Map<string, MessageImageAttachment[]>()
  for (const row of rows) {
    const list = map.get(row.messageId) ?? []
    list.push(serializeForClient(row.asset))
    map.set(row.messageId, list)
  }
  return map
}

export async function getModelImageBlocksForMessages(
  messageIds: string[],
): Promise<Map<string, Array<{ type: 'image_url'; image_url: { url: string; detail: 'high' } }>>> {
  if (!messageIds.length) return new Map()
  const db = getDb()
  const rows = await db
    .select({
      messageId: messageImageAttachments.messageId,
      position: messageImageAttachments.position,
      asset: imageAssets,
    })
    .from(messageImageAttachments)
    .innerJoin(imageAssets, eq(messageImageAttachments.assetId, imageAssets.id))
    .where(inArray(messageImageAttachments.messageId, messageIds))
    .orderBy(asc(messageImageAttachments.position))

  const map = new Map<string, Array<{ type: 'image_url'; image_url: { url: string; detail: 'high' } }>>()
  for (const row of rows) {
    const list = map.get(row.messageId) ?? []
    const modelKeys = modelKeysForAsset(row.asset)
    const base64s = await Promise.all(modelKeys.map((item) => fetchBase64(buildBase64Key(item.key))))
    modelKeys.forEach((item, index) => {
      list.push({
        type: 'image_url',
        image_url: {
          url: `data:${item.mimeType};base64,${base64s[index]}`,
          detail: 'high',
        },
      })
    })
    map.set(row.messageId, list)
  }
  return map
}

export async function getModelDataImageUrlsForMessage(messageId: string): Promise<string[]> {
  const blocks = await getModelImageBlocksForMessages([messageId])
  return (blocks.get(messageId) ?? []).map((block) => block.image_url.url)
}

export async function getImageAssetIdsForMessage(messageId: string): Promise<string[]> {
  const db = getDb()
  const rows = await db.query.messageImageAttachments.findMany({
    where: eq(messageImageAttachments.messageId, messageId),
    orderBy: asc(messageImageAttachments.position),
    columns: { assetId: true },
  })
  return rows.map((row) => row.assetId)
}
