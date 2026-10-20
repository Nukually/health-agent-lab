import { and, eq, inArray, lte, sql } from 'drizzle-orm'
import { getDb } from '../db/client.js'
import { chatSessions, messages, messageFeedback, shareTokens } from '../db/schema/index.js'
import type { Logger } from '../lib/logger.js'
import { stripSystemReminderText } from '../utils/system-reminder.js'
import {
  hasSyntheticHiddenUserMarker,
  hasSyntheticToolAttachmentMarker,
} from '../utils/repeated-user-message.js'
import { sanitizeToolCallsForClient } from '../utils/tool-call-client.js'
import {
  getProcessTimelineForClient,
  hydrateProcessTimelineToolOutputs,
} from '../utils/process-timeline-client.js'
import {
  parseMedicalRiskToolOutput,
  parseInterventionMaterialToolOutput,
  type FeedbackRating,
  type InterventionMaterialToolOutput,
  type MedicalRiskResource,
  type ToolCallRecord,
} from '@health-agent/shared'
import { refreshInterventionToolOutput } from './intervention-material-runtime.js'
import { findInterventionProgressByToolCall } from './intervention-material-engagement.js'
import {
  parseSyntheticCommunicationCardPreviews,
  parseSyntheticDocPreviews,
} from './message.js'
import { getClientImageAttachmentsForMessages } from './image-asset.js'
import {
  attachInterventionDiscomfortFeedbackToMaterial,
  buildInterventionDiscomfortFeedbackMapFromSnapshot,
  getInterventionDiscomfortFeedbackState,
  type InterventionDiscomfortFeedbackMap,
  listInterventionDiscomfortFeedbackSnapshot,
} from './intervention-discomfort-feedback.js'

export async function createShareToken(
  sessionId: string,
  userId: string,
  upToMessageId: string,
  logger: Logger,
) {
  const db = getDb()

  const session = await db.query.chatSessions.findFirst({
    where: eq(chatSessions.id, sessionId),
    columns: { userId: true },
  })
  if (!session || session.userId !== userId) {
    return null
  }

  const targetMsg = await db.query.messages.findFirst({
    where: and(eq(messages.id, upToMessageId), eq(messages.sessionId, sessionId)),
    columns: { id: true },
  })
  if (!targetMsg) {
    return null
  }

  const feedbackSnapshot = await listInterventionDiscomfortFeedbackSnapshot(sessionId, userId)

  const [created] = await db
    .insert(shareTokens)
    .values({ sessionId, upToMessageId, feedbackSnapshot })
    .returning({ token: shareTokens.token })

  logger.info({ sessionId, upToMessageId, token: created.token }, 'share token created')
  return created.token
}

export async function getSharedSession(token: string, logger: Logger) {
  const db = getDb()

  const row = await db.query.shareTokens.findFirst({
    where: eq(shareTokens.token, token),
    columns: { sessionId: true, upToMessageId: true, feedbackSnapshot: true, createdAt: true },
  })
  if (!row) return null

  const session = await db.query.chatSessions.findFirst({
    where: eq(chatSessions.id, row.sessionId),
    columns: { title: true, createdAt: true, userId: true },
  })
  if (!session) return null

  const rows = await db.query.messages.findMany({
    where: and(
      eq(messages.sessionId, row.sessionId),
      lte(
        messages.createdAt,
        sql`(SELECT created_at FROM ${messages} WHERE id = ${row.upToMessageId})`,
      ),
    ),
    orderBy: (m, { asc }) => asc(m.createdAt),
    columns: {
      id: true,
      role: true,
      content: true,
      thinking: true,
      toolCalls: true,
      rawResponse: true,
      processDurationMs: true,
      outputTps: true,
      interrupted: true,
      createdAt: true,
    },
  })
  const feedbackSnapshot = row.feedbackSnapshot
    ?? await listInterventionDiscomfortFeedbackSnapshot(row.sessionId, session.userId, {
      createdAtLte: row.createdAt,
    })
  const discomfortFeedbackMap = buildInterventionDiscomfortFeedbackMapFromSnapshot(feedbackSnapshot)
  const clientImageAttachmentsByMessageId = await getClientImageAttachmentsForMessages(
    rows.filter((r) => r.role === 'user').map((r) => r.id),
  )

  const mapped = await Promise.all(rows.map(async (r) => {
    let content = r.content
    let rawTextContent = r.content
    let images: string[] | undefined
    const imageAttachments = clientImageAttachmentsByMessageId.get(r.id)
    let synthetic = false
    if (r.role === 'user' && content.startsWith('[')) {
      try {
        const parsed = JSON.parse(content)
        if (Array.isArray(parsed)) {
          const textPart = parsed.find((p: any) => p.type === 'text')
          rawTextContent = textPart?.text || ''
          content = rawTextContent
          const urls = parsed
            .filter((p: any) => p.type === 'image_url')
            .map((p: any) => p.image_url?.url)
            .filter(Boolean)
          if (urls.length > 0) images = urls
        }
      } catch { /* keep raw */ }
    } else {
      rawTextContent = content
    }
    if (imageAttachments?.length) {
      images = imageAttachments.map((attachment) => attachment.thumbUrl)
    }
    if (r.role === 'user' && hasSyntheticHiddenUserMarker(rawTextContent)) {
      synthetic = true
    }
    if (r.role === 'user' && content) {
      content = stripSystemReminderText(content)
    }
    const toolCalls = await refreshSharedToolCallsForClient(
      sanitizeToolCallsForClient(r.toolCalls as ToolCallRecord[] | null),
      row.sessionId,
      logger,
      discomfortFeedbackMap,
    )

    return {
      id: r.id,
      role: r.role,
      content,
      images,
      imageAttachments,
      thinking: r.thinking,
      toolCalls,
      processTimeline: hydrateProcessTimelineToolOutputs(getProcessTimelineForClient(r.rawResponse), toolCalls),
      processDurationMs: r.processDurationMs ?? undefined,
      outputTps: r.outputTps ?? undefined,
      interrupted: r.interrupted || undefined,
      synthetic: synthetic || undefined,
      syntheticDocs: synthetic && hasSyntheticToolAttachmentMarker(rawTextContent)
        ? parseSyntheticDocPreviews(rawTextContent, images)
        : undefined,
      syntheticCommunicationCards: synthetic && hasSyntheticToolAttachmentMarker(rawTextContent)
        ? parseSyntheticCommunicationCardPreviews(rawTextContent)
        : undefined,
      createdAt: r.createdAt.toISOString(),
    }
  }))
  const visibleMessageCount = mapped.filter((m) => !(m.role === 'user' && m.synthetic)).length

  const messageIds = mapped.map((m) => m.id)
  const feedbackRows = messageIds.length > 0
    ? await db.query.messageFeedback.findMany({
      where: and(
        eq(messageFeedback.sessionId, row.sessionId),
        eq(messageFeedback.userId, session.userId),
        inArray(messageFeedback.messageId, messageIds),
      ),
      columns: {
        messageId: true,
        rating: true,
      },
    })
    : []
  const feedbackMap: Record<string, FeedbackRating> = {}
  for (const feedback of feedbackRows) {
    feedbackMap[feedback.messageId] = feedback.rating as FeedbackRating
  }

  logger.info({
    token,
    sessionId: row.sessionId,
    count: mapped.length,
    visibleCount: visibleMessageCount,
    feedbackCount: feedbackRows.length,
  }, 'shared session fetched')

  return {
    sessionId: row.sessionId,
    title: session.title,
    messageCount: visibleMessageCount,
    createdAt: session.createdAt.toISOString(),
    messages: mapped,
    feedbackMap,
  }
}

async function refreshSharedToolCallsForClient(
  toolCalls: ToolCallRecord[] | null,
  sessionId: string,
  logger: Logger,
  discomfortFeedbackMap: InterventionDiscomfortFeedbackMap,
): Promise<ToolCallRecord[] | null> {
  if (!toolCalls?.length) return toolCalls
  const medicalRiskResourceToolNames = new Set(['grade_medical_risk', 'generate_plan', 'saved_content'])

  return Promise.all(toolCalls.map(async (toolCall) => {
    if (medicalRiskResourceToolNames.has(toolCall.name)) {
      const parsed = parseMedicalRiskToolOutput(toolCall.output)
      if (!parsed) return toolCall

      const resources = await Promise.all(parsed.resources.map(async (resource): Promise<MedicalRiskResource> => {
        if (resource.kind === 'internal_video') {
          const discomfortFeedback = getInterventionDiscomfortFeedbackState(
            discomfortFeedbackMap,
            'internal_video',
            resource.id,
          )
          return discomfortFeedback ? { ...resource, discomfortFeedback } : resource
        }
        if (resource.kind !== 'intervention_material') {
          const feedbackResourceId = resource.providerVideoId ?? resource.id
          const discomfortFeedback = getInterventionDiscomfortFeedbackState(
            discomfortFeedbackMap,
            'video_resource',
            feedbackResourceId,
          )
          return discomfortFeedback ? { ...resource, discomfortFeedback } : resource
        }
        const virtualToolCallId = toolCall.toolCallId
          ? `${toolCall.toolCallId}:resource:${resource.id}`
          : null
        const progress = virtualToolCallId
          ? await findInterventionProgressByToolCall(sessionId, virtualToolCallId)
          : null

        try {
          const refreshed = await refreshInterventionToolOutput(resource.material, logger)
          return {
            ...resource,
            material: {
              ...attachInterventionDiscomfortFeedbackToMaterial(
                refreshed ?? clearInterventionSignedUrls(resource.material),
                discomfortFeedbackMap,
              ),
              progress,
            },
          }
        } catch (err: any) {
          logger.warn({
            materialId: resource.material.materialId,
            version: resource.material.version,
            error: err?.message ?? String(err),
          }, 'failed to refresh shared medical risk intervention material urls')
          return {
            ...resource,
            material: {
              ...attachInterventionDiscomfortFeedbackToMaterial(
                clearInterventionSignedUrls(resource.material),
                discomfortFeedbackMap,
              ),
              progress,
            },
          }
        }
      }))

      return {
        ...toolCall,
        output: {
          ...parsed,
          resources,
        },
      }
    }

    if (toolCall.name !== 'show_intervention_material') return toolCall

    const snapshot = parseInterventionMaterialToolOutput(toolCall.output)
    if (!snapshot) return toolCall
    const progress = toolCall.toolCallId
      ? await findInterventionProgressByToolCall(sessionId, toolCall.toolCallId)
      : null

    try {
      const refreshed = await refreshInterventionToolOutput(snapshot, logger)
      return {
        ...toolCall,
        output: {
          ...attachInterventionDiscomfortFeedbackToMaterial(
            refreshed ?? clearInterventionSignedUrls(snapshot),
            discomfortFeedbackMap,
          ),
          progress,
        },
      }
    } catch (err: any) {
      logger.warn({
        materialId: snapshot.materialId,
        version: snapshot.version,
        error: err?.message ?? String(err),
      }, 'failed to refresh shared intervention material urls')
      return {
        ...toolCall,
        output: {
          ...attachInterventionDiscomfortFeedbackToMaterial(
            clearInterventionSignedUrls(snapshot),
            discomfortFeedbackMap,
          ),
          progress,
        },
      }
    }
  }))
}

function clearInterventionSignedUrls(
  snapshot: InterventionMaterialToolOutput,
) {
  return {
    ...snapshot,
    currentSignedUrls: {
      overviewImageUrl: '',
      stepImageUrls: snapshot.currentSignedUrls.stepImageUrls.map(() => ''),
      stepAudioUrls: snapshot.currentSignedUrls.stepAudioUrls.map(() => ''),
    },
  }
}
