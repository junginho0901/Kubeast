import { createElement, type ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PodPage } from '@/services/api'
import '@/i18n'
import { PageContextProvider } from '@/components/PageContextProvider'
import ServiceInfo from './ServiceInfo'
import PDBInfo from './PDBInfo'
import { useOwnedWatchedResources } from './workload-info/useOwnedWatchedResources'
import WorkloadOwnedResources from './workload-info/WorkloadOwnedResources'
import { workloadPodsLayer } from './workload-info/workloadPodsLayer'
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
// these tables keep to their own line, set here apart from the namespace tables' 2 000
vi.mock('./namespacePodTable', async (importOriginal) => ({ ...(await importOriginal<typeof import('./namespacePodTable')>()), SET_POD_TABLE_WATCH_MAX: 20 }))

const LINE = 20

const pod = (name: string, extra: Record<string, unknown> = {}) => ({
  name, namespace: 'ns', status: 'Running', phase: 'Running', ready: '1/1', restart_count: 0, node_name: 'node-1',
  pod_ip: '10.0.0.1', created_at: '2026-11-07T00:00:00Z', ...extra,
})
const names = (n: number, prefix = 'p') => Array.from({ length: n }, (_, i) => `${prefix}-${String(i).padStart(5, '0')}`)

// The server's first page of a drawer's table: `matched` pods of `namespacePods`, ten of them on the page.
const pageOf = (matched: number, namespacePods: number, revision = 'r1', notRunning = 0): PodPage => ({
  items: names(Math.min(10, matched), 'page').map((n) => pod(n)),
  total: matched,
  not_running: notRunning,
  stats: { total: namespacePods },
  revision,
  source: revision ? 'index' : 'list',
} as unknown as PodPage)

const controlledBy = (kind: string, name: string) => ({ owner_references: [{ kind, name, uid: 'u1', controller: true }] })

// A workload drawer's pod table as the window draws it.
function OwnedPods({ kind, name }: { kind: string; name: string }) {
  const owned = useOwnedWatchedResources({ kind, namespace: 'ns', name, selector: { app: 'web' } })
  return createElement(WorkloadOwnedResources, {
    namespace: 'ns', owned, isCronJob: false, isDaemonSet: kind === 'DaemonSet', isDeployment: kind === 'Deployment', isJob: kind === 'Job',
    isReplicaSet: kind === 'ReplicaSet', isStatefulSet: kind === 'StatefulSet', describe: undefined, ownedJobs: undefined,
  })
}

type Drawer = {
  kind: string
  component: ComponentType<any>
  props: Record<string, unknown>
  filter: Record<string, string>
  wholeKey: unknown[]
  title: string
  // every row the whole read gives is the table's (the API server applied the selector)
  keepsAll: boolean
  using: Record<string, unknown>
  prime?: (qc: QueryClient) => void
}

const owner = (kind: string, name: string): Drawer => ({
  kind, component: OwnedPods, props: { kind, name }, filter: { label_selector: 'app=web', owner: `${kind}/${name}` },
  wholeKey: ['owned-watched-pods', kind, 'ns', name, 'app=web'], title: 'Pods', keepsAll: false, using: controlledBy(kind, name),
})

const drawers: Drawer[] = [
  {
    kind: 'Service', component: ServiceInfo, props: { name: 'svc', namespace: 'ns' }, filter: { label_selector: 'app=web' },
    wholeKey: ['service-matching-pods', 'ns', 'svc', 'app=web'], title: 'Matching Pods', keepsAll: true, using: {},
    prime: (qc) => qc.setQueryData(['service-describe', 'ns', 'svc'], { selector: { app: 'web' } }),
  },
  {
    kind: 'PodDisruptionBudget', component: PDBInfo, props: { name: 'pdb', namespace: 'ns' }, filter: { label_selector: 'app=web' },
    wholeKey: ['pdb-protected-pods', 'ns', 'pdb', 'app=web'], title: 'Protected Pods', keepsAll: true, using: {},
    prime: (qc) => qc.setQueryData(['pdb-describe', 'ns', 'pdb'], { selector: { app: 'web' } }),
  },
  owner('DaemonSet', 'ds'),
  owner('ReplicaSet', 'rs'),
  owner('StatefulSet', 'sts'),
  owner('Job', 'job'),
]

const firstPageKey = (d: Pick<Drawer, 'filter'>) => drawerPodsKey({ namespace: 'ns', ...d.filter }, 1, 10)

function render(d: Pick<Drawer, 'component' | 'props' | 'wholeKey' | 'prime'>, setUp: (qc: QueryClient) => void) {
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
    wholeAsked: whole.some((q) => q.enabled !== false),
    watchOpen: podWatches.some((w) => w.enabled),
    readPage: () => pageReads.at(-1)?.queryFn(),
    pageEvery: (data: PodPage | undefined, error: unknown = null) => {
      const every = pageReads.at(-1)?.refetchInterval
      return typeof every === 'function' ? every({ state: { data, error } }) : (every ?? false)
    },
  }
}

const settle = (qc: QueryClient, key: unknown[], data: unknown, updatedAt: number) => qc.setQueryData(key, data, { updatedAt })

// As a k8s-service from before these conditions answers a page: every pod of the namespace, and no filters.
const unfiltered = (): PodPage => ({ ...pageOf(50_000, 50_000), items: names(10, 'any').map((n) => pod(n)) })

describe.each(drawers)('the $kind drawer\'s table of its pods', (d) => {
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

  it('reads its pods whole and follows them as before when they are few', () => {
    const r = render(d, (qc) => qc.setQueryData(firstPageKey(d), pageOf(2, 50_000)))
    expect(r.wholeAsked).toBe(true)
    expect(r.watchOpen).toBe(true)
    expect(r.html).not.toContain('drawer-pods-read-every')
    // until the whole read answers, the server's page fills the table
    expect(r.html).toContain('page-00000')
    expect(r.html).toContain(`${d.title} (2)`)
    expect(r.pageEvery(pageOf(2, 50_000))).toBe(false)
  })

  it('shows the whole read\'s rows, kept as before, once it has them', () => {
    const r = render(d, (qc) => {
      settle(qc, firstPageKey(d), pageOf(2, 1500), 1)
      settle(qc, d.wholeKey, [pod('kept-1', d.using), pod('other', controlledBy('ReplicaSet', 'someone-else')), pod('kept-2', d.using)], 2)
    })
    expect(r.html).toContain('kept-1')
    expect(r.html).toContain('kept-2')
    if (d.keepsAll) expect(r.html).toContain('other')
    else expect(r.html).not.toContain('other')
    expect(r.html).toContain(`${d.title} (${d.keepsAll ? 3 : 2})`)
  })

  it('reads no pod whole and opens no watch past the line, shows the server\'s pages and says how often it reads them', () => {
    const big = (namespacePods: number) => pageOf(LINE + 500, namespacePods)
    const r = render(d, (qc) => qc.setQueryData(firstPageKey(d), big(50_000)))
    expect(r.wholeAsked).toBe(false)
    expect(r.watchOpen).toBe(false)
    expect(r.html).toContain(`${d.title} (${LINE + 500})`)
    expect(r.html).toContain('page-00009')
    expect(r.html).toContain('data-testid="drawer-pods-read-every"')
    // a workload's own pods passed the line, else a selector's matches
    expect(r.html).toContain(d.filter.owner
      ? `This ${d.kind} has too many pods to follow live, so this table is read again every 10 seconds.`
      : 'Too many pods match this selector to follow live, so this table is read again every 10 seconds.')
    expect(r.pageEvery(big(50_000))).toBe(10_000)
    expect(r.pageEvery(big(5000))).toBe(3_000)
  })

  it('stops following once its rows pass the line while open, showing them until a newer page came', () => {
    const many = names(LINE + 1, 'held').map((n) => pod(n, d.using))
    const r = render(d, (qc) => {
      settle(qc, firstPageKey(d), pageOf(2, 1500), 1)
      settle(qc, d.wholeKey, many, 2)
    })
    expect(r.wholeAsked).toBe(false)
    expect(r.watchOpen).toBe(false)
    expect(r.html).toContain(`${d.title} (${LINE + 1})`)
    expect(r.html).toContain('held-00000')
    expect(r.html).not.toContain('page-00000')
  })

  it('takes no row from a server that did not apply its conditions, and reads them whole as before', async () => {
    const r = render(d, () => {})
    seen.answer = unfiltered()
    await expect(r.readPage()).rejects.toThrow()
    // a server that kept the selector but not the owner is one from before this table too
    seen.answer = { ...unfiltered(), filters: { namespace: 'ns', label_selector: 'app=web' } }
    if (d.filter.owner) await expect(r.readPage()).rejects.toThrow()
    seen.answer = { ...unfiltered(), filters: { namespace: 'ns', ...d.filter } }
    await expect(r.readPage()).resolves.toMatchObject({ total: 50_000 })
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

describe('a workload drawer\'s pods are the ones it controls', () => {
  it('leaves out a pod that matches the selector but that no controller of that name owns, as kubectl counts it', () => {
    const d = drawers[2]
    const r = render(d, (qc) => {
      settle(qc, firstPageKey(d), pageOf(2, 1500), 1)
      settle(qc, d.wholeKey, [pod('kept-1', d.using), pod('loose'), pod('kept-2', d.using)], 2)
    })
    expect(r.html).not.toContain('loose')
    expect(r.html).toContain('Pods (2)')
  })
})

// The Deployment window shows ReplicaSets, not pods: its pods are read for the floating chat.
function DeploymentLayer() {
  const owned = useOwnedWatchedResources({ kind: 'Deployment', namespace: 'ns', name: 'web', selector: { app: 'web' } })
  return createElement('pre', null, JSON.stringify(workloadPodsLayer(undefined, owned as any, 'ns')))
}

describe('the Deployment window\'s pods, which the floating chat is told', () => {
  const d = { component: DeploymentLayer, props: {}, wholeKey: ['owned-watched-pods', 'Deployment', 'ns', 'web', 'app=web'] }
  const key = firstPageKey({ filter: { label_selector: 'app=web' } })
  const layerOf = (html: string) => JSON.parse(html.replace(/^<pre>|<\/pre>$/g, '').replace(/&quot;/g, '"'))

  it('reads none whole before the server\'s first page, and all of them live when they are few', () => {
    expect(render(d, () => {}).wholeAsked).toBe(false)
    const few = render(d, (qc) => qc.setQueryData(key, pageOf(3, 50_000, 'r1', 1)))
    expect(few.wholeAsked).toBe(true)
    expect(few.watchOpen).toBe(true)
  })

  it('past the line reads only the server\'s page and tells the chat the server\'s counts of every pod', () => {
    const r = render(d, (qc) => qc.setQueryData(key, pageOf(LINE + 500, 50_000, 'r1', 7)))
    expect(r.wholeAsked).toBe(false)
    expect(r.watchOpen).toBe(false)
    expect(layerOf(r.html)).toMatchObject({ known: true, total: LINE + 500, notRunning: 7, pageOnly: true })
    expect(layerOf(r.html).items).toHaveLength(10)
  })
})
