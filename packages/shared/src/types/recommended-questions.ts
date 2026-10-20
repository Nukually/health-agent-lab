export type RecommendedQuestionSource = 'llm' | 'rule' | 'default'

export type RecommendedQuestionBatchStatus = 'success' | 'partial_fallback' | 'fallback' | 'failed'

export type RecommendedQuestionItemStatus = 'candidate' | 'selected' | 'filtered' | 'fallback'

export type RecommendedQuestionRiskLevel = 'low' | 'medium' | 'high'

export type RecommendedQuestionTrigger = 'profile_generation' | 'manual' | 'fallback'

export interface AgentRecommendedQuestionsResponse {
  status: 'generating' | 'ready'
  source: 'agent'
  cached: boolean
  generatedAt: string | null
  questions: string[]
}

export interface RecommendedQuestionInteraction {
  interactionId: string
  source: 'agent'
  question: string
  rank: number
  cached?: boolean
  generatedAt?: string | null
}
