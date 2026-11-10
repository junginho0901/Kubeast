import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import ServiceInfo from './ServiceInfo'

// A Service drawer's "Backend Pod Resource Usage" sums the usage of the pods behind its ready endpoints: their names
// come from the answer's endpoints (each address with the Pod it points at), every one named in the query once, and a
// Service whose pods are past what one query can name says so instead of a sum of some of them.

const prom = vi.hoisted(() => ({ calls: [] as Array<{ queries: { name: string; promql: string }[]; enabled: boolean }>, answer: { available: false, data: {} } as any }))
vi.mock('@/hooks/usePrometheusQuery', () => ({
  usePrometheusQueries: (_key: string[], queries: { name: string; promql: string }[], options?: { enabled?: boolean }) => {
    prom.calls.push({ queries, enabled: options?.enabled ?? true })
    // as the hook answers: nothing for queries it was told not to ask
    return options?.enabled === false ? { available: false, data: {} } : prom.answer
  },
  useClusterFeatures: () => ({ data: undefined }),
}))
vi.mock('@/hooks/useAIContext', () => ({ useAIContext: () => {} }))
vi.mock('@/components/ResourceDetailContext', () => ({ useResourceDetail: () => ({ open: () => {} }) }))
vi.mock('./useNamespacePodTable', () => ({ useNamespacePodTable: () => ({ items: [], total: 0, loading: false, nav: null, note: null }) }))

const pod = (name: string, ip: string, ready = true, namespace = 'ns') => ({ ip, ports: [], ready, target_ref: { kind: 'Pod', name, namespace } })

function render(endpoints: object[], answer: any = { available: false, data: {} }) {
  prom.answer = answer
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } })
  const ready = (endpoints as any[]).filter((e) => e.ready).map((e) => e.ip)
  qc.setQueryData(['service-describe', 'ns', 'web'], {
    endpoint_summary: { ready_count: ready.length, not_ready_count: endpoints.length - ready.length, ready_addresses: ready, not_ready_addresses: [] },
    endpoints,
  })
  const html = renderToStaticMarkup(createElement(QueryClientProvider, { client: qc }, createElement(ServiceInfo, { name: 'web', namespace: 'ns' })))
  const last = prom.calls[prom.calls.length - 1]
  const query = (name: string) => last?.queries.find((q) => q.name === name)?.promql ?? ''
  // the pod names a query's pod=~ matcher matches, out of the ones given
  const matches = (name: string, names: string[]) => {
    const m = /pod=~"((?:[^"\\]|\\.)*)"/.exec(query(name))
    if (!m) return []
    const re = new RegExp(`^(?:${m[1].replace(/\\\\/g, '\\')})$`)
    return names.filter((n) => re.test(n))
  }
  return { html, enabled: !!last?.enabled, names: last?.queries.map((q) => q.name) ?? [], query, matches }
}

beforeEach(() => {
  prom.calls = []
})

describe('a Service drawer\'s backend pod usage', () => {
  it('asks Prometheus for exactly the pods of its ready endpoints, each once', () => {
    const r = render([
      pod('web-7d9f-a1b2c', '10.0.0.1'), pod('web-7d9f-d3e4f', '10.0.0.2'), pod('web-7d9f-d3e4f', 'fd00::2'),
      pod('db-0', '10.0.0.3'), pod('web-7d9f-zzzzz', '10.0.0.9', false), { ip: '10.0.0.10', ports: [], ready: true },
      pod('elsewhere-0', '10.0.0.11', true, 'other'),
    ])
    expect(r.enabled).toBe(true)
    expect(r.names).toEqual(['cpu', 'memory', 'pod_count'])
    const candidates = ['web-7d9f-a1b2c', 'web-7d9f-d3e4f', 'db-0', 'web-7d9f-zzzzz', 'elsewhere-0', 'web-7d9f-a1b2', 'db-01', 'xweb-7d9f-a1b2c']
    for (const q of ['cpu', 'memory', 'pod_count']) {
      expect(r.matches(q, candidates)).toEqual(['web-7d9f-a1b2c', 'web-7d9f-d3e4f', 'db-0'])
      expect(r.query(q)).toContain('namespace="ns"')
    }
  })

  it('names a pod whose name holds a dot as that name only', () => {
    const r = render([pod('web.v2-0', '10.0.0.1')])
    expect(r.enabled).toBe(true)
    expect(r.matches('cpu', ['web.v2-0', 'webxv2-0'])).toEqual(['web.v2-0'])
  })

  it('shows the sums Prometheus gives for those pods', () => {
    const r = render([pod('web-0', '10.0.0.1'), pod('web-1', '10.0.0.2')], {
      available: true,
      data: {
        cpu: { available: true, results: [{ value: 12 }] },
        memory: { available: true, results: [{ value: 3 * 1024 * 1024 }] },
        pod_count: { available: true, results: [{ value: 2 }] },
      },
    })
    expect(r.html).toContain('Backend Pod Resource Usage')
    expect(r.html).toMatch(/Total CPU<\/div><div[^>]*>12\.0m</)
    expect(r.html).toMatch(/Total Memory<\/div><div[^>]*>3\.0 MiB</)
    expect(r.html).toMatch(/Backing Pods<\/div><div[^>]*>2</)
  })

  it('does not ask for the pods of a Service past what one query can name, and says so', () => {
    const many = Array.from({ length: 800 }, (_, i) => pod(`backend-${String(i).padStart(3, '0')}-${'x'.repeat(40)}`, `10.1.${i >> 8}.${i & 255}`))
    const r = render(many, { available: true, data: { probe: { available: true, results: [{ value: 1 }] } } })
    expect(r.names).not.toContain('cpu')
    expect(r.html).toContain('800')
    expect(r.html).not.toContain('Total CPU')
  })

  it('asks nothing for a Service without ready pods', () => {
    const r = render([pod('web-0', '10.0.0.1', false)])
    expect(r.enabled).toBe(false)
  })
})
