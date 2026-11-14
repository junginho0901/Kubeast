import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// TanStack Query runs refetchInterval only where it sees a window (isServer, read when it loads): one before any import
vi.hoisted(() => {
  if (typeof window === 'undefined') {
    Object.assign(globalThis, { window: Object.assign(new EventTarget(), { location: { search: '', pathname: '/' } }) })
  }
})

import { QueryClient, QueryObserver } from '@tanstack/react-query'
import type { TopResources } from '@/services/api'
import { isMetricsDisabled, isMetricsUnavailableError } from '@/services/api'
import { forbiddenLabels, resetForbidden } from '@/services/forbiddenStore'
import { METRICS_NOT_SERVED_MS } from '../monitoring/metricsRefresh'
import { keepRefusals, readTopResources, skipOf, topResourcesPace, topResourcesPollMs, type TopRefusals } from './topResourcesRead'

// The cluster's words for a Read grant limited to namespaces, as k8s-service passes them on
const PODS_REFUSED = 'pods.metrics.k8s.io is forbidden: User "u1" cannot list resource "pods" in API group "metrics.k8s.io" in the namespace "web"'
const NODES_REFUSED = 'nodes.metrics.k8s.io is forbidden: User "u1" cannot list resource "nodes" in API group "metrics.k8s.io" at the cluster scope'
const NOT_SERVED = 'the server could not find the requested resource'
const node = { name: 'n1', cpu: '250m', cpu_percent: '6%', memory: '512Mi', memory_percent: '7%' }

const bothRefused: TopResources = {
  top_pods: [], pod_metrics_error: PODS_REFUSED, pod_metrics_refused: true,
  top_nodes: [], node_metrics_error: NODES_REFUSED, node_metrics_refused: true,
}

// The hook's query (useDashboardQueries): the same read and the same pace, on a client of its own
function watch(answer: (skip?: string) => TopResources) {
  const read = vi.fn(async (skip?: string) => answer(skip))
  const refusals = { current: { ck: 'c1' } as TopRefusals }
  const client = new QueryClient()
  const observer = new QueryObserver<TopResources>(client, {
    queryKey: ['top-resources', 'c1'],
    queryFn: () => readTopResources('c1', read, refusals),
    staleTime: 5000,
    ...topResourcesPace(() => refusals.current, 'c1'),
  })
  const stop = observer.subscribe(() => {})
  return { read, observer, stop, client }
}

describe('the Dashboard top pods and nodes read', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetForbidden()
  })
  afterEach(() => vi.useRealTimers())

  it('asks a refused read once: no read every 5 s after both parts were refused', async () => {
    const { read, observer, stop, client } = watch(() => bothRefused)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(read).toHaveBeenCalledTimes(1)
    expect(read).toHaveBeenCalledWith(undefined)
    const data = observer.getCurrentResult().data
    expect(data?.pod_metrics_error).toBe(PODS_REFUSED)
    expect(data?.node_metrics_error).toBe(NODES_REFUSED)
    expect(observer.getCurrentResult().isError).toBe(false)
    // named in the no-permission banner as a read beside a list, as Monitoring's
    expect(forbiddenLabels()).toEqual(['metrics'])
    stop()
    client.clear()
  })

  it('leaves out the refused part and keeps asking the other, with the refusal kept on screen', async () => {
    const { read, observer, stop, client } = watch((skip) =>
      skip === 'nodes' ? { top_pods: [{ namespace: 'web', name: 'p', cpu: '5m', memory: '10Mi' }] } as TopResources
        : { top_pods: [{ namespace: 'web', name: 'p', cpu: '5m', memory: '10Mi' }], top_nodes: [], node_metrics_error: NODES_REFUSED, node_metrics_refused: true })
    await vi.advanceTimersByTimeAsync(10_500)
    expect(read.mock.calls.map((c) => c[0])).toEqual([undefined, 'nodes', 'nodes'])
    const data = observer.getCurrentResult().data
    expect(data?.top_pods).toHaveLength(1)
    expect(data?.top_nodes).toEqual([])
    expect(data?.node_metrics_refused).toBe(true)
    expect(data?.node_metrics_error).toBe(NODES_REFUSED)
    stop()
    client.clear()
  })

  it('reads a cluster with no metrics-server as metrics unavailable, as before', async () => {
    const refusals = { current: { ck: 'c1' } as TopRefusals }
    const read = async () => ({ top_pods: [], top_nodes: [], pod_metrics_error: NOT_SERVED, node_metrics_error: NOT_SERVED })
    const err = await readTopResources('c1', read, refusals).catch((e) => e)
    expect(isMetricsUnavailableError(err)).toBe(true)
    expect(refusals.current).toEqual({ ck: 'c1', pods: undefined, nodes: undefined })
  })

  it('asks a cluster without metrics-server again after a minute, not every 5 s, and turns no metrics off for the session', async () => {
    let served = false
    const notServed = { top_pods: [], top_nodes: [], pod_metrics_error: NOT_SERVED, node_metrics_error: NOT_SERVED } as TopResources
    const { read, observer, stop, client } = watch(() => (served ? { top_pods: [], top_nodes: [node] } as TopResources : notServed))
    await vi.advanceTimersByTimeAsync(METRICS_NOT_SERVED_MS - 1_000)
    expect(read).toHaveBeenCalledTimes(1)
    expect(isMetricsUnavailableError(observer.getCurrentResult().error)).toBe(true)
    expect(isMetricsDisabled()).toBe(false)
    // a metrics-server installed meanwhile shows at the minute, and the read goes back to its 5 s
    served = true
    await vi.advanceTimersByTimeAsync(1_500)
    expect(read).toHaveBeenCalledTimes(2)
    expect(observer.getCurrentResult().error).toBeNull()
    expect(observer.getCurrentResult().data?.top_nodes).toEqual([node])
    await vi.advanceTimersByTimeAsync(5_000)
    expect(read).toHaveBeenCalledTimes(3)
    stop()
    client.clear()
  })

  it('asks everything again on another cluster', async () => {
    const refusals = { current: { ck: 'c1', pods: PODS_REFUSED, nodes: NODES_REFUSED } as TopRefusals }
    const read = vi.fn(async () => ({ top_pods: [], top_nodes: [node] }) as TopResources)
    await readTopResources('c2', read, refusals)
    expect(read).toHaveBeenCalledWith(undefined)
    expect(topResourcesPollMs(refusals.current, 'c2', false)).toBe(5000)
  })
})

describe('keepRefusals and skipOf', () => {
  it('fill a part left out from its refusal and add the refusals an answer gives', () => {
    const { answer, refused } = keepRefusals({ top_nodes: [node] } as TopResources, { ck: 'c1', pods: PODS_REFUSED })
    expect(answer).toEqual({ top_nodes: [node], top_pods: [], pod_metrics_error: PODS_REFUSED, pod_metrics_refused: true })
    expect(refused).toEqual({ ck: 'c1', pods: PODS_REFUSED, nodes: undefined })
    expect(skipOf(refused)).toBe('pods')
    expect(skipOf(keepRefusals(bothRefused, { ck: 'c1' }).refused)).toBe('pods,nodes')
    expect(skipOf({ ck: 'c1' })).toBeUndefined()
  })
})
