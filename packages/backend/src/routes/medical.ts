import { Hono } from 'hono'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { authMiddleware } from '../middleware/auth.js'
import { requireActiveAccount } from '../middleware/active-account.js'
import { rateLimitMiddleware } from '../middleware/rate-limit.js'
import { getDb } from '../db/client.js'
import { messages, users } from '../db/schema/index.js'
import { getFullProfile, getMedicalRecord, updateUserProfile, upsertMedicalRecord } from '../services/user.js'
import {
  createCommunicationCard,
  deleteCommunicationCard,
  findCommunicationCardBySessionMeta,
  findCommunicationCardBySource,
  getCommunicationCard,
  listCommunicationCards,
  normalizeCommunicationCardDraft,
  updateCommunicationCard,
} from '../services/communication-card.js'
import { processOcrImageAssets, processOcrImages } from '../services/ocr.js'
import { getImageAssetIdsForMessage, getModelDataImageUrlsForMessage } from '../services/image-asset.js'
import { listDocuments, getDocument, deleteDocument, deleteDocumentImage } from '../services/medical-document.js'
import {
  applyOcrExtractedMedicalProfilePatch,
  buildProfileFieldChanges,
  profilePatchChangedFields,
  valueLabelOfProfilePatch,
  type FieldChangePayload,
} from '../services/medical-profile-patch.js'
import {
  enqueueMedicalDocumentSaveJob,
  extractDataImageUrls,
  getMedicalDocumentSaveJobStatus,
  storedMessageLooksSynthetic,
} from '../services/medical-document-save-job.js'
import { appendSessionEvent, appendUserExternalEvent } from '../services/session-events.js'
import { hasConsent } from '../services/consent.js'
import { buildHealthProfileAuthorizationRejectedReminder } from '../services/first-activation.js'
import { appendPendingSystemReminder } from '../services/pending-system-reminders.js'
import { getSession } from '../services/session.js'
import { safeRecordAnalyticsEvent } from '../services/analytics.js'
import { safeTrackBackendEvent } from '../services/tracking.js'
import { pruneSyntheticMedicalDocumentContext } from '../services/message.js'
import { invalidateUserPromptSnapshots } from '../services/prompt-cache.js'
import { clearPrefixBaseline } from '../services/prefix-tracker.js'
import { clearRecommendedQuestionAgentCacheForUser } from '../services/recommended-question-agent.js'
import type { Logger } from '../lib/logger.js'
import {
  CONSENT_VERSIONS,
  hasCompleteUserProfile,
  type CreateCommunicationCardRequest,
  type UpdateCommunicationCardRequest,
  STRUCTURED_PROFILE_FIELDS,
  USER_PROFILE_FIELDS,
  COMMUNICATION_CARD_FIELD_LABELS,
  COMMUNICATION_CARD_FIELDS,
  getFieldStorageScope,
  requiresHealthProfileConsentForField,
  type CommunicationCardDraft,
  type MedicalDocument,
  type MedicalProfileData,
  type UserProfileInput,
} from '@health-agent/shared'
import {
  validateField,
  validateMedicalFieldAllowed,
  validateMedicalProfilePatch,
} from '../services/profile-validation.js'

const medicalRoutes = new Hono()

medicalRoutes.use('*', authMiddleware)
medicalRoutes.use('*', requireActiveAccount)

// GET /api/medical — combined user profile + medical record
medicalRoutes.get('/', async (c) => {
  const logger = c.get('logger')
  const userId = c.get('userId')

  const profile = await getFullProfile(userId, logger)

  return c.json({ success: true, data: profile })
})

// PUT /api/medical/profile — Level 1: personal info (nickname, birthday, gender, currentConcern)
medicalRoutes.put(
  '/profile',
  rateLimitMiddleware({
    windowMs: 1_000,
    max: 1,
    keyPrefix: 'rl:profile',
    keyExtractor: (c) => c.get('userId'),
  }),
  async (c) => {
    const logger = c.get('logger')
    const userId = c.get('userId')
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    const { sessionId, ...profileBody } = body

    for (const [field, value] of Object.entries(profileBody)) {
      if (!USER_PROFILE_FIELDS.includes(field as any)) {
        return c.json({ success: false, error: `非法字段：${field}` }, 400)
      }
      const err = validateField(field, value)
      if (err) {
        logger.warn({ field, err }, 'profile put rejected')
        return c.json({ success: false, error: err }, 400)
      }
    }

    const db = getDb()
    const currentUser = await db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { nickname: true, birthday: true, gender: true, currentConcern: true, lastLoginAt: true },
    })

    if (currentUser && currentUser.lastLoginAt == null && !currentUser.currentConcern) {
      const nextUserProfile = {
        nickname: profileBody.nickname !== undefined ? String(profileBody.nickname) : currentUser.nickname,
        birthday: profileBody.birthday !== undefined ? String(profileBody.birthday) : currentUser.birthday,
        gender: profileBody.gender !== undefined ? String(profileBody.gender) : currentUser.gender,
        currentConcern: profileBody.currentConcern !== undefined
          ? (profileBody.currentConcern as UserProfileInput['currentConcern'])
          : currentUser.currentConcern,
      }

      if (!hasCompleteUserProfile(nextUserProfile)) {
        return c.json({
          success: false,
          error: '首次登录需完整填写昵称、出生日期、性别和当前关注情况',
        }, 400)
      }
    }

    const updated = await updateUserProfile(userId, profileBody as UserProfileInput, logger)
    const currentProfile = currentUser
      ? {
          nickname: currentUser.nickname,
          birthday: currentUser.birthday,
          gender: currentUser.gender,
          currentConcern: currentUser.currentConcern,
        }
      : null
    const updatedProfile = {
      nickname: updated.nickname,
      birthday: updated.birthday,
      gender: updated.gender,
      currentConcern: updated.currentConcern,
    }
    const changes = buildProfileFieldChanges(Object.keys(profileBody), currentProfile, updatedProfile)

    const ownedSessionId = await resolveOwnedSessionId(userId, sessionId, logger)
    if (ownedSessionId) {
      if (changes.length) {
        await appendUserExternalEvent(
          userId,
          {
            type: 'external_page_changed',
            page: 'personal_info',
            action: 'profile_saved',
            fieldChanges: changes,
          },
          logger,
        )
      }
    }
    await refreshRecommendedQuestionsForProfileChanges(userId, changes, logger)

    return c.json({
      success: true,
      data: {
        id: updated.id,
        phone: updated.phone,
        nickname: updated.nickname,
        avatarUrl: updated.avatarUrl,
        birthday: updated.birthday,
        gender: updated.gender,
        currentConcern: updated.currentConcern,
      },
    })
  },
)

// POST /api/medical — Level 2: medical archive (profileData JSONB, merge-patch)
medicalRoutes.post(
  '/',
  rateLimitMiddleware({
    windowMs: 1_000,
    max: 1,
    keyPrefix: 'rl:medical',
    keyExtractor: (c) => c.get('userId'),
  }),
  async (c) => {
    const logger = c.get('logger')
    const userId = c.get('userId')
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>

    if (!(await hasHealthProfileConsent(userId))) {
      return c.json({ success: false, error: '需要先完成健康档案授权' }, 403)
    }

    const sessionId = body.sessionId
    const rawProfilePatch = ((body.profileData ?? body) || {}) as Record<string, unknown>
    const { sessionId: _ignoredSessionId, ...cleanProfilePatch } = rawProfilePatch
    const profilePatch = cleanProfilePatch as MedicalProfileData
    const { user } = await getFullProfile(userId, logger)
    const patchErr = validateMedicalProfilePatch(profilePatch, user.currentConcern, user.gender)
    if (patchErr) {
      logger.warn({ userId, patchErr }, 'medical profile patch rejected')
      return c.json({ success: false, error: patchErr }, 400)
    }

    const existingRecord = await getMedicalRecord(userId, logger)
    const existingProfile = (existingRecord?.profileData as MedicalProfileData | null) ?? null
    const record = await upsertMedicalRecord(userId, profilePatch, logger)
    await clearRecommendedQuestionAgentCacheForUser(userId, logger)
    const ownedSessionId = await resolveOwnedSessionId(userId, sessionId, logger)
    if (ownedSessionId) {
      const fieldNames = profilePatchChangedFields(profilePatch)
      const changes = buildProfileFieldChanges(
        fieldNames,
        existingProfile,
        record.profileData as MedicalProfileData,
      )
      if (changes.length) {
        await appendUserExternalEvent(
          userId,
          {
            type: 'external_page_changed',
            page: 'medical_records',
            action: 'medical_profile_saved',
            fieldChanges: changes,
          },
          logger,
        )
      }
    }

    return c.json({ success: true, data: record })
  },
)

async function hasHealthProfileConsent(userId: string): Promise<boolean> {
  return hasConsent(userId, 'health_profile', CONSENT_VERSIONS.health_profile)
}

const RECOMMENDED_QUESTION_PROFILE_REFRESH_FIELDS = new Set([
  'birthday',
  'gender',
  'currentConcern',
])

async function refreshRecommendedQuestionsForProfileChanges(
  userId: string,
  changes: FieldChangePayload[],
  logger: Logger,
): Promise<void> {
  const fields = changes
    .map((change) => change.field)
    .filter((field) => RECOMMENDED_QUESTION_PROFILE_REFRESH_FIELDS.has(field))
  if (fields.length === 0) return

  try {
    await clearRecommendedQuestionAgentCacheForUser(userId, logger)
    logger.info({ userId, fields: [...new Set(fields)] }, 'recommended question agent cache cleared after profile change')
  } catch (err) {
    logger.error(
      { userId, fields, error: err instanceof Error ? err.message : String(err) },
      'recommended question agent cache clear failed after profile change',
    )
  }
}

async function resolveOwnedSessionId(
  userId: string,
  sessionId: unknown,
  logger: Logger,
): Promise<string | null> {
  if (typeof sessionId !== 'string' || !sessionId) return null
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionId)) {
    logger.warn({ userId, sessionId }, 'session event skipped: invalid session id')
    return null
  }
  const session = await getSession(sessionId, logger)
  if (!session || session.userId !== userId) {
    logger.warn({ userId, sessionId }, 'session event skipped: session not found or not owner')
    return null
  }
  return sessionId
}

async function shouldRecordExternalPageChange(
  userId: string,
  sessionId: unknown,
  logger: Logger,
): Promise<boolean> {
  if (typeof sessionId !== 'string' || !sessionId) return true
  return Boolean(await resolveOwnedSessionId(userId, sessionId, logger))
}

function buildCommunicationCardFieldChanges(
  before: CommunicationCardDraft,
  after: CommunicationCardDraft,
) {
  return COMMUNICATION_CARD_FIELDS
    .map<FieldChangePayload | null>((field) => {
      const fromValue = before[field] || ''
      const toValue = after[field] || ''
      if (String(fromValue) === String(toValue)) return null
      return {
        field,
        fieldLabel: COMMUNICATION_CARD_FIELD_LABELS[field],
        fromValue: String(fromValue || '未填写'),
        toValue: String(toValue || '未填写'),
      }
    })
    .filter((change): change is FieldChangePayload => Boolean(change))
}

function documentEventPayload(doc: MedicalDocument | null, extra?: { imageIndex?: number }) {
  if (!doc) return undefined
  return {
    docId: doc.id,
    title: doc.title,
    documentDate: doc.documentDate,
    documentType: doc.documentType,
    hospital: doc.hospital,
    pageCount: doc.pageCount,
    imageIndex: extra?.imageIndex,
  }
}

// POST /api/medical/profile/patch — 单字段更新（确认卡片点"同意"后调用）
medicalRoutes.post(
  '/profile/patch',
  rateLimitMiddleware({
    windowMs: 1_000,
    max: 2,
    keyPrefix: 'rl:profile-patch',
    keyExtractor: (c) => c.get('userId'),
  }),
  async (c) => {
    const logger = c.get('logger')
    const userId = c.get('userId')
    const body = (await c.req.json().catch(() => ({}))) as {
      field?: string
      value?: unknown
      profilePatch?: MedicalProfileData
      sessionId?: string
      approvalId?: string
      toolCallId?: string
    }

    const { field, value, sessionId } = body
    if (!field || value === undefined) {
      return c.json({ success: false, error: '缺少 field 或 value' }, 400)
    }

    const err = validateField(field, value)
    if (err) {
      logger.warn({ field, err }, 'profile patch rejected')
      return c.json({ success: false, error: err }, 400)
    }

    const scope = getFieldStorageScope(field)
    if (!scope) {
      return c.json({ success: false, error: `非法字段：${field}` }, 400)
    }

    const { user } = await getFullProfile(userId, logger)

    if (scope === 'user_profile') {
      const updated = await updateUserProfile(userId, { [field]: value } as UserProfileInput, logger)
      const changes = buildProfileFieldChanges([field], user, updated)
      await refreshRecommendedQuestionsForProfileChanges(userId, changes, logger)
      logger.info({ userId, field }, 'user-profile field patched')
    } else {
      if (requiresHealthProfileConsentForField(field) && !(await hasHealthProfileConsent(userId))) {
        return c.json({ success: false, error: '需要先完成健康档案授权' }, 403)
      }

      const accessErr = validateMedicalFieldAllowed(field, user.currentConcern, user.gender)
      if (accessErr) {
        logger.warn({ userId, field, accessErr }, 'medical field patch rejected by concern')
        return c.json({ success: false, error: accessErr }, 400)
      }

      const patch: MedicalProfileData = body.profilePatch && typeof body.profilePatch === 'object'
        ? body.profilePatch
        : { [field]: value } as MedicalProfileData
      if (field === 'medications' && Array.isArray(patch.medications) && !patch.medications.includes('other')) {
        patch.medicationCustom = ''
      }
      const patchErr = validateMedicalProfilePatch(patch, user.currentConcern, user.gender)
      if (patchErr) {
        logger.warn({ userId, field, patchErr }, 'medical field patch rejected by profile patch validation')
        return c.json({ success: false, error: patchErr }, 400)
      }

      const existing = await getMedicalRecord(userId, logger)
      const merged: MedicalProfileData = {
        ...(existing?.profileData as MedicalProfileData | undefined),
        ...patch,
      } as MedicalProfileData
      await upsertMedicalRecord(userId, merged, logger)
      await clearRecommendedQuestionAgentCacheForUser(userId, logger)
      logger.info({ userId, field }, 'medical field patched')
    }

    // 记录 session-event，下一轮 LLM 通过 <system-reminder> 感知变化，避免重建 system prompt
    const ownedSessionId = await resolveOwnedSessionId(userId, sessionId, logger)
    if (ownedSessionId) {
      await appendSessionEvent(
        ownedSessionId,
        { type: 'profile_approved', field, valueLabel: valueLabelOfProfilePatch(field, value, body.profilePatch) },
        logger,
      )
    }

    const analyticsEvent = {
      userId,
      sessionId: sessionId || null,
      eventName: 'profile_approval_card_approved',
      dedupeKey: typeof body.approvalId === 'string' ? body.approvalId : null,
      entityType: 'profile_field',
      entityId: field,
      properties: {
        approvalId: typeof body.approvalId === 'string' ? body.approvalId : null,
        toolCallId: typeof body.toolCallId === 'string' ? body.toolCallId : null,
        field,
        valueLabel: valueLabelOfProfilePatch(field, value, body.profilePatch),
      },
    } as const
    await safeRecordAnalyticsEvent(analyticsEvent, logger)
    safeTrackBackendEvent(
      analyticsEvent,
      logger,
      c.get('trackingContext'),
    )

    return c.json({ success: true, data: { field, value } })
  },
)

// POST /api/medical/profile/reject — 用户在确认卡片点"拒绝"后调用
// 追加 profile_rejected 事件，executor 据此在本会话内直接拦截重复的同字段更新
medicalRoutes.post(
  '/profile/reject',
  rateLimitMiddleware({
    windowMs: 1_000,
    max: 5,
    keyPrefix: 'rl:profile-reject',
    keyExtractor: (c) => c.get('userId'),
  }),
  async (c) => {
    const logger = c.get('logger')
    const userId = c.get('userId')
    const body = (await c.req.json().catch(() => ({}))) as {
      sessionId?: string
      field?: string
      approvalId?: string
      toolCallId?: string
    }

    const { sessionId, field } = body
    if (!sessionId || typeof sessionId !== 'string') {
      return c.json({ success: false, error: '缺少 sessionId' }, 400)
    }
    if (!field || !STRUCTURED_PROFILE_FIELDS.includes(field as any)) {
      return c.json({ success: false, error: `非法字段：${field}` }, 400)
    }

    const ownedSessionId = await resolveOwnedSessionId(userId, sessionId, logger)
    if (ownedSessionId) {
      await appendSessionEvent(ownedSessionId, { type: 'profile_rejected', field }, logger)
    }
    const analyticsEvent = {
      userId,
      sessionId: ownedSessionId ?? sessionId,
      eventName: 'profile_approval_card_rejected',
      dedupeKey: typeof body.approvalId === 'string' ? body.approvalId : null,
      entityType: 'profile_field',
      entityId: field,
      properties: {
        approvalId: typeof body.approvalId === 'string' ? body.approvalId : null,
        toolCallId: typeof body.toolCallId === 'string' ? body.toolCallId : null,
        field,
      },
    } as const
    await safeRecordAnalyticsEvent(analyticsEvent, logger)
    safeTrackBackendEvent(
      analyticsEvent,
      logger,
      c.get('trackingContext'),
    )
    logger.info({ userId, sessionId, field, eventAppended: Boolean(ownedSessionId) }, 'profile reject handled')
    return c.json({ success: true, data: { sessionId, field } })
  },
)

medicalRoutes.post(
  '/profile/authorization-reject',
  rateLimitMiddleware({
    windowMs: 1_000,
    max: 5,
    keyPrefix: 'rl:profile-authorization-reject',
    keyExtractor: (c) => c.get('userId'),
  }),
  async (c) => {
    const logger = c.get('logger')
    const userId = c.get('userId')
    const body = (await c.req.json().catch(() => ({}))) as { sessionId?: string; fields?: unknown[] }
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
    const fields = Array.isArray(body.fields)
      ? body.fields.filter((field): field is string => typeof field === 'string' && requiresHealthProfileConsentForField(field))
      : []

    if (!sessionId) {
      return c.json({ success: false, error: '缺少 sessionId' }, 400)
    }
    if (fields.length === 0) {
      return c.json({ success: false, error: '至少需要一个医疗档案字段' }, 400)
    }

    const session = await getSession(sessionId, logger)
    if (!session || session.userId !== userId) {
      return c.json({ success: false, error: '会话不存在' }, 404)
    }

    await appendPendingSystemReminder(
      sessionId,
      buildHealthProfileAuthorizationRejectedReminder(fields),
      logger,
    )

    logger.info({ sessionId, fields }, 'health profile authorization rejected reminder queued')
    return c.json({ success: true, data: { sessionId, fields } })
  },
)

// POST /api/medical/ocr — 上传病历图片并 OCR 解析
const ocrSchema = z.object({
  images: z
    .array(z.string().startsWith('data:image/'))
    .max(10, '最多上传10张图片')
    .optional()
    .default([]),
  imageAssetIds: z.array(z.string().uuid()).max(10, '最多上传10张图片').optional(),
  sessionId: z.string().uuid().optional(),
}).refine(
  (data) => data.images.length > 0 || (data.imageAssetIds && data.imageAssetIds.length > 0),
  { message: '至少上传一张图片', path: ['images'] },
)

const saveFromChatImageSchema = z.object({
  sessionId: z.string().uuid(),
  sourceMessageId: z.string().uuid(),
  toolCallId: z.string().optional(),
  documentHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
})

medicalRoutes.post(
  '/ocr',
  rateLimitMiddleware({
    windowMs: 10_000,
    max: 1,
    keyPrefix: 'rl:ocr',
    keyExtractor: (c) => c.get('userId'),
  }),
  async (c) => {
    const logger = c.get('logger')
    const userId = c.get('userId')
    const body = await c.req.json()

    const parsed = ocrSchema.safeParse(body)
    if (!parsed.success) {
      return c.json({ success: false, error: parsed.error.issues[0]?.message }, 400)
    }

    if (!(await hasHealthProfileConsent(userId))) {
      return c.json({ success: false, error: '需要先完成健康档案授权' }, 403)
    }

    try {
      const { user } = await getFullProfile(userId, logger)
      const result = parsed.data.imageAssetIds?.length
        ? await processOcrImageAssets(
          userId,
          parsed.data.imageAssetIds,
          { currentConcern: user.currentConcern, gender: user.gender },
          logger,
        )
        : await processOcrImages(
          userId,
          parsed.data.images,
          { currentConcern: user.currentConcern, gender: user.gender },
          logger,
        )
      if (!result.isMedicalDocument) {
        return c.json({ success: true, data: result })
      }

      const extractedFields = result.extractedFields ?? {}
      const profileUpdate = await applyOcrExtractedMedicalProfilePatch({
        userId,
        extractedFields,
        currentConcern: user.currentConcern,
        gender: user.gender,
        logger,
      })
      if (profileUpdate?.changes.length) await clearRecommendedQuestionAgentCacheForUser(userId, logger)

      const ownedSessionId = await resolveOwnedSessionId(userId, parsed.data.sessionId, logger)
      if (ownedSessionId) {
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
      }
      return c.json({ success: true, data: result })
    } catch (err: any) {
      if (err.message?.includes('OSS')) {
        return c.json({ success: false, error: '文件存储服务未配置' }, 503)
      }
      logger.error({ err }, 'OCR processing failed')
      return c.json({ success: false, error: '病历解析失败，请稍后重试' }, 500)
    }
  },
)

// POST /api/medical/documents/save-from-chat-image — 将聊天中已解读的本轮图片异步保存为病历文档
medicalRoutes.post(
  '/documents/save-from-chat-image',
  rateLimitMiddleware({
    windowMs: 10_000,
    max: 2,
    keyPrefix: 'rl:save-chat-image',
    keyExtractor: (c) => c.get('userId'),
  }),
  async (c) => {
    const logger = c.get('logger')
    const userId = c.get('userId')
    const body = await c.req.json().catch(() => ({}))

    const parsed = saveFromChatImageSchema.safeParse(body)
    if (!parsed.success) {
      return c.json({ success: false, error: parsed.error.issues[0]?.message }, 400)
    }

    if (!(await hasHealthProfileConsent(userId))) {
      return c.json({ success: false, error: '需要先完成健康档案授权' }, 403)
    }

    const ownedSessionId = await resolveOwnedSessionId(userId, parsed.data.sessionId, logger)
    if (!ownedSessionId) {
      return c.json({ success: false, error: '会话不存在' }, 404)
    }

    const db = getDb()
    const sourceMessage = await db.query.messages.findFirst({
      where: and(
        eq(messages.id, parsed.data.sourceMessageId),
        eq(messages.sessionId, ownedSessionId),
        eq(messages.role, 'user'),
      ),
      columns: {
        id: true,
        content: true,
      },
    })

    if (!sourceMessage || storedMessageLooksSynthetic(sourceMessage.content)) {
      return c.json({ success: false, error: '未找到可保存的本轮图片' }, 404)
    }

    const imageAssetIds = await getImageAssetIdsForMessage(sourceMessage.id)
    let images = await getModelDataImageUrlsForMessage(sourceMessage.id)
    if (images.length === 0) {
      images = extractDataImageUrls(sourceMessage.content)
    }
    if (images.length === 0) {
      return c.json({ success: false, error: '未找到可保存的图片' }, 400)
    }

    try {
      const { user } = await getFullProfile(userId, logger)
      const status = await enqueueMedicalDocumentSaveJob({
        userId,
        sessionId: ownedSessionId,
        sourceMessageId: sourceMessage.id,
        images,
        imageAssetIds,
        expectedDocumentHash: parsed.data.documentHash,
        context: { currentConcern: user.currentConcern, gender: user.gender },
        logger,
      })

      return c.json(
        { success: true, data: status },
        status.status === 'completed' ? 200 : 202,
      )
    } catch (err: any) {
      if (err?.status === 409) {
        return c.json({ success: false, error: err.message }, 409)
      }
      logger.error({ err }, 'failed to enqueue chat image medical document save job')
      return c.json({ success: false, error: '保存任务创建失败，请稍后重试' }, 500)
    }
  },
)

// GET /api/medical/documents/save-jobs/:jobId — 查询聊天图片保存任务状态
medicalRoutes.get('/documents/save-jobs/:jobId', async (c) => {
  const logger = c.get('logger')
  const userId = c.get('userId')
  const jobId = c.req.param('jobId')

  const status = await getMedicalDocumentSaveJobStatus(jobId, logger)
  if (!status) return c.json({ success: false, error: '保存任务不存在' }, 404)

  const ownedSessionId = await resolveOwnedSessionId(userId, status.sessionId, logger)
  if (!ownedSessionId) {
    return c.json({ success: false, error: '保存任务不存在' }, 404)
  }

  return c.json({ success: true, data: status })
})

// GET /api/medical/documents — 病历文档列表
medicalRoutes.get('/documents', async (c) => {
  const logger = c.get('logger')
  const userId = c.get('userId')

  const docs = await listDocuments(userId, logger)
  return c.json({ success: true, data: docs })
})

// POST /api/medical/communication-cards — 保存沟通卡片
medicalRoutes.post(
  '/communication-cards',
  rateLimitMiddleware({
    windowMs: 1_000,
    max: 2,
    keyPrefix: 'rl:communication-cards',
    keyExtractor: (c) => c.get('userId'),
  }),
  async (c) => {
    const logger = c.get('logger')
    const userId = c.get('userId')
    const body = (await c.req.json().catch(() => ({}))) as CreateCommunicationCardRequest

    try {
      if (body.sourceSessionId && body.sourceToolCallId) {
        const existing = await findCommunicationCardBySource(
          userId,
          body.sourceSessionId,
          body.sourceToolCallId,
          logger,
        )
        if (existing) {
          const analyticsEvent = {
            userId,
            sessionId: body.sourceSessionId ?? null,
            eventName: 'communication_card_save_clicked',
            dedupeKey: `${body.sourceSessionId}:${body.sourceToolCallId}`,
            entityType: 'communication_card',
            entityId: existing.id,
            properties: {
              cardId: existing.id,
              sourceSessionId: body.sourceSessionId,
              sourceToolCallId: body.sourceToolCallId,
              title: existing.title,
              cardDate: existing.cardDate,
              alreadySaved: true,
            },
          } as const
          await safeRecordAnalyticsEvent(analyticsEvent, logger)
          safeTrackBackendEvent(
            analyticsEvent,
            logger,
            c.get('trackingContext'),
          )
          return c.json({ success: true, data: existing })
        }
      }

      const record = await createCommunicationCard(userId, body, logger)
      const analyticsEvent = {
        userId,
        sessionId: record.sourceSessionId,
        eventName: 'communication_card_save_clicked',
        dedupeKey: body.sourceSessionId && body.sourceToolCallId
          ? `${body.sourceSessionId}:${body.sourceToolCallId}`
          : record.id,
        entityType: 'communication_card',
        entityId: record.id,
        properties: {
          cardId: record.id,
          sourceSessionId: record.sourceSessionId,
          sourceToolCallId: record.contentJson.sourceToolCallId ?? null,
          title: record.title,
          cardDate: record.cardDate,
          alreadySaved: false,
        },
      } as const
      await safeRecordAnalyticsEvent(analyticsEvent, logger)
      safeTrackBackendEvent(
        analyticsEvent,
        logger,
        c.get('trackingContext'),
      )
      const eventSessionId = await resolveOwnedSessionId(userId, record.sourceSessionId, logger)
      if (eventSessionId) {
        await appendSessionEvent(
          eventSessionId,
          {
            type: 'communication_card_saved',
            cardTitle: record.contentJson.draft.title,
            cardDate: record.contentJson.draft.cardDate,
          },
          logger,
        )
      }
      return c.json({ success: true, data: record })
    } catch (err: any) {
      logger.warn({ userId, err: err?.message }, 'failed to create communication card')
      return c.json({ success: false, error: err?.message || '保存沟通卡片失败' }, 400)
    }
  },
)

// GET /api/medical/communication-cards — 沟通卡片列表
medicalRoutes.get('/communication-cards', async (c) => {
  const logger = c.get('logger')
  const userId = c.get('userId')
  const cards = await listCommunicationCards(userId, logger)
  return c.json({ success: true, data: cards })
})

// GET /api/medical/communication-cards/lookup?sessionId=...&toolCallId=...
medicalRoutes.get('/communication-cards/lookup', async (c) => {
  const logger = c.get('logger')
  const userId = c.get('userId')
  const sessionId = c.req.query('sessionId')
  const toolCallId = c.req.query('toolCallId')
  const title = c.req.query('title')
  const cardDate = c.req.query('cardDate')

  if (!sessionId || !toolCallId) {
    return c.json({ success: false, error: '缺少 sessionId 或 toolCallId' }, 400)
  }

  const card =
    await findCommunicationCardBySource(userId, sessionId, toolCallId, logger) ??
    (
      title && cardDate
        ? await findCommunicationCardBySessionMeta(userId, sessionId, title, cardDate, logger)
        : null
    )
  return c.json({ success: true, data: card })
})

// GET /api/medical/communication-cards/:id — 沟通卡片详情
medicalRoutes.get('/communication-cards/:id', async (c) => {
  const logger = c.get('logger')
  const userId = c.get('userId')
  const cardId = c.req.param('id')

  const card = await getCommunicationCard(userId, cardId, logger)
  if (!card) return c.json({ success: false, error: '沟通卡片不存在' }, 404)
  return c.json({ success: true, data: card })
})

// PUT /api/medical/communication-cards/:id — 编辑已保存沟通卡片
medicalRoutes.put(
  '/communication-cards/:id',
  rateLimitMiddleware({
    windowMs: 1_000,
    max: 2,
    keyPrefix: 'rl:communication-cards-update',
    keyExtractor: (c) => c.get('userId'),
  }),
  async (c) => {
    const logger = c.get('logger')
    const userId = c.get('userId')
    const cardId = c.req.param('id')
    const body = (await c.req.json().catch(() => ({}))) as UpdateCommunicationCardRequest & {
      sessionId?: string
    }

    try {
      const before = await getCommunicationCard(userId, cardId, logger)
      const updated = await updateCommunicationCard(userId, cardId, body.draft, logger)
      if (!updated) return c.json({ success: false, error: '沟通卡片不存在' }, 404)

      const ownedSessionId = await resolveOwnedSessionId(userId, body.sessionId, logger)
      if (ownedSessionId) {
        const changes = before
          ? buildCommunicationCardFieldChanges(before.contentJson.draft, updated.contentJson.draft)
          : []
        if (changes.length) {
          await appendUserExternalEvent(
            userId,
            {
              type: 'external_page_changed',
              page: 'materials',
              action: 'communication_card_updated',
              card: {
                cardId: updated.id,
                title: updated.contentJson.draft.title,
                cardDate: updated.contentJson.draft.cardDate,
              },
              fieldChanges: changes,
            },
            logger,
          )
        }
      }

      return c.json({ success: true, data: updated })
    } catch (err: any) {
      logger.warn({ userId, cardId, err: err?.message }, 'failed to update communication card')
      return c.json({ success: false, error: err?.message || '更新沟通卡片失败' }, 400)
    }
  },
)

// DELETE /api/medical/communication-cards/:id — 删除已保存沟通卡片
medicalRoutes.delete(
  '/communication-cards/:id',
  rateLimitMiddleware({
    windowMs: 1_000,
    max: 2,
    keyPrefix: 'rl:communication-cards-delete',
    keyExtractor: (c) => c.get('userId'),
  }),
  async (c) => {
    const logger = c.get('logger')
    const userId = c.get('userId')
    const cardId = c.req.param('id')
    const sessionId = c.req.query('sessionId')

    const deleted = await deleteCommunicationCard(userId, cardId, logger)
    if (!deleted) return c.json({ success: false, error: '沟通卡片不存在' }, 404)

    const ownedSessionId = await resolveOwnedSessionId(userId, sessionId, logger)
    if (ownedSessionId) {
      await appendUserExternalEvent(
        userId,
        {
          type: 'external_page_changed',
          page: 'materials',
          action: 'communication_card_deleted',
          card: {
            cardId: deleted.id,
            title: deleted.contentJson.draft.title,
            cardDate: deleted.contentJson.draft.cardDate,
          },
        },
        logger,
      )
    }

    return c.json({ success: true, data: { id: deleted.id } })
  },
)

// GET /api/medical/documents/:id — 病历文档详情
medicalRoutes.get('/documents/:id', async (c) => {
  const logger = c.get('logger')
  const userId = c.get('userId')
  const docId = c.req.param('id')

  const doc = await getDocument(userId, docId, logger)
  if (!doc) return c.json({ success: false, error: '文档不存在' }, 404)
  return c.json({ success: true, data: doc })
})

// DELETE /api/medical/documents/:id/images/:imageIndex — 删除病历文档中的单张图片
medicalRoutes.delete('/documents/:id/images/:imageIndex', async (c) => {
  const logger = c.get('logger')
  const userId = c.get('userId')
  const docId = c.req.param('id')
  const imageIndex = Number(c.req.param('imageIndex'))
  const sessionId = c.req.query('sessionId')

  if (!Number.isInteger(imageIndex) || imageIndex < 0) {
    return c.json({ success: false, error: '图片序号无效' }, 400)
  }

  const result = await deleteDocumentImage(userId, docId, imageIndex, logger)
  if (result.status === 'not_found') return c.json({ success: false, error: '文档不存在' }, 404)
  if (result.status === 'invalid_image_index') return c.json({ success: false, error: '图片不存在' }, 404)
  if (result.status === 'last_image') {
    return c.json({ success: false, error: '最后一张图片请删除整份病历' }, 400)
  }

  await pruneSyntheticMedicalDocumentContext(userId, docId, logger, { imageIndex })

  if (await shouldRecordExternalPageChange(userId, sessionId, logger)) {
    await appendUserExternalEvent(
      userId,
      {
        type: 'external_page_changed',
        page: 'medical_records',
        action: 'medical_document_image_deleted',
        document: documentEventPayload(result.document, { imageIndex }),
      },
      logger,
    )
  }

  return c.json({ success: true, data: result.document })
})

// DELETE /api/medical/documents/:id — 删除病历文档
medicalRoutes.delete('/documents/:id', async (c) => {
  const logger = c.get('logger')
  const userId = c.get('userId')
  const docId = c.req.param('id')
  const sessionId = c.req.query('sessionId')

  const deleted = await deleteDocument(userId, docId, logger)
  if (!deleted) return c.json({ success: false, error: '文档不存在' }, 404)

  await pruneSyntheticMedicalDocumentContext(userId, docId, logger)
  const invalidatedSessionIds = await invalidateUserPromptSnapshots(userId, logger)
  await Promise.all(
    invalidatedSessionIds.map((id) => clearPrefixBaseline(id, logger, 'medical_document_deleted')),
  )

  if (await shouldRecordExternalPageChange(userId, sessionId, logger)) {
    await appendUserExternalEvent(
      userId,
      {
        type: 'external_page_changed',
        page: 'medical_records',
        action: 'medical_document_deleted',
        document: documentEventPayload(deleted),
      },
      logger,
    )
  }
  return c.json({ success: true })
})

export default medicalRoutes
