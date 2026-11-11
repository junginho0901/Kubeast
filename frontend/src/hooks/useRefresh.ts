import { useCallback, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'

import { failureText } from '@/utils/failureText'

export type RefreshFailed = { reason: string; at: string }

// The spinner shows at least this long, so a read that answers at once is still seen to have run.
export const REFRESH_SPIN_MS = 500

// A query's own failure as RefreshFailure shows it (useQuery's error and errorUpdatedAt), for a list that reads by
// itself — a poll, a refetch — and keeps its rows when a read fails.
export const failureOf = (error: unknown, errorUpdatedAt: number): RefreshFailed | null =>
  error ? { reason: failureText(error), at: new Date(errorUpdatedAt || Date.now()).toISOString() } : null

// One read: why it failed and when, or null when it worked.
export async function readFailure(read: () => Promise<unknown>, now: () => Date = () => new Date()): Promise<RefreshFailed | null> {
  try {
    await read()
    return null
  } catch (e) {
    return { reason: failureText(e), at: now().toISOString() }
  }
}

// A page's Refresh: runs the read (which must reject when it fails — invalidateQueries and refetchQueries do so only
// with { throwOnError: true }), turns the spinner for at least REFRESH_SPIN_MS, and keeps why the last read failed
// and when, until a read succeeds or the address changes (another namespace, cluster or page: the failure was not
// about what that shows). RefreshFailure says it under the header.
export function useRefresh(read: () => Promise<unknown>): { refresh: () => Promise<void>; refreshing: boolean; failure: RefreshFailed | null } {
  const [refreshing, setRefreshing] = useState(false)
  const [failure, setFailure] = useState<RefreshFailed | null>(null)
  const { pathname, search } = useLocation()
  const [shownAt, setShownAt] = useState(pathname + search)
  if (shownAt !== pathname + search) {
    setShownAt(pathname + search)
    if (failure) setFailure(null)
  }
  const running = useRef(false)
  const readRef = useRef(read)
  readRef.current = read
  const refresh = useCallback(async () => {
    if (running.current) return
    running.current = true
    setRefreshing(true)
    const started = Date.now()
    setFailure(await readFailure(readRef.current))
    const left = REFRESH_SPIN_MS - (Date.now() - started)
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, left)))
    running.current = false
    setRefreshing(false)
  }, [])
  return { refresh, refreshing, failure }
}
