const ACCESS_TOKEN_STORAGE_KEY = 'kube-assistant:access-token'

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
  return token ? { Authorization: `Bearer ${token}` } : {}
}

