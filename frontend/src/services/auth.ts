const REDIRECT_AFTER_LOGIN_KEY = 'kubeast:redirect-after-login'

// The session lives only in the HttpOnly cookie that POST /auth/login sets; the
// page never sees the token, so a script injected into it cannot read one.
// Every state-changing request the cookie authenticates must carry this header
// — the backend refuses it otherwise, and a cross-site page cannot add a custom
// header without a CORS preflight, which is what stops request forgery.
export const CSRF_HEADER: Record<string, string> = { 'X-Requested-With': 'XMLHttpRequest' }

export function getAuthHeaders(): Record<string, string> {
  return { ...CSRF_HEADER }
}

// Ends the server session (the cookie is cleared by the response). Best-effort:
// if the call fails the cookie simply expires with the token.
export function logoutSession(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve()
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

let handlingUnauthorized = false

// A request was refused with 401: the session is gone (expired, revoked, or
// never existed). Drop the stale cookie, remember where the user was and go
// to the login page.
export function handleUnauthorized() {
  if (typeof window === 'undefined') return
  if (window.location.pathname === '/login') return
  if (handlingUnauthorized) return
  handlingUnauthorized = true

  void logoutSession()

  try {
    const path = window.location.pathname + window.location.search
    window.sessionStorage.setItem(REDIRECT_AFTER_LOGIN_KEY, path)
  } catch {
    // ignore
  }

  window.location.assign('/login')
}
