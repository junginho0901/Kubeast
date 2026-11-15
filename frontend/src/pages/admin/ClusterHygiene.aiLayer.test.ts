import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import en from '@/i18n/locales/en.json'
import ko from '@/i18n/locales/ko.json'
import type { HygieneResponse } from '@/services/api/hygiene'
import ClusterHygiene from './ClusterHygiene'

// Cluster Hygiene told the floating chat nothing until its first scan had answered, so the chat had no screen data
// while the page read "Scanning...", and nothing when the scan failed: the first scan is told with the screen's
// sentence and no count, a failed one with the reason the page shows, and a report with its counts.

// the cluster the page picks after its first paint (an effect, which a server render does not run)
const pick = { cluster: '' }
vi.mock('react', async (importOriginal) => {
  const real = await importOriginal<typeof import('react')>()
  return {
    ...real,
    useState: (initial: unknown) => {
      if (initial === '' && pick.cluster) {
        const cluster = pick.cluster
        pick.cluster = ''
        return real.useState(cluster)
      }
      return real.useState(initial)
    },
  }
})
vi.mock('@/components/ResourceDetailContext', () => ({ useResourceDetail: () => ({ open: () => {} }) }))
vi.mock('@/contexts/ClusterContext', () => ({ useCluster: () => ({ currentCluster: 'c1' }) }))
vi.mock('@/hooks/usePermission', () => ({ usePermission: () => ({ has: () => true, namespacesOn: () => null }) }))
type Layer = { source?: string; summary?: string; data?: Record<string, any> }
const layers: Layer[] = []
// the page's own layer; the shared notices under it register theirs beside it
vi.mock('@/hooks/useAIContext', () => ({ useAIContext: (input: Layer | null) => { if (input && (input.source ?? 'base') === 'base') layers.push(input) } }))

const i18n = i18next.createInstance()
beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en', fallbackLng: 'en', resources: { en: { translation: en }, ko: { translation: ko } }, interpolation: { escapeValue: false },
  })
})
beforeEach(() => { layers.length = 0 })

const REPORT_KEY = ['hygiene', 'c1', 'report']
const answer: HygieneResponse = {
  cluster: 'c1', interval_days: 30, last_review: null, next_due: null, due: false,
  report: {
    generated_at: '2026-11-15T00:00:00Z', excluded_namespaces: [], counts: { critical: 2, warning: 1, info: 0, exempt: 0 },
    checks: [], findings: [], collectors: [],
  },
}
const failed = { response: { status: 500, data: { detail: 'listing pods timed out' } }, message: 'Request failed with status code 500' }

function open(seed: (qc: QueryClient) => void = () => {}): { html: string; layer: Layer | undefined } {
  pick.cluster = 'c1'
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false, staleTime: Infinity } } })
  qc.setQueryData(['clusters', 'all', true], [{ id: 'c1', display_name: 'c1' }])
  seed(qc)
  const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(I18nextProvider, { i18n }, createElement(QueryClientProvider, { client: qc }, createElement(ClusterHygiene)))))
  return { html, layer: layers[layers.length - 1] }
}
const counted = (data: Record<string, any> | undefined) => Object.keys(data ?? {}).filter((k) => /(^|_)(total|count|counts)$|^findings$/.test(k))

describe('Cluster Hygiene, told to the floating chat', () => {
  it('says the first scan with the sentence the page shows, and no count', () => {
    const { html, layer } = open()
    expect(html).toContain('Scanning...')
    expect(layer?.summary).toBe(`클러스터 정리 점검 — c1: ${ko.clusterHygiene.scanning}`)
    expect(layer?.data).toEqual({ cluster: 'c1', tab: 'findings', viewing_snapshot: false, scanning: true })
    expect(counted(layer?.data)).toEqual([])
  })

  it('says a scan that failed with the reason the page shows, and no count', () => {
    const { html, layer } = open((qc) => {
      const q = qc.getQueryCache().build(qc, { queryKey: REPORT_KEY })
      q.setState({ ...q.state, status: 'error', error: failed as unknown as Error, errorUpdatedAt: 1, errorUpdateCount: 1 })
    })
    expect(html).toContain('data-testid="hygiene-error"')
    expect(html).toContain('listing pods timed out')
    expect(html).not.toContain('Scanning...')
    expect(layer?.summary).toBe('클러스터 정리 점검 — c1: listing pods timed out')
    expect(layer?.data?.report_failed).toEqual({ status: 500, reason: 'listing pods timed out' })
    expect(counted(layer?.data)).toEqual([])
  })

  it('says a report with the counts its cards show', () => {
    const { html, layer } = open((qc) => qc.setQueryData(REPORT_KEY, answer))
    expect(html).toContain('data-testid="hygiene-summary"')
    expect(layer?.summary).toBe('클러스터 정리 점검 — c1: critical 2, warning 1, info 0, 예외 0')
    expect(layer?.data?.scanning).toBeUndefined()
    expect(layer?.data?.findings_total).toBe(3)
  })
})
