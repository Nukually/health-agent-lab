export interface AskUserQuestionOption {
  label: string
  description: string
  ref_id?: string
}

export interface AskUserQuestionItem {
  question: string
  header: string
  options: AskUserQuestionOption[]
  multiSelect: boolean
}

export type AskUserQuestionResourceKind = 'intervention_material' | 'video_resource' | 'internal_video'

export type AskUserQuestionResourceDifficulty = 'simple' | 'medium' | 'complex'

export interface AskUserQuestionResourcePreview {
  refId: string
  kind: AskUserQuestionResourceKind
  title: string
  thumbnailUrl: string | null
  durationSec?: number | null
  difficulty?: AskUserQuestionResourceDifficulty | null
}

export interface AskUserQuestionToolOutput {
  kind: 'ask_user_question'
  questions: AskUserQuestionItem[]
  resourcePreviews?: AskUserQuestionResourcePreview[]
}
