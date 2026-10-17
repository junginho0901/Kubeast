// The floating chat keeps one conversation per browser tab: its id in sessionStorage, so a reload continues it and
// closing the tab ends it. Logging out forgets it too.
export const FLOATING_SESSION_KEY = 'kubest.floatingChat.sessionId'

export function forgetFloatingChat(): void {
  try {
    window.sessionStorage.removeItem(FLOATING_SESSION_KEY)
  } catch {
    // sessionStorage unavailable (private mode): nothing was kept
  }
}
