import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import en from '@/i18n/locales/en.json'
import ko from '@/i18n/locales/ko.json'
import MonitoringPods from './MonitoringPods'

// The Pods tab asks nothing until a namespace is picked, which a first render cannot do: the picked namespace is the
// first empty text state the tab holds.
const picked = vi.hoisted(() => ({ done: false }))
vi.mock('react', async (importOriginal) => {
  const real = await importOriginal<typeof import('react')>()
  return {
    ...real,
    useState: (initial: unknown) => {
      if (initial === '' && !picked.done) {
        picked.done = true
        return ['shop', () => undefined]
      }
      return [typeof initial === 'function' ? (initial as () => unknown)() : initial, () => undefined]
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
