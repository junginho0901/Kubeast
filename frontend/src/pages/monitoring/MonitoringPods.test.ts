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
  createElement(QueryClientProvider, { client: qc }, createElement(MonitoringPods, { pageNotice: false, onMetricsUnavailable: () => {}, namespaces: [{ name: 'shop' }] as never }))))

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

  // A namespace's pods are a page at a time in a box sized to the screen, as the other lists, so the page does not grow
  // past it; the cards and the floating chat stay about every pod.
  describe('with more pods than a screen holds', () => {
    const PODS = Array.from({ length: 70 }, (_, i) => ({ namespace: 'shop', name: `web-${String(i).padStart(2, '0')}`, cpu: '1m', memory: '1Mi', timestamp: '2026-11-07T03:59:15Z' }))
    const footer = (html: string) => html.match(/data-testid="monitoring-pod-pager"[\s\S]*?(Showing [^<]+|\d+개 중 [^<]+)/)?.[1] ?? null
    const listed = (html: string) => [...html.matchAll(/data-testid="monitoring-pod-row"[\s\S]*?(web-\d{2})/g)].map((m) => m[1])

    it('draws one fitted page of pods with the footer counting every pod', () => {
      const html = render(client(PODS, null))
      // before the box is measured a fitted page is 12 rows (useAdaptiveRowsPerPage)
      expect({ pods: listed(html), footer: footer(html) }).toEqual({ pods: PODS.slice(0, 12).map((p) => p.name), footer: 'Showing 1-12 of 70' })
    })

    it('offers the rows-per-page choice of the other lists, in the screen\'s language', () => {
      const html = render(client(PODS, null), 'ko')
      expect({ size: html.includes('data-testid="page-size"'), footer: footer(html) }).toEqual({ size: true, footer: '70개 중 1-12 표시' })
    })

    it('keeps the cards and the floating chat about every pod', () => {
      const html = render(client(PODS, null))
      const number = (label: string) => html.split(label)[1]?.match(/text-2xl[^>]*>([^<]*)</)?.[1]
      expect(number(en.monitoring.pods.totalPods)).toBe('70')
      expect(chat.current?.data?.pagination).toMatchObject({ total_count: 70 })
    })
  })

  it('a first read that fails still shows the failure, with no numbers to keep', () => {
    const html = render(client(null, httpError(503)))
    expect(html).toContain('Failed to load pod metrics')
    expect(html).not.toContain('pod-metrics-refresh-failed')
  })
})

// A read the cluster refused (403, the cluster's words in detail) is not a failure: the tab says so with that reason, keeps
// no numbers read before it and asks it no more on its 5 s, until it is opened again or another cluster or namespace is
// chosen, each a query of its own.
describe('a pod metrics read the cluster refused', () => {
  const REFUSED = 'pods.metrics.k8s.io is forbidden: User "u1" cannot list resource "pods" in API group "metrics.k8s.io" in the namespace "shop"'
  beforeEach(() => {
    picked.done = false
    vi.useFakeTimers({ toFake: ['Date'], now: NOW })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('says so in the cluster\'s words instead of a failure that retries', () => {
    const html = render(client(null, httpError(403, { detail: REFUSED })))
    expect(html).toContain('data-testid="pod-metrics-forbidden"')
    expect(html).toContain('You do not have permission to view metrics in this cluster.')
    expect(html).toContain(REFUSED.replace(/"/g, '&quot;'))
    expect(html).not.toContain('Failed to load pod metrics')
    expect(html).not.toContain('Retrying automatically')
  })

  it('shows no numbers read before it, nor a failed refresh', () => {
    const html = render(client(ROWS, httpError(403, { detail: REFUSED })))
    expect(html).toContain('data-testid="pod-metrics-forbidden"')
    expect(html).not.toContain('123m')
    expect(html).not.toContain('pod-metrics-refresh-failed')
    // the floating chat is told the refusal with the cluster's reason, and none of the old numbers
    expect(chat.current?.summary).toBe('Pod 모니터링 — shop 메트릭 볼 권한 없음')
    expect(chat.current?.data).toEqual({ tab: 'pods', filters: { namespace: 'shop' }, metrics_refused: { reason: REFUSED } })
  })

  it('is not asked again on the tab\'s 5 s, nor tried again; a failure is, as before', () => {
    read.options.length = 0
    render(client(null, null))
    const options = read.options.filter((o) => o.queryKey[0] === 'pod-metrics').at(-1)
    expect(options.queryKey).toEqual(KEY)
    expect(options.refetchInterval({ state: { error: httpError(403, { detail: REFUSED }) } })).toBe(false)
    expect(options.refetchInterval({ state: { error: httpError(503) } })).toBe(5000)
    expect([options.retry(0, httpError(403)), options.retry(0, httpError(503)), options.retry(2, httpError(503))]).toEqual([false, true, false])
  })
})

// The class of the innermost element that holds every one of the marked elements, read from the markup's tags.
function innermostHolding(html: string, testIds: string[]): string | null {
  const stack: { cls: string; found: Set<string> }[] = []
  for (const m of html.matchAll(/<(\/)?([a-zA-Z][\w-]*)([^>]*?)(\/)?>/g)) {
    const [, closing, tag, attrs, selfClosing] = m
    if (closing) {
      const top = stack.pop()
      if (!top) continue
      if (testIds.every((id) => top.found.has(id))) return top.cls
      top.found.forEach((id) => stack.at(-1)?.found.add(id))
      continue
    }
    const found = new Set(testIds.filter((id) => attrs.includes(`data-testid="${id}"`)))
    if (selfClosing || /^(input|img|br|hr)$/i.test(tag)) {
      found.forEach((id) => stack.at(-1)?.found.add(id))
      continue
    }
    stack.push({ cls: attrs.match(/class="([^"]*)"/)?.[1] ?? '', found })
  }
  return null
}

// Above the pod table sit the namespace picker, the search and the three cards: the picker and the search share one
// row of one height, so the table below keeps more of the screen's rows; nothing they said goes.
describe('what sits above the pod table', () => {
  beforeEach(() => {
    picked.done = false
    vi.useFakeTimers({ toFake: ['Date'], now: NOW })
  })
  afterEach(() => {
    vi.useRealTimers()
  })
  const heightOf = (html: string, testId: string) =>
    html.match(new RegExp(`<[^>]*data-testid="${testId}"[^>]*>`))?.[0].match(/class="[^"]*\b(h-\d+)\b/)?.[1] ?? null

  it('puts the namespace picker and the search on one row', () => {
    const row = innermostHolding(render(client(ROWS, null)), ['monitoring-namespace', 'monitoring-pod-search']) ?? ''
    expect({ row: /\bflex\b/.test(row), card: /\bcard\b/.test(row) }).toEqual({ row: true, card: false })
  })

  it('gives the picker and the search box one height, the list search boxes\' h-12', () => {
    const html = render(client(ROWS, null))
    expect([heightOf(html, 'monitoring-namespace'), heightOf(html, 'monitoring-pod-search')]).toEqual(['h-12', 'h-12'])
  })

  it('keeps the picker\'s label in its name, before the namespace it shows, in the screen\'s language', () => {
    const label = (html: string) => html.match(/<button[^>]*data-testid="monitoring-namespace"[^>]*>/)?.[0].match(/aria-label="([^"]*)"/)?.[1] ?? null
    expect(label(render(client(ROWS, null)))).toBe(`${en.monitoring.namespace.label}: shop`)
    picked.done = false
    expect(label(render(client(ROWS, null), 'ko'))).toBe(`${ko.monitoring.namespace.label}: shop`)
  })

  it('keeps the three cards with their labels and numbers', () => {
    const html = render(client(ROWS, null))
    const number = (label: string) => html.split(label)[1]?.match(/text-2xl[^>]*>([^<]*)</)?.[1]
    expect([number(en.monitoring.pods.totalPods), number(en.monitoring.pods.totalCpu), number(en.monitoring.pods.totalMemory)]).toEqual(['1', '123m', '45Mi'])
  })
})

// The floating chat is told what the tab draws where its rows go, never a count of usage the screen does not show, and the
// cards say no number the tab contradicts: an empty answer for one namespace ("No pods in … namespace", the cards at 0),
// for every namespace (not available, no cards), a failed read after an empty one, the answer that says metrics-server
// is missing, the page's notice and #900's not-served answer (404) each go as the tab says them.
describe('what the Pods tab tells the floating chat in place of rows', () => {
  const HINT = en.monitoring.metricsServerHint
  const NOT_AVAILABLE = en.monitoring.pods.unavailableAll
  const textOf = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ')
  const answered = (namespace: string, rows: unknown, error?: unknown) => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } })
    const key = ['pod-metrics', 'c1', namespace]
    if (rows) qc.setQueryData(key, rows)
    if (error) {
      const q = qc.getQueryCache().build(qc, { queryKey: key })
      q.setState({ ...q.state, status: 'error', error: error as Error, errorUpdatedAt: Date.now(), errorUpdateCount: 1 })
    }
    return qc
  }
  const renderOn = (namespace: string, qc: QueryClient, { notice = false, lng = 'en' } = {}) => {
    picked.done = false
    picked.namespace = namespace
    return renderToStaticMarkup(createElement(I18nextProvider, { i18n: i18n.cloneInstance({ lng }) },
      createElement(QueryClientProvider, { client: qc }, createElement(MonitoringPods, { pageNotice: notice, onMetricsUnavailable: () => {}, namespaces: [{ name: 'shop' }] as never }))))
  }
  const card = (html: string, label: string) => html.split(label)[1]?.match(/text-2xl[^>]*>([^<]*)</)?.[1]
  const saysWhatTheTabShows = (html: string, skip: string[] = []) => {
    const parts = (chat.current?.summary ?? '').split(' — ').filter((p) => !skip.includes(p))
    expect(parts.length).toBeGreaterThan(1)
    for (const part of parts) expect(textOf(html)).toContain(part)
    expect(chat.current?.summary).not.toContain('실시간')
  }
  beforeEach(() => { chat.current = null })
  afterEach(() => { picked.namespace = 'shop' })

  it('one namespace answered empty: "No pods in … namespace" and 0, as the tab and its cards say', () => {
    const html = renderOn('shop', answered('shop', []))
    expect(html).toContain('data-testid="pod-metrics-none-in-namespace"')
    expect(card(html, en.monitoring.pods.totalPods)).toBe('0')
    expect(chat.current?.data).toEqual({ tab: 'pods', filters: { namespace: 'shop' }, total_count: 0 })
    expect(chat.current?.summary).toBe(`${en.monitoring.pods.title} — No pods in shop namespace`)
    saysWhatTheTabShows(html)
  })

  it('every namespace answered empty: not available with its hint, and no cards at 0', () => {
    const html = renderOn('all', answered('all', []))
    expect(html).toContain('data-testid="pod-metrics-not-available"')
    expect(html).not.toContain(en.monitoring.pods.totalPods)
    expect(chat.current?.data).toEqual({ tab: 'pods', filters: { namespace: 'all' }, no_samples: true })
    expect(chat.current?.summary).toBe(`${en.monitoring.pods.title} — ${NOT_AVAILABLE} — ${HINT}`)
    saysWhatTheTabShows(html)
  })

  it('an empty answer, then a read that failed: the failure with its reason and no card of the empty answer', () => {
    const html = renderOn('shop', answered('shop', [], httpError(500, { detail: 'etcd timed out' })))
    expect(html).toContain('data-testid="pod-metrics-error"')
    expect(html).not.toContain(en.monitoring.pods.totalPods)
    expect(chat.current?.data).toEqual({ tab: 'pods', filters: { namespace: 'shop' }, metrics_error: { reason: 'etcd timed out' } })
    saysWhatTheTabShows(html)
  })

  it('the answer that says metrics-server is missing, on one namespace: not available, not "No pods"', () => {
    const html = renderOn('shop', answered('shop', null, httpError(503, { detail: 'metrics_unavailable' })))
    expect(html).toContain('data-testid="pod-metrics-not-available"')
    expect(html).not.toContain('No pods in shop namespace')
    expect(chat.current?.data).toEqual({ tab: 'pods', filters: { namespace: 'shop' }, metrics_unavailable: true })
    expect(chat.current?.summary).not.toContain(en.monitoring.metricsUnavailable)
    saysWhatTheTabShows(html)
  })

  it('the page\'s notice on: its words first, then the tab\'s, and no "No pods"', () => {
    const html = renderOn('shop', answered('shop', null, httpError(503, { detail: 'metrics_unavailable' })), { notice: true })
    expect(html).toContain('data-testid="pod-metrics-not-available"')
    expect(html).not.toContain('No pods in shop namespace')
    expect(chat.current?.summary).toBe(`${en.monitoring.pods.title} — ${en.monitoring.metricsUnavailable} — ${NOT_AVAILABLE} — ${HINT}`)
    saysWhatTheTabShows(html, [en.monitoring.metricsUnavailable])
  })

  it('#900\'s not-served answer (404): the layer is the block the tab draws for it, whichever the client reads it as', () => {
    const notServed = httpError(404, { detail: 'the server could not find the requested resource' })
    for (const qc of [answered('shop', null, notServed), answered('shop', [], notServed)]) {
      const html = renderOn('shop', qc)
      const drawn = html.includes('data-testid="pod-metrics-not-available"') ? 'not-available' : html.includes('data-testid="pod-metrics-error"') ? 'error' : 'other'
      expect(drawn).not.toBe('other')
      expect(html).not.toContain(en.monitoring.pods.totalPods)
      expect(chat.current?.data).toEqual(drawn === 'not-available'
        ? { tab: 'pods', filters: { namespace: 'shop' }, metrics_unavailable: true }
        : { tab: 'pods', filters: { namespace: 'shop' }, metrics_error: { reason: 'the server could not find the requested resource' } })
      saysWhatTheTabShows(html)
    }
  })

  it('says it in the screen\'s language', () => {
    renderOn('shop', answered('shop', []), { lng: 'ko' })
    expect(chat.current?.summary).toBe(`${ko.monitoring.pods.title} — shop Namespace에 Pod가 없습니다`)
  })

  it('tells nothing before a namespace is chosen', () => {
    renderOn('', answered('', null))
    expect(chat.current).toBeNull()
  })

  it('before a namespace is chosen, with the page\'s notice on: the notice, then the prompt the tab shows', () => {
    const html = renderOn('', answered('', null), { notice: true })
    expect(chat.current).toEqual({
      source: 'base',
      summary: `${en.monitoring.pods.title} — ${en.monitoring.metricsUnavailable} — ${en.monitoring.namespace.promptTitle} — ${en.monitoring.namespace.promptSubtitle}`,
      data: { tab: 'pods', filters: { namespace: '' }, metrics_unavailable: true },
    })
    saysWhatTheTabShows(html, [en.monitoring.metricsUnavailable])
    renderOn('', answered('', null), { notice: true, lng: 'ko' })
    expect(chat.current?.summary).toBe(`${ko.monitoring.pods.title} — ${ko.monitoring.metricsUnavailable} — ${ko.monitoring.namespace.promptTitle} — ${ko.monitoring.namespace.promptSubtitle}`)
  })
})
