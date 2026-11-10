import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import en from '@/i18n/locales/en.json'
import ko from '@/i18n/locales/ko.json'
import ResourcesTab from './ResourcesTab'
import HistoryTab from './HistoryTab'

// A Helm release's Resources and History tabs hold what the chart made and every revision kept — hundreds for a big
// chart or a release with no history limit. Each shows a page at a time with the footer every list has.

vi.mock('@/components/ResourceDetailContext', () => ({ useResourceDetail: () => ({ open: () => {} }) }))
vi.mock('@/hooks/usePermission', () => ({ usePermission: () => ({ has: () => true }) }))

const i18n = i18next.createInstance()
beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en', fallbackLng: 'en', resources: { en: { translation: en }, ko: { translation: ko } }, interpolation: { escapeValue: false },
  })
})

const NS = 'monitoring'
const NAME = 'kps'
const pad = (n: number) => String(n).padStart(3, '0')
const resources = Array.from({ length: 300 }, (_, i) => ({ kind: 'ConfigMap', apiVersion: 'v1', name: `res-${pad(i)}`, namespace: NS }))
// the release storage's order, oldest first: the tab lists the newest first
const history = Array.from({ length: 120 }, (_, i) => ({
  revision: i + 1, status: i === 119 ? 'deployed' : 'superseded', chartVersion: '1.0.0', appVersion: '1.0.0',
  updated: new Date(Date.parse('2026-11-01T00:00:00Z') + i * 3600_000).toISOString(), description: `upgrade ${pad(i + 1)}`,
}))

const render = (tab: 'resources' | 'history', lng = 'en') => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  qc.setQueryData(['helm-resources', NS, NAME], resources)
  qc.setQueryData(['helm-history', NS, NAME], history)
  const body = tab === 'resources'
    ? createElement(ResourcesTab, { namespace: NS, name: NAME })
    : createElement(HistoryTab, { namespace: NS, name: NAME, currentRevision: 120 })
  return renderToStaticMarkup(createElement(I18nextProvider, { i18n: i18n.cloneInstance({ lng }) }, createElement(QueryClientProvider, { client: qc }, body)))
}
const footer = (html: string, id: string) => html.match(new RegExp(`data-testid="${id}"[\\s\\S]*?(Showing [^<]+|\\d+개 중 [^<]+)`))?.[1] ?? null

describe('Helm release Resources tab', () => {
  it('draws one page of the release\'s objects in the order the server gave, with the footer counting all of them', () => {
    const html = render('resources')
    const names = [...html.matchAll(/>(res-\d{3})</g)].map((m) => m[1])
    // before the box is measured a fitted page is 12 rows (useAdaptiveRowsPerPage)
    expect({ names, footer: footer(html, 'helm-resources-pager') })
      .toEqual({ names: resources.slice(0, 12).map((r) => r.name), footer: 'Showing 1-12 of 300' })
  })

  it('offers the rows-per-page choice of the other lists, in the screen\'s language', () => {
    const html = render('resources', 'ko')
    expect({ size: html.includes('data-testid="page-size"'), footer: footer(html, 'helm-resources-pager') }).toEqual({ size: true, footer: '300개 중 1-12 표시' })
  })
})

describe('Helm release History tab', () => {
  it('draws one page of revisions, the newest first, with the footer counting every revision', () => {
    const html = render('history')
    const revisions = [...html.matchAll(/upgrade (\d{3})/g)].map((m) => Number(m[1]))
    expect({ revisions, footer: footer(html, 'helm-history-pager') })
      .toEqual({ revisions: Array.from({ length: 12 }, (_, i) => 120 - i), footer: 'Showing 1-12 of 120' })
  })

  it('keeps the rollback button on every revision but the current one', () => {
    const html = render('history')
    const rollbacks = html.split(en.helmReleaseDetail.rollback.button).length - 1
    expect(rollbacks).toBe(11)
  })
})
