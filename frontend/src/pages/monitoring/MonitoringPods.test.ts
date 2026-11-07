import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import en from '@/i18n/locales/en.json'
import ko from '@/i18n/locales/ko.json'
import MonitoringPods from './MonitoringPods'

// The Pods tab asks nothing until a namespace is picked, which a first render cannot do: the picked namespace is the
// first empty text state the tab holds.
const picked = vi.hoisted(() => ({ done: false, namespace: 'shop' }))
vi.mock('react', async (importOriginal) => {
  const real = await importOriginal<typeof import('react')>()
  return {
    ...real,
    useState: (initial: unknown) => {
      if (initial === '' && !picked.done) {
        picked.done = true
        return [picked.namespace, () => undefined]
      }
      return [typeof initial === 'function' ? (initial as () => unknown)() : initial, () => undefined]
    },
  }
})
// the options the tab reads with, and a stand-in for what its one observer holds once the namespace has changed
const read = vi.hoisted(() => ({ options: [] as any[], answer: undefined as unknown }))
vi.mock('@tanstack/react-query', async (importOriginal) => {
  const real = await importOriginal<typeof import('@tanstack/react-query')>()
  return {
    ...real,
    useQuery: (options: unknown, client?: never) => {
      read.options.push(options)
      return read.answer ?? real.useQuery(options as never, client)
    },
  }
})
vi.mock('@/contexts/ClusterContext', () => ({ useCluster: () => ({ currentCluster: 'c1' }) }))
vi.mock('@/components/ResourceDetailContext', () => ({ useResourceDetail: () => ({ open: () => {} }) }))
const chat: { current: { summary?: string; data?: Record<string, unknown> } | null } = { current: null }
vi.mock('@/hooks/useAIContext', () => ({ useAIContext: (input: { summary?: string; data?: Record<string, unknown> } | null) => { chat.current = input } }))

const i18n = i18next.createInstance()
beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en', fallbackLng: 'en', resources: { en: { translation: en }, ko: { translation: ko } }, interpolation: { escapeValue: false },
  })
})

const NOW = new Date('2026-11-07T04:00:00Z').getTime()
const KEY = ['pod-metrics', 'c1', 'shop']
const ROWS = [{ namespace: 'shop', name: 'web-0', cpu: '123m', memory: '45Mi', timestamp: '2026-11-07T03:59:15Z' }]
const httpError = (status: number, data?: unknown) => Object.assign(new Error(`HTTP ${status}`), { response: { status, data } })

const client = (rows: unknown, error: unknown) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } })
  if (rows) qc.setQueryData(KEY, rows, { updatedAt: NOW - 42_000 })
  if (error) {
    const q = qc.getQueryCache().build(qc, { queryKey: KEY })
    q.setState({ ...q.state, status: 'error', error: error as Error, errorUpdatedAt: NOW, errorUpdateCount: 1 })
  }
  return qc
}
const render = (qc: QueryClient, lng = 'en') => renderToStaticMarkup(createElement(I18nextProvider, { i18n: i18n.cloneInstance({ lng }) },
  createElement(QueryClientProvider, { client: qc }, createElement(MonitoringPods, { metricsUnavailable: false, onMetricsUnavailable: () => {}, namespaces: [{ name: 'shop' }] as never }))))

describe('choosing another namespace on the Pods tab', () => {
  const WEB_ROWS = [{ namespace: 'web', name: 'front-0', cpu: '7m', memory: '8Mi', timestamp: '2026-11-07T03:59:15Z' }]
  const pick = (namespace: string) => {
    picked.done = false
    picked.namespace = namespace
  }

  // The tab's own options for each namespace through one observer, as one useQuery holds them across the change.
  async function changeNamespace(answer: () => Promise<unknown>) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    read.options.length = 0
    pick('shop')
    render(qc)
    const shop = read.options.at(-1)
    pick('web')
    render(qc)
    const web = read.options.at(-1)
    qc.clear()

    const observer = new QueryObserver<any>(qc, { ...shop, queryFn: async () => ROWS, refetchInterval: false })
    const stop = observer.subscribe(() => {})
    await vi.waitFor(() => expect(observer.getCurrentResult().data).toEqual(ROWS))
    observer.setOptions({ ...web, queryFn: answer, refetchInterval: false, retry: false })
    return { qc, observer, stop }
  }

  afterEach(() => {
    read.answer = undefined
    picked.namespace = 'shop'
    chat.current = null
  })

  it('shows no row, card number or chat layer of the namespace it left until the first answer', async () => {
    const { qc, observer, stop } = await changeNamespace(() => new Promise(() => {}))
    const waiting = observer.getCurrentResult()
    read.answer = waiting
    pick('web')
    const html = render(qc)
    expect({
      rows: waiting.data,
      loading: waiting.isLoading,
      rowOnScreen: html.includes('web-0'),
      numberOnScreen: html.includes('123m'),
      spinner: html.includes(en.monitoring.loading),
      chat: chat.current?.summary,
    }).toEqual({ rows: undefined, loading: true, rowOnScreen: false, numberOnScreen: false, spinner: true, chat: undefined })
    stop()
  })

  it('keeps the cards in their place while it waits, so the page below them does not jump', async () => {
    const { qc, observer, stop } = await changeNamespace(() => new Promise(() => {}))
    read.answer = observer.getCurrentResult()
    pick('web')
    const html = render(qc)
    const number = (label: string) => html.split(label)[1]?.match(/text-2xl[^>]*>([^<]*)</)?.[1]
    expect([number(en.monitoring.pods.totalPods), number(en.monitoring.pods.totalCpu), number(en.monitoring.pods.totalMemory)]).toEqual(['-', '-', '-'])
    stop()
  })

  it('shows the new namespace\'s rows and tells the chat them once they come', async () => {
    const { qc, observer, stop } = await changeNamespace(async () => WEB_ROWS)
    await vi.waitFor(() => expect(observer.getCurrentResult().data).toEqual(WEB_ROWS))
    read.answer = observer.getCurrentResult()
    pick('web')
    const html = render(qc)
    expect(html).toContain('front-0')
    expect(html).not.toContain('web-0')
    expect(chat.current?.summary).toContain('web 1개 Pod')
    expect(JSON.stringify(chat.current?.data)).toContain('front-0')
    expect(JSON.stringify(chat.current?.data)).not.toContain('web-0')
    stop()
  })

  it('goes back to a namespace it holds with its rows at once', async () => {
    const { qc, observer, stop } = await changeNamespace(() => new Promise(() => {}))
    qc.setQueryData(['pod-metrics', 'c1', 'web'], WEB_ROWS)
    expect(observer.getCurrentResult().data).toEqual(WEB_ROWS)
    expect(observer.getCurrentResult().isLoading).toBe(false)
    stop()
  })
})

describe('numbers a refresh of the Pods tab could not replace', () => {
  beforeEach(() => {
    picked.done = false
    vi.useFakeTimers({ toFake: ['Date'], now: NOW })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('stay on screen and say that the refresh failed and how old they are', () => {
    const html = render(client(ROWS, httpError(503)))
    expect(html).toContain('123m')
    expect(html).toContain('data-testid="pod-metrics-refresh-failed"')
    expect(html).toContain('Refresh failed. These values are from 42s ago.')
    expect(html).not.toContain('Failed to load pod metrics')
  })

  it('say so in the screen\'s language', () => {
    expect(render(client(ROWS, httpError(503)), 'ko')).toContain('새로고침에 실패했습니다. 42s 전 값입니다.')
  })

  it('give the server\'s reason when there is one', () => {
    expect(render(client(ROWS, httpError(502, { detail: 'the metrics API did not answer' })))).toContain('the metrics API did not answer')
  })

  it('do not keep the green light', () => {
    expect(render(client(ROWS, null))).toContain('bg-green-500')
    picked.done = false
    expect(render(client(ROWS, httpError(503)))).not.toContain('bg-green-500')
  })

  it('tell the floating chat they are old, and from when', () => {
    render(client(ROWS, httpError(503)))
    expect(chat.current?.summary).not.toContain('실시간')
    expect(chat.current?.data?.refresh_failed).toEqual({ values_from: '2026-11-07T03:59:18.000Z' })
  })

  it('say nothing while the refresh works', () => {
    const html = render(client(ROWS, null))
    expect(html).toContain('123m')
    expect(html).not.toContain('pod-metrics-refresh-failed')
    expect(chat.current?.summary).toContain('실시간')
    expect(chat.current?.data).not.toHaveProperty('refresh_failed')
  })

  it('a first read that fails still shows the failure, with no numbers to keep', () => {
    const html = render(client(null, httpError(503)))
    expect(html).toContain('Failed to load pod metrics')
    expect(html).not.toContain('pod-metrics-refresh-failed')
  })
})
