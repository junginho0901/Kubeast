import { useMemo, useState } from 'react'

export interface ItemsPage<T> {
  items: T[]
  /** The page shown, 1-based, never past the last page */
  page: number
  totalPages: number
  total: number
}

// One page of a list held whole in the page. A page past the end (the list got shorter on a refresh) is the last
// page, so a list never shows an empty page while it has items.
export function pageOfItems<T>(all: readonly T[], page: number, size: number): ItemsPage<T> {
  const per = Math.max(1, Math.floor(size) || 1)
  const totalPages = Math.max(1, Math.ceil(all.length / per))
  const at = Math.min(Math.max(1, Math.floor(page) || 1), totalPages)
  return { items: all.slice((at - 1) * per, at * per), page: at, totalPages, total: all.length }
}

// The page state of such a list for ListPager: back to the first page whenever resetKey changes (a new search,
// filter or object), kept over refreshes of the same list.
export function usePagedItems<T>(all: readonly T[], size: number, resetKey: string = '') {
  const [page, setPage] = useState(1)
  const [keyOfPage, setKeyOfPage] = useState(resetKey)
  if (keyOfPage !== resetKey) {
    setKeyOfPage(resetKey)
    setPage(1)
  }
  const current = useMemo(() => pageOfItems(all, keyOfPage === resetKey ? page : 1, size), [all, page, size, keyOfPage, resetKey])
  return { ...current, setPage }
}
