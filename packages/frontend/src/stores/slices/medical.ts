import type { CurrentConcern } from '@health-agent/shared'
import type { MedicalProfileData } from '@health-agent/shared'
import type { StateCreator } from 'zustand'

export interface UserProfileData {
  nickname?: string
  birthday?: string
  gender?: string
  currentConcern?: CurrentConcern
}

export interface MedicalSlice {
  userProfile: UserProfileData | null
  medicalProfile: MedicalProfileData | null
  isLoading: boolean

  setUserProfile: (profile: UserProfileData | null) => void
  setMedicalProfile: (profile: MedicalProfileData | null) => void
  setLoading: (loading: boolean) => void
}

export const createMedicalSlice: StateCreator<MedicalSlice, [], [], MedicalSlice> = (set) => ({
  userProfile: null,
  medicalProfile: null,
  isLoading: false,

  setUserProfile: (profile) => set({ userProfile: profile }),
  setMedicalProfile: (profile) => set({ medicalProfile: profile }),
  setLoading: (loading) => set({ isLoading: loading }),
})
