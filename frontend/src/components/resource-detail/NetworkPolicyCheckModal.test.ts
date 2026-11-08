import { createElement, Fragment, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PodPage } from '@/services/api'
import '@/i18n'
import { PageContextProvider } from '@/components/PageContextProvider'
import NetworkPolicyCheckModal from './NetworkPolicyCheckModal'
import { POD_TABLE_WATCH_MAX, podPickerWay } from './namespacePodTable'

const seen = vi.hoisted(() => ({ queries: [] as any[] }))
vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>()
  return { ...actual, useQuery: (options: any) => (seen.queries.push(options), actual.useQuery(options)) }
})
// the window's frame draws into a portal, which the server renderer has not
vi.mock('@/components/ModalFrame', () => ({
  ModalFrame: ({ children, footer }: { children: ReactNode; footer?: ReactNode }) => createElement(Fragment, null, children, footer),
}))

const countOf = (namespacePods: number): PodPage => ({ items: [], total: namespacePods, stats: { total: namespacePods }, revision: 'r1', source: 'index' } as unknown as PodPage)
const COUNT_KEY = ['cluster', 'netpol-check-pod-count', 'shop']
const NAMES_KEY = ['cluster', 'netpol-check-names', 'pod', 'shop']

function render(setUp: (qc: QueryClient) => void) {
  seen.queries = []
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } })
  setUp(qc)
  const html = renderToStaticMarkup(createElement(QueryClientProvider, { client: qc },
    createElement(MemoryRouter, null, createElement(PageContextProvider, null,
      createElement(NetworkPolicyCheckModal, { self: 'pod/shop/web-1', selfName: 'web-1', namespace: 'shop', onClose: () => {} })))))
  const asked = (key: unknown[]) => seen.queries.some((q) => JSON.stringify(q.queryKey) === JSON.stringify(key) && q.enabled !== false)
  const search = seen.queries.find((q) => q.queryKey?.[1] === 'netpol-check-pod-search')
  return { html, namesAsked: asked(NAMES_KEY), searchAsked: !!search && search.enabled !== false }
}

describe('how the connection check offers the pods of a namespace', () => {
  beforeEach(() => {
    seen.queries = []
  })

  it('lists them whole up to the line or on a refusal, searches the server past it or when the count failed there, and waits for the count', () => {
    expect(podPickerWay(countOf(POD_TABLE_WATCH_MAX), null)).toBe('list')
    expect(podPickerWay(countOf(POD_TABLE_WATCH_MAX + 1), null)).toBe('search')
    expect(podPickerWay(undefined, { response: { status: 403 } })).toBe('list')
    expect(podPickerWay(undefined, { response: { status: 503 } })).toBe('search')
    expect(podPickerWay(undefined, null)).toBe('wait')
  })

  it('reads the names of a namespace of few pods whole, as before', () => {
    const r = render((qc) => qc.setQueryData(COUNT_KEY, countOf(40)))
    expect(r.namesAsked).toBe(true)
    expect(r.searchAsked).toBe(false)
    expect(r.html).not.toContain('netpol-check-name-input')
  })

  it('reads no name whole in a namespace of more pods than the line, and lets a name be typed with the server\'s matches', () => {
    const r = render((qc) => qc.setQueryData(COUNT_KEY, countOf(50_000)))
    expect(r.namesAsked).toBe(false)
    expect(r.searchAsked).toBe(true)
    expect(r.html).toContain('data-testid="netpol-check-name-input"')
    expect(r.html).toContain('This namespace has 50000 pods, too many to list')
  })

  it('reads no name before the count has come', () => {
    const r = render(() => {})
    expect(r.namesAsked).toBe(false)
    expect(r.searchAsked).toBe(false)
  })
})
