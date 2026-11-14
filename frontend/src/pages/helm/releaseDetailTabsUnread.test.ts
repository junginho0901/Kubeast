import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import en from '@/i18n/locales/en.json'
import ko from '@/i18n/locales/ko.json'
import HelmReleaseDetailPage from './ReleaseDetail'

// A Helm release's History and Resources tabs told the floating chat 0 revisions or 0 objects while they read and when
// the read failed, and drew "No revision history." for a failure: a tab still reading tells no count, a failed or refused
// read is drawn and told with its reason, and 0 is for a read that answered empty.

// the tab a first render cannot click to
const start: { tab: 'history' | 'resources' } = { tab: 'history' }
vi.mock('react', async (importOriginal) => {
  const real = await importOriginal<typeof import('react')>()
  return { ...real, useState: (initial: unknown) => real.useState(initial === 'overview' ? start.tab : initial) }
})
vi.mock('@/components/ResourceDetailContext', () => ({ useResourceDetail: () => ({ open: () => {} }) }))
vi.mock('@/hooks/usePermission', () => ({ usePermission: () => ({ has: () => true }) }))
vi.mock('@/services/useHelmWatchList', () => ({ useHelmWatchList: () => {} }))
vi.mock('@/contexts/ClusterContext', () => ({ useCluster: () => ({ currentCluster: 'c1' }) }))
type Layer = { source?: string; summary?: string; data?: Record<string, any> }
const chat: { current: Layer | null } = { current: null }
// the page's own layer; the shared notices under it register theirs beside it
vi.mock('@/hooks/useAIContext', () => ({ useAIContext: (input: Layer | null) => { if (input && (input.source ?? 'base') === 'base') chat.current = input } }))

const i18n = i18next.createInstance()
beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en', fallbackLng: 'en', resources: { en: { translation: en }, ko: { translation: ko } }, interpolation: { escapeValue: false },
  })
})
beforeEach(() => { chat.current = null })

const NS = 'monitoring'
const NAME = 'kps'
const release = { name: NAME, namespace: NS, revision: 2, status: 'deployed', chart: 'kube-prometheus-stack', chartVersion: '1.2.0', appVersion: 'v2', updated: '2026-11-01T00:00:00Z', description: 'Upgrade complete' }
const failed = { response: { status: 500, data: { detail: 'reading the release storage timed out' } }, message: 'Request failed with status code 500' }
const refused = { response: { status: 403, data: { detail: 'secrets is forbidden: User "kubeast:user:7" cannot list resource "secrets"' } }, message: 'Request failed with status code 403' }
const KEY = { history: ['helm-history', NS, NAME], resources: ['helm-resources', NS, NAME] }

function open(tab: 'history' | 'resources', seed: (qc: QueryClient) => void, lng = 'en') {
  start.tab = tab
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false, staleTime: Infinity } } })
  qc.setQueryData(['helm-release', NS, NAME], release)
  seed(qc)
  const html = renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: [`/helm/releases/${NS}/${NAME}`] },
    createElement(I18nextProvider, { i18n: i18n.cloneInstance({ lng }) },
      createElement(QueryClientProvider, { client: qc },
        createElement(Routes, null, createElement(Route, { path: '/helm/releases/:namespace/:name', element: createElement(HelmReleaseDetailPage) }))))))
  return { html, layer: chat.current }
}
const fail = (key: unknown[], error: unknown) => (qc: QueryClient) => {
  const q = qc.getQueryCache().build(qc, { queryKey: key })
  q.setState({ ...q.state, status: 'error', error: error as Error, errorUpdatedAt: 1, errorUpdateCount: 1 })
}
const counted = (data: Record<string, any> | undefined) => Object.keys(data ?? {}).filter((k) => /^(history|resources)/.test(k)).sort()

describe.each(['history', 'resources'] as const)('the %s tab, drawn and told to the floating chat', (tab) => {
  it('tells no count while the tab reads', () => {
    const { html, layer } = open(tab, () => {})
    expect(html).toContain('animate-spin')
    expect(layer?.data?.active_tab).toBe(tab)
    expect(counted(layer?.data)).toEqual([])
  })

  it('draws and tells a failed read with its status and reason, never 0', () => {
    const { html, layer } = open(tab, fail(KEY[tab], failed))
    expect(html).toContain(`data-testid="helm-${tab}-read-failed"`)
    expect(html).toContain('Could not read the list: reading the release storage timed out')
    expect(html).not.toContain(tab === 'history' ? 'No revision history.' : 'No resources tracked for this release.')
    expect(counted(layer?.data)).toEqual([`${tab}_failed`])
    expect(layer?.data?.[`${tab}_failed`]).toEqual({ status: 500, reason: 'reading the release storage timed out' })
  })

  it('draws a refused read as the lists draw a refusal and tells it with the reason the server gave', () => {
    const { html, layer } = open(tab, fail(KEY[tab], refused))
    expect(html).toContain(`data-testid="helm-${tab}-refused"`)
    expect(html).toContain('You do not have permission to view Helm release in this cluster.')
    expect(html).not.toContain('Could not read the list')
    expect(counted(layer?.data)).toEqual([`${tab}_refused`])
    expect(layer?.data?.[`${tab}_refused`]).toBe(refused.response.data.detail)
  })

  it('says the refusal in Korean on a Korean screen', () => {
    const { html } = open(tab, fail(KEY[tab], refused), 'ko')
    expect(html).toContain('Helm release: 이 클러스터에서 볼 권한이 없습니다.')
    expect(html).not.toContain('목록을 읽지 못했습니다')
  })

  it('says the failure in Korean on a Korean screen', () => {
    expect(open(tab, fail(KEY[tab], failed), 'ko').html).toContain('목록을 읽지 못했습니다: reading the release storage timed out')
  })

  it('tells 0 for a read that answered empty, and draws its "None" text', () => {
    const { html, layer } = open(tab, (qc) => qc.setQueryData(KEY[tab], []))
    expect(html).toContain(tab === 'history' ? 'No revision history.' : 'No resources tracked for this release.')
    expect(layer?.data?.[`${tab}_total`]).toBe(0)
    expect(layer?.data?.[tab]).toEqual([])
  })
})

describe('a tab that answered', () => {
  it('History: the revisions and their count', () => {
    const { layer } = open('history', (qc) => qc.setQueryData(KEY.history, [
      { revision: 1, status: 'superseded', chartVersion: '1.1.0', appVersion: 'v1', updated: '2026-10-01T00:00:00Z', description: 'Install complete' },
      { revision: 2, status: 'deployed', chartVersion: '1.2.0', appVersion: 'v2', updated: '2026-11-01T00:00:00Z', description: 'Upgrade complete' },
    ]))
    expect(layer?.data?.history_total).toBe(2)
    expect(layer?.data?.history.map((h: { revision: number }) => h.revision)).toEqual([2, 1])
  })

  it('Resources: the objects and their count', () => {
    const { layer } = open('resources', (qc) => qc.setQueryData(KEY.resources, [{ kind: 'Deployment', apiVersion: 'apps/v1', name: 'kps-operator', namespace: NS }]))
    expect(layer?.data?.resources_total).toBe(1)
    expect(layer?.data?.resources).toEqual([{ kind: 'Deployment', api_version: 'apps/v1', name: 'kps-operator', namespace: NS }])
  })
})
