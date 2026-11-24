import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { PageContextProvider } from '@/components/PageContextProvider'
import HPAInfo from './HPAInfo'
import IngressDetail from './network-info/IngressDetail'

// A drawer's name and namespace come from its link (?detail=), which can hold any letter but "/". The Prometheus
// queries the HPA and Ingress drawers send name them as label values, which Prometheus must read back as they were.

const sent = vi.hoisted(() => ({ promql: [] as string[] }))
vi.mock('@/hooks/usePrometheusQuery', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/usePrometheusQuery')>()
  return {
    ...actual,
    usePrometheusQueries: (_key: string[], queries: { name: string; promql: string }[]) => {
      sent.promql.push(...queries.map((q) => q.promql))
      return { data: {}, isLoading: false, available: false, failure: null }
    },
    usePrometheusRangeQuery: (_key: string[], promql: string) => {
      sent.promql.push(promql)
      return { data: undefined, error: null }
    },
  }
})
vi.mock('@/services/useKubeWatchList', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/useKubeWatchList')>()
  return { ...actual, useKubeWatchList: () => undefined }
})

function queriesOf(el: ReactElement, seed: [unknown[], unknown][] = []): string[] {
  sent.promql = []
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  for (const [key, data] of seed) qc.setQueryData(key, data)
  renderToStaticMarkup(createElement(QueryClientProvider, { client: qc },
    createElement(MemoryRouter, null, createElement(PageContextProvider, null, el))))
  qc.clear()
  return sent.promql
}

// The value of label="…" in a query, as Prometheus reads a double-quoted string (its escapes are JSON's here).
function labelValue(promql: string, label: string): string | undefined {
  const m = new RegExp(`[{,]${label}="((?:[^"\\\\]|\\\\.)*)"`).exec(promql)
  return m ? JSON.parse(`"${m[1]}"`) : undefined
}

const NAME = 'web\\"} or vector(1) #'
const NAMESPACE = 'ns\\'

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
})
