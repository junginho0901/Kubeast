const ACCESS_TOKEN_STORAGE_KEY = 'kubeast:access-token'
const REDIRECT_AFTER_LOGIN_KEY = 'kubeast:redirect-after-login'

let handlingUnauthorized = false

export function getAccessToken(): string | null {
  if (typeof window === 'undefined') return null
  const raw = window.localStorage.getItem(ACCESS_TOKEN_STORAGE_KEY)
  const value = (raw || '').trim()
  return value || null
}

export function setAccessToken(token: string) {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(ACCESS_TOKEN_STORAGE_KEY, token)
}

export function clearAccessToken() {
  if (typeof window === 'undefined') return
  window.localStorage.removeItem(ACCESS_TOKEN_STORAGE_KEY)
}

export function isLoggedIn(): boolean {
  return !!getAccessToken()
}

// Expiry (epoch ms) from the token's exp claim, or null when unreadable.
export function getTokenExpiry(token: string | null = getAccessToken()): number | null {
  if (!token) return null
  try {
    const seg = token.split('.')[1]
    if (!seg) return null
    const b64 = seg.replace(/-/g, '+').replace(/_/g, '/')
    const claims = JSON.parse(window.atob(b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), '=')))
    return typeof claims.exp === 'number' ? claims.exp * 1000 : null
  } catch {
    return null
  }
}

// Tokens are short-lived (auth.tokenTTLMinutes); while the user is active the
// client re-issues one from POST /auth/refresh before it expires. The server
// rebuilds the token from the database, so role changes and revocations
// (token_version) take effect at the next refresh at the latest.
const REFRESH_AHEAD_MS = 10 * 60 * 1000
let refreshInFlight: Promise<void> | null = null

export function refreshAccessTokenIfNeeded(): Promise<void> {
  const token = getAccessToken()
  const exp = getTokenExpiry(token)
  if (!token || exp === null || exp - Date.now() > REFRESH_AHEAD_MS) return Promise.resolve()
  if (refreshInFlight) return refreshInFlight
  refreshInFlight = fetch('/api/v1/auth/refresh', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    credentials: 'same-origin',
  })
    .then(async (res) => {
      if (res.status === 401) {
        handleUnauthorized()
        return
      }
      if (!res.ok) return // transient failure: keep using the current token until it expires
      const data = await res.json()
      if (data?.access_token) setAccessToken(data.access_token)
    })
    .catch(() => undefined)
    .finally(() => {
      refreshInFlight = null
    })
  return refreshInFlight
}

export function getAuthHeaders() {
  const token = getAccessToken()
  return token ? { Authorization: `Bearer ${token}` } : ({} as Record<string, string>)
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

export function handleUnauthorized() {
  if (typeof window === 'undefined') return
  if (handlingUnauthorized) return
  handlingUnauthorized = true

  // Best-effort: clear server-side HttpOnly cookie as well.
  try {
    const payload = new Blob([], { type: 'text/plain' })
    navigator.sendBeacon('/api/v1/auth/logout', payload)
  } catch {
    // ignore
  }

  // Clear local token and redirect to login.
  try {
    const path = window.location.pathname + window.location.search
    window.sessionStorage.setItem(REDIRECT_AFTER_LOGIN_KEY, path)
  } catch {
    // ignore
  }

  clearAccessToken()

  if (window.location.pathname !== '/login') {
    window.location.assign('/login')
  }
}
