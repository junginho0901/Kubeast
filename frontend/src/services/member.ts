const MEMBER_ID_STORAGE_KEY = 'kube-assistant:member-id'

export function getStoredMemberId(): string {
  if (typeof window === 'undefined') return 'default'
  const raw = window.localStorage.getItem(MEMBER_ID_STORAGE_KEY)
  const value = (raw || '').trim()
  return value || 'default'
}

export function setStoredMemberId(memberId: string) {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(MEMBER_ID_STORAGE_KEY, memberId)
}

export function getMemberHeaders() {
  return { 'X-User-ID': getStoredMemberId() }
}

