import type { TFunction } from 'i18next'

export type ChatStatusState = {
  /** the conversation is being made, before the first question goes out */
  starting: boolean
  /** an answer of this conversation is coming */
  answering: boolean
  /** the stream manager's status for this conversation (`completed` once an answer ended with `[DONE]`) */
  streamStatus: string | undefined
}

/**
 * What the floating chat's status line says to a screen reader (WCAG 4.1.3): the conversation being made, an answer
 * coming, an answer that came. Empty while nothing is under way, so a polite live region reads each change once.
 */
export function chatStatusText(t: TFunction, s: ChatStatusState): string {
  if (s.starting) return t('floatingChat.sessionLoading', { defaultValue: 'Preparing session...' })
  if (s.answering) return t('floatingChat.statusAnswering', { defaultValue: 'Writing the answer...' })
  if (s.streamStatus === 'completed') return t('floatingChat.statusAnswered', { defaultValue: 'The answer is complete.' })
  return ''
}
