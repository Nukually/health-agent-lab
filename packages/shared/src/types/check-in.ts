export type CheckInFieldType = 'text' | 'number' | 'boolean' | 'choice' | 'date'

export type CheckInValueStatus = 'normal' | 'abnormal' | 'critical' | 'neutral'

export type CheckInRecordedByType = 'agent' | 'user' | 'doctor' | 'system'

export type CheckInSchemaStatus = 'active' | 'archived'

export type CheckInDisplayMode = 'quantitative' | 'calendar'

export type CheckInCardStatus = 'draft' | 'saved' | 'invalidated' | 'deleted'

export interface CheckInFieldDefinition {
  key: string
  label: string
  type: CheckInFieldType
  unit?: string
  required?: boolean
  options?: string[]
}

export interface CheckInMetricGridBlock {
  type: 'metric_grid'
  bind: string[]
}

export interface CheckInKeyValueBlock {
  type: 'kv_list'
  bind: string[]
}

export interface CheckInNoteBlock {
  type: 'note'
  bind: 'note' | string
}

export interface CheckInImageGalleryBlock {
  type: 'image_gallery'
  bind: 'attachments'
}

export interface CheckInTagsBlock {
  type: 'tags'
  bind: 'tags'
}

export type CheckInA2uiLayoutBlock =
  | CheckInMetricGridBlock
  | CheckInKeyValueBlock
  | CheckInNoteBlock
  | CheckInImageGalleryBlock
  | CheckInTagsBlock

export interface CheckInA2uiSchema {
  version: 1
  kind: 'check_in_card'
  categoryKey: string
  categoryName: string
  displayMode: CheckInDisplayMode
  categoryDescription?: string
  titleTemplate: string
  aliases: string[]
  fields: CheckInFieldDefinition[]
  layout: CheckInA2uiLayoutBlock[]
}

export interface CheckInAttachment {
  url: string
  name?: string
  mimeType?: string
}

export type CheckInPrimitiveValue = string | number | boolean | null

export interface CheckInValueWithMeta {
  value: CheckInPrimitiveValue
  status?: CheckInValueStatus
  note?: string
}

export type CheckInValues = Record<string, CheckInPrimitiveValue | CheckInValueWithMeta>

export interface CheckInRenderedMetricItem {
  key: string
  label: string
  value: string
  unit?: string
  status?: CheckInValueStatus
}

export interface CheckInRenderedKeyValueItem {
  key: string
  label: string
  value: string
}

export type CheckInRenderedBlock =
  | { type: 'metric_grid'; items: CheckInRenderedMetricItem[] }
  | { type: 'kv_list'; items: CheckInRenderedKeyValueItem[] }
  | { type: 'note'; text: string }
  | { type: 'image_gallery'; images: CheckInAttachment[] }
  | { type: 'tags'; items: string[] }

export interface CheckInRenderedA2uiSchema {
  version: 1
  kind: 'check_in_record'
  title: string
  categoryKey: string
  categoryName: string
  recordedAt: string
  blocks: CheckInRenderedBlock[]
}

export interface CheckInSchemaRecord {
  id: string
  userId: string
  categoryKey: string
  categoryName: string
  displayMode: CheckInDisplayMode
  categoryDescription: string | null
  aliases: string[]
  schemaVersion: number
  schemaHash: string
  a2uiSchema: CheckInA2uiSchema
  status: CheckInSchemaStatus
  createdFromSessionId: string | null
  createdFromMessageId: string | null
  createdFromToolCallId: string | null
  createdAt: string
  updatedAt: string
  lastUsedAt: string | null
}

export interface CheckInRecord {
  id: string
  userId: string
  schemaId: string
  categoryKey: string
  schemaVersion: number
  title: string
  recordedAt: string
  recordedByType: CheckInRecordedByType
  recordedByName: string
  sourceSessionId: string | null
  sourceMessageId: string | null
  toolCallId: string | null
  valuesJson: CheckInValues
  attachmentsJson: CheckInAttachment[]
  renderedA2uiSchema: CheckInRenderedA2uiSchema
  schemaSnapshot: CheckInA2uiSchema
  tags: string[]
  createdAt: string
  updatedAt: string
}

export interface CheckInCardRecord {
  id: string
  userId: string
  sessionId: string
  sourceMessageId: string | null
  assistantMessageId: string | null
  toolCallId: string
  status: CheckInCardStatus
  recordId: string | null
  schemaActionHint: 'create' | 'use_existing'
  existingSchemaId: string | null
  categoryName: string
  displayMode: CheckInDisplayMode
  schema: CheckInA2uiSchema
  values: CheckInValues
  attachments: CheckInAttachment[]
  note: string | null
  tags: string[]
  recordedAt: string | null
  sourceEvidence: Record<string, string>
  missingFields: string[]
  record: CheckInRecord | null
  createdAt: string
  updatedAt: string
  savedAt: string | null
  deletedAt: string | null
}

export interface CheckInSchemaListResponse {
  schemas: CheckInSchemaRecord[]
}

export interface CheckInRecordListResponse {
  records: CheckInRecord[]
  nextCursor: string | null
}

export interface CheckInCardResponse {
  card: CheckInCardRecord
}

export interface CheckInToolOutput {
  action: 'schema_created' | 'record_created' | 'schema_candidates' | 'schema_not_found'
  schema?: CheckInSchemaRecord
  record?: CheckInRecord
  candidates?: Array<Pick<CheckInSchemaRecord, 'id' | 'categoryKey' | 'categoryName' | 'aliases'>>
  message: string
}

/** 工具调用产出的"草稿",尚未落库,由前端渲染成可编辑表单 */
export interface CheckInDraftToolOutput {
  action: 'draft_created' | 'draft_for_existing' | 'schema_candidates' | 'schema_not_found'
  checkInCardId?: string
  status?: CheckInCardStatus
  /** 本卡片生成后语义上替换掉的上一张未保存卡片 */
  supersedesCheckInCardId?: string | null
  /** 用户已明确委托保存时为 true;前端据此隐藏手动保存入口并置灰草稿现场 */
  isSave?: boolean
  draftToken?: string
  schemaActionHint?: 'create' | 'use_existing'
  /** 已有分类时回带的 schema(供前端 alias / categoryName 显示) */
  existingSchema?: Pick<CheckInSchemaRecord, 'id' | 'categoryKey' | 'categoryName' | 'displayMode' | 'aliases'>
  /** 草稿渲染体(标题/字段/已附图等) */
  draftRendered?: CheckInRenderedA2uiSchema
  /** 草稿 schema 本体,前端编辑表单要用 fields/layout */
  draftSchema?: CheckInA2uiSchema
  /** 草稿当前预填值 */
  draftValues?: CheckInValues
  /** 草稿当前已附图 */
  draftAttachments?: CheckInAttachment[]
  /** 候选分类(record 工具命中多个时) */
  candidates?: Array<Pick<CheckInSchemaRecord, 'id' | 'categoryKey' | 'categoryName' | 'aliases'>>
  message: string
}

export interface CheckInCommitRequest {
  draftToken?: string
  checkInCardId?: string
  values: CheckInValues
  note?: string | null
  tags?: string[]
}

export interface CheckInCommitResponse {
  record: CheckInRecord
  card?: CheckInCardRecord
}

export interface CheckInRecordUpdateRequest {
  values?: CheckInValues
  note?: string | null
  tags?: string[]
  recordedAt?: string | null
}

export interface CheckInRecordUpdateResponse {
  record: CheckInRecord
}

export interface CheckInCardSaveRequest {
  values?: CheckInValues
  note?: string | null
  tags?: string[]
}

export interface CheckInCardSaveResponse {
  card: CheckInCardRecord
  record: CheckInRecord
  action: 'created' | 'updated'
  recordId: string
}
