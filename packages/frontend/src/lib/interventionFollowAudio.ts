let interventionFollowAudioActive = false
const videoResourcePlaybackOwners = new Set<string>()

export function setInterventionFollowAudioActive(active: boolean) {
  interventionFollowAudioActive = active
}

export function isInterventionFollowAudioActive(): boolean {
  return interventionFollowAudioActive
}

export function setVideoResourcePlaybackActive(ownerId: string, active: boolean) {
  if (active) {
    videoResourcePlaybackOwners.add(ownerId)
  } else {
    videoResourcePlaybackOwners.delete(ownerId)
  }
}

export function isAssistantAutoTTSBlocked(): boolean {
  return interventionFollowAudioActive || videoResourcePlaybackOwners.size > 0
}
