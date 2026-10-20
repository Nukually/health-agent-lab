/**
 * Check-in draft store
 *
 * 工具调用产出"草稿"而不是直接落库;前端拿 draftToken 渲染可编辑表单,
 * 用户在卡片里核对/编辑/补全后调 /api/check-ins/records/commit 才落库。
 *
 * 数据放 Redis(或内存 fallback) checkin:draft:{token},TTL 1 小时。
 * 草稿失效后无意义,不需要持久化到 Postgres。
 */

import { randomUUID } from 'node:crypto'
import type {
  CheckInA2uiSchema,
  CheckInAttachment,
  CheckInValues,
} from '@health-agent/shared'
import { getKV } from '../lib/redis.js'

const DRAFT_TTL_SECONDS = 3600
const DRAFT_KEY_PREFIX = 'checkin:draft:'

export type CheckInDraftSchemaActionHint = 'create' | 'use_existing'

export interface CheckInDraftRecord {
  draftToken: string
  userId: string
  sessionId: string
  toolCallId: string
  sourceMessageId: string | null
  schemaActionHint: CheckInDraftSchemaActionHint
  /** 草稿对应的 schema(create 模式 = 新草稿;use_existing = 已有 schema 的快照) */
  schema: CheckInA2uiSchema
  /** 已有分类时的现存 schemaId,commit 时复用以避免重复创建 */
  existingSchemaId?: string | null
  draftValues: CheckInValues
  draftAttachments: CheckInAttachment[]
  draftNote: string | null
  draftTags: string[]
  recordedAt: string | null
  createdAt: string
}

function draftKey(token: string): string {
  return `${DRAFT_KEY_PREFIX}${token}`
}

export async function createCheckInDraft(
  input: Omit<CheckInDraftRecord, 'draftToken' | 'createdAt'>,
): Promise<CheckInDraftRecord> {
  const draftToken = randomUUID()
  const draft: CheckInDraftRecord = {
    ...input,
    draftToken,
    createdAt: new Date().toISOString(),
  }
  await getKV().set(draftKey(draftToken), JSON.stringify(draft), DRAFT_TTL_SECONDS)
  return draft
}

export async function readCheckInDraft(token: string): Promise<CheckInDraftRecord | null> {
  if (!token) return null
  const raw = await getKV().get(draftKey(token))
  if (!raw) return null
  try {
    return JSON.parse(raw) as CheckInDraftRecord
  } catch {
    return null
  }
}

/** Atomic read + delete; safe even if commit retries */
export async function consumeCheckInDraft(token: string): Promise<CheckInDraftRecord | null> {
  const draft = await readCheckInDraft(token)
  if (!draft) return null
  await getKV().del(draftKey(token))
  return draft
}
