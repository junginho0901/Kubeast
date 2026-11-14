import { forgetFloatingChat } from './floatingChatSession'

const REDIRECT_AFTER_LOGIN_KEY = 'kubeast:redirect-after-login'
const SIGNED_IN_KEY = 'kubeast:signed-in'
const SESSION_ENDED_KEY = 'kubeast:session-ended'

// A browser that was signed in and loses its session without signing out — an admin changed the account or its
// access, deleted it, or the session timed out — gets one notice on the sign-in page. Signing out clears the mark.
export function markSignedIn() {
  try {
    window.localStorage.setItem(SIGNED_IN_KEY, '1')
  } catch {
    // storage off
  }
}

export function noteSessionEnded() {
  try {
    if (window.localStorage.getItem(SIGNED_IN_KEY) !== '1') return
    window.localStorage.removeItem(SIGNED_IN_KEY)
    window.sessionStorage.setItem(SESSION_ENDED_KEY, '1')
  } catch {
    // storage off
  }
}

export function sessionEndedNotice(): boolean {
  try {
    return window.sessionStorage.getItem(SESSION_ENDED_KEY) === '1'
  } catch {
    return false
  }
}

export function clearSessionEndedNotice() {
  try {
    window.sessionStorage.removeItem(SESSION_ENDED_KEY)
  } catch {
    // storage off
  }
}

// The session lives only in the HttpOnly cookie that POST /auth/login sets; the
// page never sees the token, so a script injected into it cannot read one.
// Every state-changing request the cookie authenticates must carry this header
// — the backend refuses it otherwise, and a cross-site page cannot add a custom
// header without a CORS preflight, which is what stops request forgery.
export const CSRF_HEADER: Record<string, string> = { 'X-Requested-With': 'XMLHttpRequest' }

export function getAuthHeaders(): Record<string, string> {
  return { ...CSRF_HEADER }
}

// What the tab holds for the person signed in outside the query cache — the live watch socket, the chat answers on
// their way — registers here. A socket stays the identity it opened as and an answer goes on as its question's asker,
// so both are let go when that person signs out and again when someone signs in (a session can end without a sign-out).
const sessionResets = new Set<() => void>()

export function onSessionChange(reset: () => void): void {
  sessionResets.add(reset)
}

export function resetSessionState(): void {
  for (const reset of sessionResets) {
    try {
      reset()
    } catch (err) {
      console.warn('session state reset failed', err)
    }
  }
}

// Ends the server session (the cookie is cleared by the response). Best-effort:
// if the call fails the cookie simply expires with the token. The tab's floating
// chat conversation is forgotten too, so the next sign-in starts a new one, and
// the live connection and the chat streams of this session stop (resetSessionState).
export function logoutSession(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve()
  resetSessionState()
  forgetFloatingChat()
  try {
    window.localStorage.removeItem(SIGNED_IN_KEY)
  } catch {
    // storage off
  }
  return fetch('/api/v1/auth/logout', {
    method: 'POST',
    headers: CSRF_HEADER,
    credentials: 'same-origin',
    keepalive: true,
  })
    .then(() => undefined)
    .catch(() => undefined)
}

// Sliding session. The cookie carries a short-lived token (auth.tokenTTLMinutes);
// while the user is active the client re-issues it from POST /auth/refresh at
// half the TTL. An idle tab never refreshes, so the session ends at the TTL.
// The server rebuilds the token from the database, so role changes and
// revocations apply at the next refresh at the latest.
let refreshInFlight: Promise<void> | null = null

export function refreshSession(): Promise<void> {
  if (refreshInFlight) return refreshInFlight
  refreshInFlight = fetch('/api/v1/auth/refresh', {
    method: 'POST',
    headers: CSRF_HEADER,
    credentials: 'same-origin',
  })
    .then((res) => {
      if (res.status === 401) handleUnauthorized()
    })
    .catch(() => undefined)
    .finally(() => {
      refreshInFlight = null
    })
  return refreshInFlight
}

const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const

// Starts the refresh loop for a signed-in tab and returns the stop function.
export function startSessionKeepalive(ttlMinutes: number): () => void {
  if (typeof window === 'undefined') return () => undefined
  const ttlMs = Math.max(1, ttlMinutes) * 60 * 1000
  const refreshAfterMs = Math.max(60 * 1000, ttlMs / 2)
  let lastActivity = Date.now()
  let lastRefresh = Date.now()

  const markActivity = () => {
    lastActivity = Date.now()
  }
  const tick = () => {
    if (document.visibilityState === 'hidden') return
    if (lastActivity <= lastRefresh) return
    if (Date.now() - lastRefresh < refreshAfterMs) return
    lastRefresh = Date.now()
    void refreshSession()
  }

  ACTIVITY_EVENTS.forEach((ev) => window.addEventListener(ev, markActivity, { passive: true }))
  document.addEventListener('visibilitychange', tick)
  const timer = window.setInterval(tick, 60 * 1000)
  return () => {
    window.clearInterval(timer)
    document.removeEventListener('visibilitychange', tick)
    ACTIVITY_EVENTS.forEach((ev) => window.removeEventListener(ev, markActivity))
  }
}

export function getRedirectAfterLogin(): string | null {
  if (typeof window === 'undefined') return null
  try {
    const value = (window.sessionStorage.getItem(REDIRECT_AFTER_LOGIN_KEY) || '').trim()
    return value || null
  } catch {
    return null
  }
}

export function clearRedirectAfterLogin() {
  if (typeof window === 'undefined') return
  try {
    window.sessionStorage.removeItem(REDIRECT_AFTER_LOGIN_KEY)
  } catch {
    // ignore
  }
}

// A WebSocket the server closed because the session it opened with no longer stands (auth.SessionEndedCloseCode).
export const SESSION_ENDED_CLOSE_CODE = 4401
// The event an event stream ends with for the same reason; its data is the reason code.
export const SESSION_ENDED_EVENT = 'session-ended'
// A second end this soon after the first means the connection reopened with the same session.
const SESSION_END_REPEAT_MS = 60 * 1000

// One long-lived connection was ended by its session. The cookie may be newer than the connection (a sign-in in another
// tab), in which case the connection reopens with it and nobody is signed out; otherwise the session is over and the
// sign-in page says so. `lastEnd` is when this same connection last ended this way. Resolves to true when it may reopen.
export async function liveSessionEnded(lastEnd: number): Promise<boolean> {
  if (Date.now() - lastEnd >= SESSION_END_REPEAT_MS) {
    try {
      const res = await fetch('/api/v1/auth/me', { credentials: 'same-origin' })
      if (res.status !== 401) return true
    } catch {
      return true // a network failure says nothing about the session
    }
  }
  handleUnauthorized()
  return false
}

let handlingUnauthorized = false

// A request was refused with 401: the session is gone (expired, revoked, or
// never existed). Drop the stale cookie, remember where the user was and go
// to the login page.
export function handleUnauthorized() {
  if (typeof window === 'undefined') return
  if (window.location.pathname === '/login') return
  if (handlingUnauthorized) return
  handlingUnauthorized = true

  noteSessionEnded()
  void logoutSession()

  try {
    const path = window.location.pathname + window.location.search
    window.sessionStorage.setItem(REDIRECT_AFTER_LOGIN_KEY, path)
  } catch {
    // ignore
  }

  window.location.assign('/login')
}
