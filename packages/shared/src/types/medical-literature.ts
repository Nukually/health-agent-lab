export interface MedicalLiteratureChunk {
  sourceRank: number
  score?: number | null
  title: string
  content: string
  doi?: string
  journal?: string
  pubYear?: number | null
  articleClass?: string
  sectionName?: string
  chunkType?: string
}

export interface MedicalLiteratureSource {
  id: string
  title: string
  doi?: string
  journal?: string
  pubYear?: number | null
  articleClass?: string
  score?: number | null
  chunks: MedicalLiteratureChunk[]
}

export interface MedicalLiteratureSearchOutput {
  kind: 'medical_literature_search'
  query: string
  citationStyle?: 'document_id' | 'numeric'
  searchedCount: number
  scoreThreshold?: number
  scoreQualifiedCount?: number
  candidateCount?: number
  selectedCount: number
  allSources: MedicalLiteratureSource[]
  selectedSources: MedicalLiteratureSource[]
}

function optionalNumber(value: unknown): value is number | null | undefined {
  return value === undefined || value === null || typeof value === 'number'
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string'
}

export function isMedicalLiteratureChunk(value: unknown): value is MedicalLiteratureChunk {
  if (!value || typeof value !== 'object') return false
  const raw = value as Record<string, unknown>
  return typeof raw.sourceRank === 'number'
    && optionalNumber(raw.score)
    && typeof raw.title === 'string'
    && typeof raw.content === 'string'
    && optionalString(raw.doi)
    && optionalString(raw.journal)
    && optionalNumber(raw.pubYear)
    && optionalString(raw.articleClass)
    && optionalString(raw.sectionName)
    && optionalString(raw.chunkType)
}

export function isMedicalLiteratureSource(value: unknown): value is MedicalLiteratureSource {
  if (!value || typeof value !== 'object') return false
  const raw = value as Record<string, unknown>
  return typeof raw.id === 'string'
    && typeof raw.title === 'string'
    && optionalString(raw.doi)
    && optionalString(raw.journal)
    && optionalNumber(raw.pubYear)
    && optionalString(raw.articleClass)
    && optionalNumber(raw.score)
    && Array.isArray(raw.chunks)
    && raw.chunks.every(isMedicalLiteratureChunk)
}

export function isMedicalLiteratureSearchOutput(value: unknown): value is MedicalLiteratureSearchOutput {
  if (!value || typeof value !== 'object') return false
  const raw = value as Record<string, unknown>
  return raw.kind === 'medical_literature_search'
    && typeof raw.query === 'string'
    && (raw.citationStyle === undefined || raw.citationStyle === 'document_id' || raw.citationStyle === 'numeric')
    && typeof raw.searchedCount === 'number'
    && optionalNumber(raw.scoreThreshold)
    && optionalNumber(raw.scoreQualifiedCount)
    && optionalNumber(raw.candidateCount)
    && typeof raw.selectedCount === 'number'
    && Array.isArray(raw.allSources)
    && Array.isArray(raw.selectedSources)
    && raw.allSources.every(isMedicalLiteratureSource)
    && raw.selectedSources.every(isMedicalLiteratureSource)
}
