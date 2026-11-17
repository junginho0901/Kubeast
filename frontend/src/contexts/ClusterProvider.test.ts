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

import { act, createElement, Fragment, useLayoutEffect, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom'
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
import { useResourceDetail, type ResourceDetailTarget } from '@/components/ResourceDetailContext'
import LazyResourceDetailDrawer from '@/components/LazyResourceDetailDrawer'

// every read that went out, with its parameters as sent; these answer with their path and cluster
const sentReads: string[] = []
const NAMED_ANSWERS = ['/cluster/metrics/top-resources', '/cluster/features', '/cluster/namespaces']
client.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
  const params = (config.params ?? {}) as Record<string, string>
  const cluster = String(params.cluster ?? '')
  if (String(config.method ?? 'get').toLowerCase() === 'get') sentReads.push(`${config.url} ${new URLSearchParams(params)}`)
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
