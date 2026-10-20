export const COMMUNICATION_CARD_TEMPLATE_VERSION = 2

export const COMMUNICATION_CARD_FIELDS = [
  'title',
  'cardDate',
  'visitPurpose',
  'currentSituation',
  'informationForDoctor',
  'questionsForDoctor',
] as const

export type CommunicationCardField = (typeof COMMUNICATION_CARD_FIELDS)[number]

export type CommunicationCardFieldSource = 'ai' | 'user'

export type CommunicationCardFieldSources = Record<
  CommunicationCardField,
  CommunicationCardFieldSource
>

export interface CommunicationCardDraft {
  title: string
  cardDate: string
  visitPurpose: string
  currentSituation?: string
  informationForDoctor?: string
  questionsForDoctor?: string
}

export interface CommunicationCardToolOutput {
  kind: 'communication_card_draft'
  success?: boolean
  templateVersion: number
  draft: CommunicationCardDraft
  assistantReminder?: string
}

export interface CommunicationCardContent {
  draft: CommunicationCardDraft
  aiDraft: CommunicationCardDraft
  fieldSources: CommunicationCardFieldSources
  sourceToolCallId?: string | null
}

export interface CommunicationCardRecord {
  id: string
  userId: string
  title: string
  cardDate: string
  templateVersion: number
  sourceSessionId: string | null
  contentJson: CommunicationCardContent
  createdAt: string
  updatedAt: string
}

export interface CreateCommunicationCardRequest {
  draft: CommunicationCardDraft
  originalDraft?: CommunicationCardDraft
  sourceSessionId?: string | null
  sourceToolCallId?: string | null
}

export interface UpdateCommunicationCardRequest {
  draft: CommunicationCardDraft
}

export const COMMUNICATION_CARD_FIELD_LABELS: Record<CommunicationCardField, string> = {
  title: '标题',
  cardDate: '日期',
  visitPurpose: '就诊目标',
  currentSituation: '我的情况',
  informationForDoctor: '这次建议带上',
  questionsForDoctor: '我的问题（旧版）',
}

function isOptionalString(value: unknown): value is string | undefined | null {
  return value == null || typeof value === 'string'
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function joinLegacyList(value: unknown): string {
  return isStringArray(value) ? value.map((item) => item.trim()).filter(Boolean).join('\n') : ''
}

function normalizeLegacyInformation(draft: Record<string, unknown>): string {
  const sections: string[] = []
  const recentChanges = joinLegacyList(draft.recentChanges)
  const thingsToBring = joinLegacyList(draft.thingsToBring)
  const notes = typeof draft.notes === 'string' ? draft.notes.trim() : ''

  if (recentChanges) sections.push(recentChanges)
  if (thingsToBring) sections.push(`准备材料：\n${thingsToBring}`)
  if (notes) sections.push(`其他补充：\n${notes}`)

  return sections.join('\n\n')
}

function normalizeLegacyDraft(draft: Record<string, unknown>): CommunicationCardDraft | null {
  if (
    typeof draft.title !== 'string' ||
    typeof draft.cardDate !== 'string' ||
    typeof draft.visitPurpose !== 'string'
  ) {
    return null
  }

  const currentSituation =
    typeof draft.currentSituation === 'string'
      ? draft.currentSituation.trim()
      : typeof draft.currentTreatment === 'string'
        ? draft.currentTreatment.trim()
        : ''

  const informationForDoctor =
    typeof draft.informationForDoctor === 'string'
      ? draft.informationForDoctor.trim()
      : normalizeLegacyInformation(draft)

  const questionsForDoctor =
    typeof draft.questionsForDoctor === 'string'
      ? draft.questionsForDoctor.trim()
      : joinLegacyList(draft.questionsForDoctor)

  return {
    title: draft.title,
    cardDate: draft.cardDate,
    visitPurpose: draft.visitPurpose,
    currentSituation: currentSituation || undefined,
    informationForDoctor: informationForDoctor || undefined,
    questionsForDoctor: questionsForDoctor || undefined,
  }
}

export function isCommunicationCardDraft(value: unknown): value is CommunicationCardDraft {
  if (!value || typeof value !== 'object') return false
  const draft = value as Record<string, unknown>
  if (typeof draft.title !== 'string') return false
  if (typeof draft.cardDate !== 'string') return false
  if (typeof draft.visitPurpose !== 'string') return false
  if (!isOptionalString(draft.currentSituation)) return false
  if (!isOptionalString(draft.informationForDoctor)) return false
  if (!isOptionalString(draft.questionsForDoctor)) return false
  return true
}

export function parseCommunicationCardToolOutput(
  raw: unknown,
): CommunicationCardToolOutput | null {
  if (typeof raw === 'string') {
    try {
      return parseCommunicationCardToolOutput(JSON.parse(raw))
    } catch {
      return null
    }
  }

  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>

  if (value.kind === 'communication_card_draft' && isCommunicationCardDraft(value.draft)) {
    return {
      kind: 'communication_card_draft',
      success: typeof value.success === 'boolean' ? value.success : true,
      templateVersion:
        typeof value.templateVersion === 'number'
          ? value.templateVersion
          : COMMUNICATION_CARD_TEMPLATE_VERSION,
      draft: value.draft,
      assistantReminder:
        typeof value.assistantReminder === 'string' ? value.assistantReminder : undefined,
    }
  }

  if (value.kind === 'communication_card_draft' && value.draft && typeof value.draft === 'object') {
    const legacyDraft = normalizeLegacyDraft(value.draft as Record<string, unknown>)
    if (legacyDraft) {
      return {
        kind: 'communication_card_draft',
        success: typeof value.success === 'boolean' ? value.success : true,
        templateVersion:
          typeof value.templateVersion === 'number'
            ? value.templateVersion
            : COMMUNICATION_CARD_TEMPLATE_VERSION,
        draft: legacyDraft,
        assistantReminder:
          typeof value.assistantReminder === 'string' ? value.assistantReminder : undefined,
      }
    }
  }

  if (isCommunicationCardDraft(raw)) {
    return {
      kind: 'communication_card_draft',
      success: true,
      templateVersion: COMMUNICATION_CARD_TEMPLATE_VERSION,
      draft: raw,
    }
  }

  if (typeof raw === 'object' && raw) {
    const legacyDraft = normalizeLegacyDraft(raw as Record<string, unknown>)
    if (legacyDraft) {
      return {
        kind: 'communication_card_draft',
        success: true,
        templateVersion: COMMUNICATION_CARD_TEMPLATE_VERSION,
        draft: legacyDraft,
      }
    }
  }

  return null
}
