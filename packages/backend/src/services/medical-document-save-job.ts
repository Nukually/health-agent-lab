import { createHash, randomUUID } from 'node:crypto'
import type {
  MedicalDocument,
  MedicalDocumentSaveJobStatus,
  MedicalDocumentSaveSuggestionPayload,
  MedicalDocumentOcrResult,
  CurrentConcern,
} from '@health-agent/shared'
import type { ChatMessage, SessionState } from '../state/session.js'
import { getKV } from '../lib/redis.js'
import type { Logger } from '../lib/logger.js'
import { processOcrImageAssets, processOcrImages } from './ocr.js'
import { applyOcrExtractedMedicalProfilePatch } from './medical-profile-patch.js'
import { clearRecommendedQuestionAgentCacheForUser } from './recommended-question-agent.js'
import { appendUserExternalEvent } from './session-events.js'
import {
  findLatestRealUserMessageIndex,
  isSyntheticToolAttachmentUserMessage,
  SYNTHETIC_TOOL_ATTACHMENT_MARKER,
} from '../utils/repeated-user-message.js'

const JOB_KEY_PREFIX = 'medical_document_save_job:'
const DEDUPE_KEY_PREFIX = 'medical_document_save_dedupe:'
const JOB_TTL_SECONDS = 24 * 60 * 60

interface ExtractionContext {
  currentConcern: CurrentConcern | null | undefined
  gender?: string | null
}

function jobKey(jobId: string): string {
  return `${JOB_KEY_PREFIX}${jobId}`
}

function dedupeKey(userId: string, sourceMessageId: string, documentHash: string): string {
  return `${DEDUPE_KEY_PREFIX}${userId}:${sourceMessageId}:${documentHash}`
}

function parseStoredContent(content: string): ChatMessage['content'] {
  if (!content.startsWith('[')) return content
  try {
    const parsed = JSON.parse(content)
    if (Array.isArray(parsed)) return parsed as ChatMessage['content']
  } catch {
    // keep raw text
  }
  return content
}

function normalizeDataImageUrl(url: string): string | null {
  if (!url.startsWith('data:image/')) return null
  const commaIdx = url.indexOf(',')
  if (commaIdx < 0) return null
  const header = url.slice(0, commaIdx)
  if (!/;base64$/i.test(header)) return null
  const base64 = url.slice(commaIdx + 1).replace(/\s+/g, '')
  if (!base64) return null
  return `${header},${base64}`
}

export function extractDataImageUrls(content: ChatMessage['content'] | string): string[] {
  const parsed = typeof content === 'string' ? parseStoredContent(content) : content
  if (!Array.isArray(parsed)) return []

  return parsed
    .map((block: any) => block?.image_url?.url)
    .filter((url): url is string => typeof url === 'string' && url.length > 0)
    .map(normalizeDataImageUrl)
    .filter((url): url is string => !!url)
}

export function hashDataImageUrl(dataUrl: string): string {
  const commaIdx = dataUrl.indexOf(',')
  if (commaIdx < 0) throw new Error('Invalid image data URL')
  const rawBase64 = dataUrl.slice(commaIdx + 1)
  const buffer = Buffer.from(rawBase64, 'base64')
  const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  return createHash('sha256').update(bytes).digest('hex')
}

export function hashMedicalDocumentImages(images: string[]): {
  imageHashes: string[]
  documentHash: string
} {
  const imageHashes = images.map(hashDataImageUrl)
  const documentHash = createHash('sha256')
    .update(imageHashes.join('\n'))
    .digest('hex')
  return { imageHashes, documentHash }
}

export function buildMedicalDocumentSaveSuggestion(
  session: SessionState,
  toolCallId: string,
): MedicalDocumentSaveSuggestionPayload | null {
  const latestUserIdx = findLatestRealUserMessageIndex(session.messages)
  if (latestUserIdx < 0) return null

  const message = session.messages[latestUserIdx]
  if (!message.dbId || isSyntheticToolAttachmentUserMessage(message)) return null

  const images = extractDataImageUrls(message.content)
  if (!images.length) return null

  const { imageHashes, documentHash } = hashMedicalDocumentImages(images)
  return {
    suggestionId: `${message.dbId}:${toolCallId}`,
    sessionId: session.sessionId,
    sourceMessageId: message.dbId,
    toolCallId,
    imageCount: images.length,
    imageHashes,
    documentHash,
    createdAt: Date.now(),
  }
}

async function writeJobStatus(status: MedicalDocumentSaveJobStatus): Promise<void> {
  await getKV().set(jobKey(status.jobId), JSON.stringify(status), JOB_TTL_SECONDS)
}

export async function getMedicalDocumentSaveJobStatus(
  jobId: string,
  logger: Logger,
): Promise<MedicalDocumentSaveJobStatus | null> {
  try {
    const raw = await getKV().get(jobKey(jobId))
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object'
      ? parsed as MedicalDocumentSaveJobStatus
      : null
  } catch (err: any) {
    logger.warn({ jobId, err: err?.message }, 'medical document save job status read failed')
    return null
  }
}

function documentEventPayload(doc: MedicalDocument | null) {
  if (!doc) return undefined
  return {
    docId: doc.id,
    title: doc.title,
    documentDate: doc.documentDate,
    documentType: doc.documentType,
    hospital: doc.hospital,
    pageCount: doc.pageCount,
  }
}

function completedStatus(
  base: MedicalDocumentSaveJobStatus,
  result: MedicalDocumentOcrResult,
): MedicalDocumentSaveJobStatus {
  return {
    ...base,
    status: 'completed',
    updatedAt: Date.now(),
    document: result.document,
    extractedFields: result.extractedFields,
    ...(result.extractedPersonalInfo ? { extractedPersonalInfo: result.extractedPersonalInfo } : {}),
  }
}

function failedStatus(
  base: MedicalDocumentSaveJobStatus,
  err: unknown,
): MedicalDocumentSaveJobStatus {
  const message = err instanceof Error ? err.message : String(err)
  return {
    ...base,
    status: 'failed',
    updatedAt: Date.now(),
    error: message || '保存失败，请稍后重试',
  }
}

async function runMedicalDocumentSaveJob(params: {
  baseStatus: MedicalDocumentSaveJobStatus
  userId: string
  images: string[]
  imageAssetIds?: string[]
  context: ExtractionContext
  logger: Logger
}): Promise<void> {
  const { baseStatus, userId, images, imageAssetIds, context, logger } = params
  const running: MedicalDocumentSaveJobStatus = {
    ...baseStatus,
    status: 'running',
    updatedAt: Date.now(),
  }
  await writeJobStatus(running)

  try {
    const result = imageAssetIds?.length
      ? await processOcrImageAssets(userId, imageAssetIds, context, logger)
      : await processOcrImages(userId, images, context, logger)
    if (!result.isMedicalDocument) {
      await writeJobStatus(failedStatus(running, new Error(result.reason)))
      return
    }

    const profileUpdate = await applyOcrExtractedMedicalProfilePatch({
      userId,
      extractedFields: result.extractedFields ?? {},
      currentConcern: context.currentConcern,
      gender: context.gender,
      logger,
    })
    if (profileUpdate?.changes.length) await clearRecommendedQuestionAgentCacheForUser(userId, logger)
    await appendUserExternalEvent(
      userId,
      {
        type: 'external_page_changed',
        page: 'medical_records',
        action: 'medical_document_uploaded',
        document: documentEventPayload(result.document),
      },
      logger,
    )
    if (profileUpdate?.changes.length) {
      await appendUserExternalEvent(
        userId,
        {
          type: 'external_page_changed',
          page: 'medical_records',
          action: 'medical_profile_saved',
          fieldChanges: profileUpdate.changes,
        },
        logger,
      )
    }
    await writeJobStatus(completedStatus(running, result))
  } catch (err) {
    logger.error({ err, jobId: baseStatus.jobId }, 'medical document save job failed')
    await writeJobStatus(failedStatus(running, err))
  }
}

export async function enqueueMedicalDocumentSaveJob(params: {
  userId: string
  sessionId: string
  sourceMessageId: string
  images: string[]
  imageAssetIds?: string[]
  expectedDocumentHash?: string
  context: ExtractionContext
  logger: Logger
}): Promise<MedicalDocumentSaveJobStatus> {
  const { imageHashes, documentHash } = hashMedicalDocumentImages(params.images)
  if (
    params.expectedDocumentHash &&
    params.expectedDocumentHash !== documentHash
  ) {
    throw Object.assign(new Error('图片内容已变化，请刷新后重试'), { status: 409 })
  }

  const dedupe = dedupeKey(params.userId, params.sourceMessageId, documentHash)
  const jobId = randomUUID()
  const lockAcquired = await getKV().setNX(dedupe, jobId, JOB_TTL_SECONDS)
  if (!lockAcquired) {
    const existingJobId = await getKV().get(dedupe)
    if (existingJobId) {
      const existing = await getMedicalDocumentSaveJobStatus(existingJobId, params.logger)
      if (existing && existing.status !== 'failed') return existing
    }
    await getKV().set(dedupe, jobId, JOB_TTL_SECONDS)
  }

  const now = Date.now()
  const status: MedicalDocumentSaveJobStatus = {
    jobId,
    status: 'queued',
    sessionId: params.sessionId,
    sourceMessageId: params.sourceMessageId,
    imageCount: imageHashes.length,
    documentHash,
    createdAt: now,
    updatedAt: now,
  }
  await writeJobStatus(status)

  void runMedicalDocumentSaveJob({
    baseStatus: status,
    userId: params.userId,
    images: params.images,
    imageAssetIds: params.imageAssetIds,
    context: params.context,
    logger: params.logger.child({ module: 'medical-document-save-job', jobId }),
  }).catch((err) => {
    params.logger.error({ err, jobId }, 'medical document save background job crashed')
  })

  return status
}

export function storedMessageLooksSynthetic(content: string): boolean {
  return content.includes(SYNTHETIC_TOOL_ATTACHMENT_MARKER)
}
