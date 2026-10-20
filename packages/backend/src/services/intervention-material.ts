import { randomUUID } from 'node:crypto'
import {
  type InterventionAssetInput,
  type InterventionAssetRef,
  type InterventionMaterialBulkPromoteFailure,
  type InterventionMaterialBulkPromoteResponse,
  type InterventionMaterialBulkPromoteSuccess,
  type InterventionMaterialListItem,
  type InterventionMaterialPromoteRequest,
  type InterventionMaterialRecord,
  type InterventionMaterialSaveRequest,
  type InterventionMaterialStep,
} from '@health-agent/shared'
import { getEnv } from '../env.js'
import {
  deleteObjectsFromBucket,
  fetchBufferFromBucket,
  listObjectKeysFromBucket,
  signUrlForBucket,
  uploadBufferToBucket,
} from '../lib/oss.js'
import { getTTSProvider } from '../providers/factory.js'
import type { Logger } from '../lib/logger.js'

const CATALOG_KEY = 'interventions/catalog/index.json'

type PromoteTargetEnv = InterventionMaterialPromoteRequest['targetEnv']

export function resolveInterventionBucketEnv(
  deployEnv: ReturnType<typeof getEnv>['DEPLOY_ENV'],
): 'dev' | 'sit' | 'prod' {
  if (deployEnv === 'sit') return 'sit'
  if (deployEnv === 'prod') return 'prod'
  return 'dev'
}

function getBucketName(targetEnv: 'dev' | 'sit' | 'prod'): string {
  const env = getEnv()
  const localBucket = env.DEPLOY_ENV === targetEnv ? env.OSS_BUCKET : undefined
  if (targetEnv === 'dev') {
    return env.OSS_BUCKET_DEV ?? localBucket ?? env.OSS_BUCKET ?? ''
  }
  if (targetEnv === 'sit') {
    return env.OSS_BUCKET_SIT ?? localBucket ?? ''
  }
  return env.OSS_BUCKET_PROD ?? localBucket ?? ''
}

export function assertInterventionBucketName(targetEnv: 'dev' | 'sit' | 'prod'): string {
  const bucket = getBucketName(targetEnv)
  if (!bucket) {
    throw new Error(`${targetEnv} bucket not configured`)
  }
  return bucket
}

function isObjectNotFound(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const anyErr = err as { status?: number; code?: string; name?: string }
  return anyErr.status === 404
    || anyErr.code === 'NoSuchKey'
    || anyErr.code === 'NotFound'
    || anyErr.name === 'NoSuchKeyError'
}

async function readJsonFromBucket<T>(
  bucket: string,
  key: string,
  logger: Logger,
): Promise<T | null> {
  try {
    const buffer = await fetchBufferFromBucket(bucket, key)
    return JSON.parse(buffer.toString('utf-8')) as T
  } catch (err) {
    if (isObjectNotFound(err)) return null
    logger.error({ err, bucket, key }, 'failed to read JSON from OSS')
    throw err
  }
}

async function writeJsonToBucket(
  bucket: string,
  key: string,
  payload: unknown,
): Promise<void> {
  const buffer = Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, 'utf-8')
  await uploadBufferToBucket(bucket, key, buffer, 'application/json; charset=utf-8')
}

function materialPrefix(materialId: string, version: string): string {
  return `interventions/materials/${materialId}/${version}`
}

function manifestKey(materialId: string, version: string): string {
  return `${materialPrefix(materialId, version)}/manifest.json`
}

function referencedMaterialKeys(material: InterventionMaterialRecord): string[] {
  return [
    manifestKey(material.materialId, material.version),
    material.overviewAsset.key,
    ...material.steps.flatMap((step) => [step.imageAsset.key, step.audioAsset.key]),
  ]
}

async function rollbackCreatedKeys(
  bucket: string,
  keys: string[],
  logger: Logger,
): Promise<void> {
  if (keys.length === 0) return

  const result = await deleteObjectsFromBucket(bucket, keys)
  if (result.errors.length > 0) {
    logger.error(
      { bucket, keys, errors: result.errors },
      'failed to rollback intervention material objects',
    )
    return
  }

  logger.warn({ bucket, deleted: result.deleted }, 'rolled back intervention material objects')
}

async function pruneOrphanedInterventionObjects(
  bucket: string,
  catalog: InterventionMaterialRecord[],
  logger: Logger,
): Promise<void> {
  const existingKeys = await listObjectKeysFromBucket(bucket, 'interventions/materials/')
  const referencedKeys = new Set(catalog.flatMap((item) => referencedMaterialKeys(item)))
  const orphanedKeys = existingKeys.filter((key) => !referencedKeys.has(key))

  if (orphanedKeys.length === 0) return

  const result = await deleteObjectsFromBucket(bucket, orphanedKeys)
  if (result.errors.length > 0) {
    throw new Error(`failed to delete orphaned intervention objects: ${result.errors.join('; ')}`)
  }

  logger.info(
    { bucket, deleted: result.deleted },
    'deleted orphaned intervention material objects',
  )
}

function normalizeStringArray(values: string[]): string[] {
  return values.map((value) => value.trim()).filter(Boolean)
}

function slugifyMaterialIdPart(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

function buildMaterialIdFallback(): string {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
  return `material_${stamp}_${randomUUID().slice(0, 6)}`
}

function generateMaterialId(
  catalog: InterventionMaterialRecord[],
  input: InterventionMaterialSaveRequest,
): string {
  const base = [
    slugifyMaterialIdPart(input.sideEffect),
    slugifyMaterialIdPart(input.scene),
    slugifyMaterialIdPart(input.actionName),
  ]
    .filter(Boolean)
    .join('_')
    .slice(0, 80) || buildMaterialIdFallback()

  const occupied = new Set(catalog.map((item) => item.materialId))
  if (!occupied.has(base)) return base

  let counter = 2
  while (occupied.has(`${base}_${counter}`)) {
    counter += 1
  }
  return `${base}_${counter}`
}

function parseImageDataUrl(
  dataUrl: string,
): { buffer: Buffer; contentType: string; ext: string } {
  const match = dataUrl.match(/^data:(image\/([\w+.-]+));base64,(.+)$/)
  if (!match) throw new Error('Invalid image data URL')
  const ext = match[2].toLowerCase() === 'jpeg' ? 'jpg' : match[2].toLowerCase()
  return {
    buffer: Buffer.from(match[3], 'base64'),
    contentType: match[1],
    ext,
  }
}

function extFromAssetKey(key: string, fallbackExt: string): string {
  const match = key.match(/\.([a-zA-Z0-9]+)$/)
  return match?.[1] || fallbackExt
}

function buildOverviewKey(materialId: string, version: string, ext: string): string {
  return `${materialPrefix(materialId, version)}/overview.${ext}`
}

function buildStepImageKey(materialId: string, version: string, stepIndex: number, ext: string): string {
  const suffix = String(stepIndex).padStart(2, '0')
  return `${materialPrefix(materialId, version)}/step-${suffix}.${ext}`
}

function buildStepAudioKey(materialId: string, version: string, stepIndex: number): string {
  const suffix = String(stepIndex).padStart(2, '0')
  return `${materialPrefix(materialId, version)}/step-${suffix}.mp3`
}

function generateVersion(): string {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
  return `v${stamp}-${randomUUID().slice(0, 8)}`
}

export function signInterventionMaterialRecord(
  bucket: string,
  material: InterventionMaterialRecord,
): InterventionMaterialRecord {
  return {
    ...material,
    overviewAsset: {
      ...material.overviewAsset,
      url: signUrlForBucket(bucket, material.overviewAsset.key),
    },
    steps: material.steps.map((step) => ({
      ...step,
      imageAsset: {
        ...step.imageAsset,
        url: signUrlForBucket(bucket, step.imageAsset.key),
      },
      audioAsset: {
        ...step.audioAsset,
        url: signUrlForBucket(bucket, step.audioAsset.key),
      },
    })),
  }
}

async function synthesizeMp3(text: string, logger: Logger): Promise<Buffer> {
  const env = getEnv()
  const voice = env.INTERVENTION_TTS_VOICE || env.VOLCENGINE_TTS_VOICE
  const provider = getTTSProvider()
  const session = await provider.openSession({
    requestId: `intervention-${randomUUID()}`,
    voice,
  })

  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Uint8Array[] = []
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      void session.cancel().catch(() => {})
      reject(new Error('TTS synth timeout'))
    }, 60_000)

    session.onAudio((chunk) => {
      chunks.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength))
    })

    session.onEnd(() => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(Buffer.concat(chunks))
    })

    session.onError((err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      logger.error({ err: err.message }, 'intervention TTS synth failed')
      reject(err)
    })

    try {
      session.sendText(text)
      session.finish()
    } catch (err) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err)
    }
  })
}

async function copyAsset(
  bucket: string,
  sourceKey: string,
  targetKey: string,
  contentType: string,
): Promise<InterventionAssetRef> {
  const buffer = await fetchBufferFromBucket(bucket, sourceKey)
  await uploadBufferToBucket(bucket, targetKey, buffer, contentType)
  return { key: targetKey, contentType }
}

async function uploadOrReuseOverview(
  bucket: string,
  input: InterventionAssetInput,
  materialId: string,
  version: string,
  existing: InterventionMaterialRecord | null,
): Promise<InterventionAssetRef> {
  if (input.kind === 'upload') {
    const decoded = parseImageDataUrl(input.dataUrl)
    const key = buildOverviewKey(materialId, version, decoded.ext)
    await uploadBufferToBucket(bucket, key, decoded.buffer, decoded.contentType)
    return { key, contentType: decoded.contentType }
  }

  if (!existing || existing.overviewAsset.key !== input.key) {
    throw new Error('overview image key is invalid')
  }

  const ext = extFromAssetKey(existing.overviewAsset.key, 'jpg')
  const key = buildOverviewKey(materialId, version, ext)
  return copyAsset(bucket, existing.overviewAsset.key, key, existing.overviewAsset.contentType)
}

async function uploadOrReuseStepImage(
  bucket: string,
  input: InterventionAssetInput,
  materialId: string,
  version: string,
  stepIndex: number,
  existingStep?: InterventionMaterialStep,
): Promise<InterventionAssetRef> {
  if (input.kind === 'upload') {
    const decoded = parseImageDataUrl(input.dataUrl)
    const key = buildStepImageKey(materialId, version, stepIndex, decoded.ext)
    await uploadBufferToBucket(bucket, key, decoded.buffer, decoded.contentType)
    return { key, contentType: decoded.contentType }
  }

  if (!existingStep || existingStep.imageAsset.key !== input.key) {
    throw new Error(`step ${stepIndex} image key is invalid`)
  }

  const ext = extFromAssetKey(existingStep.imageAsset.key, 'jpg')
  const key = buildStepImageKey(materialId, version, stepIndex, ext)
  return copyAsset(bucket, existingStep.imageAsset.key, key, existingStep.imageAsset.contentType)
}

async function buildStepAudio(
  bucket: string,
  materialId: string,
  version: string,
  stepIndex: number,
  ttsText: string,
  logger: Logger,
  existingStep?: InterventionMaterialStep,
): Promise<InterventionAssetRef> {
  const key = buildStepAudioKey(materialId, version, stepIndex)

  if (existingStep && existingStep.ttsText === ttsText) {
    return copyAsset(bucket, existingStep.audioAsset.key, key, existingStep.audioAsset.contentType)
  }

  const buffer = await synthesizeMp3(
    ttsText,
    logger.child({ module: 'intervention-tts', stepIndex, materialId, version }),
  )
  await uploadBufferToBucket(bucket, key, buffer, 'audio/mpeg')
  return { key, contentType: 'audio/mpeg' }
}

async function readCatalog(bucket: string, logger: Logger): Promise<InterventionMaterialRecord[]> {
  const catalog = await readJsonFromBucket<InterventionMaterialRecord[]>(bucket, CATALOG_KEY, logger)
  return Array.isArray(catalog) ? catalog : []
}

async function writeCatalog(
  bucket: string,
  items: InterventionMaterialRecord[],
): Promise<void> {
  const sorted = [...items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  await writeJsonToBucket(bucket, CATALOG_KEY, sorted)
}

export async function listInterventionMaterials(
  logger: Logger,
  includeArchived: boolean = false,
): Promise<InterventionMaterialRecord[]> {
  return listInterventionMaterialsForEnv('dev', logger, includeArchived)
}

export async function listInterventionMaterialsForEnv(
  targetEnv: 'dev' | 'sit' | 'prod',
  logger: Logger,
  includeArchived: boolean = false,
): Promise<InterventionMaterialRecord[]> {
  const bucket = assertInterventionBucketName(targetEnv)
  const items = await readCatalog(bucket, logger)
  return items
    .filter((item) => includeArchived || item.status !== 'archived')
    .map((item) => signInterventionMaterialRecord(bucket, item))
}

function tryGetInterventionBucketName(targetEnv: 'dev' | 'sit' | 'prod'): string | null {
  try {
    return assertInterventionBucketName(targetEnv)
  } catch {
    return null
  }
}

async function readCatalogIndex(
  bucket: string | null,
  logger: Logger,
): Promise<Map<string, InterventionMaterialRecord> | null> {
  if (!bucket) return null
  const items = await readCatalog(bucket, logger)
  return new Map(items.map((item) => [item.materialId, item]))
}

export async function listInterventionMaterialsWithEnvPresence(
  logger: Logger,
  includeArchived: boolean = false,
): Promise<InterventionMaterialListItem[]> {
  const devBucket = assertInterventionBucketName('dev')
  const sitBucket = tryGetInterventionBucketName('sit')
  const prodBucket = tryGetInterventionBucketName('prod')

  const [devCatalog, sitIndex, prodIndex] = await Promise.all([
    readCatalog(devBucket, logger),
    readCatalogIndex(sitBucket, logger),
    readCatalogIndex(prodBucket, logger),
  ])

  return devCatalog
    .filter((item) => includeArchived || item.status !== 'archived')
    .map((item) => {
      const signed = signInterventionMaterialRecord(devBucket, item)
      const sitItem = sitIndex?.get(item.materialId) ?? null
      const prodItem = prodIndex?.get(item.materialId) ?? null
      return {
        ...signed,
        envPresence: {
          dev: { version: item.version },
          sit: sitItem ? { version: sitItem.version } : null,
          prod: prodItem ? { version: prodItem.version } : null,
        },
      }
    })
}

export async function getInterventionMaterial(
  materialId: string,
  logger: Logger,
): Promise<InterventionMaterialRecord | null> {
  const bucket = assertInterventionBucketName('dev')
  const catalog = await readCatalog(bucket, logger)
  const current = catalog.find((item) => item.materialId === materialId) ?? null
  if (!current) return null

  const manifest = await readJsonFromBucket<InterventionMaterialRecord>(
    bucket,
    manifestKey(current.materialId, current.version),
    logger,
  )

  const material = manifest
    ? { ...manifest, status: current.status, updatedAt: current.updatedAt }
    : current

  return signInterventionMaterialRecord(bucket, material)
}

export async function getInterventionMaterialVersion(
  targetEnv: 'dev' | 'sit' | 'prod',
  materialId: string,
  version: string,
  logger: Logger,
): Promise<InterventionMaterialRecord | null> {
  const bucket = assertInterventionBucketName(targetEnv)
  const material = await readJsonFromBucket<InterventionMaterialRecord>(
    bucket,
    manifestKey(materialId, version),
    logger,
  )
  if (!material) return null
  return signInterventionMaterialRecord(bucket, material)
}

export async function createInterventionMaterial(
  input: InterventionMaterialSaveRequest,
  logger: Logger,
): Promise<InterventionMaterialRecord> {
  const bucket = assertInterventionBucketName('dev')
  const catalog = await readCatalog(bucket, logger)
  return saveInterventionMaterialVersion(bucket, input, null, catalog, logger)
}

export async function updateInterventionMaterial(
  materialId: string,
  input: InterventionMaterialSaveRequest,
  logger: Logger,
): Promise<InterventionMaterialRecord> {
  const bucket = assertInterventionBucketName('dev')
  const catalog = await readCatalog(bucket, logger)
  const current = catalog.find((item) => item.materialId === materialId) ?? null
  if (!current) {
    throw Object.assign(new Error('material not found'), { status: 404 })
  }
  if (current.status === 'archived') {
    throw Object.assign(new Error('archived material cannot be edited'), { status: 409 })
  }
  return saveInterventionMaterialVersion(bucket, input, current, catalog, logger)
}

async function saveInterventionMaterialVersion(
  bucket: string,
  input: InterventionMaterialSaveRequest,
  existing: InterventionMaterialRecord | null,
  catalog: InterventionMaterialRecord[],
  logger: Logger,
): Promise<InterventionMaterialRecord> {
  const materialId = existing?.materialId ?? generateMaterialId(catalog, input)
  const version = generateVersion()
  const now = new Date().toISOString()
  const existingSteps = new Map<number, InterventionMaterialStep>(
    (existing?.steps ?? []).map((step) => [step.stepIndex, step]),
  )
  const createdKeys: string[] = []

  try {
    const overviewAsset = await uploadOrReuseOverview(
      bucket,
      input.overviewImage,
      materialId,
      version,
      existing,
    )
    createdKeys.push(overviewAsset.key)

    const steps: InterventionMaterialStep[] = []
    for (const step of input.steps) {
      const prev = existingSteps.get(step.stepIndex)
      const imageAsset = await uploadOrReuseStepImage(
        bucket,
        step.image,
        materialId,
        version,
        step.stepIndex,
        prev,
      )
      createdKeys.push(imageAsset.key)

      const audioAsset = await buildStepAudio(
        bucket,
        materialId,
        version,
        step.stepIndex,
        step.ttsText,
        logger,
        prev,
      )
      createdKeys.push(audioAsset.key)

      steps.push({
        stepIndex: step.stepIndex,
        durationSec: step.durationSec,
        displayText: step.displayText.trim(),
        ttsText: step.ttsText.trim(),
        imageAsset,
        audioAsset,
      })
    }

    const record: InterventionMaterialRecord = {
      materialId,
      version,
      status: existing?.status ?? 'draft',
      sideEffect: input.sideEffect.trim(),
      scene: input.scene.trim(),
      actionName: input.actionName.trim(),
      prepareItems: normalizeStringArray(input.prepareItems),
      precheckQuestion: input.precheckQuestion.trim(),
      feedbackQuestion: input.feedbackQuestion.trim(),
      effectiveRule: input.effectiveRule.trim(),
      fallbackAction: input.fallbackAction.trim(),
      redFlags: normalizeStringArray(input.redFlags),
      safetyNote: input.safetyNote.trim(),
      overviewAsset,
      steps,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }

    const nextManifestKey = manifestKey(record.materialId, record.version)
    await writeJsonToBucket(bucket, nextManifestKey, record)
    createdKeys.push(nextManifestKey)

    const nextCatalog = catalog.filter((item) => item.materialId !== record.materialId)
    nextCatalog.push(record)
    await writeCatalog(bucket, nextCatalog)

    logger.info({ materialId: record.materialId, version: record.version }, 'intervention material saved')
    return signInterventionMaterialRecord(bucket, record)
  } catch (err) {
    await rollbackCreatedKeys(bucket, createdKeys, logger)
    throw err
  }
}

export async function archiveInterventionMaterial(
  materialId: string,
  logger: Logger,
): Promise<InterventionMaterialRecord> {
  const bucket = assertInterventionBucketName('dev')
  const catalog = await readCatalog(bucket, logger)
  const current = catalog.find((item) => item.materialId === materialId) ?? null
  if (!current) {
    throw Object.assign(new Error('material not found'), { status: 404 })
  }

  const archived: InterventionMaterialRecord = {
    ...current,
    status: 'archived',
    updatedAt: new Date().toISOString(),
  }
  const nextCatalog = catalog.filter((item) => item.materialId !== materialId)
  nextCatalog.push(archived)
  await writeCatalog(bucket, nextCatalog)
  logger.info({ materialId }, 'intervention material archived')
  return signInterventionMaterialRecord(bucket, archived)
}

async function copyRecordAssetsToBucket(
  sourceBucket: string,
  targetBucket: string,
  material: InterventionMaterialRecord,
  createdKeys: string[],
): Promise<InterventionMaterialRecord> {
  const nextOverview = await copyBufferAsset(
    sourceBucket,
    targetBucket,
    material.overviewAsset,
  )
  createdKeys.push(nextOverview.key)

  const nextSteps: InterventionMaterialStep[] = []
  for (const step of material.steps) {
    const imageAsset = await copyBufferAsset(sourceBucket, targetBucket, step.imageAsset)
    const audioAsset = await copyBufferAsset(sourceBucket, targetBucket, step.audioAsset)
    createdKeys.push(imageAsset.key, audioAsset.key)
    nextSteps.push({ ...step, imageAsset, audioAsset })
  }

  return {
    ...material,
    overviewAsset: nextOverview,
    steps: nextSteps,
  }
}

async function copyBufferAsset(
  sourceBucket: string,
  targetBucket: string,
  asset: InterventionAssetRef,
): Promise<InterventionAssetRef> {
  const buffer = await fetchBufferFromBucket(sourceBucket, asset.key)
  await uploadBufferToBucket(targetBucket, asset.key, buffer, asset.contentType)
  return { ...asset }
}

export async function promoteInterventionMaterial(
  materialId: string,
  targetEnv: PromoteTargetEnv,
  logger: Logger,
): Promise<InterventionMaterialRecord> {
  const sourceBucket = assertInterventionBucketName('dev')
  const targetBucket = assertInterventionBucketName(targetEnv)

  const current = await getInterventionMaterial(materialId, logger)
  if (!current) {
    throw Object.assign(new Error('material not found'), { status: 404 })
  }

  if (targetEnv === 'prod') {
    const sitBucket = assertInterventionBucketName('sit')
    const sitCatalog = await readCatalog(sitBucket, logger)
    const sitVersion = sitCatalog.find((item) => item.materialId === materialId)?.version
    if (sitVersion !== current.version) {
      throw Object.assign(new Error('material must be promoted to sit first'), { status: 409 })
    }
  }

  const plainCurrent: InterventionMaterialRecord = {
    ...current,
    overviewAsset: {
      key: current.overviewAsset.key,
      contentType: current.overviewAsset.contentType,
    },
    steps: current.steps.map((step) => ({
      ...step,
      imageAsset: {
        key: step.imageAsset.key,
        contentType: step.imageAsset.contentType,
      },
      audioAsset: {
        key: step.audioAsset.key,
        contentType: step.audioAsset.contentType,
      },
    })),
    status: 'published',
  }

  const createdKeys: string[] = []

  try {
    const copied = await copyRecordAssetsToBucket(sourceBucket, targetBucket, plainCurrent, createdKeys)
    const nextManifestKey = manifestKey(copied.materialId, copied.version)
    await writeJsonToBucket(
      targetBucket,
      nextManifestKey,
      copied,
    )
    createdKeys.push(nextManifestKey)

    const targetCatalog = await readCatalog(targetBucket, logger)
    const nextCatalog = targetCatalog.filter((item) => item.materialId !== copied.materialId)
    nextCatalog.push(copied)
    await writeCatalog(targetBucket, nextCatalog)

    logger.info({ materialId, version: copied.version, targetEnv }, 'intervention material promoted')
    return signInterventionMaterialRecord(targetBucket, copied)
  } catch (err) {
    await rollbackCreatedKeys(targetBucket, createdKeys, logger)
    throw err
  }
}

export async function bulkPromoteInterventionMaterials(
  targetEnv: PromoteTargetEnv,
  logger: Logger,
): Promise<InterventionMaterialBulkPromoteResponse> {
  const devBucket = assertInterventionBucketName('dev')
  const catalog = await readCatalog(devBucket, logger)
  const eligible = catalog.filter((item) => item.status !== 'archived')

  const succeeded: InterventionMaterialBulkPromoteSuccess[] = []
  const failed: InterventionMaterialBulkPromoteFailure[] = []

  for (const item of eligible) {
    try {
      if (targetEnv === 'prod') {
        await promoteInterventionMaterial(item.materialId, 'sit', logger)
      }
      const result = await promoteInterventionMaterial(item.materialId, targetEnv, logger)
      succeeded.push({
        materialId: item.materialId,
        actionName: item.actionName,
        version: result.version,
      })
    } catch (err: any) {
      failed.push({
        materialId: item.materialId,
        actionName: item.actionName,
        error: err?.message ?? '发布失败',
      })
    }
  }

  logger.info(
    { targetEnv, succeeded: succeeded.length, failed: failed.length },
    'intervention materials bulk promoted',
  )
  return { targetEnv, succeeded, failed }
}
