// What a followed stream says when its session ended; `code` is the reason the server sent.
export function liveSessionEndText(t: (key: string, fallback: string) => string, code: string): string {
  switch (code) {
    case 'session_expired':
      return t('liveSession.expired', 'Stopped: the session reached its maximum lifetime. Sign in again.')
    case 'session_unverified':
      return t('liveSession.unverified', 'Stopped: the session could not be verified. Sign in again.')
    default:
      return t('liveSession.revoked', 'Stopped: your account or access changed. Sign in again.')
  }
}
