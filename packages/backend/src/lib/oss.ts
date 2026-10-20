/**
 * OSS Client — 进程级单例
 *
 * 阿里云 OSS 文件存储。用于病历图片和 OCR 文本的持久化。
 * OSS 四个环境变量全部配置时才初始化，否则返回 null（优雅降级）。
 */

import OSS from 'ali-oss'
import { randomUUID } from 'node:crypto'
import { getEnv } from '../env.js'
import { rootLogger } from './logger.js'

const logger = rootLogger.child({ module: 'oss' })

let _client: OSS | null | undefined // undefined = 未初始化
const _bucketClients = new Map<string, OSS>()

function getKeyPrefix(): string {
  const raw = getEnv().OSS_KEY_PREFIX?.trim()
  if (!raw) return ''
  const normalized = raw.replace(/^\/+|\/+$/g, '')
  return normalized ? `${normalized}/` : ''
}

function toPhysicalKey(key: string): string {
  const normalized = key.replace(/^\/+/, '')
  const prefix = getKeyPrefix()
  if (!prefix || normalized.startsWith(prefix)) return normalized
  return `${prefix}${normalized}`
}

function toLogicalKey(key: string): string {
  const normalized = key.replace(/^\/+/, '')
  const prefix = getKeyPrefix()
  return prefix && normalized.startsWith(prefix)
    ? normalized.slice(prefix.length)
    : normalized
}

function initClient(): OSS | null {
  const env = getEnv()
  const { OSS_ACCESS_KEY_ID, OSS_ACCESS_KEY_SECRET, OSS_BUCKET, OSS_ENDPOINT } = env

  if (!OSS_ACCESS_KEY_ID || !OSS_ACCESS_KEY_SECRET || !OSS_BUCKET || !OSS_ENDPOINT) {
    logger.warn('OSS not configured — file upload disabled')
    return null
  }

  const client = new OSS({
    accessKeyId: OSS_ACCESS_KEY_ID,
    accessKeySecret: OSS_ACCESS_KEY_SECRET,
    bucket: OSS_BUCKET,
    endpoint: OSS_ENDPOINT,
  })

  logger.info({ bucket: OSS_BUCKET, endpoint: OSS_ENDPOINT }, 'OSS client initialized')
  return client
}

function resolveCredentialsForBucket(bucket: string): { id?: string; secret?: string } {
  const env = getEnv()
  if (bucket && env.OSS_BUCKET_SIT && bucket === env.OSS_BUCKET_SIT && env.OSS_ACCESS_KEY_ID_SIT && env.OSS_ACCESS_KEY_SECRET_SIT) {
    return { id: env.OSS_ACCESS_KEY_ID_SIT, secret: env.OSS_ACCESS_KEY_SECRET_SIT }
  }
  if (bucket && env.OSS_BUCKET_PROD && bucket === env.OSS_BUCKET_PROD && env.OSS_ACCESS_KEY_ID_PROD && env.OSS_ACCESS_KEY_SECRET_PROD) {
    return { id: env.OSS_ACCESS_KEY_ID_PROD, secret: env.OSS_ACCESS_KEY_SECRET_PROD }
  }
  return { id: env.OSS_ACCESS_KEY_ID, secret: env.OSS_ACCESS_KEY_SECRET }
}

function createClientForBucket(bucket: string): OSS | null {
  const env = getEnv()
  const { OSS_ENDPOINT } = env
  const { id, secret } = resolveCredentialsForBucket(bucket)

  if (!id || !secret || !OSS_ENDPOINT) {
    logger.warn({ bucket }, 'OSS not configured — bucket client unavailable')
    return null
  }

  return new OSS({
    accessKeyId: id,
    accessKeySecret: secret,
    bucket,
    endpoint: OSS_ENDPOINT,
  })
}

export function getOSSClient(): OSS | null {
  if (_client === undefined) {
    _client = initClient()
  }
  return _client
}

export function getOSSClientForBucket(bucket: string): OSS | null {
  if (!bucket) return null
  const existing = _bucketClients.get(bucket)
  if (existing) return existing
  const client = createClientForBucket(bucket)
  if (!client) return null
  _bucketClients.set(bucket, client)
  return client
}

/** 上传 Buffer 到 OSS，返回 object key（非完整 URL） */
export async function uploadBuffer(
  key: string,
  buffer: Buffer,
  contentType: string,
): Promise<string> {
  const client = getOSSClient()
  if (!client) throw new Error('OSS not configured')

  const physicalKey = toPhysicalKey(key)
  const start = performance.now()
  try {
    await client.put(physicalKey, buffer, {
      headers: { 'Content-Type': contentType },
    })
    logger.info(
      { key, sizeBytes: buffer.length, contentType, durationMs: Math.round(performance.now() - start) },
      'oss upload completed',
    )
    return key
  } catch (err) {
    logger.error(
      { err, key, sizeBytes: buffer.length, contentType, durationMs: Math.round(performance.now() - start) },
      'oss upload failed',
    )
    throw err
  }
}

export async function uploadBufferToBucket(
  bucket: string,
  key: string,
  buffer: Buffer,
  contentType: string,
): Promise<string> {
  const client = getOSSClientForBucket(bucket)
  if (!client) throw new Error('OSS not configured')

  const physicalKey = toPhysicalKey(key)
  const start = performance.now()
  try {
    await client.put(physicalKey, buffer, {
      headers: { 'Content-Type': contentType },
    })
    logger.info(
      {
        bucket,
        key,
        sizeBytes: buffer.length,
        contentType,
        durationMs: Math.round(performance.now() - start),
      },
      'oss upload completed',
    )
    return key
  } catch (err) {
    logger.error(
      {
        err,
        bucket,
        key,
        sizeBytes: buffer.length,
        contentType,
        durationMs: Math.round(performance.now() - start),
      },
      'oss upload failed',
    )
    throw err
  }
}

/** 将 OSS object key 转为签名 URL（1 小时有效） */
export function signUrl(key: string, expiresSeconds = 3600): string {
  const client = getOSSClient()
  if (!client) return key

  // 兼容历史数据：如果存的是完整 URL，提取 key 部分
  if (key.startsWith('http')) {
    try {
      const url = new URL(key)
      key = url.pathname.slice(1) // 去掉前导 /
    } catch {
      return key
    }
  }

  const url = client.signatureUrl(toPhysicalKey(key), { expires: expiresSeconds })
  // 内网 endpoint 浏览器不可访问，替换为公网
  return url.replace('-internal.aliyuncs.com', '.aliyuncs.com')
}

export function signUrlForBucket(bucket: string, key: string): string {
  const client = getOSSClientForBucket(bucket)
  if (!client) return key

  if (key.startsWith('http')) {
    try {
      const url = new URL(key)
      key = url.pathname.slice(1)
    } catch {
      return key
    }
  }

  const url = client.signatureUrl(toPhysicalKey(key), { expires: 3600 })
  return url.replace('-internal.aliyuncs.com', '.aliyuncs.com')
}

export async function fetchBufferFromBucket(bucket: string, key: string): Promise<Buffer> {
  const client = getOSSClientForBucket(bucket)
  if (!client) throw new Error('OSS not configured')

  const physicalKey = toPhysicalKey(key)
  const start = performance.now()
  try {
    const res = await client.get(physicalKey)
    const content = res.content as Buffer | Uint8Array | string
    const buffer = Buffer.isBuffer(content)
      ? content
      : typeof content === 'string'
        ? Buffer.from(content)
        : Buffer.from(content)
    logger.debug(
      { bucket, key, sizeBytes: buffer.length, durationMs: Math.round(performance.now() - start) },
      'oss buffer fetch completed',
    )
    return buffer
  } catch (err) {
    logger.error(
      { err, bucket, key, durationMs: Math.round(performance.now() - start) },
      'oss buffer fetch failed',
    )
    throw err
  }
}

export async function listObjectKeysFromBucket(
  bucket: string,
  prefix: string,
): Promise<string[]> {
  const client = getOSSClientForBucket(bucket)
  if (!client) throw new Error('OSS not configured')

  const physicalPrefix = toPhysicalKey(prefix)
  const keys: string[] = []
  let marker: string | undefined

  while (true) {
    const list: any = await client.list(
      { prefix: physicalPrefix, marker, 'max-keys': 1000 } as any,
      {},
    )
    const pageKeys: string[] = (list.objects || []).map((object: any) => toLogicalKey(object.name))
    keys.push(...pageKeys)

    if (!list.isTruncated) break
    marker = list.nextMarker
  }

  logger.debug({ bucket, prefix, count: keys.length }, 'oss object list completed')
  return keys
}

export async function deleteObjectsFromBucket(
  bucket: string,
  keys: string[],
): Promise<{ deleted: number; errors: string[] }> {
  const client = getOSSClientForBucket(bucket)
  if (!client) throw new Error('OSS not configured')

  const normalizedKeys = Array.from(new Set(keys.filter(Boolean)))
  const errors: string[] = []
  let deleted = 0

  for (let index = 0; index < normalizedKeys.length; index += 1000) {
    const batch = normalizedKeys.slice(index, index + 1000).map(toPhysicalKey)
    if (batch.length === 0) continue

    try {
      await client.deleteMulti(batch, { quiet: true })
      deleted += batch.length
    } catch (err: any) {
      errors.push(err?.message || String(err))
    }
  }

  logger.info({ bucket, deleted, errors: errors.length }, 'oss object delete completed')
  return { deleted, errors }
}

export async function deleteMedicalFileKeys(
  keys: string[],
): Promise<{ deleted: number; errors: string[] }> {
  const client = getOSSClient()
  if (!client) return { deleted: 0, errors: ['OSS not configured'] }

  const normalizedKeys = Array.from(new Set(keys.filter(Boolean)))
  const errors: string[] = []
  let deleted = 0

  for (let index = 0; index < normalizedKeys.length; index += 1000) {
    const batch = normalizedKeys.slice(index, index + 1000).map(toPhysicalKey)
    if (batch.length === 0) continue

    try {
      await client.deleteMulti(batch, { quiet: true })
      deleted += batch.length
    } catch (err: any) {
      errors.push(err?.message || String(err))
    }
  }

  logger.info({ deleted, errors: errors.length }, 'oss medical object delete completed')
  return { deleted, errors }
}

/**
 * 批量删除指定用户病历目录下所有对象（图片、OCR 文本）。
 * OSS list 单页 1000 条，循环翻页。失败不抛出，返回已删除数 + 错误。
 */
export async function deleteUserMedicalFiles(
  userId: string,
): Promise<{ deleted: number; errors: string[] }> {
  const client = getOSSClient()
  if (!client) return { deleted: 0, errors: ['OSS not configured'] }

  const prefix = toPhysicalKey(`users/${userId}/medical/`)
  const errors: string[] = []
  let deleted = 0
  let marker: string | undefined

  while (true) {
    const list: any = await client.list(
      { prefix, marker, 'max-keys': 1000 } as any,
      {},
    )
    const keys: string[] = (list.objects || []).map((o: any) => o.name)
    if (keys.length === 0) break

    try {
      await client.deleteMulti(keys, { quiet: true })
      deleted += keys.length
    } catch (err: any) {
      errors.push(err.message || String(err))
    }

    if (!list.isTruncated) break
    marker = list.nextMarker
  }

  logger.info({ userId, deleted, errors: errors.length }, 'oss medical files purged')
  return { deleted, errors }
}

/** 构建用户病历图片的 OSS key */
export function buildImageKey(userId: string, ext: string = 'jpg'): string {
  const date = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
  return `users/${userId}/medical/${date}/${randomUUID()}.${ext}`
}

/** 构建用户 OCR 文本的 OSS key */
export function buildOcrTextKey(userId: string): string {
  const date = new Date().toISOString().slice(0, 10)
  return `users/${userId}/medical/${date}/${randomUUID()}_ocr.txt`
}

/**
 * 由原始图片 OSS key 派生 base64 伴生对象 key。
 * 同目录、同文件名，仅扩展名追加 .b64（例如 xxx.jpg → xxx.jpg.b64）。
 */
export function buildBase64Key(imageKey: string): string {
  return `${imageKey}.b64`
}

/**
 * 上传 base64 字符串到 OSS（text/plain）。
 * 用于 saved_content 工具按需发图 —— 把图片 base64 固化成伴生对象，
 * 拉回时省去原图 → buffer → base64 的转码开销。
 */
export async function uploadBase64(key: string, base64: string): Promise<string> {
  const client = getOSSClient()
  if (!client) throw new Error('OSS not configured')

  const start = performance.now()
  const physicalKey = toPhysicalKey(key)
  const buffer = Buffer.from(base64, 'utf-8')
  try {
    await client.put(physicalKey, buffer, {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    })
    logger.info(
      { key, base64Length: base64.length, durationMs: Math.round(performance.now() - start) },
      'oss base64 upload completed',
    )
    return key
  } catch (err) {
    logger.error(
      { err, key, base64Length: base64.length, durationMs: Math.round(performance.now() - start) },
      'oss base64 upload failed',
    )
    throw err
  }
}

/** 从 OSS 拉取 base64 伴生对象内容 */
export async function fetchBase64(key: string): Promise<string> {
  const client = getOSSClient()
  if (!client) throw new Error('OSS not configured')

  const physicalKey = toPhysicalKey(key)
  const start = performance.now()
  try {
    const res = await client.get(physicalKey)
    const content = (res.content as Buffer).toString('utf-8')
    logger.debug(
      { key, base64Length: content.length, durationMs: Math.round(performance.now() - start) },
      'oss base64 fetch completed',
    )
    return content
  } catch (err) {
    logger.error(
      { err, key, durationMs: Math.round(performance.now() - start) },
      'oss base64 fetch failed',
    )
    throw err
  }
}
