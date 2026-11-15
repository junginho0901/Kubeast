import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import en from '@/i18n/locales/en.json'
import type { PodPage } from '@/services/api'
import { useDashboardQueries } from './hooks/useDashboardQueries'
import { ResourceModal } from './modals/ResourceModal'

// The Dashboard's Pods window opened for one phase after another (or after every pod) drew the rows and count of the
// phase it left until the new answer came: the query kept the previous key's answer as a success, and the window
// draws rows when not loading. Another phase, search or cluster now waits as on first open; a page and a refresh do not.

const read = vi.hoisted(() => ({ options: [] as any[], cluster: 'c1' }))
vi.mock('@tanstack/react-query', async (importOriginal) => {
  const real = await importOriginal<typeof import('@tanstack/react-query')>()
  return {
    ...real,
    useQuery: (options: any, client?: never) => {
      read.options.push(options)
      return real.useQuery(options, client)
    },
  }
})
vi.mock('@/contexts/ClusterContext', () => ({ useCluster: () => ({ currentCluster: read.cluster }) }))
vi.mock('@/components/ModalOverlay', () => ({ ModalOverlay: ({ children }: { children: ReactNode }) => children }))
vi.mock('@/components/ResourceDetailContext', () => ({ useResourceDetail: () => ({ open: () => {} }) }))
vi.mock('@/hooks/useAIContext', () => ({ useAIContext: () => {} }))

const i18n = i18next.createInstance()
beforeAll(async () => {
  await i18n.use(initReactI18next).init({ lng: 'en', resources: { en: { translation: en } }, interpolation: { escapeValue: false } })
})

interface Window { status: string | null; q?: string; page?: number; cluster?: string }

// The options the dashboard reads the window's page with, for one phase, search, page and cluster.
function podPageOptions(w: Window) {
  read.options.length = 0
  read.cluster = w.cluster ?? 'c1'
  const Probe = () => {
    useDashboardQueries({
      selectedResourceType: 'pods', selectedPodStatus: w.status, isIssuesModalOpen: false, issuesWindowMinutes: null,
      includeRestartHistory: false, isStorageModalOpen: false, isOptimizationModalOpen: false, optimizationNamespace: '',
      storageActiveTab: 'pvcs', podQuery: { q: w.q ?? '', page: w.page ?? 1 },
    })
    return null
  }
  renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(Probe)))
  const options = read.options.find((o) => o.queryKey[0] === 'dashboard-pods-page')
  expect(options, 'the window\'s query').toBeDefined()
  return options
}

const pageOf = (phase: string, names: string[]): PodPage => ({
  items: names.map((name) => ({ name, namespace: 'shop', phase, status: phase === 'Succeeded' ? 'Completed' : phase, ready: '0/1', restart_count: 0, node_name: 'node-1' })) as never,
  total: names.length,
  stats: { total: 6 } as never,
  revision: 'r1',
  source: 'index',
})
const EVERY = pageOf('Running', ['web-0', 'web-1', 'web-2'])
const FAILED = pageOf('Failed', ['job-failed-0'])
const SUCCEEDED = pageOf('Succeeded', ['job-done-0', 'job-done-1'])

// One observer across the windows, as the dashboard's one useQuery holds them; each answer held until given.
function dashboard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const held = new Map<string, (page: PodPage) => void>()
  let observer: QueryObserver<PodPage> | null = null
  let stop = () => {}
  const open = (w: Window) => {
    const options = podPageOptions(w)
    const key = JSON.stringify(options.queryKey)
    const own = { ...options, queryFn: () => new Promise<PodPage>((resolve) => held.set(key, resolve)), refetchInterval: false }
    if (!observer) {
      observer = new QueryObserver<PodPage>(client, own)
      stop = observer.subscribe(() => {})
    } else observer.setOptions(own)
    return observer.getCurrentResult()
  }
  const answer = async (w: Window, page: PodPage) => {
    const key = JSON.stringify(podPageOptions(w).queryKey)
    await vi.waitFor(() => expect(held.has(key), `asked ${key}`).toBe(true))
    held.get(key)!(page)
    held.delete(key)
    await vi.waitFor(() => expect(observer!.getCurrentResult().data).toEqual(page))
  }
  return { open, answer, now: () => observer!.getCurrentResult(), refetch: () => void observer!.refetch(), stop: () => stop() }
}

// The window as DashboardBody hands it the query's result (isLoadingPods, podPage).
function windowOf(result: { isLoading: boolean; data?: PodPage }) {
  return renderToStaticMarkup(createElement(I18nextProvider, { i18n }, createElement(ResourceModal, {
    selectedResourceType: 'pods', onClose: () => {}, selectedStat: undefined,
    isLoading: result.isLoading, resourceCount: result.data?.stats.total ?? 0,
    searchQuery: '', setSearchQuery: () => {}, filteredResources: result.data?.items ?? [],
    serverPage: { total: result.data?.total ?? 0, page: 1, setPage: () => {} },
  })))
}
const rowNames = (html: string) => [...html.matchAll(/<h3 class="font-medium text-ink">([^<]*)<\/h3>/g)].map((m) => m[1])
const totalLine = (html: string) => html.match(/data-testid="resource-modal-total">([^<]*)</)?.[1]

describe('the Dashboard Pods window chosen by phase', () => {
  it('shows no row or count of every pod while the first Failed answer is on its way, and the Failed rows after it', async () => {
    const d = dashboard()
    d.open({ status: null })
    await d.answer({ status: null }, EVERY)
    expect(rowNames(windowOf(d.now()))).toEqual(['web-0', 'web-1', 'web-2'])

    const waiting = d.open({ status: 'Failed' })
    const html = windowOf(waiting)
    expect({ rows: rowNames(html), total: totalLine(html), loading: html.includes(en.dashboard.loading), pending: waiting.isLoading },
      'while the Failed answer is held').toEqual({ rows: [], total: en.dashboard.resourceModal.loading, loading: true, pending: true })

    await d.answer({ status: 'Failed' }, FAILED)
    const after = windowOf(d.now())
    expect({ rows: rowNames(after), total: totalLine(after) }, 'after the answer').toEqual({ rows: ['job-failed-0'], total: '1 of 6' })
    d.stop()
  })

  it('shows only the phase chosen going Failed, Succeeded and back, its own rows coming from the cache', async () => {
    const d = dashboard()
    d.open({ status: 'Failed' })
    await d.answer({ status: 'Failed' }, FAILED)

    const waiting = windowOf(d.open({ status: 'Succeeded' }))
    expect(rowNames(waiting), 'while the Succeeded answer is held').toEqual([])
    expect(totalLine(waiting)).toBe(en.dashboard.resourceModal.loading)
    await d.answer({ status: 'Succeeded' }, SUCCEEDED)
    expect(rowNames(windowOf(d.now()))).toEqual(['job-done-0', 'job-done-1'])

    // Failed was answered before: its rows, never Succeeded's, while it is read again
    const back = d.open({ status: 'Failed' })
    expect({ rows: rowNames(windowOf(back)), placeholder: back.isPlaceholderData }).toEqual({ rows: ['job-failed-0'], placeholder: false })
    d.stop()
  })

  it('waits for a search or another cluster as for another phase', async () => {
    const d = dashboard()
    d.open({ status: null })
    await d.answer({ status: null }, EVERY)
    expect(rowNames(windowOf(d.open({ status: null, q: 'job' }))), 'another search').toEqual([])
    await d.answer({ status: null, q: 'job' }, FAILED)
    expect(rowNames(windowOf(d.open({ status: null, q: 'job', cluster: 'c2' }))), 'another cluster').toEqual([])
    d.stop()
  })

  it('keeps the rows while another page of the same phase loads', async () => {
    const d = dashboard()
    d.open({ status: null })
    await d.answer({ status: null }, EVERY)

    const turning = d.open({ status: null, page: 2 })
    expect({ rows: rowNames(windowOf(turning)), pending: turning.isLoading }, 'while page 2 is held').toEqual({ rows: ['web-0', 'web-1', 'web-2'], pending: false })
    await d.answer({ status: null, page: 2 }, pageOf('Running', ['web-50']))
    expect(rowNames(windowOf(d.now()))).toEqual(['web-50'])
    d.stop()
  })

  it('keeps the rows while the same window is read again', async () => {
    const d = dashboard()
    d.open({ status: 'Failed' })
    await d.answer({ status: 'Failed' }, FAILED)

    d.refetch()
    await vi.waitFor(() => expect(d.now().isFetching).toBe(true))
    expect({ rows: rowNames(windowOf(d.now())), pending: d.now().isLoading }, 'while the refresh is held').toEqual({ rows: ['job-failed-0'], pending: false })
    await d.answer({ status: 'Failed' }, pageOf('Failed', ['job-failed-0', 'job-failed-1']))
    expect(rowNames(windowOf(d.now()))).toEqual(['job-failed-0', 'job-failed-1'])
    d.stop()
  })
})
