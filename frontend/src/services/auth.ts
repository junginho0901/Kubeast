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
