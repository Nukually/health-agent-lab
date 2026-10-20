import { createHash } from 'node:crypto'
import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import {
  resolveCheckInCardTitle,
  type CheckInA2uiLayoutBlock,
  type CheckInA2uiSchema,
  type CheckInAttachment,
  type CheckInCardRecord,
  type CheckInCardStatus,
  type CheckInDisplayMode,
  type CheckInDraftToolOutput,
  type CheckInFieldDefinition,
  type CheckInFieldType,
  type CheckInRecord,
  type CheckInRenderedA2uiSchema,
  type CheckInRenderedBlock,
  type CheckInRenderedKeyValueItem,
  type CheckInRenderedMetricItem,
  type CheckInSchemaRecord,
  type CheckInValueStatus,
  type CheckInValueWithMeta,
  type CheckInValues,
} from '@health-agent/shared'
import { getDb } from '../db/client.js'
import { checkInCards, checkInRecords, messages, userCheckInSchemas } from '../db/schema/index.js'
import type { Logger } from '../lib/logger.js'
import { stripSystemReminderText } from '../utils/system-reminder.js'
import {
  consumeCheckInDraft,
} from './check-in-draft.js'

const MAX_FIELDS = 12
const MAX_LAYOUT_BLOCKS = 8
const MAX_ALIAS_COUNT = 8
const MAX_TAG_COUNT = 12
const MAX_ATTACHMENT_COUNT = 8
const MAX_REMOTE_ATTACHMENT_URL_CHARS = 10_000
const MAX_DATA_IMAGE_URL_CHARS = 2_000_000
const FIELD_TYPES = new Set<CheckInFieldType>(['text', 'number', 'boolean', 'choice', 'date'])
const VALUE_STATUSES = new Set<CheckInValueStatus>(['normal', 'abnormal', 'critical', 'neutral'])
const DISPLAY_MODES = new Set<CheckInDisplayMode>(['quantitative', 'calendar'])

type DbSchemaRow = typeof userCheckInSchemas.$inferSelect
type DbRecordRow = typeof checkInRecords.$inferSelect
type DbCardRow = typeof checkInCards.$inferSelect

export interface CheckInSchemaDraftInput {
  categoryName?: unknown
  displayMode?: unknown
  categoryDescription?: unknown
  aliases?: unknown
  titleTemplate?: unknown
  fields?: unknown
  layout?: unknown
}

interface RenderRecordInput {
  schema: CheckInA2uiSchema
  title?: string
  recordedAt: string
  values: CheckInValues
  note?: string | null
  attachments?: CheckInAttachment[]
  tags?: string[]
}

export interface ProposeCheckInDraftInput {
  userId: string
  sessionId: string
  toolCallId: string
  sourceMessageId?: string | null
  draft: CheckInSchemaDraftInput
  draftValues?: CheckInValues | null
  draftNote?: string | null
  draftTags?: string[]
  attachments?: CheckInAttachment[]
  recordedAt?: string | null
  sourceText?: string | null
  supersedesCheckInCardId?: string | null
}

export interface ProposeCheckInRecordInput {
  userId: string
  sessionId: string
  toolCallId: string
  sourceMessageId?: string | null
  categoryKey?: string | null
  categoryQuery: string
  fallbackSchema?: CheckInSchemaDraftInput | null
  draftValues?: CheckInValues | null
  draftNote?: string | null
  draftTags?: string[]
  attachments?: CheckInAttachment[]
  recordedAt?: string | null
  sourceText?: string | null
  supersedesCheckInCardId?: string | null
}

export interface CommitCheckInDraftInput {
  userId: string
  draftToken?: string
  checkInCardId?: string
  values?: CheckInValues
  note?: string | null
  tags?: string[]
  recordedByName?: string
}

export interface SaveCheckInCardInput {
  userId: string
  cardId: string
  values?: CheckInValues | null
  note?: string | null
  tags?: string[]
  recordedByName?: string
}

export interface SaveCheckInCardResult {
  card: CheckInCardRecord
  record: CheckInRecord
  action: 'created' | 'updated'
}

export interface CancelCheckInCardResult {
  card: CheckInCardRecord
}

export interface UpdateCheckInRecordInput {
  userId: string
  recordId: string
  values?: CheckInValues | null
  note?: string | null
  tags?: string[]
  recordedAt?: string | null
}

export interface CheckInDraftCardPromptSummary {
  id: string
  categoryName: string
  recordedAt: string | null
  fields: Array<Pick<CheckInFieldDefinition, 'key' | 'label' | 'type' | 'unit' | 'required'>>
  values: CheckInValues
  note: string | null
  attachmentCount: number
  updatedAt: string
}

export type CheckInSchemaMatchResult =
  | {
    action: 'matched'
    schema: CheckInSchemaRecord
    candidates: []
    message: string
  }
  | {
    action: 'candidates'
    schema?: undefined
    candidates: Array<Pick<CheckInSchemaRecord, 'id' | 'categoryKey' | 'categoryName' | 'aliases'>>
    message: string
  }
  | {
    action: 'not_found'
    schema?: undefined
    candidates: []
    message: string
  }

function trimString(value: unknown, max = 500): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

export function extractCheckInSourceTextFromMessageContent(content: string): string | null {
  const parseText = (value: unknown): string | null => {
    if (typeof value !== 'string') return null
    const text = stripSystemReminderText(value).trim()
    return text || null
  }

  try {
    const parsed = JSON.parse(content)
    if (Array.isArray(parsed)) {
      const text = parsed
        .map((block) => parseText(block?.text))
        .filter(Boolean)
        .join('\n')
      return text || null
    }
  } catch {
    // Plain text content is expected for non-multimodal messages.
  }

  return parseText(content)
}

async function resolveCheckInSourceText(
  sourceText?: string | null,
  sourceMessageId?: string | null,
): Promise<string | null> {
  const direct = extractCheckInSourceTextFromMessageContent(sourceText ?? '')
  if (direct) return direct
  if (!sourceMessageId) return null

  const row = await getDb().query.messages.findFirst({
    where: and(eq(messages.id, sourceMessageId), eq(messages.role, 'user')),
    columns: { content: true },
  })
  return row ? extractCheckInSourceTextFromMessageContent(row.content) : null
}

function uniqueStrings(value: unknown, maxCount: number, maxLen: number): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const result: string[] = []
  for (const item of value) {
    const text = trimString(item, maxLen)
    if (!text || seen.has(text)) continue
    seen.add(text)
    result.push(text)
    if (result.length >= maxCount) break
  }
  return result
}

function hashText(value: string): string {
  return createHash('sha1').update(value).digest('hex')
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function inferDisplayMode(fields: CheckInFieldDefinition[]): CheckInDisplayMode {
  return fields.some((field) => field.type === 'number') ? 'quantitative' : 'calendar'
}

function normalizeDisplayMode(value: unknown, fields: CheckInFieldDefinition[]): CheckInDisplayMode {
  return DISPLAY_MODES.has(value as CheckInDisplayMode)
    ? value as CheckInDisplayMode
    : inferDisplayMode(fields)
}

function valueForFallbackField(value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value) && 'value' in value) {
    return (value as { value?: unknown }).value
  }
  return value
}

const FALLBACK_FIELD_LABELS: Record<string, string> = {
  affects_sleep: '是否影响睡眠',
  amount: '数量',
  accommodation: '住宿',
  anxiety_level: '焦虑程度',
  activity: '活动/行程',
  activities: '活动/行程',
  activity_type: '运动类型',
  beverage: '饮品',
  bp_diastolic: '舒张压',
  bp_systolic: '收缩压',
  content: '记录内容',
  date: '日期',
  destination: '目的地',
  dosage: '剂量',
  dose: '剂量',
  drink: '饮品',
  duration: '时长',
  duration_min: '运动时长',
  dairy: '乳制品',
  dairy_product: '乳制品',
  dairy_products: '乳制品',
  food: '饮食内容',
  food_content: '食物内容',
  food_items: '饮食内容',
  fruit: '水果',
  fruits: '水果',
  location: '部位',
  main_food: '主食',
  staple: '主食',
  staple_food: '主食',
  medication: '药物',
  medication_name: '药物名称',
  medication_taken: '是否服药',
  meal_type: '餐次',
  meal_content: '饮食内容',
  memo: '备注',
  missed: '是否漏服',
  mood: '情绪状态',
  name: '名称',
  nausea: '恶心',
  note: '备注',
  pain: '疼痛程度',
  pain_level: '疼痛程度',
  pain_score: '疼痛程度',
  pulse: '脉搏',
  protein: '蛋白质类',
  protein_food: '蛋白质类',
  redness: '是否发红',
  relief: '缓解情况',
  soup: '汤水',
  record_date: '记录日期',
  fever: '是否发热',
  symptom: '症状',
  symptoms: '症状',
  step_count: '步数',
  steps: '步数',
  trigger: '触发原因',
  systolic: '收缩压',
  systolic_bp: '收缩压',
  side_effect: '不适反应',
  diastolic: '舒张压',
  diastolic_bp: '舒张压',
  bloating: '是否腹胀',
  taken: '是否服药',
  temperature: '体温',
  time: '时间',
  timing: '时间',
  travel_date: '日期',
  trip_date: '日期',
  value: '数值',
  vegetable: '蔬菜',
  vegetables: '蔬菜',
  weight: '体重',
  weight_kg: '体重',
}

function fallbackFieldLabel(key: string): string {
  const normalized = key.trim().toLowerCase()
  if (FALLBACK_FIELD_LABELS[normalized]) return FALLBACK_FIELD_LABELS[normalized]
  const translatedParts = normalized
    .split(/[_\-/\s]+/)
    .filter(Boolean)
    .map((part) => FALLBACK_FIELD_LABELS[part])
    .filter((part): part is string => !!part)
  if (translatedParts.length) {
    return [...new Set(translatedParts)].join('')
  }
  return '记录内容'
}

function fallbackFieldType(value: unknown): CheckInFieldType {
  const raw = valueForFallbackField(value)
  if (typeof raw === 'boolean') return 'boolean'
  if (typeof raw === 'number' && Number.isFinite(raw)) return 'number'
  if (typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.trim())) return 'date'
  return 'text'
}

function hasChineseText(value: string): boolean {
  return /[\u3400-\u9fff]/.test(value)
}

function hasLatinText(value: string): boolean {
  return /[A-Za-z]/.test(value)
}

function extractChineseLabelText(value: string): string | null {
  const segments = value
    .split(/[\\/_|,，;；:：]+/)
    .map((segment) => segment.replace(/[A-Za-z0-9()[\]{}<>]+/g, '').trim())
    .filter((segment) => hasChineseText(segment))
  const direct = segments.at(-1)
  if (direct) return direct.slice(0, 80)
  const onlyChinese = value.replace(/[^\u3400-\u9fff]+/g, '').trim()
  return onlyChinese || null
}

function isLowQualityFieldLabelText(label: string): boolean {
  if (!label) return true
  if (hasChineseText(label)) return /[a-z]/i.test(label) && /[\\/_-]/.test(label)
  return /^[a-z][a-z0-9_\-/ ]*$/i.test(label)
}

function normalizeFieldLabel(rawLabel: unknown, key: string): string | null {
  const label = trimString(rawLabel, 80)
  const fallback = fallbackFieldLabel(key)
  if (!label) return fallback
  if (!hasLatinText(label) && hasChineseText(label)) return label
  if (fallback !== '记录内容') return fallback
  const chineseLabel = extractChineseLabelText(label)
  if (chineseLabel) return chineseLabel
  if (!isLowQualityFieldLabelText(label) && hasChineseText(label)) return label
  return fallback
}

function isLowQualityFieldLabel(field: CheckInFieldDefinition): boolean {
  return isLowQualityFieldLabelText(trimString(field.label, 80))
}

function sourceLooksLikeFoodRecord(sourceText?: string | null, categoryQuery?: string | null): boolean {
  const text = `${categoryQuery ?? ''}\n${sourceText ?? ''}`
  if (/(服药|用药|吃药|药物|药名|剂量|漏服|降压药|高血压药|他莫昔芬|来曲唑|阿那曲唑|依西美坦|托瑞米芬|卡培他滨|mg|毫克)/.test(text)) {
    return /(饮食|餐食|用餐|吃饭|三餐|早餐吃|早饭吃|午餐吃|午饭吃|晚餐吃|晚饭吃|加餐)/.test(text)
  }
  return /(饮食|餐食|用餐|吃饭|三餐|早餐|早饭|午餐|午饭|晚餐|晚饭|加餐|吃了|吃的是|吃过)/.test(text)
}

function schemaHasFoodContentField(schema: CheckInA2uiSchema): boolean {
  return schema.fields.some((field) =>
    matchesField(field, [/food_content/, /food_items/, /main_food/, /main_dish/, /staple/, /食物/, /进食/, /饮食内容/, /主食/, /吃了什么/, /蛋白/]),
  )
}

function buildFoodCheckInSchemaDraft(input: {
  categoryName: string
  aliases?: unknown
  categoryDescription?: unknown
  titleTemplate?: unknown
}): CheckInSchemaDraftInput {
  return {
    categoryName: input.categoryName,
    displayMode: 'calendar',
    categoryDescription: input.categoryDescription,
    aliases: input.aliases,
    titleTemplate: input.titleTemplate,
    fields: [
      { key: 'meal_type', label: '餐次', type: 'choice', options: ['早餐', '午餐', '晚餐', '加餐'], required: true },
      { key: 'food_content', label: '食物内容', type: 'text', required: true },
    ],
    layout: [
      { type: 'kv_list', bind: ['meal_type', 'food_content'] },
      { type: 'note', bind: 'note' },
      { type: 'image_gallery', bind: 'attachments' },
      { type: 'tags', bind: 'tags' },
    ],
  }
}

export function buildFallbackCheckInSchemaDraft(input: {
  categoryQuery: string
  draftValues?: CheckInValues | null
  fallbackSchema?: CheckInSchemaDraftInput | null
  sourceText?: string | null
}): CheckInSchemaDraftInput {
  const fallback = input.fallbackSchema ?? null
  const fallbackFields = Array.isArray(fallback?.fields) ? fallback.fields : []
  if (fallbackFields.length > 0) {
    return buildContentFirstCheckInSchemaDraft({
      categoryQuery: input.categoryQuery,
      draftValues: input.draftValues,
      sourceText: input.sourceText,
      fallbackSchema: {
        categoryName: trimString(fallback?.categoryName, 80) || trimString(input.categoryQuery, 80) || '打卡记录',
        displayMode: fallback?.displayMode,
        categoryDescription: fallback?.categoryDescription,
        aliases: fallback?.aliases,
        titleTemplate: fallback?.titleTemplate,
        fields: fallbackFields,
        layout: fallback?.layout,
      },
    })
  }

  const values = input.draftValues && typeof input.draftValues === 'object' ? input.draftValues : {}
  const fields = Object.entries(values)
    .filter(([, value]) => {
      const raw = valueForFallbackField(value)
      return raw !== null && raw !== undefined && raw !== ''
    })
    .slice(0, 6)
    .map(([key, value]) => ({
      key,
      label: fallbackFieldLabel(key),
      type: fallbackFieldType(value),
    }))

  return buildContentFirstCheckInSchemaDraft({
    categoryQuery: input.categoryQuery,
    draftValues: input.draftValues,
    sourceText: input.sourceText,
    fallbackSchema: {
      categoryName: trimString(fallback?.categoryName, 80) || trimString(input.categoryQuery, 80) || '打卡记录',
      displayMode: fallback?.displayMode,
      categoryDescription: fallback?.categoryDescription,
      aliases: fallback?.aliases,
      titleTemplate: fallback?.titleTemplate,
      fields: fields.length ? fields : [
        { key: 'content', label: '记录内容', type: 'text' },
      ],
      layout: fallback?.layout,
    },
  })
}

const DRAFT_VALUE_SCHEMA_EXCLUDED_KEYS = new Set(['note', 'memo', 'remark', 'remarks', 'comment', 'comments', '备注'])

interface SourceDerivedFact {
  field: {
    key: string
    label: string
    type: CheckInFieldType
    unit?: string
    required?: boolean
  }
  value: unknown
}

function draftValueEntriesForSchema(values: CheckInValues | null | undefined): Array<[string, unknown]> {
  if (!values || typeof values !== 'object') return []
  return Object.entries(values).filter(([key, value]) => {
    if (DRAFT_VALUE_SCHEMA_EXCLUDED_KEYS.has(key.trim().toLowerCase())) return false
    return !isEmptyCheckInValue(valueForFallbackField(value))
  })
}

function valuesEquivalentForCoverage(left: unknown, right: unknown): boolean {
  const leftValue = valueForFallbackField(left)
  const rightValue = valueForFallbackField(right)
  if (typeof leftValue === 'number' && typeof rightValue === 'number') {
    return Number.isFinite(leftValue) && Number.isFinite(rightValue) && Math.abs(leftValue - rightValue) < 0.0001
  }
  return String(leftValue).trim() === String(rightValue).trim()
}

function draftValuesAlreadyContainValue(values: CheckInValues | null | undefined, sourceValue: unknown): boolean {
  return draftValueEntriesForSchema(values).some(([, value]) => valuesEquivalentForCoverage(value, sourceValue))
}

function countProjectedValues(values: CheckInValues | null | undefined, schema: CheckInA2uiSchema): number {
  return Object.keys(projectValuesToFields(values, schema)).length
}

function fieldComparableText(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s\-_:/／\\|，,。；;（）()【】[\]{}]+/g, '')
}

function fieldsAreCompatible(left: CheckInFieldDefinition, right: CheckInFieldDefinition): boolean {
  const leftKey = fieldComparableText(left.key)
  const rightKey = fieldComparableText(right.key)
  if (leftKey && leftKey === rightKey) return true
  const leftLabel = fieldComparableText(left.label)
  const rightLabel = fieldComparableText(right.label)
  return !!leftLabel && leftLabel === rightLabel
}

function countFieldsCoveredBy(target: CheckInA2uiSchema, source: CheckInA2uiSchema): number {
  return source.fields.filter((sourceField) =>
    target.fields.some((targetField) => fieldsAreCompatible(targetField, sourceField)),
  ).length
}

function replacementAddsFields(existing: CheckInA2uiSchema, replacement: CheckInA2uiSchema): boolean {
  const existingFieldsCovered = countFieldsCoveredBy(replacement, existing)
  const replacementFieldsCovered = countFieldsCoveredBy(existing, replacement)
  if (existingFieldsCovered === existing.fields.length && replacement.fields.length > existing.fields.length) return true
  return replacementFieldsCovered === 0 && existingFieldsCovered === 0
}

function rawFieldCoversDraftValueKey(field: unknown, key: string): boolean {
  if (!field || typeof field !== 'object') return false
  const raw = field as Record<string, unknown>
  const comparableKey = fieldComparableText(key)
  const fieldKey = trimString(raw.key, 80)
  if (fieldKey && fieldComparableText(fieldKey) === comparableKey) return true
  const fieldLabel = trimString(raw.label, 80)
  return !!fieldLabel && fieldComparableText(fieldLabel) === comparableKey
}

function sourceDerivedFieldKey(label: string, fallback: string): string {
  const ascii = fallback
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
  if (ascii) return ascii
  return `fact_${hashText(label).slice(0, 8)}`
}

function cleanSourceFactPrefix(value: string): string {
  const tail = value
    .split(/[：:]/)
    .pop() ?? value
  return tail
    .replace(/^(今天|今晚|现在|刚才|请|帮我|记录|记下|生成|打卡|我的|为我|给我)+/g, '')
    .replace(/^(早饭后|早餐后|午饭后|午餐后|晚饭后|晚餐后|饭后|睡前|早上|中午|晚上|夜间)+/g, '')
    .replace(/(吃了|喝了|用了|服用|记录)$/g, '')
    .replace(/[^\u3400-\u9fffA-Za-z0-9]+/g, '')
    .trim()
    .slice(-12)
}

function unitMeta(unit: string): { key: string; label: string; unit: string } {
  const normalized = unit.toLowerCase()
  if (normalized === 'mg' || unit === '毫克') return { key: 'dose', label: '剂量', unit: 'mg' }
  if (normalized === 'kg' || unit === '公斤') return { key: 'weight', label: '体重', unit: 'kg' }
  if (unit === '斤') return { key: 'weight', label: '体重', unit: '斤' }
  if (unit === '°c' || unit === '℃' || unit === '度') return { key: 'temperature', label: '体温', unit: '°C' }
  if (normalized === 'cm' || unit === '厘米') return { key: 'measurement', label: '数值', unit: 'cm' }
  if (normalized === 'ml' || unit === '毫升') return { key: 'amount', label: '数量', unit: 'ml' }
  if (unit === '小时') return { key: 'duration', label: '时长', unit: '小时' }
  if (unit === '分钟') return { key: 'duration', label: '时长', unit: '分钟' }
  if (unit === '步') return { key: 'step_count', label: '步数', unit: '步' }
  if (unit === '次') return { key: 'count', label: '次数', unit: '次' }
  if (unit === '分') return { key: 'score', label: '评分', unit: '分' }
  return { key: 'value', label: '数值', unit }
}

function shouldUsePrefixAsNumberLabel(prefix: string, unit: string): boolean {
  if (!prefix || prefix.length > 8) return false
  if (/^(约|约有|大概|大约|左右|近|将近)$/.test(prefix)) return false
  if (unit === '步') return false
  if (/^(他|她|我|已|未|没|无|有|还|吃|喝|服|用|记录|打卡)/.test(prefix)) return false
  if ((unit.toLowerCase() === 'mg' || unit === '毫克') && !/(剂量|药量)/.test(prefix)) return false
  return true
}

function addSourceFact(
  facts: SourceDerivedFact[],
  usedKeys: Set<string>,
  fact: SourceDerivedFact,
) {
  if (isEmptyCheckInValue(fact.value)) return
  let key = fact.field.key
  let index = 2
  while (usedKeys.has(key)) {
    key = `${fact.field.key}_${index}`
    index++
  }
  usedKeys.add(key)
  facts.push({ ...fact, field: { ...fact.field, key } })
}

function deriveSourceFacts(sourceText?: string | null): SourceDerivedFact[] {
  const text = trimString(sourceText, 2000)
  if (!text) return []

  const facts: SourceDerivedFact[] = []
  const usedKeys = new Set<string>()

  const systolic = text.match(/收缩压(?:是|为)?\s*(\d{2,3})/)?.[1]
  const diastolic = text.match(/舒张压(?:是|为)?\s*(\d{2,3})/)?.[1]
  const pulse = text.match(/脉搏(?:是|为)?\s*(\d{2,3})/)?.[1]
  const slashBloodPressure = text.match(/血压(?:是|为)?\s*(\d{2,3})\s*[\\/／-]\s*(\d{2,3})/)
  const resolvedSystolic = systolic ?? slashBloodPressure?.[1]
  const resolvedDiastolic = diastolic ?? slashBloodPressure?.[2]
  if (resolvedSystolic) {
    addSourceFact(facts, usedKeys, {
      field: { key: 'systolic', label: '收缩压', type: 'number', unit: 'mmHg', required: true },
      value: Number(resolvedSystolic),
    })
  }
  if (resolvedDiastolic) {
    addSourceFact(facts, usedKeys, {
      field: { key: 'diastolic', label: '舒张压', type: 'number', unit: 'mmHg', required: true },
      value: Number(resolvedDiastolic),
    })
  }
  if (pulse) {
    addSourceFact(facts, usedKeys, {
      field: { key: 'pulse', label: '脉搏', type: 'number', unit: '次/分', required: true },
      value: Number(pulse),
    })
  }

  const numberUnitRe = /([\u3400-\u9fffA-Za-z0-9：:]{0,18}?)(-?\d+(?:\.\d+)?)\s*(mg|毫克|kg|公斤|斤|°C|℃|度|厘米|cm|ml|毫升|小时|分钟|步|次|分)/gi

  for (const chunk of text.split(/[，,。；;\n]/)) {
    numberUnitRe.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = numberUnitRe.exec(chunk)) !== null) {
      const prefix = cleanSourceFactPrefix(match[1] ?? '')
      const numeric = Number(match[2])
      if (!Number.isFinite(numeric)) continue
      const unit = match[3]
      const meta = unitMeta(unit)
      const label = shouldUsePrefixAsNumberLabel(prefix, unit) ? prefix : meta.label
      const key = sourceDerivedFieldKey(label, shouldUsePrefixAsNumberLabel(prefix, unit) ? `value_${hashText(label).slice(0, 6)}` : meta.key)

      addSourceFact(facts, usedKeys, {
        field: { key, label, type: 'number', unit: meta.unit, required: true },
        value: numeric,
      })

      if ((unit.toLowerCase() === 'mg' || unit === '毫克') && prefix && !/(剂量|药量)/.test(prefix)) {
        addSourceFact(facts, usedKeys, {
          field: { key: 'item_name', label: '名称', type: 'text', required: true },
          value: prefix,
        })
      }
    }
  }

  const timePhrase = text.match(/(早饭后|早餐后|午饭后|午餐后|晚饭后|晚餐后|饭后|睡前|睡前|起床后|早上|上午|中午|下午|晚上|夜间|刚才)/)?.[1]
  if (timePhrase) {
    addSourceFact(facts, usedKeys, {
      field: { key: 'time', label: '时间', type: 'text' },
      value: timePhrase,
    })
  }

  const activityPhrase = text.match(/(散步|快走|慢跑|跑步|瑜伽|骑车|游泳|拉伸|康复操|健身操)/)?.[1]
  if (activityPhrase) {
    addSourceFact(facts, usedKeys, {
      field: { key: 'activity_type', label: '运动类型', type: 'text' },
      value: activityPhrase,
    })
  }

  const locationPhrase = text.match(/((?:左|右|双)侧?[\u3400-\u9fff]{0,8}(?:切口|伤口|腋下|腋窝|手臂|上臂|前臂|手|臂|腿|肩|胸部|乳房))/)?.[1]
  if (locationPhrase) {
    addSourceFact(facts, usedKeys, {
      field: { key: 'location', label: '部位', type: 'text' },
      value: locationPhrase,
    })
  }

  const qualityMatch = text.match(/(睡眠质量|活动度|精神状态|食欲|胃口|心情|感受|状态)(?:是|为|还)?(一般|还可以|尚可|不错|很好|较好|好|不好|较差|差|偏差)/)
  if (qualityMatch?.[1] && qualityMatch[2]) {
    addSourceFact(facts, usedKeys, {
      field: {
        key: sourceDerivedFieldKey(qualityMatch[1], `quality_${hashText(qualityMatch[1]).slice(0, 6)}`),
        label: qualityMatch[1],
        type: 'text',
      },
      value: qualityMatch[2],
    })
  }

  const negativeRe = /(?:没有|没|未|无)([\u3400-\u9fff]{1,6})/g
  let negativeMatch: RegExpExecArray | null
  while ((negativeMatch = negativeRe.exec(text)) !== null) {
    const term = negativeMatch[1].replace(/[了的]$/g, '')
    if (!term || /^(吃|喝|服|用|发热)$/.test(term)) continue
    addSourceFact(facts, usedKeys, {
      field: {
        key: sourceDerivedFieldKey(`是否${term}`, `flag_${hashText(term).slice(0, 6)}`),
        label: `是否${term}`,
        type: 'boolean',
      },
      value: false,
    })
  }

  const qualitative = text.match(/(?:轻微|明显|严重|有点|比较|很)[\u3400-\u9fff]{1,6}/)?.[0]
  if (qualitative && !/程度|字段|记录/.test(qualitative) && !facts.some((fact) => String(fact.value).includes(qualitative))) {
    addSourceFact(facts, usedKeys, {
      field: { key: 'detail', label: '补充情况', type: 'text' },
      value: qualitative,
    })
  }

  return facts.slice(0, 6)
}

function sourceDerivedValuesFromText(sourceText?: string | null): CheckInValues {
  return Object.fromEntries(deriveSourceFacts(sourceText).map((fact) => [fact.field.key, fact.value])) as CheckInValues
}

function buildSourceDerivedCheckInSchemaDraft(input: {
  categoryQuery: string
  sourceText?: string | null
  fallbackSchema?: CheckInSchemaDraftInput | null
}): CheckInSchemaDraftInput | null {
  const facts = deriveSourceFacts(input.sourceText)
  if (facts.length === 0) return null
  const fallback = input.fallbackSchema ?? null
  return {
    categoryName: trimString(fallback?.categoryName, 80) || trimString(input.categoryQuery, 80) || '打卡记录',
    displayMode: fallback?.displayMode,
    categoryDescription: fallback?.categoryDescription,
    aliases: fallback?.aliases,
    titleTemplate: fallback?.titleTemplate,
    fields: facts.map((fact) => fact.field),
  }
}

function buildContentFirstCheckInSchemaDraft(input: {
  categoryQuery: string
  draftValues?: CheckInValues | null
  sourceText?: string | null
  fallbackSchema: CheckInSchemaDraftInput
}): CheckInSchemaDraftInput {
  const fallback = input.fallbackSchema
  const sourceDraft = buildSourceDerivedCheckInSchemaDraft(input)
  if (!sourceDraft) return fallback

  const sourceValues = sourceDerivedValuesFromText(input.sourceText)
  const fallbackSchema = normalizeCheckInSchemaDraft(fallback)
  const sourceSchema = normalizeCheckInSchemaDraft(sourceDraft)
  const fallbackCoverage = countProjectedValues(sourceValues, fallbackSchema)
  const sourceCoverage = countProjectedValues(sourceValues, sourceSchema)
  const draftCoverage = countProjectedValues(input.draftValues, fallbackSchema)

  if (sourceCoverage >= 3 && fallbackCoverage === 0) return sourceDraft
  const fallbackFields = Array.isArray(fallback.fields) ? fallback.fields : []
  const sourceFields = Array.isArray(sourceDraft.fields) ? sourceDraft.fields : []
  if (sourceCoverage <= fallbackCoverage) return fallback
  if (draftCoverage > 0) {
    const uncoveredSourceFields = sourceFields.filter((sourceField) => {
      if (!sourceField || typeof sourceField !== 'object') return false
      const raw = sourceField as Record<string, unknown>
      const key = trimString(raw.key, 80)
      const label = trimString(raw.label, 80)
      if (!key) return false
      if (key in sourceValues && draftValuesAlreadyContainValue(input.draftValues, sourceValues[key])) return false
      return !fallbackFields.some((field) =>
        rawFieldCoversDraftValueKey(field, key) ||
        (label ? rawFieldCoversDraftValueKey(field, label) : false),
      )
    })
    return uncoveredSourceFields.length
      ? {
          ...fallback,
          fields: [...fallbackFields, ...uncoveredSourceFields].slice(0, MAX_FIELDS),
          layout: undefined,
        }
      : fallback
  }

  const mergedFields = [
    ...fallbackFields,
    ...sourceFields.filter((sourceField) => {
      const sourceKey = typeof sourceField === 'object' && sourceField !== null
        ? trimString((sourceField as Record<string, unknown>).key, 80)
        : ''
      return sourceKey && !fallbackFields.some((field) => rawFieldCoversDraftValueKey(field, sourceKey))
    }),
  ].slice(0, MAX_FIELDS)

  return {
    ...fallback,
    fields: mergedFields,
    layout: undefined,
  }
}

function buildContentSchemaDraft(input: {
  existing: CheckInA2uiSchema
  categoryQuery: string
  draftValues?: CheckInValues | null
  fallbackSchema?: CheckInSchemaDraftInput | null
  sourceText?: string | null
}): CheckInSchemaDraftInput | null {
  const fallbackFields = Array.isArray(input.fallbackSchema?.fields) ? input.fallbackSchema.fields : []
  if (fallbackFields.length > 0) {
    const missingDraftValueFields = draftValueEntriesForSchema(input.draftValues)
      .filter(([key]) => !fallbackFields.some((field) => rawFieldCoversDraftValueKey(field, key)))
      .map(([key, value]) => ({
        key,
        label: fallbackFieldLabel(key),
        type: fallbackFieldType(value),
      }))
    return buildFallbackCheckInSchemaDraft({
      categoryQuery: input.categoryQuery || input.existing.categoryName,
      draftValues: input.draftValues,
      sourceText: input.sourceText,
      fallbackSchema: {
        ...input.fallbackSchema,
        categoryName: trimString(input.fallbackSchema?.categoryName, 80) || input.existing.categoryName,
        aliases: input.fallbackSchema?.aliases ?? input.existing.aliases,
        categoryDescription: input.fallbackSchema?.categoryDescription ?? input.existing.categoryDescription,
        titleTemplate: input.fallbackSchema?.titleTemplate ?? input.existing.titleTemplate,
        fields: [...fallbackFields, ...missingDraftValueFields],
      },
    })
  }

  const entries = draftValueEntriesForSchema(input.draftValues)
  if (entries.length === 0) {
    const sourceDraft = buildSourceDerivedCheckInSchemaDraft({
      categoryQuery: input.categoryQuery || input.existing.categoryName,
      sourceText: input.sourceText,
      fallbackSchema: {
        categoryName: input.existing.categoryName,
        aliases: input.existing.aliases,
        categoryDescription: input.existing.categoryDescription,
        titleTemplate: input.existing.titleTemplate,
      },
    })
    return sourceDraft
  }
  const missingDraftValueFields = entries
    .filter(([key]) => !input.existing.fields.some((field) => rawFieldCoversDraftValueKey(field, key)))
    .map(([key, value]) => ({
      key,
      label: fallbackFieldLabel(key),
      type: fallbackFieldType(value),
    }))
  const existingDraftCoverage = countProjectedValues(input.draftValues, input.existing)
  const baseFields = existingDraftCoverage === 0 && missingDraftValueFields.length > 0
    ? missingDraftValueFields
    : [...input.existing.fields, ...missingDraftValueFields]
  return buildFallbackCheckInSchemaDraft({
    categoryQuery: input.categoryQuery || input.existing.categoryName,
    draftValues: Object.fromEntries(entries) as CheckInValues,
    sourceText: input.sourceText,
    fallbackSchema: {
      categoryName: input.existing.categoryName,
      aliases: input.existing.aliases,
      categoryDescription: input.existing.categoryDescription,
      titleTemplate: input.existing.titleTemplate,
      fields: baseFields,
      layout: input.existing.layout,
      displayMode: input.existing.displayMode,
    },
  })
}

function shouldPreferContentSchema(input: {
  existing: CheckInA2uiSchema
  replacement: CheckInA2uiSchema
  draftValues?: CheckInValues | null
  sourceText?: string | null
}): boolean {
  const existingValueCoverage = countProjectedValues(input.draftValues, input.existing)
  const replacementValueCoverage = countProjectedValues(input.draftValues, input.replacement)
  if (replacementValueCoverage > existingValueCoverage) return true

  const sourceValues = sourceDerivedValuesFromText(input.sourceText)
  const existingSourceCoverage = countProjectedValues(sourceValues, input.existing)
  const replacementSourceCoverage = countProjectedValues(sourceValues, input.replacement)
  if (replacementSourceCoverage >= 3 && existingSourceCoverage === 0) return true
  if (
    replacementSourceCoverage > existingSourceCoverage &&
    'location' in sourceValues &&
    input.replacement.fields.some((field) => field.key === 'location' || field.label === '部位')
  ) return true
  if (replacementSourceCoverage >= 3 && replacementSourceCoverage > existingSourceCoverage) return true

  const hasDraftValues = draftValueEntriesForSchema(input.draftValues).length > 0
  if (!hasDraftValues && replacementAddsFields(input.existing, input.replacement)) return true

  return false
}

export function shouldReplaceExistingCheckInSchema(input: {
  existing: CheckInA2uiSchema
  categoryQuery: string
  draftValues?: CheckInValues | null
  sourceText?: string | null
  fallbackSchema?: CheckInSchemaDraftInput | null
}): boolean {
  const contentSchemaDraft = buildContentSchemaDraft(input)
  if (contentSchemaDraft) {
    const replacement = normalizeCheckInSchemaDraft(contentSchemaDraft)
    if (shouldPreferContentSchema({
      existing: input.existing,
      replacement,
      draftValues: input.draftValues,
      sourceText: input.sourceText,
    })) return true
  }

  const isFoodLike = isFoodRecordSchema(input.existing) || sourceLooksLikeFoodRecord(input.sourceText, input.categoryQuery)
  const hasLowQualityLabels = input.existing.fields.some(isLowQualityFieldLabel)
  if (hasLowQualityLabels) {
    if (isFoodLike) return true
    const replacement = normalizeCheckInSchemaDraft(buildReplacementCheckInSchemaDraft({
      existing: input.existing,
      categoryQuery: input.categoryQuery,
      draftValues: input.draftValues,
      sourceText: input.sourceText,
      fallbackSchema: input.fallbackSchema,
    }))
    if (!replacement.fields.some(isLowQualityFieldLabel)) return true
  }

  if (isFoodLike && sourceLooksLikeFoodRecord(input.sourceText, input.categoryQuery) && !schemaHasFoodContentField(input.existing)) {
    return true
  }

  if (input.fallbackSchema && Array.isArray(input.fallbackSchema.fields) && input.fallbackSchema.fields.length > 0) {
    const replacement = normalizeCheckInSchemaDraft(buildFallbackCheckInSchemaDraft({
      categoryQuery: input.categoryQuery,
      draftValues: input.draftValues,
      fallbackSchema: input.fallbackSchema,
    }))
    const projectedExisting = projectValuesToFields(input.draftValues, input.existing)
    const projectedReplacement = projectValuesToFields(input.draftValues, replacement)
    if (Object.keys(projectedExisting).length === 0 && Object.keys(projectedReplacement).length > 0) return true
  }

  return false
}

export function buildReplacementCheckInSchemaDraft(input: {
  existing: CheckInA2uiSchema
  categoryQuery: string
  draftValues?: CheckInValues | null
  sourceText?: string | null
  fallbackSchema?: CheckInSchemaDraftInput | null
}): CheckInSchemaDraftInput {
  const contentSchemaDraft = buildContentSchemaDraft(input)
  if (contentSchemaDraft) {
    const replacement = normalizeCheckInSchemaDraft(contentSchemaDraft)
    if (shouldPreferContentSchema({
      existing: input.existing,
      replacement,
      draftValues: input.draftValues,
      sourceText: input.sourceText,
    })) return contentSchemaDraft
  }

  const fallback = input.fallbackSchema ?? null
  const fallbackFields = Array.isArray(fallback?.fields) ? fallback.fields : []
  if (fallback && fallbackFields.length > 0) {
    return buildFallbackCheckInSchemaDraft({
      categoryQuery: input.categoryQuery,
      draftValues: input.draftValues,
      fallbackSchema: {
        ...fallback,
        categoryName: trimString(fallback.categoryName, 80) || input.existing.categoryName,
        aliases: fallback.aliases ?? input.existing.aliases,
        categoryDescription: fallback.categoryDescription ?? input.existing.categoryDescription,
        titleTemplate: fallback.titleTemplate ?? input.existing.titleTemplate,
      },
    })
  }

  if (isFoodRecordSchema(input.existing) || sourceLooksLikeFoodRecord(input.sourceText, input.categoryQuery)) {
    return buildFoodCheckInSchemaDraft({
      categoryName: input.existing.categoryName || trimString(input.categoryQuery, 80) || '饮食记录',
      aliases: input.existing.aliases,
      categoryDescription: input.existing.categoryDescription,
      titleTemplate: input.existing.titleTemplate,
    })
  }

  return buildFallbackCheckInSchemaDraft({
    categoryQuery: input.categoryQuery || input.existing.categoryName,
    draftValues: input.draftValues,
    fallbackSchema: {
      categoryName: input.existing.categoryName,
      aliases: input.existing.aliases,
      categoryDescription: input.existing.categoryDescription,
      titleTemplate: input.existing.titleTemplate,
      fields: input.existing.fields,
      layout: input.existing.layout,
      displayMode: input.existing.displayMode,
    },
  })
}

export function shouldUpgradeStoredCheckInSchema(
  existing: CheckInA2uiSchema,
  replacement: CheckInA2uiSchema,
): boolean {
  if (existing.categoryKey !== replacement.categoryKey) return false
  if (existing.fields.some(isLowQualityFieldLabel) && !replacement.fields.some(isLowQualityFieldLabel)) return true
  if (replacementAddsFields(existing, replacement)) return true
  const existingFoodLike = isFoodRecordSchema(existing)
  const replacementFoodLike = isFoodRecordSchema(replacement)
  if (!existingFoodLike || !replacementFoodLike) return false
  return !schemaHasFoodContentField(existing) && schemaHasFoodContentField(replacement)
}

export function canInvalidateSupersededCheckInCard(input: {
  card: Pick<CheckInCardRecord, 'userId' | 'sessionId' | 'status'> | {
    userId: string
    sessionId: string
    status: string
  }
  userId: string
  sessionId: string
}): boolean {
  return input.card.userId === input.userId
    && input.card.sessionId === input.sessionId
    && input.card.status === 'draft'
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${stableStringify(record[key])}`,
  ).join(',')}}`
}

export function makeCheckInCategoryKey(categoryName: string): string {
  return `ci_${hashText(categoryName.trim().toLowerCase()).slice(0, 12)}`
}

function normalizeFieldKey(value: unknown, fallback: string, used: Set<string>): string {
  const raw = trimString(value, 80)
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
  let key = raw || fallback
  if (/^[0-9]/.test(key)) key = `f_${key}`
  let candidate = key
  let idx = 2
  while (used.has(candidate)) {
    candidate = `${key}_${idx}`
    idx++
  }
  used.add(candidate)
  return candidate
}

function looksLikeDateInputField(key: string, label: string): boolean {
  const normalizedKey = key.trim().toLowerCase()
  const normalizedLabel = label.replace(/\s+/g, '')
  if (
    normalizedKey === 'date' ||
    normalizedKey === 'record_date' ||
    normalizedKey === 'record_day' ||
    normalizedKey === 'recorded_at' ||
    normalizedKey === 'recordedat' ||
    normalizedKey === 'check_in_date' ||
    normalizedKey === 'checkin_date' ||
    normalizedKey.endsWith('_date') ||
    normalizedKey.includes('_date_')
  ) return true
  return normalizedLabel.includes('日期')
}

function normalizeFieldType(rawType: unknown, key: string, label: string): CheckInFieldType {
  const type = FIELD_TYPES.has(rawType as CheckInFieldType) ? rawType as CheckInFieldType : 'text'
  return looksLikeDateInputField(key, label) ? 'date' : type
}

function normalizeField(input: unknown, index: number, used: Set<string>): CheckInFieldDefinition | null {
  if (!input || typeof input !== 'object') return null
  const raw = input as Record<string, unknown>
  const key = normalizeFieldKey(raw.key, `field_${index + 1}`, used)
  const label = normalizeFieldLabel(raw.label, key)
  if (!label) return null
  const type = normalizeFieldType(raw.type, key, label)
  const unit = trimString(raw.unit, 24)
  const options = type === 'choice' ? uniqueStrings(raw.options, 12, 80) : []
  return {
    key,
    label,
    type,
    ...(unit ? { unit } : {}),
    ...(raw.required === true ? { required: true } : {}),
    ...(options.length ? { options } : {}),
  }
}

function deriveCheckInCategoryDescription(input: {
  categoryName: string
  explicit?: unknown
  fields: CheckInFieldDefinition[]
}): string {
  const explicit = trimString(input.explicit, 300)
  if (explicit) return explicit

  const labels = [...new Set(input.fields
    .map((field) => field.label.trim())
    .filter((label) => label && label !== '记录内容'))]
    .slice(0, 6)
  const fieldSummary = labels.length ? `，核心字段：${labels.join('、')}。` : '。'
  return trimString(`用于记录${input.categoryName}${fieldSummary}`, 300)
}

function normalizeBindArray(value: unknown, fieldKeys: Set<string>, max = 6): string[] {
  if (!Array.isArray(value)) return []
  const result: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    const key = typeof item === 'string' ? item.trim() : ''
    if (!fieldKeys.has(key) || seen.has(key)) continue
    seen.add(key)
    result.push(key)
    if (result.length >= max) break
  }
  return result
}

function normalizeLayoutBlock(input: unknown, fieldKeys: Set<string>): CheckInA2uiLayoutBlock | null {
  if (!input || typeof input !== 'object') return null
  const raw = input as Record<string, unknown>
  if (raw.type === 'metric_grid') {
    const bind = normalizeBindArray(raw.bind, fieldKeys)
    return bind.length ? { type: 'metric_grid', bind } : null
  }
  if (raw.type === 'kv_list') {
    const bind = normalizeBindArray(raw.bind, fieldKeys, 8)
    return bind.length ? { type: 'kv_list', bind } : null
  }
  if (raw.type === 'note') {
    const bind = typeof raw.bind === 'string' && (raw.bind === 'note' || fieldKeys.has(raw.bind))
      ? raw.bind
      : 'note'
    return { type: 'note', bind }
  }
  if (raw.type === 'image_gallery') return { type: 'image_gallery', bind: 'attachments' }
  if (raw.type === 'tags') return { type: 'tags', bind: 'tags' }
  return null
}

function defaultLayout(fields: CheckInFieldDefinition[]): CheckInA2uiLayoutBlock[] {
  const numberFields = fields.filter((field) => field.type === 'number').map((field) => field.key).slice(0, 6)
  const otherFields = fields.filter((field) => field.type !== 'number').map((field) => field.key).slice(0, 8)
  return [
    ...(numberFields.length ? [{ type: 'metric_grid' as const, bind: numberFields }] : []),
    ...(otherFields.length ? [{ type: 'kv_list' as const, bind: otherFields }] : []),
    { type: 'note' as const, bind: 'note' as const },
    { type: 'image_gallery' as const, bind: 'attachments' as const },
    { type: 'tags' as const, bind: 'tags' as const },
  ]
}

function ensureOptionalLayoutBlocks(layout: CheckInA2uiLayoutBlock[]): CheckInA2uiLayoutBlock[] {
  const needsImageGallery = !layout.some((block) => block.type === 'image_gallery')
  const needsTags = !layout.some((block) => block.type === 'tags')
  const reserved = Number(needsImageGallery) + Number(needsTags)
  const result = layout.slice(0, Math.max(0, MAX_LAYOUT_BLOCKS - reserved))
  if (needsImageGallery) {
    result.push({ type: 'image_gallery', bind: 'attachments' })
  }
  if (needsTags) {
    result.push({ type: 'tags', bind: 'tags' })
  }
  return result
}

export function normalizeCheckInSchemaDraft(input: CheckInSchemaDraftInput): CheckInA2uiSchema {
  const categoryName = trimString(input.categoryName, 80)
  if (!categoryName) throw new Error('categoryName 不能为空')
  const aliases = uniqueStrings(input.aliases, MAX_ALIAS_COUNT, 40)
  const usedKeys = new Set<string>()
  const fields = Array.isArray(input.fields)
    ? input.fields
      .slice(0, MAX_FIELDS)
      .map((field, index) => normalizeField(field, index, usedKeys))
      .filter((field): field is CheckInFieldDefinition => !!field)
    : []
  if (fields.length === 0) throw new Error('fields 至少需要 1 项')
  const categoryDescription = deriveCheckInCategoryDescription({
    categoryName,
    explicit: input.categoryDescription,
    fields,
  })

  const fieldKeys = new Set(fields.map((field) => field.key))
  const layout = Array.isArray(input.layout)
    ? input.layout
      .slice(0, MAX_LAYOUT_BLOCKS)
      .map((block) => normalizeLayoutBlock(block, fieldKeys))
      .filter((block): block is CheckInA2uiLayoutBlock => !!block)
    : []
  const normalizedLayout = ensureOptionalLayoutBlocks(layout.length ? layout : defaultLayout(fields))

  return {
    version: 1,
    kind: 'check_in_card',
    categoryKey: makeCheckInCategoryKey(categoryName),
    categoryName,
    displayMode: normalizeDisplayMode(input.displayMode, fields),
    categoryDescription,
    titleTemplate: trimString(input.titleTemplate, 100) || categoryName,
    aliases,
    fields,
    layout: normalizedLayout,
  }
}

function fieldMapOf(schema: CheckInA2uiSchema): Map<string, CheckInFieldDefinition> {
  return new Map(schema.fields.map((field) => [field.key, field]))
}

function fieldLabelMapOf(schema: CheckInA2uiSchema): Map<string, CheckInFieldDefinition> {
  return new Map(schema.fields.map((field) => [field.label.trim(), field]))
}

function valueMeta(value: unknown): { value: unknown; status?: CheckInValueStatus } {
  if (value && typeof value === 'object' && !Array.isArray(value) && 'value' in value) {
    const withMeta = value as CheckInValueWithMeta
    return {
      value: withMeta.value,
      ...(VALUE_STATUSES.has(withMeta.status as CheckInValueStatus) ? { status: withMeta.status } : {}),
    }
  }
  return { value }
}

function formatValue(value: unknown): string | null {
  if (value == null) return null
  if (typeof value === 'boolean') return value ? '是' : '否'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null
  if (typeof value === 'string') return value.trim() || null
  return null
}

function hasRequiredValue(value: unknown): boolean {
  const raw = valueMeta(value).value
  if (raw === null || raw === undefined) return false
  if (typeof raw === 'string') return raw.trim().length > 0
  if (typeof raw === 'number') return Number.isFinite(raw)
  if (typeof raw === 'boolean') return true
  return false
}

export function validateCheckInRequiredFields(schema: CheckInA2uiSchema, values: CheckInValues): string[] {
  return schema.fields
    .filter((field) => field.required)
    .filter((field) => !hasRequiredValue(values[field.key]))
    .map((field) => field.label)
}

function metricItemsFor(
  bind: string[],
  fields: Map<string, CheckInFieldDefinition>,
  values: CheckInValues,
): CheckInRenderedMetricItem[] {
  const items: CheckInRenderedMetricItem[] = []
  for (const key of bind) {
    const field = fields.get(key)
    if (!field) continue
    const meta = valueMeta(values[key])
    const value = formatValue(meta.value)
    if (value == null) continue
    items.push({
      key,
      label: field.label,
      value,
      ...(field.unit ? { unit: field.unit } : {}),
      ...(meta.status ? { status: meta.status } : {}),
    })
  }
  return items
}

function kvItemsFor(
  bind: string[],
  fields: Map<string, CheckInFieldDefinition>,
  values: CheckInValues,
): CheckInRenderedKeyValueItem[] {
  const items: CheckInRenderedKeyValueItem[] = []
  for (const key of bind) {
    const field = fields.get(key)
    if (!field) continue
    const value = formatValue(valueMeta(values[key]).value)
    if (value == null) continue
    items.push({ key, label: field.label, value })
  }
  return items
}

function normalizeAttachments(value: CheckInAttachment[] | undefined): CheckInAttachment[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => {
      const url = typeof item?.url === 'string' ? item.url.trim() : ''
      const maxUrlChars = url.startsWith('data:image/')
        ? MAX_DATA_IMAGE_URL_CHARS
        : MAX_REMOTE_ATTACHMENT_URL_CHARS
      return {
        url: url.length <= maxUrlChars ? url : '',
        name: trimString(item?.name, 120) || undefined,
        mimeType: trimString(item?.mimeType, 80) || undefined,
      }
    })
    .filter((item) => item.url)
    .slice(0, MAX_ATTACHMENT_COUNT)
}

function mimeTypeFromImageUrl(url: string): string | undefined {
  if (!url.startsWith('data:image/')) return undefined
  const semicolon = url.indexOf(';')
  return semicolon > 5 ? url.slice(5, semicolon) : 'image/*'
}

export function extractCheckInAttachmentsFromMessageContent(content: string): CheckInAttachment[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []

  return normalizeAttachments(
    parsed
      .filter((block) => block?.type === 'image_url' && typeof block.image_url?.url === 'string')
      .map((block, index) => {
        const url = block.image_url.url
        return {
          url,
          name: `图片信息 ${index + 1}`,
          mimeType: mimeTypeFromImageUrl(url),
        }
      }),
  )
}

async function resolveCheckInAttachments(
  attachments: CheckInAttachment[] | undefined,
  sourceMessageId?: string | null,
): Promise<CheckInAttachment[]> {
  const direct = normalizeAttachments(attachments)
  if (direct.length || !sourceMessageId) return direct

  const row = await getDb().query.messages.findFirst({
    where: and(eq(messages.id, sourceMessageId), eq(messages.role, 'user')),
    columns: { content: true },
  })
  return row ? extractCheckInAttachmentsFromMessageContent(row.content) : []
}

function normalizeTags(value: unknown): string[] {
  return uniqueStrings(value, MAX_TAG_COUNT, 40)
}

export function renderCheckInRecordSchema(input: RenderRecordInput): CheckInRenderedA2uiSchema {
  const schema = localizeCheckInSchemaLabels(input.schema)
  const fields = fieldMapOf(schema)
  const values = input.values ?? {}
  const attachments = normalizeAttachments(input.attachments)
  const tags = normalizeTags(input.tags)
  const blocks: CheckInRenderedBlock[] = []
  let hasRenderedImageGallery = false
  let hasRenderedTags = false

  for (const block of schema.layout) {
    if (block.type === 'metric_grid') {
      const items = metricItemsFor(block.bind, fields, values)
      if (items.length) blocks.push({ type: 'metric_grid', items })
      continue
    }
    if (block.type === 'kv_list') {
      const items = kvItemsFor(block.bind, fields, values)
      if (items.length) blocks.push({ type: 'kv_list', items })
      continue
    }
    if (block.type === 'note') {
      const text = block.bind === 'note'
        ? trimString(input.note, 1000)
        : formatValue(valueMeta(values[block.bind]).value) ?? ''
      if (text) blocks.push({ type: 'note', text })
      continue
    }
    if (block.type === 'image_gallery') {
      hasRenderedImageGallery = true
      if (attachments.length) blocks.push({ type: 'image_gallery', images: attachments })
      continue
    }
    if (block.type === 'tags' && tags.length) {
      hasRenderedTags = true
      blocks.push({ type: 'tags', items: tags })
    }
  }

  if (attachments.length && !hasRenderedImageGallery) {
    blocks.push({ type: 'image_gallery', images: attachments })
  }
  if (tags.length && !hasRenderedTags) {
    blocks.push({ type: 'tags', items: tags })
  }

  return {
    version: 1,
    kind: 'check_in_record',
    title: resolveCheckInCardTitle({
      titleTemplate: trimString(input.title, 120) || schema.titleTemplate,
      categoryName: schema.categoryName,
    }),
    categoryKey: schema.categoryKey,
    categoryName: schema.categoryName,
    recordedAt: input.recordedAt,
    blocks,
  }
}

function localizeRenderedMetricItem(item: CheckInRenderedMetricItem): CheckInRenderedMetricItem {
  return {
    ...item,
    label: normalizeFieldLabel(item.label, item.key) ?? '记录内容',
  }
}

function localizeRenderedKeyValueItem(item: CheckInRenderedKeyValueItem): CheckInRenderedKeyValueItem {
  return {
    ...item,
    label: normalizeFieldLabel(item.label, item.key) ?? '记录内容',
  }
}

function localizeRenderedSchemaLabels(rendered: CheckInRenderedA2uiSchema): CheckInRenderedA2uiSchema {
  return {
    ...rendered,
    blocks: rendered.blocks.map((block) => {
      if (block.type === 'metric_grid') {
        return { ...block, items: block.items.map(localizeRenderedMetricItem) }
      }
      if (block.type === 'kv_list') {
        return { ...block, items: block.items.map(localizeRenderedKeyValueItem) }
      }
      return block
    }),
  }
}

function withOptionalRenderedBlocks(
  rendered: CheckInRenderedA2uiSchema,
  attachments: CheckInAttachment[],
  tags: string[],
): CheckInRenderedA2uiSchema {
  const localized = localizeRenderedSchemaLabels(rendered)
  const blocks = [...localized.blocks]
  if (attachments.length && !blocks.some((block) => block.type === 'image_gallery')) {
    blocks.push({ type: 'image_gallery', images: attachments })
  }
  if (tags.length && !blocks.some((block) => block.type === 'tags')) {
    blocks.push({ type: 'tags', items: tags })
  }
  return {
    ...localized,
    blocks,
  }
}

function localizeCheckInSchemaLabels(schema: CheckInA2uiSchema): CheckInA2uiSchema {
  return {
    ...schema,
    fields: schema.fields.map((field) => ({
      ...field,
      label: normalizeFieldLabel(field.label, field.key) ?? '记录内容',
    })),
  }
}

function schemaWithDisplayMode(schema: CheckInA2uiSchema, displayMode?: CheckInDisplayMode | null): CheckInA2uiSchema {
  return localizeCheckInSchemaLabels({
    ...schema,
    displayMode: DISPLAY_MODES.has(displayMode as CheckInDisplayMode)
      ? displayMode as CheckInDisplayMode
      : (DISPLAY_MODES.has(schema.displayMode as CheckInDisplayMode)
          ? schema.displayMode
          : inferDisplayMode(schema.fields)),
  })
}

export function buildCheckInDedupeKey(input: {
  userId: string
  sourceMessageId?: string | null
  categoryKey: string
  values: CheckInValues
}): string {
  return hashText([
    input.userId,
    input.sourceMessageId ?? 'no-message',
    input.categoryKey,
    stableStringify(input.values),
  ].join('\n'))
}

function serializeSchema(row: DbSchemaRow): CheckInSchemaRecord {
  return {
    id: row.id,
    userId: row.userId,
    categoryKey: row.categoryKey,
    categoryName: row.categoryName,
    displayMode: DISPLAY_MODES.has(row.displayMode as CheckInDisplayMode)
      ? row.displayMode as CheckInDisplayMode
      : inferDisplayMode((row.a2uiSchema as CheckInA2uiSchema).fields),
    categoryDescription: row.categoryDescription,
    aliases: row.aliases ?? [],
    schemaVersion: row.schemaVersion,
    schemaHash: row.schemaHash,
    a2uiSchema: schemaWithDisplayMode(row.a2uiSchema as CheckInA2uiSchema, row.displayMode as CheckInDisplayMode),
    status: row.status as CheckInSchemaRecord['status'],
    createdFromSessionId: row.createdFromSessionId,
    createdFromMessageId: row.createdFromMessageId,
    createdFromToolCallId: row.createdFromToolCallId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
  }
}

function timeOfNullableDate(value: Date | null | undefined): number {
  return value instanceof Date && Number.isFinite(value.getTime()) ? value.getTime() : Number.NEGATIVE_INFINITY
}

export function orderCheckInSchemasForDisplay<T extends {
  lastUsedAt?: Date | null
  updatedAt?: Date | null
  createdAt?: Date | null
}>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const lastUsedDiff = timeOfNullableDate(b.lastUsedAt) - timeOfNullableDate(a.lastUsedAt)
    if (lastUsedDiff !== 0) return lastUsedDiff
    const updatedDiff = timeOfNullableDate(b.updatedAt) - timeOfNullableDate(a.updatedAt)
    if (updatedDiff !== 0) return updatedDiff
    return timeOfNullableDate(b.createdAt) - timeOfNullableDate(a.createdAt)
  })
}

function serializeRecord(row: DbRecordRow): CheckInRecord {
  const attachments = row.attachmentsJson as CheckInAttachment[]
  const tags = row.tags ?? []
  return {
    id: row.id,
    userId: row.userId,
    schemaId: row.schemaId,
    categoryKey: row.categoryKey,
    schemaVersion: row.schemaVersion,
    title: row.title,
    recordedAt: row.recordedAt.toISOString(),
    recordedByType: row.recordedByType as CheckInRecord['recordedByType'],
    recordedByName: row.recordedByName,
    sourceSessionId: row.sourceSessionId,
    sourceMessageId: row.sourceMessageId,
    toolCallId: row.toolCallId,
    valuesJson: row.valuesJson as CheckInValues,
    attachmentsJson: attachments,
    renderedA2uiSchema: withOptionalRenderedBlocks(row.renderedA2uiSchema as CheckInRenderedA2uiSchema, attachments, tags),
    schemaSnapshot: schemaWithDisplayMode(row.schemaSnapshot as CheckInA2uiSchema),
    tags,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

function serializeCard(row: DbCardRow, record: CheckInRecord | null = null): CheckInCardRecord {
  return {
    id: row.id,
    userId: row.userId,
    sessionId: row.sessionId,
    sourceMessageId: row.sourceMessageId,
    assistantMessageId: row.assistantMessageId,
    toolCallId: row.toolCallId,
    status: row.status as CheckInCardStatus,
    recordId: row.recordId,
    schemaActionHint: row.schemaActionHint as CheckInCardRecord['schemaActionHint'],
    existingSchemaId: row.existingSchemaId,
    categoryName: row.categoryName,
    displayMode: DISPLAY_MODES.has(row.displayMode as CheckInDisplayMode)
      ? row.displayMode as CheckInDisplayMode
      : inferDisplayMode((row.schemaJson as CheckInA2uiSchema).fields),
    schema: schemaWithDisplayMode(row.schemaJson as CheckInA2uiSchema, row.displayMode as CheckInDisplayMode),
    values: row.valuesJson as CheckInValues,
    attachments: normalizeAttachments(row.attachmentsJson as CheckInAttachment[]),
    note: row.note,
    tags: normalizeTags(row.tags),
    recordedAt: row.recordedAt?.toISOString() ?? null,
    sourceEvidence: (row.sourceEvidenceJson ?? {}) as Record<string, string>,
    missingFields: Array.isArray(row.missingFieldsJson) ? row.missingFieldsJson as string[] : [],
    record,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    savedAt: row.savedAt?.toISOString() ?? null,
    deletedAt: row.deletedAt?.toISOString() ?? null,
  }
}

function parseRecordedAt(value?: string | null): Date {
  if (!value) return new Date()
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date : new Date()
}

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const DATE_VALUE_RE = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/
const RECORD_DATE_FIELD_KEYS = new Set([
  'date',
  'day',
  'record_date',
  'record_day',
  'recorded_at',
  'recordedat',
  'check_in_date',
  'checkin_date',
])
const RECORD_DATE_FIELD_LABELS = new Set(['日期', '记录日期', '打卡日期', '归属日期', '发生日期'])

export function resolveCheckInRecordedAt(input: {
  recordedAt?: string | null
  fallbackNow?: Date
}): Date {
  const recordedAt = trimString(input.recordedAt, 80)
  if (!recordedAt) return input.fallbackNow ?? new Date()
  const match = DATE_ONLY_RE.exec(recordedAt)
  if (!match) throw new Error('recordedAt 必须使用 YYYY-MM-DD 格式。')
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const utcMidnight = new Date(Date.UTC(year, month - 1, day))
  if (
    utcMidnight.getUTCFullYear() !== year ||
    utcMidnight.getUTCMonth() !== month - 1 ||
    utcMidnight.getUTCDate() !== day
  ) {
    throw new Error('recordedAt 必须是有效日期。')
  }
  const resolved = new Date(Date.UTC(year, month - 1, day) - 8 * 60 * 60 * 1000)
  assertNotFutureCheckInDate(resolved, input.fallbackNow)
  return resolved
}

export function resolveOptionalUserRecordDate(userDate: string | null | undefined, storedDate: string | null | undefined): Date {
  return userDate == null
    ? parseRecordedAt(storedDate)
    : resolveCheckInRecordedAt({ recordedAt: userDate })
}

function normalizeDateOnlyValue(value: unknown): string | null {
  const text = trimString(value, 40)
  const match = DATE_VALUE_RE.exec(text)
  if (!match) return null
  const year = match[1]
  const month = match[2].padStart(2, '0')
  const day = match[3].padStart(2, '0')
  return `${year}-${month}-${day}`
}

function formatShanghaiDateOnly(value: string | Date | null | undefined): string | null {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) return null
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  const year = parts.find((part) => part.type === 'year')?.value
  const month = parts.find((part) => part.type === 'month')?.value
  const day = parts.find((part) => part.type === 'day')?.value
  return year && month && day ? `${year}-${month}-${day}` : null
}

function assertNotFutureCheckInDate(recordedAt: Date, now = new Date()) {
  const recordDate = formatShanghaiDateOnly(recordedAt)
  const today = formatShanghaiDateOnly(now)
  if (recordDate && today && recordDate > today) {
    throw new Error('未来日期不可保存为历史打卡,请改为提醒。')
  }
}

function isEmptyCheckInValue(value: unknown): boolean {
  const raw = value && typeof value === 'object' && !Array.isArray(value) && 'value' in value
    ? (value as CheckInValueWithMeta).value
    : value
  if (raw == null) return true
  if (typeof raw === 'string') return raw.trim() === ''
  if (Array.isArray(raw)) return raw.length === 0
  return false
}

function looksLikeRecordDateField(field: CheckInFieldDefinition): boolean {
  const key = field.key.trim().toLowerCase()
  const label = field.label.replace(/\s+/g, '')
  return RECORD_DATE_FIELD_KEYS.has(key) || RECORD_DATE_FIELD_LABELS.has(label)
}

function dateOnlyFromRecordDateField(
  schema: CheckInA2uiSchema,
  values: CheckInValues | null | undefined,
): string | null {
  if (!values || typeof values !== 'object') return null
  const dateFields = schema.fields.filter((field) => field.type === 'date')
  if (!dateFields.length) return null
  const preferredFields = dateFields.filter(looksLikeRecordDateField)
  const candidates = preferredFields.length ? preferredFields : dateFields.length === 1 ? dateFields : []
  for (const field of candidates) {
    const normalized = normalizeDateOnlyValue(values[field.key] ?? values[field.label])
    if (normalized) return normalized
  }
  return null
}

export function applyRecordedAtToRecordDateFields(
  schema: CheckInA2uiSchema,
  values: CheckInValues | null | undefined,
  recordedAt: string | Date | null | undefined,
): CheckInValues {
  const out = projectValuesToFields(values, schema)
  const dateOnly = formatShanghaiDateOnly(recordedAt)
  if (!dateOnly) return out

  for (const field of schema.fields) {
    if (field.type !== 'date' || !looksLikeRecordDateField(field)) continue
    if (isEmptyCheckInValue(out[field.key])) {
      out[field.key] = dateOnly
    }
  }

  return out
}

export function resolveCheckInRecordRecordedAt(input: {
  explicitRecordedAt?: string | null
  schema?: CheckInA2uiSchema
  values?: CheckInValues | null
  storedRecordedAt?: string | null
  fallbackNow?: Date
}): Date {
  if (trimString(input.explicitRecordedAt, 80)) {
    return resolveCheckInRecordedAt({
      recordedAt: input.explicitRecordedAt,
      fallbackNow: input.fallbackNow,
    })
  }
  const valueDate = input.schema ? dateOnlyFromRecordDateField(input.schema, input.values) : null
  if (valueDate) {
    return resolveCheckInRecordedAt({
      recordedAt: valueDate,
      fallbackNow: input.fallbackNow,
    })
  }
  if (input.storedRecordedAt) return parseRecordedAt(input.storedRecordedAt)
  return input.fallbackNow ?? new Date()
}

function noteFromRenderedRecord(record: CheckInRecord): string | null {
  const noteBlock = record.renderedA2uiSchema.blocks.find((block) => block.type === 'note')
  return noteBlock?.type === 'note' ? noteBlock.text : null
}

export function buildCheckInRecordUpdatePayload(input: {
  record: CheckInRecord
  values?: CheckInValues | null
  note?: string | null
  tags?: string[]
  recordedAt?: string | null
}) {
  const schema = schemaWithDisplayMode(input.record.schemaSnapshot)
  const values = projectValuesToFields(
    input.values === undefined ? input.record.valuesJson : input.values,
    schema,
  )
  const note = trimString(
    input.note === undefined ? noteFromRenderedRecord(input.record) : input.note,
    1000,
  ) || null
  const tags = normalizeTags(input.tags === undefined ? input.record.tags : input.tags)
  const attachments = normalizeAttachments(input.record.attachmentsJson)
  const recordedAt = resolveOptionalUserRecordDate(input.recordedAt, input.record.recordedAt)
  const rendered = renderCheckInRecordSchema({
    schema,
    title: schema.titleTemplate,
    recordedAt: recordedAt.toISOString(),
    values,
    note,
    attachments,
    tags,
  })

  return {
    valuesJson: values,
    renderedA2uiSchema: rendered,
    title: rendered.title,
    recordedAt,
    dedupeKey: buildCheckInDedupeKey({
      userId: input.record.userId,
      sourceMessageId: input.record.sourceMessageId,
      categoryKey: schema.categoryKey,
      values,
    }),
    tags,
  }
}

async function findRecordByDedupeKey(userId: string, dedupeKey: string): Promise<CheckInRecord | null> {
  const row = await getDb().query.checkInRecords.findFirst({
    where: and(
      eq(checkInRecords.userId, userId),
      eq(checkInRecords.dedupeKey, dedupeKey),
      isNull(checkInRecords.deletedAt),
    ),
  })
  return row ? serializeRecord(row) : null
}

function renderDraftPreview(input: {
  schema: CheckInA2uiSchema
  values: CheckInValues
  attachments: CheckInAttachment[]
  note: string | null
  tags: string[]
  recordedAt: string
}): CheckInRenderedA2uiSchema {
  return renderCheckInRecordSchema({
    schema: input.schema,
    title: input.schema.titleTemplate,
    recordedAt: input.recordedAt,
    values: input.values,
    note: input.note,
    attachments: input.attachments,
    tags: input.tags,
  })
}

export function buildCheckInCardToolOutput(input: {
  id: string
  status: CheckInCardStatus
  schemaActionHint: 'create' | 'use_existing'
  schema: CheckInA2uiSchema
  values: CheckInValues
  attachments: CheckInAttachment[]
  note: string | null
  tags: string[]
  recordedAt: string
  message: string
  supersedesCheckInCardId?: string | null
  existingSchema?: CheckInDraftToolOutput['existingSchema']
}): CheckInDraftToolOutput {
  return {
    action: input.schemaActionHint === 'use_existing' ? 'draft_for_existing' : 'draft_created',
    checkInCardId: input.id,
    status: input.status,
    ...(input.supersedesCheckInCardId ? { supersedesCheckInCardId: input.supersedesCheckInCardId } : {}),
    schemaActionHint: input.schemaActionHint,
    ...(input.existingSchema ? { existingSchema: input.existingSchema } : {}),
    draftSchema: input.schema,
    draftRendered: renderDraftPreview({
      schema: input.schema,
      values: input.values,
      attachments: input.attachments,
      note: input.note,
      tags: input.tags,
      recordedAt: input.recordedAt,
    }),
    draftValues: input.values,
    draftAttachments: input.attachments,
    message: input.message,
  }
}

/** 仅保留 schema 中声明的 field key,把多余字段过滤掉(防 LLM 乱传) */
function projectValuesToFields(
  values: CheckInValues | null | undefined,
  schema: CheckInA2uiSchema,
): CheckInValues {
  if (!values || typeof values !== 'object') return {}
  const fieldsByKey = fieldMapOf(schema)
  const fieldsByLabel = fieldLabelMapOf(schema)
  const out: CheckInValues = {}
  for (const [key, value] of Object.entries(values)) {
    const field = fieldsByKey.get(key) ?? fieldsByLabel.get(key.trim())
    if (field) out[field.key] = value as any
  }
  return out
}

function sourceTextIncludes(text: string, terms: string[]): string | null {
  return terms.find((term) => text.includes(term)) ?? null
}

function sourceFoodTerm(text: string, terms: string[]): string | null {
  for (const term of terms) {
    const quantityPattern = `(?:半|[一二两三四五六七八九十百\\d]+)?(?:碗|个|颗|枚|份|片|块|杯|根)?`
    const before = text.match(new RegExp(`${quantityPattern}${term}`))
    if (before?.[0]) return before[0]
    if (text.includes(term)) return term
  }
  return null
}

function isFoodClassMismatch(value: unknown, classTerms: string[]): boolean {
  const text = typeof value === 'string' ? value.trim() : ''
  return Boolean(text && sourceTextIncludes(text, classTerms))
}

function isFoodRecordSchema(schema: CheckInA2uiSchema): boolean {
  const category = `${schema.categoryName}${schema.categoryDescription ?? ''}`
  if (/(饮食|餐食|用餐|吃饭|三餐)/.test(category)) return true
  const labels = schema.fields.map((field) => `${field.key}:${field.label}`).join('|').toLowerCase()
  return /meal|餐次|主食|蛋白|蔬菜|汤|水果/.test(labels)
}

function fieldNameText(field: CheckInFieldDefinition): string {
  return `${field.key} ${field.label}`.toLowerCase()
}

function matchesField(field: CheckInFieldDefinition, patterns: RegExp[]): boolean {
  const name = fieldNameText(field)
  return patterns.some((pattern) => pattern.test(name))
}

function setTextValueIfEmpty(values: CheckInValues, field: CheckInFieldDefinition, value: string | null) {
  if (!value || !isEmptyCheckInValue(values[field.key])) return
  values[field.key] = value
}

function setTextValueIfEmptyOrMismatched(
  values: CheckInValues,
  field: CheckInFieldDefinition,
  value: string | null,
  mismatchedTerms: string[],
) {
  if (!value) return
  if (isEmptyCheckInValue(values[field.key]) || isFoodClassMismatch(values[field.key], mismatchedTerms)) {
    values[field.key] = value
  }
}

function setTextValueIfEmptyOrMoreSpecific(values: CheckInValues, field: CheckInFieldDefinition, value: string | null) {
  if (!value) return
  const raw = values[field.key]
  const current = typeof raw === 'string' ? raw.trim() : ''
  if (isEmptyCheckInValue(raw) || (current && value.length > current.length && value.includes(current))) {
    values[field.key] = value
  }
}

function inferMealType(sourceText: string, field: CheckInFieldDefinition): string | null {
  const candidates: Array<[string, string[]]> = [
    ['早餐', ['早餐', '早饭', '早上', '早晨', '今早', '昨天早上', '明早']],
    ['午餐', ['午餐', '午饭', '中午', '午间']],
    ['晚餐', ['晚餐', '晚饭', '晚上', '昨晚', '昨天晚上', '今晚', '傍晚']],
    ['加餐', ['加餐', '夜宵', '零食']],
  ]
  const matched = candidates.find(([, terms]) => terms.some((term) => sourceText.includes(term)))?.[0] ?? null
  if (!matched) return null
  return field.options?.length && !field.options.includes(matched) ? null : matched
}

function inferSoup(sourceText: string): string | null {
  const explicit = sourceTextIncludes(sourceText, ['豆腐汤', '鸡汤', '鱼汤', '排骨汤', '紫菜汤', '蛋花汤', '蔬菜汤'])
  if (explicit) return explicit
  const match = sourceText.match(/([\u4e00-\u9fa5]{1,8}汤)/)
  return match?.[1] ?? null
}

function normalizeFoodContentText(value: string): string | null {
  const text = value
    .replace(/\s+/g, '')
    .replace(/[，,]/g, '、')
    .replace(/和/g, '、')
    .replace(/^[：:、，,。；;]+|[：:、，,。；;]+$/g, '')
  return text || null
}

function inferFoodContent(sourceText: string): string | null {
  const eatingMatch = sourceText.match(/(?:吃了|吃的是|吃过|吃)([^。；;\n]+)/)
  const mealMatch = sourceText.match(/(?:早餐|早饭|午餐|午饭|晚餐|晚饭|加餐|夜宵)[^。；;\n]*(?:有|是|为)([^。；;\n]+)/)
  const raw = eatingMatch?.[1] ?? mealMatch?.[1] ?? ''
  return normalizeFoodContentText(raw)
}

export function enhanceCheckInValuesFromSourceText(
  values: CheckInValues | null | undefined,
  schema: CheckInA2uiSchema,
  sourceText?: string | null,
): CheckInValues {
  const out = projectValuesToFields(values, schema)
  const text = trimString(sourceText, 2000)
  if (!text) return out

  const sourceValues = projectValuesToFields(sourceDerivedValuesFromText(text), schema)
  for (const [key, value] of Object.entries(sourceValues)) {
    if (isEmptyCheckInValue(out[key])) {
      out[key] = value as any
    }
  }

  if (!isFoodRecordSchema(schema)) return out

  for (const field of schema.fields) {
    if (matchesField(field, [/meal_type/, /餐次/])) {
      setTextValueIfEmpty(out, field, inferMealType(text, field))
      continue
    }
    if (matchesField(field, [/food_content/, /food_items/, /\bfood\b/, /食物/, /进食/, /饮食内容/, /吃了什么/])) {
      setTextValueIfEmpty(out, field, inferFoodContent(text))
      continue
    }
    if (matchesField(field, [/main_dish/, /staple/, /主食/])) {
      setTextValueIfEmptyOrMismatched(
        out,
        field,
        sourceFoodTerm(text, ['白米饭', '米饭', '面条', '馒头', '包子', '粥', '饺子', '面包', '红薯', '玉米']),
        ['煎鸡蛋', '鸡蛋', '水煮蛋', '牛肉', '鸡肉', '鱼肉', '虾', '豆腐'],
      )
      continue
    }
    if (matchesField(field, [/protein/, /蛋白/, /蛋白质/])) {
      setTextValueIfEmptyOrMoreSpecific(out, field, sourceFoodTerm(text, ['煎鸡蛋', '鸡蛋', '水煮蛋', '牛肉', '鸡肉', '鱼肉', '虾', '豆腐']))
      continue
    }
    if (matchesField(field, [/vegetable/, /蔬菜/, /青菜/, /菜$/])) {
      setTextValueIfEmpty(out, field, sourceTextIncludes(text, ['清炒青菜', '青菜', '白菜', '菠菜', '西兰花', '生菜', '番茄', '黄瓜']))
      continue
    }
    if (matchesField(field, [/soup/, /汤/])) {
      setTextValueIfEmpty(out, field, inferSoup(text))
      continue
    }
    if (matchesField(field, [/fruit/, /水果/])) {
      setTextValueIfEmpty(out, field, sourceTextIncludes(text, ['苹果', '香蕉', '橙子', '橘子', '草莓', '葡萄', '梨']))
    }
  }

  return out
}

export function mergeCheckInCardValues(
  base: CheckInValues | null | undefined,
  patch: CheckInValues | null | undefined,
  schema: CheckInA2uiSchema,
): CheckInValues {
  return {
    ...projectValuesToFields(base, schema),
    ...projectValuesToFields(patch, schema),
  }
}

export function resolveCheckInDraftNote(
  draftNote: unknown,
  draftValues?: CheckInValues | null,
): string | null {
  const direct = trimString(draftNote, 1000)
  if (direct) return direct
  if (!draftValues || typeof draftValues !== 'object') return null

  const record = draftValues as Record<string, unknown>
  return trimString(record.note ?? record.备注, 1000) || null
}

async function serializeCardWithRecord(row: DbCardRow): Promise<CheckInCardRecord> {
  if (!row.recordId) return serializeCard(row, null)
  const recordRow = await getDb().query.checkInRecords.findFirst({
    where: and(
      eq(checkInRecords.id, row.recordId),
      eq(checkInRecords.userId, row.userId),
      isNull(checkInRecords.deletedAt),
    ),
  })
  return serializeCard(row, recordRow ? serializeRecord(recordRow) : null)
}

async function invalidateSupersededCheckInCard(input: {
  userId: string
  sessionId: string
  supersedesCheckInCardId?: string | null
}): Promise<void> {
  const cardId = trimString(input.supersedesCheckInCardId, 80)
  if (!cardId) return
  if (!isUuid(cardId)) return

  const row = await getDb().query.checkInCards.findFirst({
    where: and(
      eq(checkInCards.id, cardId),
      eq(checkInCards.userId, input.userId),
      eq(checkInCards.sessionId, input.sessionId),
      isNull(checkInCards.deletedAt),
    ),
  })
  if (!row || !canInvalidateSupersededCheckInCard({
    card: {
      userId: row.userId,
      sessionId: row.sessionId,
      status: row.status,
    },
    userId: input.userId,
    sessionId: input.sessionId,
  })) return

  await getDb().update(checkInCards)
    .set({
      status: 'invalidated',
      updatedAt: new Date(),
    })
    .where(and(
      eq(checkInCards.id, row.id),
      eq(checkInCards.userId, input.userId),
      eq(checkInCards.sessionId, input.sessionId),
      eq(checkInCards.status, 'draft'),
      isNull(checkInCards.deletedAt),
    ))
}

async function upsertCheckInSchemaForDraft(input: {
  userId: string
  sessionId: string
  sourceMessageId?: string | null
  toolCallId: string
  schema: CheckInA2uiSchema
  existingSchemaId?: string | null
  schemaActionHint: 'create' | 'use_existing'
}): Promise<DbSchemaRow> {
  const schema = input.schema
  const schemaHash = hashText(stableStringify(schema))
  const now = new Date()

  const existingById = input.existingSchemaId
    ? await getDb().query.userCheckInSchemas.findFirst({
        where: and(eq(userCheckInSchemas.id, input.existingSchemaId), eq(userCheckInSchemas.userId, input.userId)),
      })
    : undefined
  const existing = existingById ?? await getDb().query.userCheckInSchemas.findFirst({
    where: and(
      eq(userCheckInSchemas.userId, input.userId),
      eq(userCheckInSchemas.categoryKey, schema.categoryKey),
    ),
  })

  if (existing) {
    const existingSchema = schemaWithDisplayMode(
      existing.a2uiSchema as CheckInA2uiSchema,
      existing.displayMode as CheckInDisplayMode,
    )
    if (input.schemaActionHint === 'create' && shouldUpgradeStoredCheckInSchema(existingSchema, schema)) {
      const [updated] = await getDb().update(userCheckInSchemas)
        .set({
          categoryName: schema.categoryName,
          displayMode: schema.displayMode,
          categoryDescription: schema.categoryDescription ?? null,
          aliases: schema.aliases,
          schemaVersion: existing.schemaVersion + 1,
          schemaHash,
          a2uiSchema: schema,
          status: 'active',
          lastUsedAt: now,
          updatedAt: now,
        })
        .where(and(eq(userCheckInSchemas.id, existing.id), eq(userCheckInSchemas.userId, input.userId)))
        .returning()
      if (updated) return updated
    }

    const [touched] = await getDb().update(userCheckInSchemas)
      .set({ status: 'active', lastUsedAt: now, updatedAt: now })
      .where(and(eq(userCheckInSchemas.id, existing.id), eq(userCheckInSchemas.userId, input.userId)))
      .returning()
    if (touched) return touched
    return existing
  }

  const [inserted] = await getDb().insert(userCheckInSchemas).values({
    userId: input.userId,
    categoryKey: schema.categoryKey,
    categoryName: schema.categoryName,
    displayMode: schema.displayMode,
    categoryDescription: schema.categoryDescription ?? null,
    aliases: schema.aliases,
    schemaVersion: 1,
    schemaHash,
    a2uiSchema: schema,
    status: 'active',
    createdFromSessionId: input.sessionId,
    createdFromMessageId: input.sourceMessageId ?? null,
    createdFromToolCallId: input.toolCallId,
    lastUsedAt: now,
  }).returning()
  if (!inserted) throw new Error('打卡模板创建失败。')
  return inserted
}

async function createCheckInCard(input: {
  userId: string
  sessionId: string
  toolCallId: string
  sourceMessageId?: string | null
  schemaActionHint: 'create' | 'use_existing'
  schema: CheckInA2uiSchema
  existingSchemaId?: string | null
  values: CheckInValues
  attachments: CheckInAttachment[]
  note: string | null
  tags: string[]
  recordedAt: string
  supersedesCheckInCardId?: string | null
  sourceEvidence?: Record<string, string>
  missingFields?: string[]
}): Promise<CheckInCardRecord> {
  const [row] = await getDb().insert(checkInCards).values({
    userId: input.userId,
    sessionId: input.sessionId,
    sourceMessageId: input.sourceMessageId ?? null,
    assistantMessageId: null,
    toolCallId: input.toolCallId,
    status: 'draft',
    recordId: null,
    schemaActionHint: input.schemaActionHint,
    existingSchemaId: input.existingSchemaId ?? null,
    categoryName: input.schema.categoryName,
    displayMode: input.schema.displayMode,
    schemaJson: input.schema,
    valuesJson: input.values,
    attachmentsJson: input.attachments,
    note: input.note,
    tags: input.tags,
    recordedAt: parseRecordedAt(input.recordedAt),
    sourceEvidenceJson: input.sourceEvidence ?? {},
    missingFieldsJson: input.missingFields ?? [],
  }).returning()
  if (!row) throw new Error('打卡卡片创建失败。')
  await invalidateSupersededCheckInCard({
    userId: input.userId,
    sessionId: input.sessionId,
    supersedesCheckInCardId: input.supersedesCheckInCardId,
  })
  return serializeCard(row)
}

export async function getCheckInCard(userId: string, id: string): Promise<CheckInCardRecord | null> {
  const row = await getDb().query.checkInCards.findFirst({
    where: and(eq(checkInCards.userId, userId), eq(checkInCards.id, id), isNull(checkInCards.deletedAt)),
  })
  return row ? serializeCardWithRecord(row) : null
}

export async function findLatestDraftCheckInCard(
  userId: string,
  sessionId: string,
): Promise<CheckInCardRecord | null> {
  const row = await getDb().query.checkInCards.findFirst({
    where: and(
      eq(checkInCards.userId, userId),
      eq(checkInCards.sessionId, sessionId),
      eq(checkInCards.status, 'draft'),
      isNull(checkInCards.deletedAt),
    ),
    orderBy: desc(checkInCards.updatedAt),
  })
  return row ? serializeCard(row) : null
}

export async function listDraftCheckInCardsForPrompt(
  userId: string,
  sessionId: string,
  limit = 5,
): Promise<CheckInDraftCardPromptSummary[]> {
  const rows = await getDb().query.checkInCards.findMany({
    where: and(
      eq(checkInCards.userId, userId),
      eq(checkInCards.sessionId, sessionId),
      eq(checkInCards.status, 'draft'),
      isNull(checkInCards.deletedAt),
    ),
    orderBy: desc(checkInCards.updatedAt),
    limit: Math.max(1, Math.min(limit, 5)),
  })

  return rows.map((row) => {
    const schema = schemaWithDisplayMode(row.schemaJson as CheckInA2uiSchema, row.displayMode as CheckInDisplayMode)
    const attachments = Array.isArray(row.attachmentsJson) ? row.attachmentsJson : []
    return {
      id: row.id,
      categoryName: row.categoryName,
      recordedAt: row.recordedAt ? row.recordedAt.toISOString() : null,
      fields: schema.fields.slice(0, MAX_FIELDS).map((field) => ({
        key: field.key,
        label: field.label,
        type: field.type,
        unit: field.unit,
        required: field.required,
      })),
      values: row.valuesJson ?? {},
      note: row.note,
      attachmentCount: attachments.length,
      updatedAt: row.updatedAt.toISOString(),
    }
  })
}

export async function findLatestCheckInCard(
  userId: string,
  sessionId: string,
): Promise<CheckInCardRecord | null> {
  const row = await getDb().query.checkInCards.findFirst({
    where: and(
      eq(checkInCards.userId, userId),
      eq(checkInCards.sessionId, sessionId),
      isNull(checkInCards.deletedAt),
    ),
    orderBy: desc(checkInCards.updatedAt),
  })
  return row ? serializeCard(row) : null
}

export async function cancelCheckInCard(
  userId: string,
  cardId: string,
): Promise<CancelCheckInCardResult | null> {
  if (!isUuid(cardId)) return null
  const row = await getDb().query.checkInCards.findFirst({
    where: and(eq(checkInCards.userId, userId), eq(checkInCards.id, cardId), isNull(checkInCards.deletedAt)),
  })
  if (!row) return null
  if (row.status === 'saved') throw new Error('已保存的打卡卡片不能取消。')
  if (row.status === 'invalidated' || row.status === 'deleted') {
    return { card: await serializeCardWithRecord(row) }
  }

  const [updated] = await getDb().update(checkInCards)
    .set({
      status: 'invalidated',
      updatedAt: new Date(),
    })
    .where(and(
      eq(checkInCards.userId, userId),
      eq(checkInCards.id, cardId),
      eq(checkInCards.status, 'draft'),
      isNull(checkInCards.deletedAt),
    ))
    .returning()
  if (!updated) throw new Error('打卡卡片取消失败。')
  return { card: serializeCard(updated) }
}

export async function saveCheckInCard(
  input: SaveCheckInCardInput,
  logger: Logger,
): Promise<SaveCheckInCardResult> {
  const row = await getDb().query.checkInCards.findFirst({
    where: and(eq(checkInCards.userId, input.userId), eq(checkInCards.id, input.cardId), isNull(checkInCards.deletedAt)),
  })
  if (!row) throw new Error('打卡卡片不存在。')

  if (row.status === 'deleted') throw new Error('打卡卡片已删除。')
  if (row.status === 'invalidated') throw new Error('这张打卡卡片已失效,请使用最新卡片重新保存。')

  const schema = schemaWithDisplayMode(row.schemaJson as CheckInA2uiSchema, row.displayMode as CheckInDisplayMode)
  const schemaHash = hashText(stableStringify(schema))
  const now = new Date()

  if (row.status === 'saved' && row.recordId) {
    const record = await getCheckInRecord(input.userId, row.recordId)
    if (record) {
      const values = mergeCheckInCardValues(record.valuesJson, input.values, schema)
      const missingRequired = validateCheckInRequiredFields(schema, values)
      if (missingRequired.length) throw new Error(`请先填写必填项:${missingRequired.join('、')}`)
      const note = input.note === undefined ? (row.note ?? noteFromRenderedRecord(record)) : input.note
      const tags = input.tags === undefined ? row.tags : input.tags
      const payload = buildCheckInRecordUpdatePayload({
        record,
        values,
        note,
        tags,
      })
      const [updatedRecordRow] = await getDb().update(checkInRecords)
        .set({
          ...payload,
          updatedAt: new Date(),
        })
        .where(and(
          eq(checkInRecords.userId, input.userId),
          eq(checkInRecords.id, row.recordId),
          isNull(checkInRecords.deletedAt),
        ))
        .returning()
      if (!updatedRecordRow) throw new Error('打卡记录更新失败。')
      const updatedRecord = serializeRecord(updatedRecordRow)
      const [updatedCard] = await getDb().update(checkInCards)
        .set({
          valuesJson: updatedRecord.valuesJson,
          note: trimString(note, 1000) || null,
          tags: updatedRecord.tags,
          recordedAt: payload.recordedAt,
          savedAt: row.savedAt ?? now,
          updatedAt: new Date(),
        })
        .where(and(eq(checkInCards.userId, input.userId), eq(checkInCards.id, row.id), isNull(checkInCards.deletedAt)))
        .returning()
      if (!updatedCard) throw new Error('打卡卡片状态更新失败。')
      logger.info({ userId: input.userId, cardId: row.id, recordId: updatedRecord.id }, 'check-in card save updated existing record')
      return { card: serializeCard(updatedCard, updatedRecord), record: updatedRecord, action: 'updated' }
    }
  }

  let schemaRow: DbSchemaRow | undefined
  if (row.existingSchemaId) {
    schemaRow = await getDb().query.userCheckInSchemas.findFirst({
      where: and(eq(userCheckInSchemas.id, row.existingSchemaId), eq(userCheckInSchemas.userId, input.userId)),
    })
  }
  if (!schemaRow) {
    const existing = await getDb().query.userCheckInSchemas.findFirst({
      where: and(
        eq(userCheckInSchemas.userId, input.userId),
        eq(userCheckInSchemas.categoryKey, schema.categoryKey),
      ),
    })
    if (existing) {
      const existingSchema = schemaWithDisplayMode(
        existing.a2uiSchema as CheckInA2uiSchema,
        existing.displayMode as CheckInDisplayMode,
      )
      if (row.schemaActionHint === 'create' && shouldUpgradeStoredCheckInSchema(existingSchema, schema)) {
        schemaRow = (await getDb().update(userCheckInSchemas)
          .set({
            categoryName: schema.categoryName,
            displayMode: schema.displayMode,
            categoryDescription: schema.categoryDescription ?? null,
            aliases: schema.aliases,
            schemaVersion: existing.schemaVersion + 1,
            schemaHash,
            a2uiSchema: schema,
            status: 'active',
            lastUsedAt: now,
            updatedAt: now,
          })
          .where(and(eq(userCheckInSchemas.id, existing.id), eq(userCheckInSchemas.userId, input.userId)))
          .returning())[0]
      } else {
        schemaRow = existing
      }
    }
    schemaRow = schemaRow ?? (await getDb().insert(userCheckInSchemas).values({
      userId: input.userId,
      categoryKey: schema.categoryKey,
      categoryName: schema.categoryName,
      displayMode: schema.displayMode,
      categoryDescription: schema.categoryDescription ?? null,
      aliases: schema.aliases,
      schemaVersion: 1,
      schemaHash,
      a2uiSchema: schema,
      status: 'active',
      createdFromSessionId: row.sessionId,
      createdFromMessageId: row.sourceMessageId ?? null,
      createdFromToolCallId: row.toolCallId,
      lastUsedAt: now,
    }).returning())[0]
  }
  if (!schemaRow) throw new Error('打卡模板创建失败。')

  const values = mergeCheckInCardValues(row.valuesJson as CheckInValues, input.values, schema)
  const missingRequired = validateCheckInRequiredFields(schema, values)
  if (missingRequired.length) throw new Error(`请先填写必填项:${missingRequired.join('、')}`)
  const note = trimString(input.note ?? row.note, 1000) || null
  const tags = normalizeTags((input.tags ?? row.tags) as unknown)
  const attachments = normalizeAttachments(row.attachmentsJson as CheckInAttachment[])
  const recordedAt = parseRecordedAt(row.recordedAt?.toISOString() ?? now.toISOString())
  assertNotFutureCheckInDate(recordedAt, now)

  const rendered = renderCheckInRecordSchema({
    schema,
    title: schema.titleTemplate,
    recordedAt: recordedAt.toISOString(),
    values,
    note,
    attachments,
    tags,
  })

  const dedupeKey = buildCheckInDedupeKey({
    userId: input.userId,
    sourceMessageId: row.sourceMessageId,
    categoryKey: schema.categoryKey,
    values,
  })

  let record = await findRecordByDedupeKey(input.userId, dedupeKey)
  let action: SaveCheckInCardResult['action'] = 'created'
  if (record) {
    logger.info({ userId: input.userId, cardId: row.id, dedupeKey }, 'check-in card save hit existing dedupe row')
    const payload = buildCheckInRecordUpdatePayload({
      record,
      values,
      note,
      tags,
    })
    const [updated] = await getDb().update(checkInRecords)
      .set({
        ...payload,
        updatedAt: new Date(),
      })
      .where(and(
        eq(checkInRecords.userId, input.userId),
        eq(checkInRecords.id, record.id),
        isNull(checkInRecords.deletedAt),
      ))
      .returning()
    if (!updated) throw new Error('打卡记录更新失败。')
    record = serializeRecord(updated)
    action = 'updated'
  } else {
    const [inserted] = await getDb().insert(checkInRecords).values({
      userId: input.userId,
      schemaId: schemaRow.id,
      categoryKey: schema.categoryKey,
      schemaVersion: schemaRow.schemaVersion,
      title: rendered.title,
      recordedAt,
      recordedByType: 'user',
      recordedByName: input.recordedByName ?? '本人提交',
      sourceSessionId: row.sessionId,
      sourceMessageId: row.sourceMessageId ?? null,
      toolCallId: row.toolCallId,
      valuesJson: values,
      attachmentsJson: attachments,
      renderedA2uiSchema: rendered,
      schemaSnapshot: schema,
      tags,
      dedupeKey,
    }).returning()
    if (!inserted) throw new Error('打卡记录保存失败。')
    record = serializeRecord(inserted)
  }

  await getDb().update(userCheckInSchemas)
    .set({ lastUsedAt: new Date(), updatedAt: new Date() })
    .where(eq(userCheckInSchemas.id, schemaRow.id))

  const [updatedCard] = await getDb().update(checkInCards)
    .set({
      status: 'saved',
      recordId: record.id,
      valuesJson: values,
      note,
      tags,
      recordedAt,
      savedAt: now,
      updatedAt: new Date(),
    })
    .where(and(eq(checkInCards.userId, input.userId), eq(checkInCards.id, row.id), isNull(checkInCards.deletedAt)))
    .returning()
  if (!updatedCard) throw new Error('打卡卡片状态更新失败。')

  return { card: serializeCard(updatedCard, record), record, action }
}

export async function proposeCheckInDraft(
  input: ProposeCheckInDraftInput,
): Promise<CheckInDraftToolOutput> {
  const sourceText = await resolveCheckInSourceText(input.sourceText, input.sourceMessageId)
  const schema = normalizeCheckInSchemaDraft(buildFallbackCheckInSchemaDraft({
    categoryQuery: trimString(input.draft.categoryName, 80) || '打卡记录',
    draftValues: input.draftValues,
    fallbackSchema: input.draft,
    sourceText,
  }))
  const existing = await getDb().query.userCheckInSchemas.findFirst({
    where: and(
      eq(userCheckInSchemas.userId, input.userId),
      eq(userCheckInSchemas.categoryKey, schema.categoryKey),
    ),
  })

  // 已存在同分类 → 走 use_existing 复用,避免重复创建模板
  if (existing) {
    return proposeCheckInRecord({
      userId: input.userId,
      sessionId: input.sessionId,
      toolCallId: input.toolCallId,
      sourceMessageId: input.sourceMessageId,
      categoryKey: schema.categoryKey,
      categoryQuery: schema.categoryName,
      draftValues: input.draftValues,
      draftNote: input.draftNote,
      draftTags: input.draftTags,
      attachments: input.attachments,
      recordedAt: input.recordedAt,
      sourceText: input.sourceText,
      supersedesCheckInCardId: input.supersedesCheckInCardId,
    })
  }

  const baseValues = enhanceCheckInValuesFromSourceText(input.draftValues ?? null, schema, sourceText)
  const note = resolveCheckInDraftNote(input.draftNote, input.draftValues)
  const tags = normalizeTags(input.draftTags)
  const attachments = await resolveCheckInAttachments(input.attachments, input.sourceMessageId)
  const recordedAt = resolveCheckInRecordRecordedAt({
    explicitRecordedAt: input.recordedAt,
    schema,
    values: baseValues,
  }).toISOString()
  const values = trimString(input.recordedAt, 80)
    ? applyRecordedAtToRecordDateFields(schema, baseValues, recordedAt)
    : baseValues

  const schemaRow = await upsertCheckInSchemaForDraft({
    userId: input.userId,
    sessionId: input.sessionId,
    toolCallId: input.toolCallId,
    sourceMessageId: input.sourceMessageId ?? null,
    schemaActionHint: 'create',
    schema,
  })

  const card = await createCheckInCard({
    userId: input.userId,
    sessionId: input.sessionId,
    toolCallId: input.toolCallId,
    sourceMessageId: input.sourceMessageId ?? null,
    schemaActionHint: 'create',
    schema,
    existingSchemaId: schemaRow.id,
    values,
    attachments,
    note,
    tags,
    recordedAt,
    supersedesCheckInCardId: input.supersedesCheckInCardId,
  })

  return buildCheckInCardToolOutput({
    id: card.id,
    status: card.status,
    schemaActionHint: 'create',
    schema,
    values,
    attachments,
    note,
    tags,
    recordedAt,
    supersedesCheckInCardId: input.supersedesCheckInCardId,
    message: '已生成打卡卡片草稿,等待用户在卡片里核对并保存。',
  })
}

function scoreSchema(schema: CheckInSchemaRecord, query: string): number {
  const needle = query.trim().toLowerCase()
  if (!needle) return 0
  const names = [schema.categoryName, schema.categoryKey, ...schema.aliases].map((item) => item.toLowerCase())
  if (names.some((item) => item === needle)) return 100
  if (names.some((item) => item.includes(needle) || needle.includes(item))) return 60
  return 0
}

function summarizeSchemaCandidate(
  schema: CheckInSchemaRecord,
): Pick<CheckInSchemaRecord, 'id' | 'categoryKey' | 'categoryName' | 'aliases'> {
  return {
    id: schema.id,
    categoryKey: schema.categoryKey,
    categoryName: schema.categoryName,
    aliases: schema.aliases,
  }
}

export function findCheckInSchemaMatch(
  schemas: CheckInSchemaRecord[],
  input: { categoryQuery?: string | null; categoryKey?: string | null },
): CheckInSchemaMatchResult {
  const categoryKey = trimString(input.categoryKey, 160)
  if (categoryKey) {
    const matched = schemas.find((schema) => schema.categoryKey === categoryKey)
    if (matched) {
      return {
        action: 'matched',
        schema: matched,
        candidates: [],
        message: `已按 categoryKey 命中分类:${matched.categoryName}`,
      }
    }
    return {
      action: 'not_found',
      candidates: [],
      message: `未找到 categoryKey=${categoryKey} 对应的打卡分类,请重新读取分类 schema 或按新分类生成。`,
    }
  }

  const categoryQuery = trimString(input.categoryQuery, 120)
  const ranked = schemas
    .map((schema) => ({ schema, score: scoreSchema(schema, categoryQuery) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)

  if (ranked.length === 0) {
    return {
      action: 'not_found',
      candidates: [],
      message: '未命中已有打卡分类。',
    }
  }

  if (ranked.length > 1 && ranked[0].score === ranked[1].score && ranked[0].score < 100) {
    return {
      action: 'candidates',
      candidates: ranked.slice(0, 5).map(({ schema }) => summarizeSchemaCandidate(schema)),
      message: '找到多个可能的打卡模板,请先让用户确认分类。',
    }
  }

  return {
    action: 'matched',
    schema: ranked[0].schema,
    candidates: [],
    message: `已命中分类:${ranked[0].schema.categoryName}`,
  }
}

export async function listCheckInSchemas(userId: string): Promise<CheckInSchemaRecord[]> {
  const rows = await getDb().query.userCheckInSchemas.findMany({
    where: and(eq(userCheckInSchemas.userId, userId), eq(userCheckInSchemas.status, 'active')),
    orderBy: desc(userCheckInSchemas.updatedAt),
  })
  return orderCheckInSchemasForDisplay(rows).map(serializeSchema)
}

export async function getCheckInSchemaForTool(input: {
  userId: string
  categoryQuery?: string | null
  categoryKey?: string | null
}): Promise<CheckInSchemaMatchResult> {
  const schemas = await listCheckInSchemas(input.userId)
  return findCheckInSchemaMatch(schemas, input)
}

export async function proposeCheckInRecord(
  input: ProposeCheckInRecordInput,
): Promise<CheckInDraftToolOutput> {
  const schemas = await listCheckInSchemas(input.userId)
  const schemaMatch = findCheckInSchemaMatch(schemas, {
    categoryQuery: input.categoryQuery,
    categoryKey: input.categoryKey,
  })

  if (schemaMatch.action === 'not_found') {
    if (trimString(input.categoryKey, 160)) {
      throw new Error(schemaMatch.message)
    }
    const sourceText = await resolveCheckInSourceText(input.sourceText, input.sourceMessageId)
    const schema = normalizeCheckInSchemaDraft(buildFallbackCheckInSchemaDraft({
      categoryQuery: input.categoryQuery,
      draftValues: input.draftValues,
      fallbackSchema: input.fallbackSchema,
      sourceText,
    }))
    const baseValues = enhanceCheckInValuesFromSourceText(input.draftValues ?? null, schema, sourceText)
    const note = resolveCheckInDraftNote(input.draftNote, input.draftValues)
    const tags = normalizeTags(input.draftTags)
    const attachments = await resolveCheckInAttachments(input.attachments, input.sourceMessageId)
    const recordedAt = resolveCheckInRecordRecordedAt({
      explicitRecordedAt: input.recordedAt,
      schema,
      values: baseValues,
    }).toISOString()
    const values = trimString(input.recordedAt, 80)
      ? applyRecordedAtToRecordDateFields(schema, baseValues, recordedAt)
      : baseValues

    const schemaRow = await upsertCheckInSchemaForDraft({
      userId: input.userId,
      sessionId: input.sessionId,
      toolCallId: input.toolCallId,
      sourceMessageId: input.sourceMessageId ?? null,
      schemaActionHint: 'create',
      schema,
    })

    const card = await createCheckInCard({
      userId: input.userId,
      sessionId: input.sessionId,
      toolCallId: input.toolCallId,
      sourceMessageId: input.sourceMessageId ?? null,
      schemaActionHint: 'create',
      schema,
      existingSchemaId: schemaRow.id,
      values,
      attachments,
      note,
      tags,
      recordedAt,
      supersedesCheckInCardId: input.supersedesCheckInCardId,
    })

    return buildCheckInCardToolOutput({
      id: card.id,
      status: card.status,
      schemaActionHint: 'create',
      schema,
      values,
      attachments,
      note,
      tags,
      recordedAt,
      supersedesCheckInCardId: input.supersedesCheckInCardId,
      message: '已生成新的打卡分类和本次记录草稿,等待用户在卡片里核对并保存。',
    })
  }

  if (schemaMatch.action === 'candidates') {
    return {
      action: 'schema_candidates',
      candidates: schemaMatch.candidates,
      message: schemaMatch.message,
    }
  }

  const matchedSchema = schemaMatch.schema
  const sourceText = await resolveCheckInSourceText(input.sourceText, input.sourceMessageId)
  const shouldReplaceSchema = shouldReplaceExistingCheckInSchema({
    existing: matchedSchema.a2uiSchema,
    categoryQuery: input.categoryQuery,
    draftValues: input.draftValues,
    sourceText,
    fallbackSchema: input.fallbackSchema,
  })
  const schema = shouldReplaceSchema
    ? normalizeCheckInSchemaDraft(buildReplacementCheckInSchemaDraft({
        existing: matchedSchema.a2uiSchema,
        categoryQuery: input.categoryQuery,
        draftValues: input.draftValues,
        sourceText,
        fallbackSchema: input.fallbackSchema,
      }))
    : matchedSchema.a2uiSchema
  const schemaActionHint: 'create' | 'use_existing' = shouldReplaceSchema ? 'create' : 'use_existing'
  const baseValues = enhanceCheckInValuesFromSourceText(input.draftValues ?? null, schema, sourceText)
  const note = resolveCheckInDraftNote(input.draftNote, input.draftValues)
  const tags = normalizeTags(input.draftTags)
  const attachments = await resolveCheckInAttachments(input.attachments, input.sourceMessageId)
  const recordedAt = resolveCheckInRecordRecordedAt({
    explicitRecordedAt: input.recordedAt,
    schema,
    values: baseValues,
  }).toISOString()
  const values = trimString(input.recordedAt, 80)
    ? applyRecordedAtToRecordDateFields(schema, baseValues, recordedAt)
    : baseValues

  const schemaRow = await upsertCheckInSchemaForDraft({
    userId: input.userId,
    sessionId: input.sessionId,
    toolCallId: input.toolCallId,
    sourceMessageId: input.sourceMessageId ?? null,
    schemaActionHint,
    schema,
    existingSchemaId: matchedSchema.id,
  })

  const card = await createCheckInCard({
    userId: input.userId,
    sessionId: input.sessionId,
    toolCallId: input.toolCallId,
    sourceMessageId: input.sourceMessageId ?? null,
    schemaActionHint,
    schema,
    existingSchemaId: schemaRow.id,
    values,
    attachments,
    note,
    tags,
    recordedAt,
    supersedesCheckInCardId: input.supersedesCheckInCardId,
  })

  return buildCheckInCardToolOutput({
    id: card.id,
    status: card.status,
    schemaActionHint,
    ...(shouldReplaceSchema ? {} : {
      existingSchema: {
        id: matchedSchema.id,
        categoryKey: matchedSchema.categoryKey,
        categoryName: matchedSchema.categoryName,
        displayMode: matchedSchema.displayMode,
        aliases: matchedSchema.aliases,
      },
    }),
    schema,
    values,
    attachments,
    note,
    tags,
    recordedAt,
    supersedesCheckInCardId: input.supersedesCheckInCardId,
    message: shouldReplaceSchema
      ? '已生成更适合本次内容的打卡卡片草稿,等待用户在卡片里核对并保存。'
      : '已基于已有打卡分类生成本次记录草稿,等待用户在卡片里核对并保存。',
  })
}

/**
 * 用户在卡片里点"保存"后,本函数把 draft 落库为正式 record。
 * - 草稿 schema 不存在则 upsert 为用户可复用模板
 */
export async function commitCheckInDraft(
  input: CommitCheckInDraftInput,
  logger: Logger,
): Promise<CheckInRecord> {
  if (input.checkInCardId) {
    const { record } = await saveCheckInCard({
      userId: input.userId,
      cardId: input.checkInCardId,
      values: input.values,
      note: input.note,
      tags: input.tags,
      recordedByName: input.recordedByName,
    }, logger)
    return record
  }

  if (!input.draftToken) throw new Error('缺少打卡卡片 ID 或旧版草稿 token。')
  const draft = await consumeCheckInDraft(input.draftToken)
  if (!draft) throw new Error('打卡草稿不存在或已过期,请重新生成。')
  if (draft.userId !== input.userId) throw new Error('打卡草稿与当前用户不匹配。')

  const schema = draft.schema
  const schemaHash = hashText(stableStringify(schema))
  const now = new Date()

  // upsert schema
  let schemaRow: DbSchemaRow | undefined
  if (draft.existingSchemaId) {
    schemaRow = await getDb().query.userCheckInSchemas.findFirst({
      where: eq(userCheckInSchemas.id, draft.existingSchemaId),
    })
  }
  if (!schemaRow) {
    const existing = await getDb().query.userCheckInSchemas.findFirst({
      where: and(
        eq(userCheckInSchemas.userId, input.userId),
        eq(userCheckInSchemas.categoryKey, schema.categoryKey),
      ),
    })
    if (existing) {
      const existingSchema = schemaWithDisplayMode(
        existing.a2uiSchema as CheckInA2uiSchema,
        existing.displayMode as CheckInDisplayMode,
      )
      if (shouldUpgradeStoredCheckInSchema(existingSchema, schema)) {
        schemaRow = (await getDb().update(userCheckInSchemas)
          .set({
            categoryName: schema.categoryName,
            displayMode: schema.displayMode,
            categoryDescription: schema.categoryDescription ?? null,
            aliases: schema.aliases,
            schemaVersion: existing.schemaVersion + 1,
            schemaHash,
            a2uiSchema: schema,
            status: 'active',
            lastUsedAt: now,
            updatedAt: now,
          })
          .where(and(eq(userCheckInSchemas.id, existing.id), eq(userCheckInSchemas.userId, input.userId)))
          .returning())[0]
      } else {
        schemaRow = existing
      }
    }
    schemaRow = schemaRow ?? (await getDb().insert(userCheckInSchemas).values({
      userId: input.userId,
      categoryKey: schema.categoryKey,
      categoryName: schema.categoryName,
      displayMode: schema.displayMode,
      categoryDescription: schema.categoryDescription ?? null,
      aliases: schema.aliases,
      schemaVersion: 1,
      schemaHash,
      a2uiSchema: schema,
      status: 'active',
      createdFromSessionId: draft.sessionId,
      createdFromMessageId: draft.sourceMessageId ?? null,
      createdFromToolCallId: draft.toolCallId,
      lastUsedAt: now,
    }).returning())[0]
  }
  if (!schemaRow) throw new Error('打卡模板创建失败。')

  // 用户提交的 values 是权威值;只保留 schema 声明的 field key
  const values = projectValuesToFields(input.values ?? draft.draftValues, schema)
  const note = trimString(input.note ?? draft.draftNote, 1000) || null
  const tags = normalizeTags((input.tags ?? draft.draftTags) as unknown)
  const attachments = draft.draftAttachments
  const recordedAt = parseRecordedAt(draft.recordedAt)
  assertNotFutureCheckInDate(recordedAt, now)

  const rendered = renderCheckInRecordSchema({
    schema,
    title: schema.titleTemplate,
    recordedAt: recordedAt.toISOString(),
    values,
    note,
    attachments,
    tags,
  })

  const dedupeKey = buildCheckInDedupeKey({
    userId: input.userId,
    sourceMessageId: draft.sourceMessageId,
    categoryKey: schema.categoryKey,
    values,
  })

  const existing = await findRecordByDedupeKey(input.userId, dedupeKey)
  if (existing) {
    logger.info({ userId: input.userId, dedupeKey }, 'check-in commit hit existing dedupe row, returning existing')
    return existing
  }

  const [inserted] = await getDb().insert(checkInRecords).values({
    userId: input.userId,
    schemaId: schemaRow.id,
    categoryKey: schema.categoryKey,
    schemaVersion: schemaRow.schemaVersion,
    title: rendered.title,
    recordedAt,
    recordedByType: 'user',
    recordedByName: input.recordedByName ?? '本人提交',
    sourceSessionId: draft.sessionId,
    sourceMessageId: draft.sourceMessageId ?? null,
    toolCallId: draft.toolCallId,
    valuesJson: values,
    attachmentsJson: attachments,
    renderedA2uiSchema: rendered,
    schemaSnapshot: schema,
    tags,
    dedupeKey,
  }).returning()

  await getDb().update(userCheckInSchemas)
    .set({ lastUsedAt: new Date(), updatedAt: new Date() })
    .where(eq(userCheckInSchemas.id, schemaRow.id))

  return serializeRecord(inserted)
}

export async function listCheckInRecords(input: {
  userId: string
  categoryKey?: string | null
  limit?: number
  cursor?: string | null
}): Promise<{ records: CheckInRecord[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(input.limit ?? 30, 1), 50)
  const where = [
    eq(checkInRecords.userId, input.userId),
    isNull(checkInRecords.deletedAt),
    input.categoryKey ? eq(checkInRecords.categoryKey, input.categoryKey) : undefined,
    input.cursor ? sql`${checkInRecords.recordedAt} < ${new Date(input.cursor)}` : undefined,
  ].filter(Boolean) as any[]
  const rows = await getDb().query.checkInRecords.findMany({
    where: and(...where),
    orderBy: desc(checkInRecords.recordedAt),
    limit: limit + 1,
  })
  const hasMore = rows.length > limit
  const pageRows = hasMore ? rows.slice(0, limit) : rows
  return {
    records: pageRows.map(serializeRecord),
    nextCursor: hasMore ? pageRows[pageRows.length - 1]?.recordedAt.toISOString() ?? null : null,
  }
}

export async function getCheckInRecord(userId: string, id: string): Promise<CheckInRecord | null> {
  const row = await getDb().query.checkInRecords.findFirst({
    where: and(eq(checkInRecords.userId, userId), eq(checkInRecords.id, id), isNull(checkInRecords.deletedAt)),
  })
  return row ? serializeRecord(row) : null
}

export async function updateCheckInRecord(input: UpdateCheckInRecordInput): Promise<CheckInRecord | null> {
  const row = await getDb().query.checkInRecords.findFirst({
    where: and(
      eq(checkInRecords.userId, input.userId),
      eq(checkInRecords.id, input.recordId),
      isNull(checkInRecords.deletedAt),
    ),
  })
  if (!row) return null

  const currentRecord = serializeRecord(row)
  const payload = buildCheckInRecordUpdatePayload({
    record: currentRecord,
    values: input.values,
    note: input.note,
    tags: input.tags,
    recordedAt: input.recordedAt,
  })
  const missingRequired = validateCheckInRequiredFields(currentRecord.schemaSnapshot, payload.valuesJson)
  if (missingRequired.length) throw new Error(`请先填写必填项:${missingRequired.join('、')}`)
  const [updated] = await getDb().update(checkInRecords)
    .set({
      ...payload,
      updatedAt: new Date(),
    })
    .where(and(
      eq(checkInRecords.userId, input.userId),
      eq(checkInRecords.id, input.recordId),
      isNull(checkInRecords.deletedAt),
    ))
    .returning()

  return updated ? serializeRecord(updated) : null
}

export async function deleteCheckInRecord(userId: string, id: string): Promise<boolean> {
  const [row] = await getDb().update(checkInRecords)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(checkInRecords.userId, userId), eq(checkInRecords.id, id), isNull(checkInRecords.deletedAt)))
    .returning({ id: checkInRecords.id })
  return !!row
}
