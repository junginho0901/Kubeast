import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import en from '@/i18n/locales/en.json'
import ko from '@/i18n/locales/ko.json'
import HelmReleaseDetailPage from './ReleaseDetail'

// On a Helm release's History tab the floating chat is told the newest revisions in the order the tab lists them,
// each with the chart and app version the history answer carries (chartVersion, appVersion), and how many there are.

// the tab a first render cannot click to: the page's tab state starts on History
vi.mock('react', async (importOriginal) => {
  const real = await importOriginal<typeof import('react')>()
  return { ...real, useState: (initial: unknown) => real.useState(initial === 'overview' ? 'history' : initial) }
})
vi.mock('@/components/ResourceDetailContext', () => ({ useResourceDetail: () => ({ open: () => {} }) }))
vi.mock('@/hooks/usePermission', () => ({ usePermission: () => ({ has: () => true }) }))
vi.mock('@/services/useHelmWatchList', () => ({ useHelmWatchList: () => {} }))
vi.mock('@/contexts/ClusterContext', () => ({ useCluster: () => ({ currentCluster: 'c1' }) }))
const chat: { current: { summary?: string; data?: Record<string, any> } | null } = { current: null }
vi.mock('@/hooks/useAIContext', () => ({ useAIContext: (input: { summary?: string; data?: Record<string, any> } | null) => { chat.current = input } }))

const i18n = i18next.createInstance()
beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en', fallbackLng: 'en', resources: { en: { translation: en }, ko: { translation: ko } }, interpolation: { escapeValue: false },
  })
})

const NS = 'monitoring'
const NAME = 'kps'
// 30 revisions in the release storage's order, oldest first; each upgrade moved the chart and the app on
const history = Array.from({ length: 30 }, (_, i) => ({
  revision: i + 1, status: i === 29 ? 'deployed' : 'superseded', chartVersion: `1.${i + 1}.0`, appVersion: `v${i + 1}`,
  updated: new Date(Date.parse('2026-11-01T00:00:00Z') + i * 3600_000).toISOString(), description: `Upgrade ${i + 1}`,
}))
const release = {
  name: NAME, namespace: NS, revision: 30, status: 'deployed', chart: 'kube-prometheus-stack', chartVersion: '1.30.0', appVersion: 'v30',
  updated: history[29].updated, description: 'Upgrade 30',
}

const render = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  qc.setQueryData(['helm-release', NS, NAME], release)
  qc.setQueryData(['helm-history', NS, NAME], history)
  return renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: [`/helm/releases/${NS}/${NAME}`] },
    createElement(I18nextProvider, { i18n: i18n.cloneInstance({ lng: 'en' }) },
      createElement(QueryClientProvider, { client: qc },
        createElement(Routes, null, createElement(Route, { path: '/helm/releases/:namespace/:name', element: createElement(HelmReleaseDetailPage) }))))))
}

describe('Helm release History tab, told to the floating chat', () => {
  it('carries the newest revisions first, as the tab lists them, with their chart and app versions', () => {
    render()
    const listed = ((chat.current?.data?.history ?? []) as Record<string, unknown>[]).map((h) => [h.revision, h.chart_version, h.app_version])
    expect(listed).toEqual(Array.from({ length: 20 }, (_, i) => [30 - i, `1.${30 - i}.0`, `v${30 - i}`]))
  })

  it('says how many revisions the release keeps beyond the ones it lists', () => {
    render()
    expect({ total: chat.current?.data?.history_total, tab: chat.current?.data?.active_tab }).toEqual({ total: 30, tab: 'history' })
  })

  it('keeps each revision\'s status, time and description', () => {
    render()
    expect((chat.current?.data?.history ?? [])[0]).toMatchObject({ revision: 30, status: 'deployed', updated: history[29].updated, description: 'Upgrade 30' })
  })
})
