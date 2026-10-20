import type {
  InterventionMaterialEnvPresence,
  InterventionMaterialRecord,
  InterventionAssetInput,
  InterventionTargetEnv,
} from './intervention-material.js'

export interface InterventionMaterialListItem extends InterventionMaterialRecord {
  envPresence: InterventionMaterialEnvPresence
}

export interface InterventionMaterialListResponse {
  items: InterventionMaterialListItem[]
}

export interface InterventionMaterialDetailResponse {
  material: InterventionMaterialRecord
}

export interface InterventionMaterialPromoteResponse {
  materialId: string
  version: string
  targetEnv: Exclude<InterventionTargetEnv, 'dev'>
}

export interface InterventionMaterialBulkPromoteRequest {
  targetEnv: Exclude<InterventionTargetEnv, 'dev'>
}

export interface InterventionMaterialBulkPromoteSuccess {
  materialId: string
  actionName: string
  version: string
}

export interface InterventionMaterialBulkPromoteFailure {
  materialId: string
  actionName: string
  error: string
}

export interface InterventionMaterialBulkPromoteResponse {
  targetEnv: Exclude<InterventionTargetEnv, 'dev'>
  succeeded: InterventionMaterialBulkPromoteSuccess[]
  failed: InterventionMaterialBulkPromoteFailure[]
}

export interface InterventionMaterialEditorStepDraft {
  stepIndex: number
  durationSec: string
  displayText: string
  image: InterventionAssetInput
  previewUrl?: string
}

export interface InterventionMaterialEditorDraft {
  materialId: string
  sideEffect: string
  scene: string
  actionName: string
  prepareItems: string[]
  precheckQuestion: string
  feedbackQuestion: string
  effectiveRule: string
  fallbackAction: string
  redFlags: string[]
  safetyNote: string
  overviewImage: InterventionAssetInput
  overviewPreviewUrl?: string
  steps: InterventionMaterialEditorStepDraft[]
}
