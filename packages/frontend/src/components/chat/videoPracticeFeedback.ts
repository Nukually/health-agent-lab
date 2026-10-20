export type VideoPracticeFeedbackState = 'hidden' | 'paused' | 'completed'
export type VideoPracticeFeedbackSource = 'chat_inline' | 'materials' | 'shared_view'

interface ShouldShowVideoPracticeFeedbackArgs {
  source: VideoPracticeFeedbackSource
  hasTodoContext: boolean
  isTodoContextClosed: boolean
  isAtEnd: boolean
  feedbackState: VideoPracticeFeedbackState
}

export function shouldShowVideoPracticeFeedback({
  source,
  hasTodoContext,
  isTodoContextClosed,
  isAtEnd,
  feedbackState,
}: ShouldShowVideoPracticeFeedbackArgs): boolean {
  if (source === 'shared_view') return false
  if (hasTodoContext) {
    return feedbackState !== 'hidden' || isTodoContextClosed || isAtEnd
  }
  return feedbackState !== 'hidden'
}

export function getMobilePracticeFeedbackDelayMs(
  durationSec: number,
  currentPlayheadSec: number,
): number | null {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return null
  const midpointSec = durationSec / 2
  const normalizedPlayheadSec = Number.isFinite(currentPlayheadSec)
    ? Math.max(0, currentPlayheadSec)
    : 0
  const remainingSec = Math.max(0, midpointSec - normalizedPlayheadSec)
  return Math.round(remainingSec * 1000)
}
