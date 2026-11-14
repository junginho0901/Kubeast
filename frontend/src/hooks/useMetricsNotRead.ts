import { useCallback, useSyncExternalStore } from 'react'
import { useQueryClient, type Query } from '@tanstack/react-query'

import { useAIContext } from './useAIContext'
import { METRICS_NOT_READ, type NotRead } from '@/utils/aiContext/metricsNotRead'

/** Tells the floating chat the numbers a screen could not show (utils/aiContext/metricsNotRead), while it says so. */
export function useMetricsNotReadForChat(notRead: NotRead | null): void {
  useAIContext(notRead ? { source: METRICS_NOT_READ, summary: notRead.summary, data: notRead.data } : null, [notRead?.summary, JSON.stringify(notRead?.data ?? null)])
}

const updatedAt = (q: Query) => Math.max(q.state.dataUpdatedAt, q.state.errorUpdatedAt)

/**
 * The read a mounted component holds under a key starting with `prefix` (a query with an observer that may fetch, the
 * newest if several), for a parent that draws nothing of it: Monitoring, whose tabs own their reads.
 */
export function useActiveRead(prefix: string): { queryKey: readonly unknown[]; error: unknown; data: unknown } | null {
  const cache = useQueryClient().getQueryCache()
  const find = useCallback(
    () => cache.findAll({ queryKey: [prefix], type: 'active' }).reduce<Query | undefined>((a, q) => (!a || updatedAt(q) > updatedAt(a) ? q : a), undefined),
    [cache, prefix],
  )
  const subscribe = useCallback((onChange: () => void) => cache.subscribe(onChange), [cache])
  const snapshot = useCallback(() => find()?.state, [find])
  const state = useSyncExternalStore(subscribe, snapshot, snapshot)
  const query = find()
  return query && state ? { queryKey: query.queryKey, error: state.status === 'error' ? state.error : null, data: state.data } : null
}
