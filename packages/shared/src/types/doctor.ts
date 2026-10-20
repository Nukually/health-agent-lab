import type { CurrentConcern, MedicalProfileData, UserProfileInput } from './user.js'
import type { DocumentType } from './medical-document.js'
import type { FeatureSnapshot } from '../features.js'

export type DoctorBindingStatus = 'pending_confirmation' | 'confirmed' | 'rejected' | 'pending_unbind' | 'unbound'
export type DoctorUnbindRequestedBy = 'patient' | 'doctor'

export interface MyDoctorProfile {
  id: string
  doctorInviteCode?: string | null
  name: string
  avatarUrl: string | null
  hospital?: string | null
  department: string | null
  title: string | null
  phone?: string | null
}

export interface BoundDoctor {
  status: DoctorBindingStatus
  unbindRequestedBy: DoctorUnbindRequestedBy | null
  bindingId: string
  doctor: MyDoctorProfile
  createdAt: string
  confirmedAt: string | null
  unboundAt: string | null
}

export interface MyDoctorResponse {
  bindings: BoundDoctor[]
  /** @deprecated Use bindings. Kept for older clients during rollout. */
  binding: BoundDoctor | null
  features?: FeatureSnapshot
}

export interface UnbindDoctorResponse {
  unbound: boolean
  bindings: BoundDoctor[]
  /** @deprecated Use bindings. Kept for older clients during rollout. */
  binding: BoundDoctor | null
  features?: FeatureSnapshot
}

export interface InviteBindDoctorRequest {
  doctorId: string
}

export interface InviteBindDoctorResponse {
  binding: BoundDoctor
  features?: FeatureSnapshot
}

export type DoctorAccessPatientListStatus = 'pending_confirmation' | 'confirmed'

export interface DoctorAccessPendingPatient {
  bindingId: string
  patient: {
    nickname: string | null
    phoneMasked: string
  }
  status: Extract<DoctorBindingStatus, 'pending_confirmation' | 'rejected' | 'pending_unbind'>
  unbindRequestedBy: DoctorUnbindRequestedBy | null
  createdAt: string
}

export interface DoctorAccessConfirmedPatient {
  bindingId: string
  patient: {
    nickname: string | null
    gender: UserProfileInput['gender'] | null
    birthday: string | null
    phoneMasked: string
    currentConcern: CurrentConcern | null
  }
  confirmedAt: string | null
  lastProfileUpdatedAt: string | null
  lastDocumentUpdatedAt: string | null
}

export interface DoctorAccessPatientsResponse {
  patients: Array<DoctorAccessPendingPatient | DoctorAccessConfirmedPatient>
}

export interface DoctorAccessConfirmBindingRequest {
  status: Extract<DoctorBindingStatus, 'confirmed' | 'rejected' | 'pending_unbind' | 'unbound'>
}

export interface DoctorAccessConfirmBindingResponse {
  bindingId: string
  status: Extract<DoctorBindingStatus, 'confirmed' | 'rejected' | 'pending_unbind' | 'unbound'>
  confirmedAt: string | null
}

export interface DoctorAccessMedicalDocumentSummary {
  documentId: string
  title: string | null
  documentType: DocumentType | null
  hospital: string | null
  documentDate: string | null
  imageCount: number
  uploadedAt: string
  updatedAt: string
}

export type DoctorAccessMedicalProfileZh = Record<string, string | Record<string, string>>

export interface DoctorAccessMedicalSummaryResponse {
  bindingId: string
  patient: {
    nickname: string | null
    gender: UserProfileInput['gender'] | null
    birthday: string | null
    currentConcern: CurrentConcern | null
  }
  medicalProfile: {
    profileData: DoctorAccessMedicalProfileZh
    profileDataRaw: MedicalProfileData
    profileDataZh: DoctorAccessMedicalProfileZh
  }
  documents: DoctorAccessMedicalDocumentSummary[]
}

export interface DoctorAccessDocumentImageResponse {
  documentId: string
  imageIndex: number
  imageUrl: string
  expiresIn: number
}
