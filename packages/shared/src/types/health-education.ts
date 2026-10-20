export type HealthEducationScope = 'all' | 'my_doctor'
export type HealthEducationReaction = 'like' | 'dislike'
export type HealthEducationStatus = 'published' | 'offline'

export interface HealthEducationDoctor {
  id: string
  name: string
  avatarUrl: string | null
  department: string | null
  title: string | null
  hospital?: string | null
}

export interface HealthEducationItem {
  id: string
  posterId?: number
  status: HealthEducationStatus
  title: string
  summary: string | null
  content: string
  imageUrls: string[]
  coverUrl: string | null
  doctor: HealthEducationDoctor
  publishedAt: string
  updatedAt: string
  tags?: string[]
  drug?: string | null
  contentFormat?: string | null
  taskType?: string | null
  posterContent?: unknown
  isAvailable?: boolean
}

export interface HealthEducationItemWithStats extends HealthEducationItem {
  likeCount: number
  dislikeCount: number
  favoriteCount: number
  pvCount: number
  uvCount: number
  userReaction: HealthEducationReaction | null
  isFavorited: boolean
}

export interface HealthEducationListResponse {
  items: HealthEducationItemWithStats[]
  scope: HealthEducationScope
  boundDoctorId: string | null
  boundDoctorIds: string[]
  nextCursor: number | null
}

export interface HealthEducationSavedListResponse {
  items: HealthEducationItemWithStats[]
}

export interface HealthEducationPublishRequest {
  itemId?: string
  doctorId: string
  doctorName: string
  doctorAvatarUrl?: string | null
  department?: string | null
  doctorTitle?: string | null
  title: string
  summary?: string | null
  content: string
  imageUrls?: string[]
  coverUrl?: string | null
  publishedAt?: string
  clearImages?: boolean
  keepImageUrls?: string[]
}

export interface HealthEducationInteractionResponse {
  item: HealthEducationItemWithStats
}

export interface HealthEducationViewResponse {
  itemId: string
  pvCount: number
  uvCount: number
}

export interface HealthEducationStatsRecord {
  itemId: string
  likeCount: number
  dislikeCount: number
  favoriteCount: number
  pvCount: number
  uvCount: number
}

export interface DoctorAccessHealthEducationStatsResponse {
  items: HealthEducationStatsRecord[]
}

export interface DoctorAccessHealthEducationStatsByDoctorResponse {
  doctorId: string
  items: HealthEducationStatsRecord[]
  nextCursor: number | null
}

export interface DoctorHealthEducationListResponse {
  items: HealthEducationItemWithStats[]
}
