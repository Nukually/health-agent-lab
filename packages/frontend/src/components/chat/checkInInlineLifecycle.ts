type MutableRef<T> = { current: T }

export function shouldDeactivateCheckInDraftCard(input: {
  supersededByNewerUserMessage: boolean
  status?: 'draft' | 'saved' | 'invalidated' | 'deleted' | null
}): boolean {
  return input.status === 'invalidated' || input.status === 'deleted'
}

export function shouldMuteCheckInReadOnlyCard(input: {
  hasSavedRecord: boolean
  isSaveIntent?: boolean
  supersededByNewerUserMessage: boolean
  status?: 'draft' | 'saved' | 'invalidated' | 'deleted' | null
}): boolean {
  return input.hasSavedRecord || input.isSaveIntent === true || input.status === 'saved' || shouldDeactivateCheckInDraftCard(input)
}

export function shouldApplyCheckInCardInvalidation(input: {
  status?: 'draft' | 'saved' | 'invalidated' | 'deleted' | null
}): boolean {
  return input.status === 'draft'
}

export function setupCheckInAsyncLifecycle(
  cancelledRef: MutableRef<boolean>,
  pollTimerRef: MutableRef<number | null>,
  clearTimer: (timerId: number) => void = (timerId) => window.clearTimeout(timerId),
): () => void {
  cancelledRef.current = false
  return () => {
    cancelledRef.current = true
    if (pollTimerRef.current != null) {
      clearTimer(pollTimerRef.current)
      pollTimerRef.current = null
    }
  }
}
