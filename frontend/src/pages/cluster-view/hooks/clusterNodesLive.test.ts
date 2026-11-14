import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import type { PodNodeSummary } from '@/services/api'
import { NODE_LIST_KEY, useClusterPodsQuery } from './useClusterPodsQuery'
import { deriveEntries } from './useClusterDerived'

// Cluster View's node list follows the cluster: it is read once and then kept by the Nodes page's own watch of
// /api/v1/nodes (no poll), so a node added or removed, turning NotReady or cordoned, shows in the order, the marks and
// the floating chat's counts. The watch starts only once the list was read: a grant the cluster refuses nodes asks once.

const watched = vi.hoisted(() => ({ options: [] as { enabled: boolean; queryKey: unknown[]; path: string; query: string }[] }))
vi.mock('@/services/useKubeWatchList', () => ({
  LIST_GATHER_MS: 100,
  useKubeWatchList: (o: { enabled: boolean; queryKey: unknown[]; path: string; query: string }) => { watched.options.push(o) },
}))

function open(client: QueryClient) {
  watched.options.length = 0
  const Probe = () => (useClusterPodsQuery({ selectedNamespace: 'all', search: '' }), null)
  renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(Probe)))
  return watched.options.find((o) => o.path === '/api/v1/nodes')
}

describe('the live node list', () => {
  it('follows /api/v1/nodes with the Nodes page\'s watch once the list is read, and never polls it', () => {
    expect(NODE_LIST_KEY).toEqual(['cluster', 'nodes'])
    const fresh = new QueryClient()
    expect(open(fresh)).toMatchObject({ enabled: false, queryKey: ['cluster', 'nodes'], query: 'watch=1' })
    expect(fresh.getQueryCache().find({ queryKey: NODE_LIST_KEY })?.options).not.toHaveProperty('refetchInterval')
    const read = new QueryClient()
    read.setQueryData(NODE_LIST_KEY, [{ name: 'cp-0', roles: ['control-plane'], status: 'Ready' }])
    expect(open(read)).toMatchObject({ enabled: true, queryKey: ['cluster', 'nodes'], path: '/api/v1/nodes', query: 'watch=1' })
  })

  it('puts a node added in its place (control planes first), carries a node\'s STATUS and drops a node removed', () => {
    const summary = (names: string[]): PodNodeSummary => ({ nodes: names.map((node) => ({ node, total: 1, ok: 1, warn: 0, error: 0 })), total: names.length, all: names.length, revision: 'r', source: 'index' })
    const nodes = [{ name: 'cp-0', roles: ['control-plane'], status: 'Ready' }, { name: 'w-1', roles: [], status: 'Ready' }, { name: 'w-3', roles: [], status: 'Ready' }]
    const order = (s: PodNodeSummary, n: typeof nodes) => deriveEntries(s, n).map((e) => `${e.label}${e.status && e.status !== 'Ready' ? `:${e.status}` : ''}`)
    expect(order(summary(['w-3', 'cp-0', 'w-1', '']), nodes)).toEqual(['cp-0', 'w-1', 'w-3', 'Unscheduled'])
    // a worker and a second control plane join (their pods count them on the map, the watch names their roles)
    const joined = [...nodes, { name: 'w-2', roles: [], status: 'Ready' }, { name: 'cp-1', roles: ['control-plane'], status: 'Ready' }]
    expect(order(summary(['w-3', 'cp-0', 'w-2', 'w-1', 'cp-1', '']), joined)).toEqual(['cp-0', 'cp-1', 'w-1', 'w-2', 'w-3', 'Unscheduled'])
    // w-1 turns NotReady and w-2 is cordoned
    const marked = joined.map((n) => (n.name === 'w-1' ? { ...n, status: 'NotReady' } : n.name === 'w-2' ? { ...n, status: 'Ready,SchedulingDisabled' } : n))
    expect(order(summary(['w-3', 'cp-0', 'w-2', 'w-1', 'cp-1']), marked)).toEqual(['cp-0', 'cp-1', 'w-1:NotReady', 'w-2:Ready,SchedulingDisabled', 'w-3'])
    // w-3 removed: its pods gone from the map, its node from the list
    expect(order(summary(['cp-0', 'w-2', 'w-1', 'cp-1']), marked.filter((n) => n.name !== 'w-3'))).toEqual(['cp-0', 'cp-1', 'w-1:NotReady', 'w-2:Ready,SchedulingDisabled'])
  })
})
