import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import i18next, { type TFunction } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import en from '@/i18n/locales/en.json'
import MonitoringNodes from '@/pages/monitoring/MonitoringNodes'
import { DashboardTopResources } from '@/pages/dashboard/DashboardTopResources'
import { PrometheusClusterMetricsFailure } from '@/pages/dashboard/PrometheusClusterMetrics'
import { METRICS_NOT_READ, monitoringNotRead, topResourcesNotRead } from './metricsNotRead'

// Numbers a screen could not read reach the floating chat as the screen says it in their place: the Monitoring tabs and
// the Dashboard's top cards when the read failed or the cluster has no metrics-server, and the cluster metrics card when
// Prometheus did not answer. A refusal is the screen's own layer (`metrics_refused`, `top_*_refused`).

type Layer = { source?: string; summary: string; data?: Record<string, unknown> }
const told: Layer[] = []
vi.mock('@/hooks/useAIContext', () => ({ useAIContext: (input: Layer | null | undefined) => { if (input) told.push(input) } }))
vi.mock('@/contexts/ClusterContext', () => ({ useCluster: () => ({ currentCluster: 'c1' }) }))
vi.mock('@/components/ResourceDetailContext', () => ({ useResourceDetail: () => ({ open: () => {} }) }))

const i18n = i18next.createInstance()
let t: TFunction
beforeAll(async () => {
  await i18n.use(initReactI18next).init({ lng: 'en', fallbackLng: 'en', resources: { en: { translation: en } }, interpolation: { escapeValue: false } })
  t = i18n.t.bind(i18n) as TFunction
})
beforeEach(() => { told.length = 0 })

const textOf = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ')
const httpError = (status: number, data?: unknown) => Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, data } })
const draw = (element: ReactElement, client = new QueryClient()) =>
  renderToStaticMarkup(createElement(I18nextProvider, { i18n }, createElement(QueryClientProvider, { client }, element)))

describe('a Monitoring tab whose read failed', () => {
  const REASON = 'get node metrics (status 503): the server is currently unable to handle the request'
  const failedTab = (error: Error) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } })
    client.setQueryData(['nodes', 'c1'], [{ name: 'n1' }])
    const q = client.getQueryCache().build(client, { queryKey: ['node-metrics', 'c1'] })
    q.setState({ ...q.state, status: 'error', error, errorUpdatedAt: Date.now(), errorUpdateCount: 1 })
    return draw(createElement(MonitoringNodes, { metricsUnavailable: false, onMetricsUnavailable: () => {} }), client)
  }

  it('tells the chat the failure the tab shows in place of its numbers, which its own layer does not carry', () => {
    const error = httpError(502, { detail: REASON })
    const html = failedTab(error)
    expect(html).toContain('data-testid="node-metrics-error"')
    expect(told.filter((l) => (l.source ?? 'base') === 'base')).toEqual([])
    const notRead = monitoringNotRead(t, 'nodes', { queryKey: ['node-metrics', 'c1'], error, data: undefined }, false)
    expect(notRead?.data).toEqual({ tab: 'nodes', metrics_error: { reason: REASON } })
    for (const part of [en.monitoring.nodes.errorTitle, REASON, en.monitoring.pods.retrying]) {
      expect(textOf(html)).toContain(part)
      expect(notRead?.summary).toContain(part)
    }
  })

  it('names the Pods tab\'s namespace, as the tab\'s own layer does', () => {
    const notRead = monitoringNotRead(t, 'pods', { queryKey: ['pod-metrics', 'c1', 'shop'], error: httpError(500, { detail: 'boom' }), data: undefined }, false)
    expect(notRead?.data).toEqual({ tab: 'pods', filters: { namespace: 'shop' }, metrics_error: { reason: 'boom' } })
    expect(notRead?.summary).toContain(en.monitoring.pods.errorTitle)
  })

  it('leaves a refusal to the tab, numbers kept to the failed refresh, and a tab with no namespace chosen alone', () => {
    expect(monitoringNotRead(t, 'nodes', { queryKey: ['node-metrics', 'c1'], error: httpError(403, { detail: 'forbidden' }), data: undefined }, false)).toBeNull()
    expect(monitoringNotRead(t, 'nodes', { queryKey: ['node-metrics', 'c1'], error: httpError(500), data: [{ name: 'n1' }] }, false)).toBeNull()
    expect(monitoringNotRead(t, 'pods', { queryKey: ['pod-metrics', 'c1', ''], error: httpError(500), data: undefined }, false)).toBeNull()
    expect(monitoringNotRead(t, 'nodes', { queryKey: ['node-metrics', 'c1'], error: null, data: undefined }, false)).toBeNull()
    expect(monitoringNotRead(t, 'nodes', null, false)).toBeNull()
  })

  it('tells the chat a cluster without metrics-server, as the banner says', () => {
    expect(monitoringNotRead(t, 'nodes', null, true)).toEqual({ summary: en.monitoring.metricsUnavailable, data: { tab: 'nodes', metrics_unavailable: true } })
  })
})

describe("the Dashboard's top cards whose read failed", () => {
  const error = httpError(500, { detail: 'top resources: etcd timed out' })

  it('tell the chat each card\'s failure with the reason the cards show', () => {
    const html = draw(createElement(DashboardTopResources, { topResources: undefined, isLoading: false, isError: true, error, metricsUnavailable: false }))
    expect(html).toContain('data-testid="top-resources-read-failed"')
    const notRead = topResourcesNotRead(t, { loading: false, answer: undefined, failed: true, error, metricsUnavailable: false })
    expect(notRead?.data).toEqual({ top_pods_error: { reason: 'top resources: etcd timed out' }, top_nodes_error: { reason: 'top resources: etcd timed out' } })
    expect(textOf(html)).toContain(notRead?.summary)
  })

  it('name only the card with no rows to keep', () => {
    const notRead = topResourcesNotRead(t, { loading: false, answer: { top_pods: [{ name: 'p' }] }, failed: true, error, metricsUnavailable: false })
    expect(notRead?.data).toEqual({ top_nodes_error: { reason: 'top resources: etcd timed out' } })
  })

  it('tell nothing while the first read runs or after one that answered, and say a cluster without metrics-server', () => {
    expect(topResourcesNotRead(t, { loading: true, failed: false, metricsUnavailable: false })).toBeNull()
    expect(topResourcesNotRead(t, { loading: false, answer: { top_pods: [], top_nodes: [] }, failed: false, metricsUnavailable: false })).toBeNull()
    const html = draw(createElement(DashboardTopResources, { topResources: undefined, isLoading: false, isError: false, metricsUnavailable: true }))
    const notRead = topResourcesNotRead(t, { loading: false, failed: false, metricsUnavailable: true })
    expect(notRead?.data).toEqual({ metrics_unavailable: true })
    expect(textOf(html)).toContain(notRead?.summary)
  })
})

describe("the Dashboard's cluster metrics card when Prometheus did not answer", () => {
  it('tells the chat in its own words, with the reason', () => {
    const html = draw(createElement(PrometheusClusterMetricsFailure, { title: 'Cluster Resource Utilization', failure: httpError(502, { detail: 'prometheus: connection refused' }) }))
    expect(html).toContain('data-testid="prometheus-not-answering"')
    expect(told).toHaveLength(1)
    expect(told[0].source).toBe(METRICS_NOT_READ)
    expect(told[0].data).toEqual({ section: 'Cluster Resource Utilization', prometheus_not_answering: 'prometheus: connection refused' })
    expect(textOf(html)).toContain('Prometheus did not answer: prometheus: connection refused')
    expect(told[0].summary).toContain('Prometheus did not answer: prometheus: connection refused')
  })
})
