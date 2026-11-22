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

// A k8s-service refuses a terminal past its account's cap (multicluster.maxTerminalsPerAccount) with close code 4429
// (internal/streamcap) and the reason `terminal_limit`, and a followed log past its cap (maxFollowedLogsPerAccount)
// with the event `stream-limit`: nothing was opened, so once the account closes another one a new one opens. Past the
// server's cap on every account's together (maxStreamsPerServer) it is the same close code or event with
// `server_stream_limit`: a new one opens once any account closes one.
export const TERMINAL_LIMIT_CLOSE_CODE = 4429
const TERMINAL_LIMIT = 'terminal_limit'
export const STREAM_LIMIT_EVENT = 'stream-limit'
export const SERVER_STREAM_LIMIT = 'server_stream_limit'

export type TerminalEnd = 'serverReplaced' | 'connectionLost' | 'sessionUnchecked' | 'accountLimit' | 'serverLimit'

// Why a terminal's socket closed, when a new terminal may help: the server was replaced, the connection dropped with no
// reason, the session could not be checked, the account had as many terminals open as the server allows, or the server
// had as many terminals and followed logs open as it allows. null for an end the person or the session made, which say
// why themselves.
export function terminalEnd(code: number, reason: string): TerminalEnd | null {
  if (code === SERVER_SHUTDOWN_CLOSE_CODE && reason === SERVER_SHUTDOWN_REASON) return 'serverReplaced'
  if (code === ABNORMAL_CLOSE) return 'connectionLost'
  if (code === SESSION_RETRY_CLOSE_CODE && reason === SESSION_UNVERIFIED) return 'sessionUnchecked'
  if (code === TERMINAL_LIMIT_CLOSE_CODE && reason === TERMINAL_LIMIT) return 'accountLimit'
  if (code === TERMINAL_LIMIT_CLOSE_CODE && reason === SERVER_STREAM_LIMIT) return 'serverLimit'
  return null
}

export function terminalEndText(end: TerminalEnd, t: (key: string, fallback: string) => string): string {
  if (end === 'sessionUnchecked') {
    return t('serverShutdown.terminalUnchecked', 'The session could not be checked for a while. Reconnect to open a new terminal.')
  }
  if (end === 'accountLimit') {
    return t('serverShutdown.terminalLimit', 'This account already has as many terminals open on this server as it may. Close one, then reconnect.')
  }
  if (end === 'serverLimit') {
    return t('serverShutdown.terminalServerLimit', 'This server already has as many terminals and followed logs open as it may, for all accounts together. Reconnect in a while.')
  }
  return end === 'serverReplaced'
    ? t('serverShutdown.terminalReplaced', 'The server was replaced. Reconnect to open a new terminal.')
    : t('serverShutdown.terminalLost', 'The connection to the server was lost. Reconnect to open a new terminal.')
}

// What a followed log refused at a cap says in its place: the event's data says whose, the server's or else the
// account's.
export function followLimitText(t: (key: string, fallback: string) => string, reason?: string): string {
  if (reason === SERVER_STREAM_LIMIT) {
    return t('serverShutdown.followServerLimit', 'Not followed: this server already has as many terminals and followed logs open as it may, for all accounts together. Open this one again in a while.')
  }
  return t('serverShutdown.followLimit', 'Not followed: this account already follows as many logs on this server as it may. Stop one it follows elsewhere, then open this one again.')
}
