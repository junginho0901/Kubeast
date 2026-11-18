// A k8s-service being replaced (STREAM_DRAIN_SECONDS) ends its terminals with close code 1001 and the reason
// `server_shutdown`, after writing on them why, and its followed logs with the event `server-shutdown`.
export const SERVER_SHUTDOWN_CLOSE_CODE = 1001
export const SERVER_SHUTDOWN_REASON = 'server_shutdown'
export const SERVER_SHUTDOWN_EVENT = 'server-shutdown'

// RFC 6455 §7.1.5: the socket closed without a close frame — the server or the way to it went away without saying so.
const ABNORMAL_CLOSE = 1006

// A k8s-service that could not check a terminal's session for a while ends it with 1013 (auth.SessionRetryCloseCode) and
// the reason `session_unverified`: the session did not end, so a new terminal may open.
export const SESSION_RETRY_CLOSE_CODE = 1013
const SESSION_UNVERIFIED = 'session_unverified'

export type TerminalEnd = 'serverReplaced' | 'connectionLost' | 'sessionUnchecked'

// Why a terminal's socket closed, when a new terminal may help: the server was replaced, the connection dropped with no
// reason, or the session could not be checked. null for an end the person or the session made, which say why themselves.
export function terminalEnd(code: number, reason: string): TerminalEnd | null {
  if (code === SERVER_SHUTDOWN_CLOSE_CODE && reason === SERVER_SHUTDOWN_REASON) return 'serverReplaced'
  if (code === ABNORMAL_CLOSE) return 'connectionLost'
  if (code === SESSION_RETRY_CLOSE_CODE && reason === SESSION_UNVERIFIED) return 'sessionUnchecked'
  return null
}

export function terminalEndText(end: TerminalEnd, t: (key: string, fallback: string) => string): string {
  if (end === 'sessionUnchecked') {
    return t('serverShutdown.terminalUnchecked', 'The session could not be checked for a while. Reconnect to open a new terminal.')
  }
  return end === 'serverReplaced'
    ? t('serverShutdown.terminalReplaced', 'The server was replaced. Reconnect to open a new terminal.')
    : t('serverShutdown.terminalLost', 'The connection to the server was lost. Reconnect to open a new terminal.')
}
