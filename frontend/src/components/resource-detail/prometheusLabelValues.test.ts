import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { PageContextProvider } from '@/components/PageContextProvider'
import HPAInfo from './HPAInfo'
import IngressDetail from './network-info/IngressDetail'
import NamespaceInfo from './NamespaceInfo'
import PodInfo from './PodInfo'
import ServiceInfo from './ServiceInfo'
import { useWorkloadData } from './workload-info/useWorkloadData'

// A drawer's name and namespace come from its link (?detail=), which can hold any letter but "/". The Prometheus
// queries the drawers send name them as label values, which Prometheus must read back as they were.

const sent = vi.hoisted(() => ({ promql: [] as string[], keys: [] as string[] }))
vi.mock('@/hooks/usePrometheusQuery', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/usePrometheusQuery')>()
  return {
    ...actual,
    usePrometheusQueries: (key: string[], queries: { name: string; promql: string }[]) => {
      for (const q of queries) {
        sent.keys.push(key[0])
        sent.promql.push(q.promql)
      }
      return { data: {}, isLoading: false, available: false, failure: null }
    },
    usePrometheusRangeQuery: (key: string[], promql: string) => {
      sent.keys.push(key[0])
      sent.promql.push(promql)
      return { data: undefined, error: null }
    },
  }
})
vi.mock('@/services/useKubeWatchList', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/useKubeWatchList')>()
  return { ...actual, useKubeWatchList: () => undefined }
})

// The queries a drawer sends, or only those of one query key (a drawer's sections send queries of their own).
function queriesOf(el: ReactElement, seed: [unknown[], unknown][] = [], key?: string): string[] {
  sent.promql = []
  sent.keys = []
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  for (const [k, data] of seed) qc.setQueryData(k, data)
  renderToStaticMarkup(createElement(QueryClientProvider, { client: qc },
    createElement(MemoryRouter, null, createElement(PageContextProvider, null, el))))
  qc.clear()
  return key ? sent.promql.filter((_, i) => sent.keys[i] === key) : sent.promql
}

// The value of label="…" (or label=~"…") in a query, as Prometheus reads a double-quoted string (its escapes are JSON's here).
function labelValue(promql: string, label: string, op = '='): string | undefined {
  const m = new RegExp(`[{,]${label}${op}"((?:[^"\\\\]|\\\\.)*)"`).exec(promql)
  return m ? JSON.parse(`"${m[1]}"`) : undefined
}

// The names out of `names` that a query's pod=~ value matches, anchored as Prometheus anchors it.
function podsMatched(promql: string, names: string[]): string[] {
  const pattern = labelValue(promql, 'pod', '=~')
  if (pattern === undefined) return []
  const re = new RegExp(`^(?:${pattern})$`)
  return names.filter((n) => re.test(n))
}

const NAME = 'web\\"} or vector(1) #'
const NAMESPACE = 'ns\\'

function Workload({ name, namespace }: { name: string; namespace: string }) {
  useWorkloadData({ name, namespace, kind: 'Deployment' })
  return null
}

describe('the label values of a drawer\'s Prometheus queries', () => {
  it('Ingress: each latency query names the Ingress and its namespace as they are', () => {
    const queries = queriesOf(createElement(IngressDetail, { name: NAME, namespace: NAMESPACE, rawJson: { metadata: { name: NAME } } }))
    expect(queries).toHaveLength(3)
    for (const q of queries) {
      expect({ ingress: labelValue(q, 'ingress'), exported_namespace: labelValue(q, 'exported_namespace') }, q)
        .toEqual({ ingress: NAME, exported_namespace: NAMESPACE })
    }
  })

  it('HorizontalPodAutoscaler: the scaling history names the HPA and its namespace as they are', () => {
    const describeAnswer = { uid: 'u', created_at: '2026-11-24T00:00:00Z', labels: {}, annotations: {}, conditions: [], events: [] }
    const queries = queriesOf(createElement(HPAInfo, { name: NAME, namespace: NAMESPACE }), [[['hpa-describe', NAMESPACE, NAME], describeAnswer]])
    expect(queries).toHaveLength(1)
    expect({ horizontalpodautoscaler: labelValue(queries[0], 'horizontalpodautoscaler'), namespace: labelValue(queries[0], 'namespace') }, queries[0])
      .toEqual({ horizontalpodautoscaler: NAME, namespace: NAMESPACE })
  })

  it('Pod: each container query names the pod and its namespace as they are', () => {
    const queries = queriesOf(createElement(PodInfo, { name: NAME, namespace: NAMESPACE }), [], 'pod-detail')
    expect(queries).toHaveLength(2)
    for (const q of queries) {
      expect({ pod: labelValue(q, 'pod'), namespace: labelValue(q, 'namespace') }, q).toEqual({ pod: NAME, namespace: NAMESPACE })
    }
  })

  it('Namespace: each query names the namespace as it is', () => {
    const queries = queriesOf(createElement(NamespaceInfo, { name: NAMESPACE }), [], 'namespace-detail')
    expect(queries).toHaveLength(4)
    for (const q of queries) expect(labelValue(q, 'namespace'), q).toBe(NAMESPACE)
  })

  it('Service: each backend query names the namespace as it is and matches exactly the backend pods', () => {
    const pods = ['web.v2-a1', 'web.v2-b2', 'x\\y"z-0']
    const endpoints = pods.map((name, i) => ({ ip: `10.0.0.${i + 1}`, ports: [], ready: true, target_ref: { kind: 'Pod', name, namespace: NAMESPACE } }))
    const describeAnswer = {
      endpoint_summary: { ready_count: pods.length, not_ready_count: 0, ready_addresses: endpoints.map((e) => e.ip), not_ready_addresses: [] },
      endpoints,
    }
    const queries = queriesOf(createElement(ServiceInfo, { name: 'web', namespace: NAMESPACE }), [[['service-describe', NAMESPACE, 'web'], describeAnswer]], 'service-detail')
    expect(queries).toHaveLength(3)
    const others = ['webxv2-a1', 'web.v2-a', 'x\\y"z-00', 'xy"z-0', 'x\\\\y"z-0']
    for (const q of queries) {
      expect(labelValue(q, 'namespace'), q).toBe(NAMESPACE)
      expect(podsMatched(q, [...pods, ...others]), q).toEqual(pods)
    }
  })

  it('Deployment: each workload query names the namespace as it is and matches the pods named <name>-<suffix> only', () => {
    const queries = queriesOf(createElement(Workload, { name: 'web.v2', namespace: NAMESPACE }), [], 'workload-detail')
    expect(queries).toHaveLength(5)
    for (const q of queries) {
      expect(labelValue(q, 'namespace'), q).toBe(NAMESPACE)
      expect(podsMatched(q, ['web.v2-7d9f-a1b2c', 'web.v2-0', 'webxv2-0', 'web.v2-', 'web.v2x-0']), q).toEqual(['web.v2-7d9f-a1b2c', 'web.v2-0'])
    }
    const odd = queriesOf(createElement(Workload, { name: NAME, namespace: NAMESPACE }), [], 'workload-detail')
    expect(odd).toHaveLength(5)
    for (const q of odd) {
      expect(labelValue(q, 'namespace'), q).toBe(NAMESPACE)
      expect(podsMatched(q, [`${NAME}-0`, 'web"} or vector(1) #-0', `${NAME}-`]), q).toEqual([`${NAME}-0`])
    }
  })
})
