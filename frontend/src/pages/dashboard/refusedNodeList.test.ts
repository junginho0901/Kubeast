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
import { useDashboardQueries } from './hooks/useDashboardQueries'

// The Dashboard reads the node list for its charts every minute. For a person the cluster does not let list nodes (a
// grant limited to namespaces) that read was refused at each open, tried again a second later and asked again every
// minute with its retry, for as long as the page stayed open.

const read = vi.hoisted(() => ({ options: [] as any[] }))
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
vi.mock('@/contexts/ClusterContext', () => ({ useCluster: () => ({ currentCluster: 'c1' }) }))

const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { response: { status, data: {} } })

// the options the Dashboard reads its node list with
function nodeListOptions() {
  read.options.length = 0
  const Probe = () => {
    useDashboardQueries({
      selectedResourceType: null, selectedPodStatus: null, isIssuesModalOpen: false, issuesWindowMinutes: null,
      includeRestartHistory: false, isStorageModalOpen: false, isOptimizationModalOpen: false, optimizationNamespace: '',
      storageActiveTab: 'pvcs', podQuery: { q: '', page: 1 },
    })
    return null
  }
  renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(Probe)))
  const options = read.options.find((o) => o.queryKey[0] === 'nodes')
  expect(options?.queryKey).toEqual(['nodes', 'c1'])
  return options
}

describe('the Dashboard\'s node list', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  // with the app's defaults, as main.tsx gives every query
  const onScreen = (queryFn: QueryFunction<unknown>) => {
    const client = new QueryClient({ defaultOptions: { queries: queryDefaults } })
    return new QueryObserver(client, { ...nodeListOptions(), queryFn }).subscribe(() => {})
  }

  it('refused, is read once while the page stays open; one that answers is read every minute', async () => {
    const refused = vi.fn(async () => { throw httpError(403) })
    const answered = vi.fn(async () => [{ name: 'node-1' }])
    const stops = [onScreen(refused), onScreen(answered)]
    await vi.advanceTimersByTimeAsync(3 * 60_000 + 1_000)
    expect({ refused: refused.mock.calls.length, answered: answered.mock.calls.length }).toEqual({ refused: 1, answered: 4 })
    stops.forEach((stop) => stop())
  })
})
