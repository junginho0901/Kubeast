import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import en from '@/i18n/locales/en.json'
import ko from '@/i18n/locales/ko.json'
import HelmReleasesPage from './Releases'

// The Helm Releases list tells the floating chat what it shows, as the other lists do: the rows of the page, the page and
// the cards' counts once read, zero for a list read empty, nothing while it loads, and the refusal or the failure with
// its reason. A failure with no rows drew "No Helm releases"; it says it could not read them.

vi.mock('@/hooks/useAdaptiveTable', () => ({ useAdaptiveTable: () => ({ containerRef: { current: null }, bodyRef: { current: null }, theadRef: { current: null }, firstRowRef: { current: null }, rowsPerPage: 2 }) }))
vi.mock('@/services/useHelmWatchList', () => ({ useHelmWatchList: () => {} }))
vi.mock('@/contexts/ClusterContext', () => ({ useCluster: () => ({ currentCluster: 'c1' }) }))
type Layer = { source?: string; summary?: string; data?: Record<string, any> }
const chat: { current: Layer | null } = { current: null }
// the page's own layer: the shared notices it draws (RefreshFailure) register theirs through the same hook
vi.mock('@/hooks/useAIContext', () => ({ useAIContext: (input: Layer | null) => { if (input?.source === 'base') chat.current = input } }))

const i18n = i18next.createInstance()
beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en', fallbackLng: 'en', resources: { en: { translation: en }, ko: { translation: ko } }, interpolation: { escapeValue: false },
  })
})
beforeEach(() => { chat.current = null })

const KEY = ['helm-releases', 'c1', '']
const release = (name: string, status: string) => ({ name, namespace: 'apps', revision: 3, status, chart: 'podinfo', chartVersion: '6.7.0', appVersion: '6.7.0', updated: '2026-11-01T00:00:00Z' })
const refused = { response: { status: 403, data: { detail: 'secrets is forbidden: User "kubeast:user:7" cannot list resource "secrets"' } }, message: 'Request failed with status code 403' }
const failed = { response: { status: 500, data: { detail: 'listing the release Secrets timed out' } }, message: 'Request failed with status code 500' }

function open(seed: (qc: QueryClient) => void, lng = 'en') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false, staleTime: Infinity } } })
  qc.setQueryData(['namespaces'], [])
  seed(qc)
  const html = renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: ['/helm/releases'] },
    createElement(I18nextProvider, { i18n: i18n.cloneInstance({ lng }) }, createElement(QueryClientProvider, { client: qc }, createElement(HelmReleasesPage)))))
  return { html, layer: chat.current }
}
const fail = (error: unknown) => (qc: QueryClient) => {
  const q = qc.getQueryCache().build(qc, { queryKey: KEY })
  q.setState({ ...q.state, status: 'error', error: error as Error, errorUpdatedAt: 1, errorUpdateCount: 1 })
}

describe('Helm Releases, told to the floating chat', () => {
  it('tells nothing while the list loads', () => {
    open(() => {})
    expect(chat.current).toBeNull()
  })

  it('tells a refused list as refused, with the server\'s reason and no count', () => {
    const { html, layer } = open(fail(refused))
    expect(html).toContain('data-testid="helm-forbidden"')
    expect(layer?.data).toEqual({ filters: { namespace: undefined, search: undefined }, refused: refused.response.data.detail })
    expect(layer?.summary).toBe(`전체 네임스페이스 Helm Release — 볼 권한 없음: ${refused.response.data.detail}`)
  })

  it('draws and tells a failed list with its reason, not "No Helm releases" or 0', () => {
    const { html, layer } = open(fail(failed))
    expect(html).toContain('data-testid="helm-read-failed"')
    expect(html).toContain('Could not read the list: listing the release Secrets timed out')
    expect(html).not.toContain('No Helm releases')
    expect(layer?.data?.failed).toEqual({ status: 500, reason: 'listing the release Secrets timed out' })
    expect(layer?.data?.stats).toBeUndefined()
    expect(layer?.summary).toBe('전체 네임스페이스 Helm Release — 불러오지 못함: listing the release Secrets timed out')
    expect(open(fail(failed), 'ko').html).toContain('목록을 읽지 못했습니다: listing the release Secrets timed out')
  })

  it('registers zero for a list read empty', () => {
    const { html, layer } = open((qc) => qc.setQueryData(KEY, []))
    expect(html).toContain('No Helm releases')
    expect(layer?.data?.stats).toEqual({ total: 0, deployed: 0, failed: 0, pending: 0, superseded: 0 })
    expect(layer?.data?.pagination?.total_count).toBe(0)
    expect(layer?.data?.visible_items).toEqual([])
  })

  it('carries the page on screen with its columns, the page and the cards\' counts', () => {
    const rows = [release('a', 'deployed'), release('b', 'failed'), release('c', 'pending-upgrade'), release('d', 'superseded'), release('e', 'deployed')]
    const { layer } = open((qc) => qc.setQueryData(KEY, rows))
    expect(layer?.data?.stats).toEqual({ total: 5, deployed: 2, failed: 1, pending: 1, superseded: 1 })
    expect(layer?.data?.pagination).toMatchObject({ current_page: 1, total_pages: 3, page_size: 2, total_count: 5, showing_count: 2 })
    expect(layer?.data?.visible_items).toEqual([
      { name: 'a', namespace: 'apps', revision: 3, status: 'deployed', chart: 'podinfo', chart_version: '6.7.0', app_version: '6.7.0', updated: '2026-11-01T00:00:00Z' },
      { name: 'b', namespace: 'apps', revision: 3, status: 'failed', chart: 'podinfo', chart_version: '6.7.0', app_version: '6.7.0', updated: '2026-11-01T00:00:00Z' },
    ])
    expect(layer?.data?.problematic_items?.map((r: { name: string }) => r.name)).toEqual(['b'])
    expect(layer?.summary).toBe('⚠️ 전체 네임스페이스 Helm Release 5개 (deployed 2, pending 1, failed 1, superseded 1)')
  })
})
