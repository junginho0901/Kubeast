import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import en from '@/i18n/locales/en.json'
import type { AlertSilence } from '@/services/api/alertInbox'
import SilenceList from './SilenceList'
import { MarkdownTable } from '@/components/MarkdownTable'

// Alerts → Silences lists every silence the store holds for this cluster, its own and the store's others, which a
// store shared by teams keeps by the hundred: the tab pages them with the list footer every list has, as the inbox
// beside it does, instead of a card that scrolls every row. A table in an AI answer holds what the answer wrote and
// is marked so the list guard does not ask it for a footer.

vi.mock('@/contexts/ClusterContext', () => ({ useCluster: () => ({ currentCluster: 'self' }) }))
vi.mock('@/hooks/useAIContext', () => ({ useAIContext: () => {} }))
vi.mock('@/services/confirm', () => ({ useConfirm: () => async () => false }))

const i18n = i18next.createInstance()
beforeAll(async () => {
  await i18n.use(initReactI18next).init({ lng: 'en', resources: { en: { translation: en } }, interpolation: { escapeValue: false } })
})

const silence = (i: number): AlertSilence => ({
  id: `s${String(i).padStart(3, '0')}`, state: 'active', scope: i % 4 ? 'cluster' : 'all', matchers: [`alertname="A${i}"`],
  createdBy: 'ops@example.com', startsAt: '2026-11-13T00:00:00Z', endsAt: '2026-11-14T00:00:00Z',
})

const render = (silences: AlertSilence[]) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } })
  qc.setQueryData(['alert-inbox', 'silences', 'self'], silences)
  return renderToStaticMarkup(createElement(I18nextProvider, { i18n }, createElement(QueryClientProvider, { client: qc }, createElement(SilenceList, { canExpire: true }))))
}
const rows = (html: string) => [...html.matchAll(/data-testid="silence-row-([^"]+)"/g)].map((m) => m[1])

describe('Alerts → Silences', () => {
  it('shows one page of 120 silences and a footer that counts them all', () => {
    const all = Array.from({ length: 120 }, (_, i) => silence(i))
    const html = render(all)
    const shown = rows(html)
    expect(shown.length).toBeGreaterThan(0)
    expect(shown.length).toBeLessThan(all.length)
    expect(shown).toEqual(all.slice(0, shown.length).map((s) => s.id))
    expect(html).toMatch(new RegExp(`data-testid="silences-pager"[^>]*data-rows-per-page="${shown.length}"`))
    expect(html).toContain(`Showing 1-${shown.length} of 120`)
  })

  it('keeps the footer with no silences, as every list does', () => {
    const html = render([])
    expect(rows(html)).toEqual([])
    expect(html).toContain('data-testid="silences-pager"')
    expect(html).toContain('Showing 0 of 0')
  })
})

describe('a table in an AI answer', () => {
  it('says why it takes no list footer', () => {
    const html = renderToStaticMarkup(createElement(MarkdownTable, { children: createElement('tbody') }))
    expect(html).toMatch(/data-testid="chat-table" data-list-bounded="the rows one AI answer wrote"/)
  })
})
