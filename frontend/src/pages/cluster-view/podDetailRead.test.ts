import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// The pod's window as Cluster View wires it (ClusterViewBody): the real provider, the detail queries and the fill, in
// react-dom with the few DOM parts it touches (as ClusterViewProvider.test.ts), the describe answered here.

vi.hoisted(() => {
  const document: Record<string, unknown> = { nodeType: 9, addEventListener() {}, removeEventListener() {}, activeElement: null, body: null }
  const window = Object.assign(new EventTarget(), { document, location: { search: '' }, HTMLIFrameElement: class {} })
  document.defaultView = window
  vi.stubGlobal('window', window)
  vi.stubGlobal('document', document)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
})

const reads = vi.hoisted(() => ({ describe: [] as { namespace: string; name: string; answer: (v: unknown) => void; fail: (e: unknown) => void }[] }))
vi.mock('@/services/api', () => ({
  api: {
    describePod: (namespace: string, name: string) => new Promise((answer, fail) => { reads.describe.push({ namespace, name, answer, fail }) }),
    getResourceYaml: async () => ({ yaml: '' }),
  },
}))

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { applyWatchFrames } from '@/services/useKubeWatchList'
import type { NodeBoxPod, PodInfo } from '@/services/api'
import { ClusterViewProvider } from './ClusterViewProvider'
import { useClusterView } from './ClusterViewContext'
import type { ClusterViewContextValue } from './ClusterViewContext'
import { usePodDetailQueries } from './hooks/usePodDetailQueries'
import { filledDetail, openPodWindow, podReadState, readsPod, usePodDetailRead, type PodReadShown } from './podDetailRead'
import { pickMainContainer, podToDetail } from './types'

// a box's row (k8s-service nodeBoxPod) and the full row of the same pod (podrow.Info), as the describe answers it
const SHORT: NodeBoxPod = {
  name: 'web-7d9f8c6b5-x2k4p', namespace: 'shop', node_name: 'n1', pod_ip: '10.0.1.7', status: 'Running', phase: 'Running', restart_count: 2,
  created_at: '2026-11-16T01:02:03Z', labels: { app: 'web' }, health: 'ok', health_reason: 'Running',
}
const containers = [
  { name: 'istio-proxy', image: 'istio/proxyv2:1.28', ready: true, restart_count: 0, state: { running: { started_at: '' } } },
  { name: 'web', image: 'example.test/web:3', ready: true, restart_count: 2, state: { running: { started_at: '' } } },
]
const FULL = { ...SHORT, ready: '2/2', containers, init_containers: [], labels: { app: 'web' } } as unknown as PodInfo

const container = {
  nodeType: 1, nodeName: 'DIV', tagName: 'DIV', namespaceURI: 'http://www.w3.org/1999/xhtml',
  ownerDocument: document, addEventListener() {}, removeEventListener() {}, childNodes: [], firstChild: null,
} as unknown as HTMLElement

const i18n = i18next.createInstance()
let root: Root
let client: QueryClient
let view: ClusterViewContextValue
let shown: PodReadShown = 'none'

// ClusterViewBody's part for the window: the detail queries, the fill and what the tabs are told
function Window() {
  view = useClusterView()
  const { selectedPod, showManifest, showDescribe, activeTab, selectedContainer, execContainer, setSelectedPod, setSelectedContainer, setExecContainer } = view
  const { podRead } = usePodDetailQueries({ selectedPod, showManifest, showDescribe })
  usePodDetailRead({ selectedPod, read: podRead, choice: { activeTab, selectedContainer, execContainer }, setSelectedPod, setSelectedContainer, setExecContainer })
  shown = podReadState(selectedPod, podRead)
  return null
}

beforeAll(async () => {
  await i18n.use(initReactI18next).init({ lng: 'en', resources: {} })
})

beforeEach(async () => {
  reads.describe = []
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  root = createRoot(container)
  await act(async () => {
    root.render(createElement(I18nextProvider, { i18n },
      createElement(QueryClientProvider, { client },
        createElement(MemoryRouter, { initialEntries: ['/cluster-view?cluster=self'] },
          createElement(ClusterViewProvider, null, createElement(Window))))))
  })
})

afterEach(async () => {
  await act(async () => root.unmount())
})

afterAll(() => {
  vi.unstubAllGlobals()
})

// react-query tells its observers on a timer: each step waits for it before the screen is read
const settled = () => new Promise((done) => setTimeout(done, 20))
const open = (pod: unknown, tab: 'logs' | 'exec') => act(async () => { openPodWindow(pod, tab, view); await settled() })
const answer = (i: number, pod: unknown) => act(async () => { reads.describe[i].answer(pod); await settled() })
const fail = (i: number, error: Error) => act(async () => { reads.describe[i].fail(error); await settled() })

describe("a card's pod window", () => {
  it('opened from a box row reads the pod once, then Logs opens on the main container', async () => {
    await open(SHORT, 'logs')
    expect({ reads: reads.describe.map((r) => `${r.namespace}/${r.name}`), shown, container: view.selectedContainer, known: view.selectedPod?.containersKnown })
      .toEqual({ reads: ['shop/web-7d9f8c6b5-x2k4p'], shown: 'reading', container: '', known: false })
    await answer(0, FULL)
    expect({ reads: reads.describe.length, shown, container: view.selectedContainer, known: view.selectedPod?.containersKnown, containers: view.selectedPod?.containers.map((c) => c.name) })
      .toEqual({ reads: 1, shown: 'none', container: 'web', known: true, containers: ['istio-proxy', 'web'] })
  })

  it('opened from a full row (a live frame came) opens at once and reads nothing', async () => {
    await open(FULL, 'logs')
    expect({ reads: reads.describe.length, shown, container: view.selectedContainer, known: view.selectedPod?.containersKnown })
      .toEqual({ reads: 0, shown: 'none', container: 'web', known: true })
  })

  it("opened on Exec from a box row's menu waits for the read and takes the first container", async () => {
    await open(SHORT, 'exec')
    expect({ reads: reads.describe.length, shown, exec: view.execContainer }).toEqual({ reads: 1, shown: 'reading', exec: '' })
    await answer(0, FULL)
    expect({ tab: view.activeTab, exec: view.execContainer, shown }).toEqual({ tab: 'exec', exec: 'istio-proxy', shown: 'none' })
  })

  it('says a failed read, and does not fill from an answer read before it opened', async () => {
    await open(SHORT, 'logs')
    await fail(0, new Error('pods "web-7d9f8c6b5-x2k4p" is forbidden'))
    expect(typeof shown === 'object' && String(shown.error)).toBe('Error: pods "web-7d9f8c6b5-x2k4p" is forbidden')
    expect(view.selectedContainer).toBe('')
    // an older answer in the cache: opened again later, the window reads again and waits for that
    client.setQueryData(['pod-describe', 'shop', 'web-7d9f8c6b5-x2k4p'], FULL, { updatedAt: Date.now() - 60_000 })
    await act(async () => view.closeDetailModal())
    await open(SHORT, 'logs')
    expect({ reads: reads.describe.length, shown, container: view.selectedContainer }).toEqual({ reads: 2, shown: 'reading', container: '' })
    await answer(1, FULL)
    expect({ shown, container: view.selectedContainer }).toEqual({ shown: 'none', container: 'web' })
  })

  it('opened from a box row whose live frame came first uses the frame', async () => {
    const key = ['cluster-view', 'node-pods', 'n1', 'all']
    client.setQueryData(key, [SHORT])
    applyWatchFrames(client, key, [{ type: 'DATA', data: { type: 'MODIFIED', object: FULL } }])
    const [row] = client.getQueryData<unknown[]>(key) ?? []
    await open(row, 'logs')
    expect({ reads: reads.describe.length, container: view.selectedContainer }).toEqual({ reads: 0, container: 'web' })
  })

  it("opened on Exec after another pod's window, with Logs pressed before the read, keeps none of that pod's containers", async () => {
    await open(FULL, 'logs')
    expect(view.selectedContainer).toBe('web')
    await act(async () => { view.closeDetailModal(); await settled() })
    const db = { ...SHORT, name: 'db-0', labels: { app: 'db' } }
    await open(db, 'exec')
    expect({ logs: view.selectedContainer, exec: view.execContainer }).toEqual({ logs: '', exec: '' })
    // PodDetailTabs' Logs: the main container of a row with none is '', which leaves the one chosen
    await act(async () => {
      const main = pickMainContainer(view.selectedPod!)
      if (main) view.setSelectedContainer(main)
      view.selectTab('logs')
      await settled()
    })
    const dbContainers = [
      { name: 'postgres', image: 'example.test/postgres:17', ready: true, restart_count: 0, state: { running: { started_at: '' } } },
      { name: 'metrics', image: 'example.test/exporter:1', ready: true, restart_count: 0, state: { running: { started_at: '' } } },
    ]
    await answer(0, { ...FULL, name: 'db-0', containers: dbContainers })
    expect({ tab: view.activeTab, logs: view.selectedContainer, shown }).toEqual({ tab: 'logs', logs: 'postgres', shown: 'none' })
  })
})

describe('the rules', () => {
  it('a box row reads the pod, a full row does not', () => {
    expect([readsPod(podToDetail(SHORT)), readsPod(podToDetail(FULL)), readsPod(null)]).toEqual([true, false, false])
  })

  it("fills only from this pod's answer, keeps a container already chosen and chooses none for another tab", () => {
    const pod = podToDetail(SHORT)
    const at = (pod.openedAt ?? 0) + 1
    const read = (data: unknown, dataAt = at) => ({ data, dataAt, error: null, errorAt: 0 })
    expect(filledDetail(pod, read({ ...FULL, name: 'other' }), { activeTab: 'logs', selectedContainer: '', execContainer: '' })).toBeNull()
    expect(filledDetail(pod, read(FULL, at - 2), { activeTab: 'logs', selectedContainer: '', execContainer: '' })).toBeNull()
    const kept = filledDetail(pod, read(FULL), { activeTab: 'logs', selectedContainer: 'istio-proxy', execContainer: '' })
    expect({ container: kept?.container, known: kept?.pod.containersKnown }).toEqual({ container: undefined, known: true })
    const summary = filledDetail(pod, read(FULL), { activeTab: 'summary', selectedContainer: '', execContainer: '' })
    expect([summary?.container, summary?.execContainer, summary?.pod.containers.length]).toEqual([undefined, undefined, 2])
    // a container chosen that the pod does not have (another window's) is chosen anew
    const logs = filledDetail(pod, read(FULL), { activeTab: 'logs', selectedContainer: 'app', execContainer: '' })
    const exec = filledDetail(pod, read(FULL), { activeTab: 'exec', selectedContainer: '', execContainer: 'app' })
    expect([logs?.container, exec?.execContainer]).toEqual(['web', 'istio-proxy'])
  })
})
