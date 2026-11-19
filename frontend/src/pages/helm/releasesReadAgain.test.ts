import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import en from '@/i18n/locales/en.json'
import { api, type HelmReleaseSummary } from '@/services/api'
import { refreshList } from '@/hooks/useRefresh'
import HelmReleasesPage from './Releases'

// When the releases stream says it missed something, the page reads its list past the server's 30 s cache of it. That
// read went through react-query's fetchQuery, which gives a second fetch of a key the read already on its way: while the
// page's own read of the list (from that cache) was on its way, no read past the cache went out, and a release
// uninstalled outside Kubeast stayed on screen until the next Refresh.

vi.mock('@/hooks/useAdaptiveTable', () => ({ useAdaptiveTable: () => ({ containerRef: { current: null }, bodyRef: { current: null }, theadRef: { current: null }, firstRowRef: { current: null }, rowsPerPage: 20 }) }))
vi.mock('@/contexts/ClusterContext', () => ({ useCluster: () => ({ currentCluster: 'c1' }) }))
vi.mock('@/hooks/useAIContext', () => ({ useAIContext: () => {} }))
// the read the page gives the stream for its resync
const stream: { onResync?: () => void } = {}
vi.mock('@/services/useHelmWatchList', () => ({ useHelmWatchList: (options: { onResync?: () => void }) => { stream.onResync = options.onResync } }))

const i18n = i18next.createInstance()
beforeAll(async () => {
  await i18n.use(initReactI18next).init({ lng: 'en', fallbackLng: 'en', resources: { en: { translation: en } }, interpolation: { escapeValue: false } })
})

const KEY = ['helm-releases', 'c1', '']
const release = (name: string): HelmReleaseSummary => ({ name, namespace: 'apps', revision: 3, status: 'deployed', chart: 'podinfo', chartVersion: '6.7.0', appVersion: '6.7.0', updated: '2026-11-01T00:00:00Z' })
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// Each read of the list waits for its answer: past the cache (force_refresh) or from it.
type Read = { pastCache: boolean; answer: (rows: HelmReleaseSummary[]) => void }
let reads: Read[] = []
const waiting = (pastCache: boolean) => reads.filter((read) => read.pastCache === pastCache)
// the server's cache still holds db, which was uninstalled outside Kubeast; the cluster does not
const fromCache = () => [release('db'), release('web')]
const fromCluster = () => [release('web')]

function open() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(['namespaces'], [])
  client.setQueryData(KEY, fromCache())
  renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: ['/helm/releases'] },
    createElement(I18nextProvider, { i18n }, createElement(QueryClientProvider, { client }, createElement(HelmReleasesPage)))))
  // the page's list query as useQuery keeps it once drawn: its own read, never stale, its options given again on every
  // drawing (one comes as a read starts, isFetching)
  const options = { queryKey: KEY, queryFn: () => api.helm.listReleases(undefined), staleTime: Infinity }
  const observer = new QueryObserver(client, options)
  const stop = observer.subscribe(() => {})
  const names = () => (client.getQueryData(KEY) as HelmReleaseSummary[]).map((row) => row.name)
  return { client, observer, draw: () => observer.setOptions(options), stop, readAgain: stream.onResync!, names }
}

describe("the Helm Releases page's read after the stream's resync", () => {
  beforeEach(() => {
    reads = []
    stream.onResync = undefined
    vi.spyOn(api.helm, 'listReleases').mockImplementation((params) =>
      new Promise((resolve) => reads.push({ pastCache: params?.force_refresh === true, answer: resolve })))
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('reads past the cache once, and nothing else, when no read of the list is on its way', async () => {
    const page = open()
    page.readAgain()
    await sleep(5)
    expect(waiting(true)).toHaveLength(1)
    waiting(true)[0].answer(fromCluster())
    await sleep(5)

    expect(reads).toHaveLength(1)
    expect(page.names()).toEqual(['web'])
    page.stop()
  })

  it("reads past the cache after the page's own read that was on its way, which answers from the cache", async () => {
    const page = open()
    // the list's own read, on its way when the resync's read is asked for
    void page.observer.refetch()
    await sleep(5)
    page.readAgain()
    await sleep(5)
    waiting(false)[0].answer(fromCache())
    await sleep(5)
    for (const read of waiting(true)) read.answer(fromCluster())
    await sleep(5)

    expect(waiting(true), 'a read past the cache went out').toHaveLength(1)
    expect(page.names(), 'db, uninstalled outside Kubeast, is gone').toEqual(['web'])
    page.stop()
  })

  it("reads past the cache again when the page's own read took its place on the way", async () => {
    const page = open()
    page.readAgain()
    await sleep(5)
    page.draw()
    // the list asked for again while the resync's read is on its way: react-query stops that one and answers for it
    void page.client.invalidateQueries({ queryKey: KEY })
    await sleep(5)
    expect(waiting(false)).toHaveLength(1)
    // the read that gave way answers late, and its answer is not kept
    waiting(true)[0].answer(fromCluster())
    waiting(false)[0].answer(fromCache())
    await sleep(5)
    for (const read of waiting(true).slice(1)) read.answer(fromCluster())
    await sleep(5)

    expect(waiting(true), 'one more read past the cache').toHaveLength(2)
    expect(page.names()).toEqual(['web'])
    page.stop()
  })

  it("does not stop a Refresh on its way, and ends on a read past the cache", async () => {
    const page = open()
    const pressed = refreshList(page.client, KEY, () => api.helm.listReleases({ force_refresh: true }))
    await sleep(5)
    page.readAgain()
    await sleep(5)
    const refreshed = fromCluster()
    waiting(true)[0].answer(refreshed)
    expect(await pressed, "the Refresh ended on its own answer").toBe(refreshed)
    await sleep(5)
    for (const read of waiting(true).slice(1)) read.answer(fromCluster())
    await sleep(5)

    expect(waiting(false)).toHaveLength(0)
    expect(page.names()).toEqual(['web'])
    page.stop()
  })
})
