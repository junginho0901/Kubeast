import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

// After a cluster switch nothing of the cluster before is drawn as the new one's — not in one commit. React Router
// applies the URL change in a transition, and the page re-mounted under the new cluster (Layout's key) used to read
// the old cache, refusals, notices and drawer row before an effect after that render emptied them. These tests run
// the real provider in react-dom with the few DOM parts it touches while nothing it renders is an element, and note
// what each commit shows (layout effects run for every commit, painted or not).

vi.hoisted(() => {
  const stored = new Map<string, string>()
  const document: Record<string, unknown> = { nodeType: 9, addEventListener() {}, removeEventListener() {}, activeElement: null, body: null }
  const window = Object.assign(new EventTarget(), {
    document,
    location: { search: '' },
    localStorage: {
      getItem: (k: string) => stored.get(k) ?? null,
      setItem: (k: string, v: string) => { stored.set(k, String(v)) },
      removeItem: (k: string) => { stored.delete(k) },
    },
    HTMLIFrameElement: class {},
  })
  document.defaultView = window
  vi.stubGlobal('window', window)
  vi.stubGlobal('document', document)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
})

// the drawer itself: one that notes each time it starts
const drawerMounts = vi.hoisted(() => ({ count: 0 }))
vi.mock('@/components/ResourceDetailDrawer', async () => {
  const { useLayoutEffect } = await import('react')
  return {
    default: function Drawer() {
      useLayoutEffect(() => { drawerMounts.count += 1 }, [])
      return null
    },
  }
})

import { act, createElement, Fragment, useEffect, useLayoutEffect, useState, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Router, createPath, useLocation, useNavigate, type To } from 'react-router-dom'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import type { InternalAxiosRequestConfig } from 'axios'
import { AxiosError } from 'axios'

import { ClusterProvider } from './ClusterProvider'
import { useCluster } from './ClusterContext'
import { client } from '@/services/api/client'
import { useForbiddenLabels } from '@/services/forbiddenStore'
import { announceCreated, useCreatedNotice } from '@/services/createdNoticeStore'
import { recordWatchFrame, useWatchProblem } from '@/services/watchProblemStore'
import { ResourceDetailProvider } from '@/components/ResourceDetailProvider'
import { selectionSettled, useClusterList } from '@/hooks/useAccessibleClusterSelection'
import ClusterGate from '@/components/ClusterGate'
import { everyUntilRefused, queryDefaults } from '@/services/queryDefaults'
import { useResourceDetail, type ResourceDetailTarget } from '@/components/ResourceDetailContext'
import LazyResourceDetailDrawer from '@/components/LazyResourceDetailDrawer'

// every read that went out, with its parameters as sent; these answer with their path and cluster
const sentReads: string[] = []
const NAMED_ANSWERS = ['/cluster/metrics/top-resources', '/cluster/features', '/cluster/namespaces']
// a grant limited to namespaces on the one cluster it may reach: refused the node list and the pods across namespaces
const ONLY_SELF = ['/clusters', '/cluster/overview', '/cluster/nodes', '/cluster/pods/page']
// the clusters the person may reach, as /clusters?accessibleOnly answers, and failures it answers first, one a read
let registry: string[] = ['self']
let health: Record<string, string> = {}
let listFailures: { status: number; retryAfter?: string }[] = []
client.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
  const params = (config.params ?? {}) as Record<string, string>
  const cluster = String(params.cluster ?? '')
  if (String(config.method ?? 'get').toLowerCase() === 'get') sentReads.push(`${config.url} ${new URLSearchParams(params)}`)
  if (ONLY_SELF.includes(String(config.url))) {
    await new Promise((r) => setTimeout(r, 20))
    const failure = config.url === '/clusters' ? listFailures.shift() : undefined
    if (failure) {
      const headers = failure.retryAfter ? { 'retry-after': failure.retryAfter } : {}
      throw new AxiosError('Request failed', 'ERR_BAD_RESPONSE', config, null, { status: failure.status, statusText: '', data: { detail: 'Session could not be checked; try again' }, headers, config })
    }
    if (config.url === '/clusters') return { data: { items: registry.map((id) => ({ id, display_name: id, health_status: health[id] ?? 'healthy' })) }, status: 200, statusText: 'OK', headers: {}, config }
    if (config.url === '/cluster/overview') return { data: {}, status: 200, statusText: 'OK', headers: {}, config }
    throw new AxiosError('Request failed', 'ERR_BAD_REQUEST', config, null, { status: 403, statusText: '', data: {}, headers: {}, config })
  }
  if (config.url === '/cluster/secrets/all') {
    throw new AxiosError('Request failed', 'ERR_BAD_RESPONSE', config, null, { status: 403, statusText: '', data: {}, headers: {}, config })
  }
  const data = config.url === '/cluster/pods/all' ? `pods of ${cluster}` : NAMED_ANSWERS.includes(String(config.url)) ? `${config.url} of ${cluster}` : null
  return { data, status: 200, statusText: 'OK', headers: {}, config }
}

const container = {
  nodeType: 1, nodeName: 'DIV', tagName: 'DIV', namespaceURI: 'http://www.w3.org/1999/xhtml',
  ownerDocument: document, addEventListener() {}, removeEventListener() {}, childNodes: [], firstChild: null,
} as unknown as HTMLElement

let root: Root
let pick: (id: string) => void = () => {}

// give the answers and TanStack's notifications their turn
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 5)) })
const until = async (ok: () => boolean) => {
  for (let i = 0; i < 100 && !ok(); i += 1) await settle()
  expect(ok()).toBe(true)
}

function Picker() {
  pick = useCluster().setCurrentCluster
  return null
}

const mount = async (body: ReactNode) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  root = createRoot(container)
  await act(async () => {
    root.render(createElement(MemoryRouter, { initialEntries: ['/?cluster=a'] },
      createElement(QueryClientProvider, { client: qc },
        createElement(ClusterProvider, null, createElement(Picker), body))))
  })
}

beforeEach(async () => {
  if (root) await act(async () => root.unmount())
  drawerMounts.count = 0
})

afterAll(() => {
  vi.unstubAllGlobals()
})

describe('a cluster switch', () => {
  type Shown = { cluster: string; rows: unknown; refused: string[]; notice: unknown; watch: unknown }
  const commits: Shown[] = []

  // a list page as Layout mounts it: under a key of the cluster, with the lines above it
  function Page() {
    const { currentCluster } = useCluster()
    const { data } = useQuery({ queryKey: ['workloads', 'pods', 'all'], queryFn: async () => (await client.get('/cluster/pods/all')).data })
    const refused = useForbiddenLabels()
    const notice = useCreatedNotice()
    const watch = useWatchProblem()
    useLayoutEffect(() => { commits.push({ cluster: currentCluster, rows: data, refused, notice, watch }) })
    return null
  }
  function Screen() {
    const { currentCluster } = useCluster()
    return createElement(Page, { key: currentCluster || 'default' })
  }

  it("draws the new cluster with none of the old one's rows, refusals, created line or watch problems", async () => {
    commits.length = 0
    await mount(createElement(Screen))
    await until(() => commits.at(-1)?.rows === 'pods of a')
    await act(async () => {
      await client.get('/cluster/secrets/all').catch(() => undefined)
      announceCreated('/', [{ kind: 'ConfigMap', name: 'made-on-a' }])
      recordWatchFrame('a\n/api/v1/pods?watch=1', { type: 'ERROR', error: { reason: 'forbidden' } })
    })
    await settle()
    expect(commits.at(-1)).toMatchObject({ cluster: 'a', rows: 'pods of a', refused: ['Secret'], watch: 'forbidden' })
    expect(commits.at(-1)?.notice).not.toBeNull()

    commits.length = 0
    await act(async () => pick('b'))
    await until(() => commits.at(-1)?.rows === 'pods of b')

    const onB = commits.filter((c) => c.cluster === 'b')
    expect(onB.length).toBeGreaterThan(0)
    expect(onB.filter((c) => c.rows === 'pods of a' || c.refused.length > 0 || c.notice !== null || c.watch !== undefined)).toEqual([])
    // and the cluster before is never drawn with the new one's rows
    expect(commits.filter((c) => c.cluster === 'a' && c.rows === 'pods of b')).toEqual([])
  })
})

// A switch asks each read of the new cluster once. The cache was emptied with the queries of the screen being left still
// on it, and asking them then sent them as the new cluster with that screen's key and parameters: the Dashboard's top
// resources went to the new cluster twice, once with the `skip=nodes` the cluster left had refused it, and every read
// keyed by the cluster went twice.
describe('the reads a cluster switch makes', () => {
  const shown: Record<string, unknown> = {}

  // a page as Layout mounts it, under a key of the cluster, whose read leaves out what its own cluster refused before
  function Page() {
    const { currentCluster } = useCluster()
    shown.top = useQuery({
      queryKey: ['top-resources', currentCluster],
      queryFn: async () => (await client.get('/cluster/metrics/top-resources', { params: currentCluster === 'a' ? { skip: 'nodes' } : {} })).data,
    }).data
    return null
  }
  // beside it, as Layout's own reads: one keyed by the cluster, one whose key names none
  function Beside() {
    const { currentCluster } = useCluster()
    shown.features = useQuery({ queryKey: ['cluster-features', currentCluster], queryFn: async () => (await client.get('/cluster/features')).data }).data
    shown.namespaces = useQuery({ queryKey: ['namespaces'], queryFn: async () => (await client.get('/cluster/namespaces')).data }).data
    return null
  }
  function Screen() {
    const { currentCluster } = useCluster()
    return createElement(Fragment, null, createElement(Beside), createElement(Page, { key: currentCluster || 'default' }))
  }
  const on = (cluster: string) => () =>
    shown.top === `/cluster/metrics/top-resources of ${cluster}` &&
    shown.features === `/cluster/features of ${cluster}` &&
    shown.namespaces === `/cluster/namespaces of ${cluster}`

  it("asks each read of the new cluster once, with none of the cluster left's parameters", async () => {
    await mount(createElement(Screen))
    await until(on('a'))
    expect(sentReads.filter((r) => r.includes('skip=nodes'))).toEqual(['/cluster/metrics/top-resources skip=nodes&cluster=a'])

    sentReads.length = 0
    await act(async () => pick('b'))
    await until(on('b'))
    await settle()

    expect(sentReads.sort()).toEqual([
      '/cluster/features cluster=b',
      '/cluster/metrics/top-resources cluster=b',
      '/cluster/namespaces cluster=b',
    ])
  })
})

describe('an open drawer on a cluster switch', () => {
  type Shown = { cluster: string; target: ResourceDetailTarget | null; canGoBack: boolean }
  const commits: Shown[] = []
  let open: (t: ResourceDetailTarget) => void = () => {}

  function Probe() {
    const { currentCluster } = useCluster()
    const detail = useResourceDetail()
    open = detail.open
    useLayoutEffect(() => { commits.push({ cluster: currentCluster, target: detail.target, canGoBack: detail.canGoBack }) })
    return null
  }

  it('stays on the object the address names, without the row or the way back of the cluster before', async () => {
    commits.length = 0
    await mount(createElement(ResourceDetailProvider, null, createElement(Probe)))
    await act(async () => open({ kind: 'Deployment', namespace: 'default', name: 'api', rawJson: { from: 'list of a' } }))
    await act(async () => open({ kind: 'Deployment', namespace: 'default', name: 'web', rawJson: { from: 'list of a' } }))
    expect(commits.at(-1)).toMatchObject({ cluster: 'a', canGoBack: true, target: { name: 'web', rawJson: { from: 'list of a' } } })

    commits.length = 0
    await act(async () => pick('b'))
    await settle()

    const onB = commits.filter((c) => c.cluster === 'b')
    expect(onB.length).toBeGreaterThan(0)
    expect(onB.filter((c) => c.target?.rawJson !== undefined || c.canGoBack)).toEqual([])
    expect(onB.at(-1)?.target).toMatchObject({ kind: 'Deployment', namespace: 'default', name: 'web' })
  })

  it('starts the drawer again, so nothing it held of the cluster before stays', async () => {
    await mount(createElement(ResourceDetailProvider, null, createElement(Probe), createElement(LazyResourceDetailDrawer)))
    await act(async () => open({ kind: 'Deployment', namespace: 'default', name: 'web' }))
    await until(() => drawerMounts.count === 1)

    await act(async () => pick('b'))
    await settle()

    expect(drawerMounts.count).toBe(2)
  })
})

describe('the cluster context across navigations', () => {
  const reads: string[] = []
  let go: (to: string) => void = () => {}
  let address = ''
  function Reader() {
    reads.push(useCluster().currentCluster)
    return null
  }
  function Address() {
    const location = useLocation()
    const navigate = useNavigate()
    go = navigate
    address = location.search
    return null
  }

  it('gives its readers the same value while the cluster stays, and a switch keeps the address the moment before it', async () => {
    await mount(createElement(Fragment, null, createElement(Reader), createElement(Address)))
    await settle()
    reads.length = 0
    await act(async () => go('/?cluster=a&namespace=ns1&node=n1'))
    await act(async () => go('/?cluster=a&namespace=ns1&node=n2'))
    expect(reads).toEqual([])

    await act(async () => pick('b'))
    await settle()
    expect({ address, reads: [...new Set(reads)] }).toEqual({ address: '?cluster=b&namespace=ns1', reads: ['b'] })
  })
})

// The first selection after sign-in ('' → one of the person's clusters), and the gate the screens wait at (ClusterGate,
// as Layout draws it). The switch emptied the cluster list without asking it again: Layout read "no accessible cluster"
// and took the page away, and the picker cleared the selection it had just made, so the screen went back and forth
// between the cluster and none and each turn with none read the page again without `cluster=`. A page drawn before the
// selection read once without `cluster=` too, answered for the server's default cluster. A list whose first read failed
// cleared a stored selection, and the screens read the default cluster.
describe('the screens and the selection of a cluster', () => {
  const ck = (cluster: string) => cluster || 'default'
  // the Dashboard's reads on a timer: the overview every 15 s, the problem pods every 30 s, the node list every minute
  function Page() {
    const { currentCluster } = useCluster()
    useQuery({ queryKey: ['cluster-overview', ck(currentCluster)], queryFn: async () => (await client.get('/cluster/overview')).data, refetchInterval: everyUntilRefused(15_000) })
    useQuery({ queryKey: ['dashboard-problem-pods', ck(currentCluster)], queryFn: async () => (await client.get('/cluster/pods/page', { params: { sort: 'health' } })).data, refetchInterval: everyUntilRefused(30_000) })
    useQuery({ queryKey: ['nodes', ck(currentCluster)], queryFn: async () => (await client.get('/cluster/nodes', { params: { force_refresh: false } })).data, refetchInterval: everyUntilRefused(60_000) })
    return null
  }
  // the gate's fallback: how many times it was drawn
  const fallback = { drawn: 0 }
  function Fallback() {
    useLayoutEffect(() => { fallback.drawn += 1 })
    return null
  }
  // as Layout draws it: under the cluster's key, the gate and the page in it
  function Body() {
    const { currentCluster } = useCluster()
    return createElement(Fragment, { key: ck(currentCluster) }, createElement(ClusterGate, { fallback: createElement(Fallback), children: createElement(Page) }))
  }
  let shown = ''
  function Shown() {
    shown = useCluster().currentCluster
    return null
  }
  // the picker's list: each cluster's health dot
  let listed: Record<string, string | undefined> = {}
  function Listed() {
    listed = Object.fromEntries((useClusterList().data ?? []).map((c) => [c.id, c.health_status]))
    return null
  }
  let client_: QueryClient
  const stored = () => window.localStorage.getItem('kubeast:current-cluster')
  const reads = (path: string, cluster: string) => {
    const of = sentReads.filter((r) => r.startsWith(`${path} `))
    return { atNone: of.filter((r) => !r.includes('cluster=')).length, at: of.filter((r) => r.includes(`cluster=${cluster}`)).length, elsewhere: of.filter((r) => r.includes('cluster=') && !r.includes(`cluster=${cluster}`)).length }
  }
  // the page's three reads at one cluster: each once with it, none without a cluster or at another
  const pageReads = (cluster: string) => ({ nodes: reads('/cluster/nodes', cluster), pods: reads('/cluster/pods/page', cluster), overview: reads('/cluster/overview', cluster) })
  const once = { atNone: 0, at: 1, elsewhere: 0 }
  const pass = async (ms: number) => { for (let t = 0; t < ms; t += 500) await act(async () => { await vi.advanceTimersByTimeAsync(500) }) }
  const start = async ({ clusters, storedAs = '', failures = [] }: { clusters: string[]; storedAs?: string; failures?: typeof listFailures }) => {
    registry = clusters
    listFailures = [...failures]
    if (storedAs) window.localStorage.setItem('kubeast:current-cluster', storedAs)
    else window.localStorage.removeItem('kubeast:current-cluster')
    sentReads.length = 0
    fallback.drawn = 0
    client_ = new QueryClient({ defaultOptions: { queries: queryDefaults } })
    root = createRoot(container)
    await act(async () => {
      root.render(createElement(MemoryRouter, { initialEntries: ['/'] },
        createElement(QueryClientProvider, { client: client_ },
          createElement(ClusterProvider, null, createElement(Shown), createElement(Listed), createElement(Picker), createElement(Body)))))
    })
  }
  const end = async () => {
    await act(async () => root.unmount())
    vi.useRealTimers()
    registry = ['self']
    health = {}
    listFailures = []
  }

  it('settles the screens once the selection is one of the clusters the list answered, or on a selection the list could not answer for', () => {
    const list = (data: string[] | undefined, isError = false, failureCount = 0) => ({ data: data?.map((id) => ({ id }) as never), isError, failureCount })
    expect([
      selectionSettled(list(['a', 'b']), 'a'),
      selectionSettled(list(['a', 'b']), 'gone'),
      selectionSettled(list(['a']), ''),
      selectionSettled(list([]), ''),
      selectionSettled(list([]), 'a'),
      selectionSettled(list(undefined), 'a'),
      selectionSettled(list(undefined, false, 1), 'a'),
      selectionSettled(list(undefined, false, 1), ''),
      selectionSettled(list(undefined, true, 2), 'a'),
      selectionSettled(list(undefined, true, 2), ''),
    ]).toEqual([true, false, false, true, true, false, true, false, true, true])
  })

  for (const c of [
    { install: 'one cluster', clusters: ['self'], storedAs: '', chosen: 'self' },
    { install: 'two clusters', clusters: ['default', 'self'], storedAs: '', chosen: 'default' },
    { install: 'one cluster, chosen before', clusters: ['self'], storedAs: 'self', chosen: 'self' },
    { install: 'two clusters, chosen before', clusters: ['default', 'self'], storedAs: 'self', chosen: 'self' },
    { install: 'a stored cluster since removed', clusters: ['self'], storedAs: 'gone', chosen: 'self' },
  ]) {
    it(`${c.install}: reads nothing without a cluster or at another, each refused read once with the one chosen, none again`, async () => {
      vi.useFakeTimers()
      try {
        await start(c)
        await pass(5_000)
        expect({ shown, stored: stored(), ...pageReads(c.chosen) }).toEqual({ shown: c.chosen, stored: c.chosen, nodes: once, pods: once, overview: once })

        // two minutes on: the overview's 15 s eight times over, no refused read asked again anywhere
        await pass(120_000)
        const overview = reads('/cluster/overview', c.chosen)
        expect({ shown, nodes: reads('/cluster/nodes', c.chosen), pods: reads('/cluster/pods/page', c.chosen), overviewElsewhere: overview.atNone + overview.elsewhere, overviewOnItsTimer: overview.at > 8 })
          .toEqual({ shown: c.chosen, nodes: once, pods: once, overviewElsewhere: 0, overviewOnItsTimer: true })
      } finally {
        await end()
      }
    })
  }

  // The session store's database restarting: /clusters answers 503 with Retry-After for a while, then its list.
  it('a list answered "ask again" keeps a stored selection, which the screens read, and stays on it once the list answers', async () => {
    vi.useFakeTimers()
    try {
      await start({ clusters: ['default', 'self'], storedAs: 'self', failures: [{ status: 503, retryAfter: '5' }, { status: 503, retryAfter: '5' }] })
      await pass(3_000)
      expect({ shown, stored: stored(), listAsked: sentReads.filter((r) => r.startsWith('/clusters ')).length, ...pageReads('self') })
        .toEqual({ shown: 'self', stored: 'self', listAsked: 1, nodes: once, pods: once, overview: once })
      await pass(15_000)
      expect({ shown, stored: stored(), listAsked: sentReads.filter((r) => r.startsWith('/clusters ')).length, nodes: reads('/cluster/nodes', 'self'), pods: reads('/cluster/pods/page', 'self') })
        .toEqual({ shown: 'self', stored: 'self', listAsked: 3, nodes: once, pods: once })
    } finally {
      await end()
    }
  })

  it('with nothing stored, the screens wait while the list answers "ask again", then read the cluster it gives once', async () => {
    vi.useFakeTimers()
    try {
      await start({ clusters: ['default', 'self'], failures: [{ status: 503, retryAfter: '5' }, { status: 503, retryAfter: '5' }] })
      await pass(8_000)
      expect({ shown, nodes: reads('/cluster/nodes', 'default'), overview: reads('/cluster/overview', 'default') })
        .toEqual({ shown: '', nodes: { atNone: 0, at: 0, elsewhere: 0 }, overview: { atNone: 0, at: 0, elsewhere: 0 } })
      await pass(15_000)
      expect({ shown, stored: stored(), ...pageReads('default') }).toEqual({ shown: 'default', stored: 'default', nodes: once, pods: once, overview: once })
    } finally {
      await end()
    }
  })

  it('with nothing stored and a list that failed for good, the screens read as before, at the server\'s default cluster', async () => {
    vi.useFakeTimers()
    try {
      await start({ clusters: ['self'], failures: [{ status: 500 }, { status: 500 }] })
      await pass(5_000)
      expect({ shown, nodes: reads('/cluster/nodes', 'self') }).toEqual({ shown: '', nodes: { atNone: 1, at: 0, elsewhere: 0 } })
    } finally {
      await end()
    }
  })

  it('a switch in the picker keeps the gate open: no fallback drawn, each read once at the cluster chosen, none again at the one left', async () => {
    vi.useFakeTimers()
    try {
      await start({ clusters: ['default', 'self'], storedAs: 'default' })
      await pass(3_000)
      expect({ ...pageReads('default'), listed }).toEqual({ nodes: once, pods: once, overview: once, listed: { default: 'healthy', self: 'healthy' } })
      sentReads.length = 0
      fallback.drawn = 0
      // the cluster to switch to went unhealthy since the list was read: the switch reads the list again behind it
      health = { self: 'unhealthy' }
      await act(async () => pick('self'))
      await pass(65_000)
      expect({ shown, fallbackDrawn: fallback.drawn, listAsked: sentReads.filter((r) => r.startsWith('/clusters ')).length, listed, nodes: reads('/cluster/nodes', 'self'), pods: reads('/cluster/pods/page', 'self'), leftBehind: sentReads.filter((r) => r.includes('cluster=default')) })
        .toEqual({ shown: 'self', fallbackDrawn: 0, listAsked: 1, listed: { default: 'healthy', self: 'unhealthy' }, nodes: once, pods: once, leftBehind: [] })
    } finally {
      await end()
    }
  })

  it('the selected cluster gone from the list: the screens wait, read none of it, and read the cluster chosen in its place once', async () => {
    vi.useFakeTimers()
    try {
      await start({ clusters: ['default', 'self'], storedAs: 'self' })
      await pass(3_000)
      expect(pageReads('self')).toEqual({ nodes: once, pods: once, overview: once })
      sentReads.length = 0
      registry = ['default']
      await act(async () => { void client_.invalidateQueries({ queryKey: ['clusters-accessible'] }) })
      await pass(65_000)
      expect({ shown, stored: stored(), atSelf: sentReads.filter((r) => r.includes('cluster=self') && !r.startsWith('/clusters ')), nodes: reads('/cluster/nodes', 'default'), pods: reads('/cluster/pods/page', 'default') })
        .toEqual({ shown: 'default', stored: 'default', atSelf: [], nodes: once, pods: once })
    } finally {
      await end()
    }
  })
})

// A page opened fresh with nothing stored and no ?cluster= (signed in, then a link): the first selection goes into the
// address, which React Router applies in a transition. Here the router never applies it, with and without a
// cluster-scoped read changing afterwards (the provider renders again on useIsFetching).
describe('the first selection when the address change does not land', () => {
  const seen = { opened: false, shown: '' }
  function Page() {
    useLayoutEffect(() => { seen.opened = true })
    return null
  }
  function Shown() {
    seen.shown = useCluster().currentCluster
    return null
  }
  function ListOnly() {
    useClusterList()
    return null
  }
  const run = async (laterRead: boolean) => {
    registry = ['default']
    sentReads.length = 0
    seen.opened = false
    seen.shown = ''
    window.localStorage.removeItem('kubeast:current-cluster')
    const asked: string[] = []
    const path = (to: To) => (typeof to === 'string' ? to : createPath(to))
    const navigator = {
      createHref: path,
      encodeLocation: (to: To) => (typeof to === 'string' ? { pathname: to, search: '', hash: '' } : { pathname: to.pathname ?? '/', search: to.search ?? '', hash: to.hash ?? '' }),
      push: (to: To) => { asked.push(path(to)) },
      replace: (to: To) => { asked.push(path(to)) },
      go: () => {},
    }
    function Later() {
      const { currentCluster } = useCluster()
      const [go, setGo] = useState(false)
      useEffect(() => {
        if (!laterRead) return
        const t = setTimeout(() => setGo(true), 50)
        return () => clearTimeout(t)
      }, [])
      // on its way for a while, as a read over the network is: the provider draws the count of reads on their way
      useQuery({ queryKey: ['later-read', currentCluster || 'none'], queryFn: async () => { await new Promise((r) => setTimeout(r, 20)); return (await client.get('/auth/admin/access-requests')).data }, enabled: go, retry: false })
      return null
    }
    root = createRoot(container)
    await act(async () => {
      root.render(createElement(Router, { location: { pathname: '/admin/users', search: '', hash: '', state: null, key: 'k0' }, navigator },
        createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: queryDefaults } }) },
          createElement(ClusterProvider, null, createElement(Shown), createElement(Later), createElement(ListOnly),
            createElement(ClusterGate, { fallback: null, children: createElement(Page) })))))
    })
    for (let i = 0; i < 60 && !seen.opened; i += 1) await settle()
    const out = { opened: seen.opened, shown: seen.shown, stored: window.localStorage.getItem('kubeast:current-cluster'), asked }
    await act(async () => root.unmount())
    registry = ['self']
    return out
  }

  it('opens the gate on the cluster the list gave with nothing else drawing the provider again, the address asked once', async () => {
    expect(await run(false)).toEqual({ opened: true, shown: 'default', stored: 'default', asked: ['/admin/users?cluster=default'] })
  })

  it('opens it the same when a cluster-scoped read changes afterwards', async () => {
    const r = await run(true)
    expect({ opened: r.opened, shown: r.shown, stored: r.stored }).toEqual({ opened: true, shown: 'default', stored: 'default' })
  })
})
