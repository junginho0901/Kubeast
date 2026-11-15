import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// TanStack Query runs refetchInterval only where it sees a window (isServer, read when it loads): one before any import
vi.hoisted(() => {
  if (typeof window === 'undefined') {
    Object.assign(globalThis, { window: Object.assign(new EventTarget(), { location: { search: '', pathname: '/' } }) })
  }
})

import { QueryClient, QueryObserver } from '@tanstack/react-query'
import type { TopResources } from '@/services/api'
import { readTopResources, topResourcesPace, type TopRefusals } from '../dashboard/topResourcesRead'
import { METRICS_NOT_SERVED_MS, metricsReadPace, metricsRefreshFailure, metricsRefusal } from './metricsRefresh'

// The cluster's words for a Read grant limited to namespaces, as k8s-service passes them on in the 403's detail
const NODES_REFUSED = 'nodes.metrics.k8s.io is forbidden: User "u1" cannot list resource "nodes" in API group "metrics.k8s.io" at the cluster scope'
const httpError = (status: number, data?: unknown) => Object.assign(new Error(`HTTP ${status}`), { response: { status, data } })
const ROWS = [{ name: 'n1', cpu: '100m', cpu_percent: '5%', memory: '10Mi', memory_percent: '1%' }]
// k8s-service's answer for a cluster without metrics-server, from its discovery kept on its side for a minute (apiResourcesTTL)
const NOT_SERVED = () => httpError(404, { detail: 'the server could not find the requested resource' })

// The Nodes tab's query (MonitoringNodes): its key and pace, on a client of its own, the cluster's answer standing in
function watch(answer: (cluster: string) => unknown) {
  const read = vi.fn(async (cluster: string) => {
    const a = answer(cluster)
    if (a instanceof Error) throw a
    return a
  })
  const client = new QueryClient()
  const options = (cluster: string) => ({ queryKey: ['node-metrics', cluster], queryFn: () => read(cluster), ...metricsReadPace() })
  const observer = new QueryObserver<unknown>(client, options('c1'))
  const stop = observer.subscribe(() => {})
  return { read, observer, options, done: () => { stop(); client.clear() } }
}

describe('the Monitoring tabs\' metrics read', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => vi.useRealTimers())

  it('asks a refused read once: no retry and no read every 5 s', async () => {
    const { read, observer, done } = watch(() => httpError(403, { detail: NODES_REFUSED }))
    await vi.advanceTimersByTimeAsync(30_000)
    expect(read).toHaveBeenCalledTimes(1)
    expect(metricsRefusal(observer.getCurrentResult().error)).toEqual({ reason: NODES_REFUSED })
    done()
  })

  it('asks again on another cluster and keeps its pace there', async () => {
    const { read, observer, options, done } = watch((cluster) => (cluster === 'c1' ? httpError(403, { detail: NODES_REFUSED }) : ROWS))
    await vi.advanceTimersByTimeAsync(10_000)
    expect(read.mock.calls.map((c) => c[0])).toEqual(['c1'])
    observer.setOptions(options('c2'))
    await vi.advanceTimersByTimeAsync(10_500)
    expect(read.mock.calls.map((c) => c[0])).toEqual(['c1', 'c2', 'c2', 'c2'])
    expect(observer.getCurrentResult().data).toEqual(ROWS)
    done()
  })

  it('keeps asking after a failure that is not a refusal, as before: tried twice more, then every 5 s', async () => {
    const { read, done } = watch(() => httpError(503, { detail: 'the metrics API did not answer' }))
    await vi.advanceTimersByTimeAsync(3_500)
    expect(read).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(read.mock.calls.length).toBeGreaterThan(3)
    done()
  })

  it('asks the answer that the cluster serves no metrics.k8s.io once a minute, not every 5 s, and tries it no more', async () => {
    const { read, done } = watch(NOT_SERVED)
    await vi.advanceTimersByTimeAsync(METRICS_NOT_SERVED_MS - 1_000)
    expect(read).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1_500)
    expect(read).toHaveBeenCalledTimes(2)
    done()
  })

  it('asks another cluster at once and keeps its 5 s there, and the first again when it is chosen again', async () => {
    let served = false
    const { read, observer, options, done } = watch((cluster) => (cluster === 'c1' && !served ? NOT_SERVED() : ROWS))
    await vi.advanceTimersByTimeAsync(10_000)
    observer.setOptions(options('c2'))
    await vi.advanceTimersByTimeAsync(10_500)
    expect(read.mock.calls.map((c) => c[0])).toEqual(['c1', 'c2', 'c2', 'c2'])
    // a metrics-server installed on c1 meanwhile: chosen again, c1 is asked at once and read every 5 s
    served = true
    observer.setOptions(options('c1'))
    await vi.advanceTimersByTimeAsync(10_500)
    expect(read.mock.calls.map((c) => c[0]).slice(4)).toEqual(['c1', 'c1', 'c1'])
    expect(observer.getCurrentResult().data).toEqual(ROWS)
    done()
  })

  it('still asks after the Dashboard found no metrics.k8s.io, and shows a metrics-server installed since within the minute', async () => {
    let served = false
    const NOT_SERVED_TEXT = 'the server could not find the requested resource'
    // the Dashboard's top resources query (useDashboardQueries) on the same cluster first
    const refusals = { current: { ck: 'c1' } as TopRefusals }
    const dashboardRead = vi.fn(async () => (served
      ? { top_pods: [], top_nodes: ROWS }
      : { top_pods: [], top_nodes: [], pod_metrics_error: NOT_SERVED_TEXT, node_metrics_error: NOT_SERVED_TEXT }) as TopResources)
    const dashboardClient = new QueryClient()
    const dashboard = new QueryObserver<TopResources>(dashboardClient, {
      queryKey: ['top-resources', 'c1'], queryFn: () => readTopResources('c1', dashboardRead, refusals), staleTime: 5000,
      ...topResourcesPace(() => refusals.current, 'c1'),
    })
    const stopDashboard = dashboard.subscribe(() => {})
    await vi.advanceTimersByTimeAsync(1_000)
    expect(dashboardRead).toHaveBeenCalledTimes(1)
    stopDashboard()
    dashboardClient.clear()
    // then the Nodes tab, with the options MonitoringNodes gives it
    const read = vi.fn(async () => {
      if (!served) throw NOT_SERVED()
      return ROWS
    })
    const client = new QueryClient()
    const tab = new QueryObserver<unknown>(client, {
      queryKey: ['node-metrics', 'c1'], queryFn: read, ...metricsReadPace(),
    })
    const stop = tab.subscribe(() => {})
    await vi.advanceTimersByTimeAsync(30_000)
    expect(read).toHaveBeenCalledTimes(1)
    served = true
    await vi.advanceTimersByTimeAsync(METRICS_NOT_SERVED_MS - 30_000 + 500)
    expect(read).toHaveBeenCalledTimes(2)
    expect(tab.getCurrentResult().data).toEqual(ROWS)
    stop()
    client.clear()
  })

})

describe('a refusal is not a failed refresh', () => {
  it('keeps no numbers as old ones and gives the cluster\'s reason', () => {
    expect(metricsRefreshFailure(httpError(403, { detail: NODES_REFUSED }), ROWS, 1_000)).toBeNull()
    expect(metricsRefreshFailure(httpError(503), ROWS, 1_000)).toEqual({ valuesFrom: 1_000 })
    expect(metricsRefreshFailure(NOT_SERVED(), ROWS, 1_000), 'no metrics.k8s.io is not a failed refresh either').toBeNull()
    expect(metricsRefusal(httpError(403))).toEqual({})
    expect(metricsRefusal(httpError(503))).toBeNull()
    expect(metricsRefusal(null)).toBeNull()
  })
})
