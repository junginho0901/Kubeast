import { useCallback, useRef, useState } from 'react'

import { failureText } from '@/utils/failureText'

export type RefreshFailed = { reason: string; at: string }

// The spinner shows at least this long, so a read that answers at once is still seen to have run.
export const REFRESH_SPIN_MS = 500

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
// and when, until a read succeeds. The rows on screen stay; RefreshFailure says they are from before.
export function useRefresh(read: () => Promise<unknown>): { refresh: () => Promise<void>; refreshing: boolean; failure: RefreshFailed | null } {
  const [refreshing, setRefreshing] = useState(false)
  const [failure, setFailure] = useState<RefreshFailed | null>(null)
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
