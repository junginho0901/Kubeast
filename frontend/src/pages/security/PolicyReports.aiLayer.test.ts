import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import en from '@/i18n/locales/en.json'
import PolicyReports from './PolicyReports'

// The Results tab tells the floating chat what its table shows: no count while the first read is on its way, the
// refusal or the failure with its reason when the read did not answer, and zero only for a read that found nothing.

// the tab a first render cannot click to: the page's tab state starts on Results
vi.mock('react', async (importOriginal) => {
  const real = await importOriginal<typeof import('react')>()
  return { ...real, useState: (initial: unknown) => real.useState(initial === 'policies' ? 'results' : initial) }
})
vi.mock('@/hooks/useAdaptiveTable', () => ({ useAdaptiveTable: () => ({ containerRef: { current: null }, bodyRef: { current: null }, theadRef: { current: null }, firstRowRef: { current: null }, rowsPerPage: 10 }) }))
vi.mock('@/components/ResourceDetailContext', () => ({ useResourceDetail: () => ({ open: () => {} }) }))
type Layer = { summary?: string; data?: Record<string, any> }
const layers: Layer[] = []
vi.mock('@/hooks/useAIContext', () => ({ useAIContext: (input: Layer | null) => { if (input) layers.push(input) } }))

const i18n = i18next.createInstance()
beforeAll(async () => {
  await i18n.use(initReactI18next).init({ lng: 'en', resources: { en: { translation: en } }, interpolation: { escapeValue: false } })
})
beforeEach(() => { layers.length = 0 })

const summary = {
  generated_at: '2026-11-15T00:00:00Z', reports: 3, truncated: false, scoped: false,
  totals: { fail: 2, warn: 1, error: 0, pass: 5, skip: 0 }, policies: [], namespaces: [],
}
// the page's first read of the results: page 1 of 10 rows, problems first, in the server's order
const resultsKey = ['cluster', 'policyreports', 'results', { namespace: '', policy: '', source: '', result: '', severity: '', search: '', offset: 0, limit: 10, sort: undefined, dir: 'asc' }]
const row = (name: string) => ({ namespace: 'web', kind: 'Pod', name, policy: 'require-labels', rule: 'check', result: 'fail', report: 'polr-web' })

function open(results: (qc: QueryClient) => void): { html: string; layer: Layer } {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false, staleTime: Infinity } } })
  qc.setQueryData(['cluster', 'policyreports', 'status'], { enabled: true, installed: true, group: 'wgpolicyk8s.io' })
  qc.setQueryData(['cluster', 'policyreports', 'summary', ''], summary)
  qc.setQueryData(['namespaces'], [])
  results(qc)
  const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(I18nextProvider, { i18n }, createElement(QueryClientProvider, { client: qc }, createElement(PolicyReports)))))
  return { html, layer: layers[layers.length - 1] }
}
const failWith = (status: number, detail: string) => (qc: QueryClient) => {
  const q = qc.getQueryCache().build(qc, { queryKey: resultsKey })
  q.setState({ ...q.state, status: 'error', error: { response: { status, data: { detail } }, message: `Request failed with status code ${status}` } as never, errorUpdatedAt: 1, errorUpdateCount: 1 })
}

describe('Policy Reports Results tab, told to the floating chat', () => {
  it('counts nothing while the first read of the results is on its way', () => {
    const { html, layer } = open(() => {})
    expect(html).toContain('animate-spin')
    expect(layer.data?.filters?.tab).toBe('results')
    expect(layer.data?.pagination).toBeUndefined()
    expect(layer.data?.visible_items).toBeUndefined()
    expect(Object.keys(layer.data ?? {}).filter((k) => k.startsWith('results_'))).toEqual([])
  })

  it('says the read failed, with its status and the reason the table shows, and no count', () => {
    const { html, layer } = open(failWith(500, 'reading the reports timed out'))
    expect(html).toContain('data-testid="policy-reports-load-error"')
    expect(html).toContain('reading the reports timed out')
    expect(layer.data?.results_failed).toEqual({ status: 500, reason: 'reading the reports timed out' })
    expect(layer.data?.pagination).toBeUndefined()
    expect(layer.summary).toContain('the results could not be read')
  })

  it('says the read was refused, with the reason, and no count', () => {
    const { layer } = open(failWith(403, 'policyreports.wgpolicyk8s.io is forbidden'))
    expect(layer.data?.results_refused).toBe('policyreports.wgpolicyk8s.io is forbidden')
    expect(layer.data?.results_failed).toBeUndefined()
    expect(layer.data?.pagination).toBeUndefined()
    expect(layer.summary).toContain('the results were refused')
  })

  it('registers zero for a read that found no result', () => {
    const { layer } = open((qc) => qc.setQueryData(resultsKey, { generated_at: summary.generated_at, truncated: false, scoped: false, total: 0, rows: [] }))
    expect(layer.data?.pagination?.total_count).toBe(0)
    expect(layer.data?.visible_items).toEqual([])
    expect(layer.data?.results_failed).toBeUndefined()
  })

  it('lists the rows of a read that answered, with the whole count', () => {
    const { layer } = open((qc) => qc.setQueryData(resultsKey, { generated_at: summary.generated_at, truncated: false, scoped: false, total: 12, rows: [row('a'), row('b')] }))
    expect(layer.data?.pagination?.total_count).toBe(12)
    expect((layer.data?.visible_items ?? []).map((r: { name: string }) => r.name)).toEqual(['a', 'b'])
  })
})
