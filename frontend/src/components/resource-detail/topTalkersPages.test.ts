import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import '@/i18n'
import type { NfmResult } from '@/services/api/types'
import TopTalkers from './TopTalkers'

// The Top Talkers table of a drawer, once its rows are asked for, draws ten rows at a time with the drawers' pager
// ("1-10 / N"); rows that fit a page are drawn whole without it.

// the section as it is after "Show top talkers": the server renderer cannot click, so the one false state starts true
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>()
  return { ...actual, useState: (initial: unknown) => actual.useState(initial === false ? true : initial) }
})
vi.mock('@/components/CustomDropdown', () => ({ default: () => null }))
vi.mock('@/contexts/ClusterContext', () => ({ useCluster: () => ({ currentCluster: 'c1' }) }))
vi.mock('@/hooks/usePermission', () => ({ usePermission: () => ({ has: () => true }) }))
vi.mock('@/hooks/usePrometheusQuery', () => ({
  useClusterFeatures: () => ({ data: { networkFlowMonitor: { enabled: true, clusters: ['c1'] } } }),
}))

const range = (n: number) => Array.from({ length: n }, (_, i) => i)

function render(n: number): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } })
  const answer: NfmResult = {
    cluster: 'c1', monitor: 'm', namespace: 'ns', kind: 'Pod', name: 'web', metric: 'DATA_TRANSFERRED', unit: 'Bytes', view: 'cluster', range: '1h', truncated: false,
    rows: range(n).map((i) => ({ local: { namespace: 'ns', pod: 'web' }, remote: { ip: `10.6.0.${i}` }, port: 443, value: 1000 - i, category: 'INTRA_AZ' })),
  }
  qc.setQueryData(['cluster', 'networktopflows', 'c1', 'ns', 'Pod', 'web', 'cluster', 'DATA_TRANSFERRED', '1h'], answer)
  return renderToStaticMarkup(createElement(QueryClientProvider, { client: qc }, createElement(TopTalkers, { kind: 'Pod', namespace: 'ns', name: 'web' })))
}
const rows = (html: string) => (html.match(/data-testid="toptalkers-row"/g) ?? []).length
const peers = (html: string) => [...new Set([...html.matchAll(/10\.6\.0\.\d+/g)].map((m) => m[0]))]

describe('a drawer\'s top talkers', () => {
  it('draws ten rows to a page, in the monitor\'s order, with the range of all', () => {
    const html = render(23)
    expect(rows(html)).toBe(10)
    expect(peers(html)).toEqual(range(10).map((i) => `10.6.0.${i}`))
    expect(html).toContain('<span>1-10 / 23</span>')
  })

  it('draws rows that fit a page whole without a pager', () => {
    const html = render(3)
    expect(rows(html)).toBe(3)
    expect(html).not.toMatch(/<span>\d+-\d+ \/ \d+<\/span>/)
  })
})
