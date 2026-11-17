import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// TanStack Query runs refetchInterval only where it sees a window (isServer, read when it loads): one before any import
vi.hoisted(() => {
  if (typeof window === 'undefined') {
    Object.assign(globalThis, { window: Object.assign(new EventTarget(), { location: { search: '', pathname: '/' } }) })
  }
})

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider, QueryObserver, type QueryFunction } from '@tanstack/react-query'
import { queryDefaults } from '@/services/queryDefaults'
import { usePrometheusQuery } from '@/hooks/usePrometheusQuery'
import { useDashboardQueries } from './hooks/useDashboardQueries'

// The Dashboard's reads on a timer — the overview every 15 s, the problem pods every 30 s, the node list every minute —
// and the Prometheus sections' every 30 s went on asking a read the cluster refused, each with its retry, for as long as
// the page stayed open: a grant limited to namespaces sent the refused node list twice a minute.

const read = vi.hoisted(() => ({ options: [] as any[], cluster: 'c1' }))
vi.mock('@tanstack/react-query', async (importOriginal) => {
  const real = await importOriginal<typeof import('@tanstack/react-query')>()
  return {
    ...real,
    useQuery: (options: any, client?: never) => {
      read.options.push(options)
      return real.useQuery(options, client)
    },
  }
})
vi.mock('@/contexts/ClusterContext', () => ({ useCluster: () => ({ currentCluster: read.cluster }) }))

const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { response: { status, data: {} } })
const refusedRead = () => vi.fn(async () => { throw httpError(403) })
const answeredRead = () => vi.fn(async () => ({ answered: true }))

// the options a hook reads a key with, on cluster `cluster`
function optionsOf(head: string, cluster: string, useHook: () => void) {
  read.options.length = 0
  read.cluster = cluster
  const Probe = () => { useHook(); return null }
  renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(Probe)))
  const options = read.options.find((o) => o.queryKey[0] === head)
  expect(options?.queryKey[1]).toBe(cluster)
  return options
}
const useDashboard = () => useDashboardQueries({
  selectedResourceType: null, selectedPodStatus: null, isIssuesModalOpen: false, issuesWindowMinutes: null,
  includeRestartHistory: false, isStorageModalOpen: false, isOptimizationModalOpen: false, optimizationNamespace: '',
  storageActiveTab: 'pvcs', podQuery: { q: '', page: 1 },
})
const usePrometheus = () => { usePrometheusQuery(['cluster-cpu'], 'up') }

const READS = [
  { head: 'cluster-overview', hook: useDashboard, every: 15_000 },
  { head: 'dashboard-problem-pods', hook: useDashboard, every: 30_000 },
  { head: 'nodes', hook: useDashboard, every: 60_000 },
  { head: 'prometheus', hook: usePrometheus, every: 30_000 },
]
const WINDOW = 3 * 60_000 + 1_000

describe('a read on a timer the cluster refused', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  // with the app's defaults, as main.tsx gives every query; a Prometheus read asks once the features have come
  const onScreen = (client: QueryClient, options: any, queryFn: QueryFunction<unknown>) =>
    new QueryObserver(client, { ...options, queryFn, enabled: true })
  const clientOf = () => new QueryClient({ defaultOptions: { queries: queryDefaults } })

  for (const { head, hook, every } of READS) {
    it(`${head}: refused, is read once while the screen stays open; one that answers is read every ${every / 1000} s`, async () => {
      const options = optionsOf(head, 'c1', hook)
      const refused = refusedRead()
      const answered = answeredRead()
      const stops = [onScreen(clientOf(), options, refused).subscribe(() => {}), onScreen(clientOf(), options, answered).subscribe(() => {})]
      await vi.advanceTimersByTimeAsync(WINDOW)
      expect({ refused: refused.mock.calls.length, answered: answered.mock.calls.length })
        .toEqual({ refused: 1, answered: 1 + Math.floor(WINDOW / every) })
      stops.forEach((stop) => stop())
    })
  }

  it('cluster-overview: asked again on another cluster, and on that one every 15 s while it answers', async () => {
    const client = clientOf()
    const refused = refusedRead()
    const observer = onScreen(client, optionsOf('cluster-overview', 'c1', useDashboard), refused)
    const stop = observer.subscribe(() => {})
    await vi.advanceTimersByTimeAsync(60_000)
    expect(refused).toHaveBeenCalledTimes(1)

    // the page under the other cluster: the same useQuery with that cluster's key
    const answered = answeredRead()
    observer.setOptions({ ...optionsOf('cluster-overview', 'c2', useDashboard), queryFn: answered, enabled: true })
    await vi.advanceTimersByTimeAsync(31_000)
    expect({ refused: refused.mock.calls.length, answered: answered.mock.calls.length }).toEqual({ refused: 1, answered: 3 })
    stop()
  })
})
