import { createElement, type ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PodPage } from '@/services/api'
import '@/i18n'
import { PageContextProvider } from '@/components/PageContextProvider'
import ConfigMapInfo from './ConfigMapInfo'
import SecretInfo from './SecretInfo'
import ServiceAccountInfo from './ServiceAccountInfo'
import RoleBindingInfo from './RoleBindingInfo'
import NetworkPolicyDetail from './network-info/NetworkPolicyDetail'
import { POD_TABLE_WATCH_MAX, PodPageNotFiltered, isClientError, podPageApplied, podTableReadEvery, podTableReadsPages, podTableReadsWhole, podTableShows } from './namespacePodTable'
import { drawerPodsKey } from './useServerPods'

const seen = vi.hoisted(() => ({ queries: [] as any[], watches: [] as any[], answer: undefined as unknown }))
vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>()
  return { ...actual, api: { ...actual.api, getPodPage: async () => seen.answer } }
})
vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>()
  return { ...actual, useQuery: (options: any) => (seen.queries.push(options), actual.useQuery(options)) }
})
vi.mock('@/services/useKubeWatchList', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/useKubeWatchList')>()
  return { ...actual, useKubeWatchList: (options: any) => void seen.watches.push(options) }
})

const pod = (name: string, extra: Record<string, unknown> = {}) => ({
  name, namespace: 'ns', status: 'Running', phase: 'Running', ready: '1/1', restart_count: 0, node_name: 'node-1',
  pod_ip: '10.0.0.1', created_at: '2026-11-07T00:00:00Z', ...extra,
})
const names = (n: number, prefix = 'p') => Array.from({ length: n }, (_, i) => `${prefix}-${String(i).padStart(5, '0')}`)

// The server's first page of a drawer's table: `matched` pods of `namespacePods`, ten of them on the page.
const pageOf = (matched: number, namespacePods: number, revision = 'r1'): PodPage => ({
  items: names(Math.min(10, matched), 'page').map((n) => pod(n)),
  total: matched,
  stats: { total: namespacePods },
  revision,
  source: revision ? 'index' : 'list',
} as unknown as PodPage)

type Drawer = {
  kind: string
  component: ComponentType<any>
  props: Record<string, unknown>
  filter: Record<string, string>
  wholeKey: unknown[]
  title: string
  bySelector?: boolean
  follows?: boolean
  // a pod of the namespace the drawer keeps
  using: Record<string, unknown>
  prime?: (qc: QueryClient) => void
}

const drawers: Drawer[] = [
  {
    kind: 'ConfigMap', component: ConfigMapInfo, props: { name: 'cm', namespace: 'ns' }, filter: { config_map: 'cm' },
    wholeKey: ['cm-used-by-pods', 'ns', 'cm'], title: 'Used By Pods', using: { config_map_refs: ['cm'] },
    prime: (qc) => qc.setQueryData(['configmap-describe', 'ns', 'cm'], { data_keys: [] }),
  },
  {
    kind: 'Secret', component: SecretInfo, props: { name: 'sec', namespace: 'ns' }, filter: { secret: 'sec' },
    wholeKey: ['secret-used-by-pods', 'ns', 'sec'], title: 'Used By Pods', using: { secret_refs: ['sec'] },
    prime: (qc) => qc.setQueryData(['secret-describe', 'ns', 'sec'], { data_keys: [] }),
  },
  {
    kind: 'ServiceAccount', component: ServiceAccountInfo, props: { name: 'web', namespace: 'ns' }, filter: { service_account: 'ns/web' },
    wholeKey: ['sa-using-pods', 'ns', 'web'], title: 'Pods Using This ServiceAccount', using: { service_account_name: 'web' },
    prime: (qc) => qc.setQueryData(['serviceaccount-describe', 'ns', 'web'], {}),
  },
  {
    kind: 'RoleBinding', component: RoleBindingInfo, props: { name: 'rb', namespace: 'ns' }, filter: { service_account: 'ns/web,ns/worker' },
    wholeKey: ['rolebinding-bound-pods', 'ns', 'rb'], title: 'Bound Pods via ServiceAccount Subjects', follows: false, using: { service_account_name: 'worker' },
    prime: (qc) => qc.setQueryData(['rolebinding-describe', 'ns', 'rb'], {
      subjects: [{ kind: 'ServiceAccount', name: 'web' }, { kind: 'ServiceAccount', name: 'worker', namespace: 'ns' }, { kind: 'User', name: 'someone' }],
    }),
  },
  {
    kind: 'NetworkPolicy', component: NetworkPolicyDetail, filter: { label_selector: 'app=web' }, bySelector: true,
    props: { name: 'np', namespace: 'ns', rawJson: { metadata: { name: 'np', namespace: 'ns' }, spec: { podSelector: { matchLabels: { app: 'web' } } } } },
    wholeKey: ['networkpolicy-affected-pods', 'ns', 'np', 'app=web'], title: 'Affected Pods', using: { labels: { app: 'web' } },
  },
]

const firstPageKey = (d: Drawer) => drawerPodsKey({ namespace: 'ns', ...d.filter }, 1, 10)

function render(d: Drawer, setUp: (qc: QueryClient) => void) {
  seen.queries = []
  seen.watches = []
  // retryOnMount off: a page set up as failed reads as the answer of this opening, not one asked again on mount
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } })
  d.prime?.(qc)
  setUp(qc)
  const html = renderToStaticMarkup(createElement(QueryClientProvider, { client: qc },
    createElement(MemoryRouter, null, createElement(PageContextProvider, null, createElement(d.component, d.props)))))
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
  const whole = seen.queries.filter((q) => same(q.queryKey, d.wholeKey))
  const pageReads = seen.queries.filter((q) => q.queryKey?.[0] === 'drawer-pods')
  const podWatches = seen.watches.filter((w) => w.path === '/api/v1/namespaces/ns/pods')
  return {
    html,
    // the whole read of the namespace's pods: asked at all, and asked now
    wholeAsked: whole.some((q) => q.enabled !== false),
    anyPodAsked: seen.queries.some((q) => q.enabled !== false && (q.queryKey?.[0] === 'drawer-pods' || q.queryKey?.[0] === d.wholeKey[0])),
    watchOpen: podWatches.some((w) => w.enabled),
    // the table's read of the server's page, as its query runs it
    readPage: () => pageReads.at(-1)?.queryFn(),
    // how often the server's page is read again (false: not)
    pageEvery: (data: PodPage | undefined, error: unknown = null) => {
      const every = pageReads.at(-1)?.refetchInterval
      return typeof every === 'function' ? every({ state: { data, error } }) : (every ?? false)
    },
  }
}

const settle = (qc: QueryClient, key: unknown[], data: unknown, updatedAt: number) => qc.setQueryData(key, data, { updatedAt })

describe('where a drawer\'s table of its namespace\'s pods stops reading them whole', () => {
  it('reads them whole up to the line, by the namespace\'s pods or, for a selector, by its matches', () => {
    expect(POD_TABLE_WATCH_MAX).toBe(2000)
    expect(podTableReadsPages({ answered: pageOf(3, 2000) }, false)).toBe(false)
    expect(podTableReadsPages({ answered: pageOf(3, 2001) }, false)).toBe(true)
    // a selector the API server applies holds its matches only
    expect(podTableReadsPages({ answered: pageOf(30, 50_000) }, true)).toBe(false)
    expect(podTableReadsPages({ answered: pageOf(2001, 50_000) }, true)).toBe(true)
    // rows the whole read already holds count too
    expect(podTableReadsPages({ held: 2001 }, false)).toBe(true)
    expect(podTableReadsPages({ held: 2000, answered: pageOf(3, 1500) }, false)).toBe(false)
    expect(podTableReadsPages({}, false)).toBe(false)
  })

  it('reads nothing whole before a page said the pods are few, unless the page was refused', () => {
    expect(podTableReadsWhole(false, false, false)).toBe(false)
    expect(podTableReadsWhole(false, true, false)).toBe(true)
    expect(podTableReadsWhole(false, false, true)).toBe(true)
    expect(podTableReadsWhole(true, true, false)).toBe(false)
    expect(podTableReadsWhole(true, false, true)).toBe(false)
  })

  it('shows the whole read\'s rows while it follows them, and once it reads pages until a newer page came', () => {
    expect(podTableShows({ pages: false, held: false, answered: true, pageAt: 1, heldAt: 0 })).toBe('page')
    expect(podTableShows({ pages: false, held: true, answered: true, pageAt: 1, heldAt: 2 })).toBe('whole')
    expect(podTableShows({ pages: true, held: false, answered: true, pageAt: 1, heldAt: 0 })).toBe('page')
    expect(podTableShows({ pages: true, held: true, answered: true, pageAt: 1, heldAt: 2 })).toBe('whole')
    expect(podTableShows({ pages: true, held: true, answered: true, pageAt: 3, heldAt: 2 })).toBe('page')
    expect(podTableShows({ pages: true, held: true, answered: false, pageAt: 3, heldAt: 2 })).toBe('whole')
  })

  it('reads pages as often as the Pods page, asks a failed first page again unless refused, and polls nothing else', () => {
    expect(podTableReadEvery(true, pageOf(3, 2001), null)).toBe(3_000)
    expect(podTableReadEvery(true, pageOf(3, 10_001), null)).toBe(10_000)
    expect(podTableReadEvery(true, pageOf(3, 50_000, ''), null)).toBe(30_000)
    expect(podTableReadEvery(false, pageOf(3, 2000), null)).toBe(false)
    expect(podTableReadEvery(false, undefined, { response: { status: 503 } })).toBe(10_000)
    expect(podTableReadEvery(false, undefined, new Error('Network Error'))).toBe(10_000)
    expect(podTableReadEvery(false, undefined, { response: { status: 403 } })).toBe(false)
    expect(podTableReadEvery(false, undefined, null)).toBe(false)
    expect(isClientError({ response: { status: 404 } })).toBe(true)
    expect(isClientError({ response: { status: 500 } })).toBe(false)
  })
})

// As a k8s-service from before the drawer conditions answers a page: every pod of the namespace, and no filters.
const unfiltered = (): PodPage => ({ ...pageOf(50_000, 50_000), items: names(10, 'any').map((n) => pod(n)) })

describe('an answer from a server that does not read a drawer table\'s condition', () => {
  it('is told from one that applied every condition asked', () => {
    const asked = { namespace: 'ns', config_map: 'cm' }
    expect(podPageApplied(asked, unfiltered())).toBe(false)
    expect(podPageApplied(asked, { ...unfiltered(), filters: { namespace: 'ns' } } as PodPage)).toBe(false)
    expect(podPageApplied(asked, { ...unfiltered(), filters: { namespace: 'ns', config_map: 'other' } } as PodPage)).toBe(false)
    expect(podPageApplied(asked, { ...unfiltered(), filters: { namespace: 'ns', config_map: 'cm' } } as PodPage)).toBe(true)
    expect(podPageApplied({ namespace: 'ns', label_selector: undefined }, { ...unfiltered(), filters: { namespace: 'ns' } } as PodPage)).toBe(true)
  })
})

describe('the NetworkPolicy drawer opened by a link, before its object is read', () => {
  it('asks for no pod until it knows its selector, which an empty one would make every pod of the namespace', () => {
    const d = { ...drawers[4], props: { name: 'np', namespace: 'ns' } }
    const r = render(d, () => {})
    expect(r.anyPodAsked).toBe(false)
    expect(r.watchOpen).toBe(false)
    expect(r.html).toContain('Loading...')
  })
})

describe.each(drawers)('the $kind drawer\'s table of the pods that use it', (d) => {
  beforeEach(() => {
    seen.queries = []
    seen.watches = []
  })

  it('reads nothing whole and follows nothing before the server\'s first page has said how many pods there are', () => {
    const r = render(d, () => {})
    expect(r.wholeAsked).toBe(false)
    expect(r.watchOpen).toBe(false)
    expect(r.html).toContain('Loading...')
  })

  it('reads its namespace\'s pods whole and follows them as before when they are few', () => {
    const r = render(d, (qc) => qc.setQueryData(firstPageKey(d), pageOf(2, d.bySelector ? POD_TABLE_WATCH_MAX : 1500)))
    expect(r.wholeAsked).toBe(true)
    expect(r.watchOpen).toBe(d.follows !== false)
    expect(r.html).not.toContain('drawer-pods-read-every')
    // until the whole read answers, the server's page fills the table
    expect(r.html).toContain('page-00000')
    expect(r.pageEvery(pageOf(2, 1500))).toBe(false)
  })

  it('shows the whole read\'s rows, kept as before, once it has them', () => {
    const r = render(d, (qc) => {
      settle(qc, firstPageKey(d), pageOf(2, 1500), 1)
      settle(qc, d.wholeKey, [pod('kept-1', d.using), pod('other'), pod('kept-2', d.using)], 2)
    })
    expect(r.html).toContain('kept-1')
    expect(r.html).toContain('kept-2')
    // the API server applied the selector to the whole read; the others keep their own
    if (d.bySelector) expect(r.html).toContain('other')
    else expect(r.html).not.toContain('other')
    expect(r.html).toContain(`${d.title} (${d.bySelector ? 3 : 2})`)
  })

  it('reads no pod whole and opens no watch past the line, shows the server\'s pages and says how often it reads them', () => {
    // the matches of a selector, else the namespace's pods, pass the line
    const matched = d.bySelector ? 2500 : 37
    const big = (namespacePods: number) => pageOf(matched, namespacePods)
    const r = render(d, (qc) => qc.setQueryData(firstPageKey(d), big(50_000)))
    expect(r.wholeAsked).toBe(false)
    expect(r.watchOpen).toBe(false)
    expect(r.html).toContain(`${d.title} (${matched})`)
    expect(r.html).toContain('page-00009')
    expect(r.html).toContain('data-testid="drawer-pods-read-every"')
    // a selector's matches passed the line, else the namespace's pods
    expect(r.html).toContain(d.bySelector
      ? 'Too many pods match this selector to follow live, so this table is read again every 10 seconds.'
      : 'This namespace has too many pods to follow live, so this table is read again every 10 seconds.')
    expect(r.pageEvery(big(50_000))).toBe(10_000)
    expect(r.pageEvery(big(5000))).toBe(3_000)
    expect(render(d, (qc) => qc.setQueryData(firstPageKey(d), big(5000))).html).toContain('every 3 seconds')
  })

  it('stops following once its rows pass the line while open, showing them until a newer page came', () => {
    const many = names(POD_TABLE_WATCH_MAX + 1, 'held').map((n) => pod(n, d.using))
    const r = render(d, (qc) => {
      settle(qc, firstPageKey(d), pageOf(2, 1500), 1)
      settle(qc, d.wholeKey, many, 2)
    })
    expect(r.wholeAsked).toBe(false)
    expect(r.watchOpen).toBe(false)
    expect(r.html).toContain(`${d.title} (${POD_TABLE_WATCH_MAX + 1})`)
    expect(r.html).toContain('held-00000')
    expect(r.html).not.toContain('page-00000')
  })

  it('goes the old way when its first page is refused, which a whole read is as well', () => {
    const r = render(d, (qc) => {
      const query = qc.getQueryCache().build(qc, { queryKey: firstPageKey(d) })
      query.setState({ ...query.state, status: 'error', error: { response: { status: 403 } } as never, errorUpdatedAt: 1 })
    })
    expect(r.wholeAsked).toBe(true)
  })

  it('takes no row from a server that did not apply its condition, and reads the namespace whole as before', async () => {
    const r = render(d, () => {})
    seen.answer = unfiltered()
    await expect(r.readPage()).rejects.toBeInstanceOf(PodPageNotFiltered)
    seen.answer = { ...unfiltered(), filters: { namespace: 'ns', ...d.filter } }
    await expect(r.readPage()).resolves.toMatchObject({ total: 50_000 })

    const old = render(d, (qc) => {
      const query = qc.getQueryCache().build(qc, { queryKey: firstPageKey(d) })
      query.setState({ ...query.state, status: 'error', error: new PodPageNotFiltered() as never, errorUpdatedAt: 1 })
    })
    expect(old.wholeAsked).toBe(true)
    expect(old.watchOpen).toBe(d.follows !== false)
    expect(old.pageEvery(undefined, new PodPageNotFiltered())).toBe(false)
    expect(old.html).not.toContain('any-00000')
    expect(old.html).toContain('Loading...')
  })

  it('reads nothing whole when its first page failed on the server\'s side, and asks it again', () => {
    const r = render(d, (qc) => {
      const query = qc.getQueryCache().build(qc, { queryKey: firstPageKey(d) })
      query.setState({ ...query.state, status: 'error', error: { response: { status: 503 } } as never, errorUpdatedAt: 1 })
    })
    expect(r.wholeAsked).toBe(false)
    expect(r.pageEvery(undefined, { response: { status: 503 } })).toBe(10_000)
  })
})
