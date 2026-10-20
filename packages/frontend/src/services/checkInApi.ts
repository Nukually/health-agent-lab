import type {
  ApiResponse,
  CheckInCardResponse,
  CheckInCardSaveRequest,
  CheckInCardSaveResponse,
  CheckInCommitRequest,
  CheckInCommitResponse,
  CheckInRecord,
  CheckInRecordListResponse,
  CheckInRecordUpdateRequest,
  CheckInRecordUpdateResponse,
  CheckInSchemaListResponse,
} from '@health-agent/shared'
import { api } from './api.js'

function unwrap<T>(payload: ApiResponse<T>): T {
  if (!payload.success) {
    throw new Error(payload.error || '请求失败')
  }
  return payload.data as T
}

export async function listCheckInSchemas() {
  const payload = await api.get<ApiResponse<CheckInSchemaListResponse>>('/check-ins/schemas')
  return unwrap(payload).schemas
}

export async function listCheckInRecords(query: { categoryKey?: string; cursor?: string; limit?: number } = {}) {
  const params = new URLSearchParams()
  if (query.categoryKey) params.set('categoryKey', query.categoryKey)
  if (query.cursor) params.set('cursor', query.cursor)
  if (query.limit) params.set('limit', String(query.limit))
  const suffix = params.toString() ? `?${params.toString()}` : ''
  const payload = await api.get<ApiResponse<CheckInRecordListResponse>>(`/check-ins/records${suffix}`)
  return unwrap(payload)
}

export async function collectCheckInRecords(
  fetchPage: (query: { categoryKey?: string; cursor?: string; limit?: number }) => Promise<CheckInRecordListResponse>,
  options: { categoryKey?: string; pageSize?: number; maxRecords?: number; maxPages?: number } = {},
): Promise<CheckInRecord[]> {
  const pageSize = Math.max(1, Math.min(options.pageSize ?? 50, 50))
  const maxRecords = options.maxRecords === undefined ? Number.POSITIVE_INFINITY : Math.max(1, options.maxRecords)
  const maxPages = Math.max(1, options.maxPages ?? 200)
  const records: CheckInRecord[] = []
  let cursor: string | undefined
  let pageCount = 0

  while (records.length < maxRecords && pageCount < maxPages) {
    pageCount += 1
    const page = await fetchPage({
      categoryKey: options.categoryKey,
      ...(cursor ? { cursor } : {}),
      limit: Math.min(pageSize, maxRecords - records.length),
    })
    records.push(...page.records.slice(0, maxRecords - records.length))
    if (!page.nextCursor || page.records.length === 0) break
    cursor = page.nextCursor
  }

  return records
}

export async function listAllCheckInRecords(query: { categoryKey?: string; maxRecords?: number } = {}) {
  return collectCheckInRecords(listCheckInRecords, {
    categoryKey: query.categoryKey,
    maxRecords: query.maxRecords,
  })
}

export async function getCheckInRecord(id: string) {
  const payload = await api.get<ApiResponse<CheckInRecord>>(`/check-ins/records/${id}`)
  return unwrap(payload)
}

export async function getCheckInCard(id: string) {
  const payload = await api.get<ApiResponse<CheckInCardResponse>>(`/check-ins/cards/${id}`)
  return unwrap(payload).card
}

export async function saveCheckInCard(id: string, body: CheckInCardSaveRequest) {
  const payload = await api.post<ApiResponse<CheckInCardSaveResponse>>(`/check-ins/cards/${id}/save`, body)
  return unwrap(payload)
}

export async function cancelCheckInCard(id: string) {
  const payload = await api.post<ApiResponse<CheckInCardResponse>>(`/check-ins/cards/${id}/cancel`, {})
  return unwrap(payload).card
}

export async function deleteCheckInRecord(id: string) {
  await api.delete<ApiResponse<{ deleted: boolean }>>(`/check-ins/records/${id}`)
}

export async function updateCheckInRecord(id: string, body: CheckInRecordUpdateRequest) {
  const payload = await api.patch<ApiResponse<CheckInRecordUpdateResponse>>(`/check-ins/records/${id}`, body)
  return unwrap(payload).record
}

export async function commitCheckInDraft(body: CheckInCommitRequest) {
  if (body.checkInCardId) {
    const result = await saveCheckInCard(body.checkInCardId, {
      values: body.values,
      note: body.note,
      tags: body.tags,
    })
    return result.record
  }
  const payload = await api.post<ApiResponse<CheckInCommitResponse>>('/check-ins/records/commit', body)
  return unwrap(payload).record
}
