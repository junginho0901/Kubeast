import { useSyncExternalStore } from 'react'

// Rows per page of the list tables, one choice for every list, kept in this
// browser: 'fit' (the default) fills the screen height (useAdaptiveRowsPerPage),
// a number shows that many rows and the table scrolls inside its card.

export type PageSize = 'fit' | 25 | 50 | 100
export const PAGE_SIZES: PageSize[] = ['fit', 25, 50, 100]

const KEY = 'kubeast.listPageSize'
const listeners = new Set<() => void>()

export function getPageSize(): PageSize {
  try {
    const v = Number(localStorage.getItem(KEY))
    if (v === 25 || v === 50 || v === 100) return v
  } catch {
    /* storage blocked: the default */
  }
  return 'fit'
}

export function setPageSize(size: PageSize): void {
  try {
    if (size === 'fit') localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, String(size))
  } catch {
    /* storage blocked: this page only */
  }
  listeners.forEach((l) => l())
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY) listener()
  }
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('storage', onStorage)
  }
}

export function usePageSize(): PageSize {
  return useSyncExternalStore(subscribe, getPageSize, () => 'fit')
}
