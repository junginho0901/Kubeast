import { useSyncExternalStore } from 'react'

// The console's colour mode, chosen on the Account page and kept in this browser (DESIGN.md "Colour modes"):
// 'default' the navy of the sign-in page, 'dark' a neutral grey, 'light' an off-white. It is the
// data-color-mode attribute on <html>; public/color-mode.js sets it from the same key before the first paint
// (the gateway's CSP allows scripts from 'self' only), so a reload does not flash the default colours.

export type ColorMode = 'default' | 'dark' | 'light'
export const COLOR_MODES: ColorMode[] = ['default', 'dark', 'light']

export const COLOR_MODE_KEY = 'kubeast.colorMode'
const listeners = new Set<() => void>()

export function getColorMode(): ColorMode {
  try {
    const v = localStorage.getItem(COLOR_MODE_KEY)
    if (v === 'dark' || v === 'light') return v
  } catch {
    /* storage blocked: the default */
  }
  return 'default'
}

export function applyColorMode(mode: ColorMode): void {
  const root = document.documentElement
  if (mode === 'default') delete root.dataset.colorMode
  else root.dataset.colorMode = mode
}

export function setColorMode(mode: ColorMode): void {
  try {
    if (mode === 'default') localStorage.removeItem(COLOR_MODE_KEY)
    else localStorage.setItem(COLOR_MODE_KEY, mode)
  } catch {
    /* storage blocked: this page only */
  }
  applyColorMode(mode)
  listeners.forEach((l) => l())
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  // another tab changed it: follow
  const onStorage = (e: StorageEvent) => {
    if (e.key !== COLOR_MODE_KEY) return
    applyColorMode(getColorMode())
    listener()
  }
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('storage', onStorage)
  }
}

export function useColorMode(): ColorMode {
  return useSyncExternalStore(subscribe, getColorMode, () => 'default')
}
