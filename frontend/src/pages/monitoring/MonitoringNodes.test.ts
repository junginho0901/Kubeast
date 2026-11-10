import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import en from '@/i18n/locales/en.json'
import ko from '@/i18n/locales/ko.json'
import MonitoringNodes from './MonitoringNodes'

// The Nodes tab says which of three things happened: the metrics could not be read (an error, retrying), the cluster
// gave none (metrics-server is missing or not answering) or the caller may not read them.

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

const KEY = ['node-metrics', 'c1']
const seeded = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } })
  qc.setQueryData(['nodes', 'c1'], [{ name: 'n1' }])
  return qc
}
const failed = (error: unknown, data?: unknown) => {
  const qc = seeded()
  if (data) qc.setQueryData(KEY, data)
  const q = qc.getQueryCache().build(qc, { queryKey: KEY })
  q.setState({ ...q.state, status: 'error', error: error as Error, errorUpdatedAt: Date.now(), errorUpdateCount: 1 })
  return qc
}
const render = (qc: QueryClient, lng = 'en') => renderToStaticMarkup(createElement(I18nextProvider, { i18n: i18n.cloneInstance({ lng }) },
  createElement(QueryClientProvider, { client: qc }, createElement(MonitoringNodes, { metricsUnavailable: false, onMetricsUnavailable: () => {} }))))

const httpError = (status: number, data?: unknown) => Object.assign(new Error(`HTTP ${status}`), { response: { status, data } })
const NOT_AVAILABLE = 'Node metrics are not available'
const FAILED = 'Failed to load node metrics'

describe('the Monitoring Nodes tab', () => {
  it('a gateway\'s 503 shows the failure and that it retries, not that the metrics are missing', () => {
    const html = render(failed(httpError(503, 'gateway temporarily unavailable')))
    expect(html).toContain(FAILED)
    expect(html).toContain('Retrying automatically')
    expect(html).not.toContain(NOT_AVAILABLE)
    expect(html).not.toContain('metrics-server is missing')
  })

  it('metrics-server not answering shows the failure with the server\'s reason', () => {
    const reason = 'get node metrics (status 503): the server is currently unable to handle the request (get nodes.metrics.k8s.io)'
    const html = render(failed(httpError(502, { detail: reason })))
    expect(html).toContain(FAILED)
    expect(html).toContain(reason)
    expect(html).not.toContain(NOT_AVAILABLE)
  })

  it('the failure is in the screen\'s language', () => {
    expect(render(failed(httpError(503)), 'ko')).toContain('Node 메트릭을 불러오는 중 오류가 발생했습니다')
  })

  it('an empty answer, the cluster without metrics-server, still says the metrics are not available', () => {
    const qc = seeded()
    qc.setQueryData(KEY, [])
    const html = render(qc)
    expect(html).toContain(NOT_AVAILABLE)
    expect(html).toContain('metrics-server is missing or not answering')
    expect(html).not.toContain(FAILED)
  })

  it('the answer that says metrics-server is missing says the metrics are not available', () => {
    const html = render(failed(Object.assign(new Error('metrics_unavailable'), { code: 'metrics_unavailable' })))
    expect(html).toContain(NOT_AVAILABLE)
    expect(html).not.toContain(FAILED)
  })

  it('a refused read still says the caller may not read them', () => {
    const html = render(failed(httpError(403)))
    expect(html).toContain('node-metrics-forbidden')
    expect(html).not.toContain(FAILED)
    expect(html).not.toContain(NOT_AVAILABLE)
  })

  it('a failed refresh keeps the last numbers on screen', () => {
    const html = render(failed(httpError(503), [{ name: 'n1', cpu: '100m', cpu_percent: '5%', memory: '10Mi', memory_percent: '1%' }]))
    expect(html).toContain('100m')
    expect(html).not.toContain(FAILED)
  })

  describe('numbers a refresh could not replace', () => {
    const NOW = new Date('2026-11-07T04:00:00Z').getTime()
    const ROWS = [{ name: 'n1', cpu: '100m', cpu_percent: '5%', memory: '10Mi', memory_percent: '1%', timestamp: '2026-11-07T03:59:15Z' }]
    const aged = (error: unknown) => {
      const qc = seeded()
      qc.setQueryData(KEY, ROWS, { updatedAt: NOW - 42_000 })
      if (error) {
        const q = qc.getQueryCache().find({ queryKey: KEY })!
        q.setState({ ...q.state, status: 'error', error: error as Error, errorUpdatedAt: NOW, errorUpdateCount: 1 })
      }
      return qc
    }
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'], now: NOW })
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    it('say that the refresh failed and how old they are', () => {
      const html = render(aged(httpError(503)))
      expect(html).toContain('data-testid="node-metrics-refresh-failed"')
      expect(html).toContain('Refresh failed. These values are from 42s ago.')
      expect(html).toContain('100m')
    })

    it('say so in the screen\'s language', () => {
      expect(render(aged(httpError(503)), 'ko')).toContain('새로고침에 실패했습니다. 42s 전 값입니다.')
    })

    it('give the server\'s reason when there is one', () => {
      expect(render(aged(httpError(502, { detail: 'the metrics API did not answer' })))).toContain('the metrics API did not answer')
    })

    it('stop saying it retries once metrics are off for this cluster', () => {
      const off = renderToStaticMarkup(createElement(I18nextProvider, { i18n: i18n.cloneInstance({ lng: 'en' }) },
        createElement(QueryClientProvider, { client: aged(httpError(503)) }, createElement(MonitoringNodes, { metricsUnavailable: true, onMetricsUnavailable: () => {} }))))
      expect(off).toContain('Refresh failed.')
      expect(off).not.toContain('Retrying automatically')
    })

    it('do not keep the green light', () => {
      expect(render(aged(null))).toContain('bg-green-500')
      expect(render(aged(httpError(503)))).not.toContain('bg-green-500')
    })

    it('tell the floating chat they are old, and from when', () => {
      render(aged(httpError(502, { detail: 'the metrics API did not answer' })))
      expect(chat.current?.summary).not.toContain('실시간')
      expect(chat.current?.data?.refresh_failed).toEqual({ values_from: '2026-11-07T03:59:18.000Z', reason: 'the metrics API did not answer' })
    })

    it('say nothing while the refresh works', () => {
      const html = render(aged(null))
      expect(html).not.toContain('node-metrics-refresh-failed')
      expect(html).not.toContain('Refresh failed')
      expect(chat.current?.summary).toContain('실시간')
      expect(chat.current?.data).not.toHaveProperty('refresh_failed')
    })
  })

  // A big cluster's nodes are a page at a time in a box sized to the screen, as the other lists, so the page does
  // not grow past it; the header's total and the floating chat stay about every node.
  describe('a cluster with more nodes than a screen holds', () => {
    const NODES = Array.from({ length: 30 }, (_, i) => ({
      name: `node-${String(i).padStart(2, '0')}`, cpu: `${100 + i}m`, cpu_percent: `${i}%`, memory: `${200 + i}Mi`, memory_percent: `${i + 1}%`,
    }))
    const many = () => {
      const qc = seeded()
      qc.setQueryData(['nodes', 'c1'], NODES.map((n) => ({ name: n.name })))
      qc.setQueryData(KEY, NODES)
      return qc
    }
    const footer = (html: string) => html.match(/data-testid="monitoring-node-pager"[\s\S]*?(Showing [^<]+|\d+개 중 [^<]+)/)?.[1] ?? null
    const opened = (html: string) => [...html.matchAll(/data-testid="monitoring-node"[\s\S]*?(node-\d{2})/g)].map((m) => m[1])

    it('draws one fitted page of nodes with the footer counting every node', () => {
      const html = render(many())
      // before the box is measured a fitted page is 12 rows (useAdaptiveRowsPerPage)
      expect({ nodes: opened(html), footer: footer(html) }).toEqual({ nodes: NODES.slice(0, 12).map((n) => n.name), footer: 'Showing 1-12 of 30' })
    })

    it('offers the rows-per-page choice of the other lists, in the screen\'s language', () => {
      const html = render(many(), 'ko')
      expect({ size: html.includes('data-testid="page-size"'), footer: footer(html) }).toEqual({ size: true, footer: '30개 중 1-12 표시' })
    })

    it('shows each node\'s usage as kubectl top prints it, and opens it from the keyboard too', () => {
      const html = render(many())
      const row = html.split('data-testid="monitoring-node"')[1] ?? ''
      expect(['100m', '0%', '200Mi', '1%'].every((v) => row.split('data-testid="monitoring-node"')[0].includes(`>${v}<`))).toBe(true)
      const opener = html.match(/<(\w+)[^>]*data-testid="monitoring-node"[^>]*>/)?.[0] ?? ''
      expect(opener.startsWith('<button') || opener.includes('tabindex="0"')).toBe(true)
    })

    it('keeps the total of every node in the header and tells the floating chat about all of them', () => {
      const html = render(many())
      expect(html).toContain('Total 30 nodes')
      expect(chat.current?.data?.pagination).toMatchObject({ total_count: 30 })
    })
  })
})
