import type { MedicalProfileData } from './user.js'

// === Medical Document (OCR 病历文档) ===

export type DocumentType = 'outpatient' | 'pathology' | 'imaging' | 'discharge' | 'lab' | 'other'

export interface MedicalDocument {
  id: string
  userId: string
  documentDate: string | null // YYYY-MM-DD, OCR 提取的就诊/检查日期
  uploadedAt: string
  title: string | null
  documentType: DocumentType | null
  hospital: string | null
  ocrText: string
  imageUrls: string[]
  rawTextUrl: string | null
  pageCount: number
  createdAt: string
  updatedAt: string
}

/** OCR 提取的个人信息（可回填 Level 1 表单） */
export interface ExtractedPersonalInfo {
  name?: string       // 姓名 → 昵称
  birthday?: string   // YYYY-MM-DD（从身份证号或年龄+日期推算）
  gender?: '男' | '女'
}

/** OCR 已确认是病历/报告类医疗资料 */
export interface MedicalDocumentOcrResult {
  isMedicalDocument: true
  document: MedicalDocument
  extractedFields: MedicalProfileData
  extractedPersonalInfo?: ExtractedPersonalInfo
}

/** OCR 判定为明显非病历/报告类图片 */
export interface NonMedicalDocumentOcrResult {
  isMedicalDocument: false
  reason: string
}

/** POST /api/medical/ocr 响应 */
export type OcrResult = MedicalDocumentOcrResult | NonMedicalDocumentOcrResult

export type MedicalDocumentSaveJobState = 'queued' | 'running' | 'completed' | 'failed'

export interface MedicalDocumentSaveJobStatus {
  jobId: string
  status: MedicalDocumentSaveJobState
  sessionId: string
  sourceMessageId: string
  imageCount: number
  documentHash: string
  createdAt: number
  updatedAt: number
  document?: MedicalDocument
  extractedFields?: MedicalProfileData
  extractedPersonalInfo?: ExtractedPersonalInfo
  error?: string
}

/** LLM 提取的文档元数据 */
export interface DocumentMeta {
  documentDate: string | null // YYYY-MM-DD
  title: string | null
  documentType: DocumentType | null
  hospital: string | null
}
