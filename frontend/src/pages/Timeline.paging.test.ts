import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import en from '@/i18n/locales/en.json'
import ko from '@/i18n/locales/ko.json'
import Timeline from './Timeline'

// Change History lists a window of up to 500 events and its rollouts. It shows them a page at a time in a box sized
// to the screen, with the footer every list has — not the first 50 and a button that adds 50 more under them — while
// the item count, the "newest 500 of N" note and what the floating chat is told stay about the whole window.

vi.mock('@/components/ResourceDetailContext', () => ({ useResourceDetail: () => ({ open: () => {} }) }))
const chat: { current: { summary?: string; data?: Record<string, any> } | null } = { current: null }
vi.mock('@/hooks/useAIContext', () => ({ useAIContext: (input: { summary?: string; data?: Record<string, any> } | null) => { chat.current = input } }))

const i18n = i18next.createInstance()
beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en', fallbackLng: 'en', resources: { en: { translation: en }, ko: { translation: ko } }, interpolation: { escapeValue: false },
  })
})

const START = Date.parse('2026-11-09T06:00:00Z')
const at = (minutes: number) => new Date(START - minutes * 60_000).toISOString()
const pad = (n: number) => String(n).padStart(3, '0')
// 500 events a minute apart and 23 rollouts between them: the newest item first is ev-000, then the rollout
// cause-000 half a minute later, and so on
const events = Array.from({ length: 500 }, (_, i) => ({
  timestamp: at(i), type: 'Normal' as const, reason: 'Pulled', message: `ev-${pad(i)}`, source: 'kubelet', count: 1,
  resource: { kind: 'Pod', name: `p-${i}`, namespace: 'shop' }, involved_object: { kind: 'Pod', name: `p-${i}`, namespace: 'shop' },
  first_seen: at(i), last_seen: at(i),
}))
const rollouts = Array.from({ length: 23 }, (_, i) => ({
  kind: 'Deployment', name: `web-${i}`, namespace: 'shop', revision: i + 1, change_cause: `cause-${pad(i)}`,
  created_at: at(i + 0.5), images: ['web:1'], replicas: 1,
}))
const timeline = {
  events, rollout_history: rollouts,
  summary: { total_events: 900, normal_count: 880, warning_count: 20, events_shown: 500, events_matching: 900 },
}
// the order the screen lists them in: newest first
const newest = [
  ...events.map((e, i) => ({ id: e.message, t: Date.parse(e.timestamp), i })),
  ...rollouts.map((r, i) => ({ id: r.change_cause, t: Date.parse(r.created_at), i })),
].sort((a, b) => b.t - a.t).map((x) => x.id)

const render = (lng = 'en') => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  qc.setQueryData(['timeline', '*', 24, 'all'], timeline)
  qc.setQueryData(['namespaces'], [{ name: 'shop' }])
  return renderToStaticMarkup(createElement(I18nextProvider, { i18n: i18n.cloneInstance({ lng }) },
    createElement(QueryClientProvider, { client: qc }, createElement(Timeline))))
}
// the items drawn, in order, by the message or change cause each one shows
const listed = (html: string) => [...html.matchAll(/(ev-\d{3}|cause-\d{3})/g)].map((m) => m[1])
const footer = (html: string) => html.match(/data-testid="timeline-pager"[\s\S]*?(Showing [^<]+|\d+개 중 [^<]+)/)?.[1] ?? null

describe('Change History', () => {
  it('draws one page of the window, the newest first, with the footer counting all of it', () => {
    const html = render()
    // before the box is measured a fitted page is 12 rows (useAdaptiveRowsPerPage)
    expect({ listed: listed(html), footer: footer(html), loadMore: html.includes('Load More') })
      .toEqual({ listed: newest.slice(0, 12), footer: 'Showing 1-12 of 523', loadMore: false })
  })

  it('offers the rows-per-page choice of the other lists', () => {
    expect(render().includes('data-testid="page-size"')).toBe(true)
  })

  it('sizes the page to the screen, so the list scrolls in its box and the page does not', () => {
    const root = render().match(/^<div class="([^"]*)"/)?.[1] ?? ''
    expect(root.split(' ')).toContain('h-[calc(100vh-4rem)]')
  })

  it('keeps the count of the whole window and the newest-500 note', () => {
    const html = render()
    expect(html).toContain('523 items (500 events · 23 rollouts)')
    expect(html).toContain('The newest 500 of the 900 events in this range are listed.')
  })

  it('says the footer in the screen\'s language', () => {
    expect(footer(render('ko'))).toBe('523개 중 1-12 표시')
  })

  it('tells the floating chat the newest items of the window, whichever page is open', () => {
    render()
    const items = (chat.current?.data?.recent_items ?? []) as { message?: string; cause?: string }[]
    expect(items.map((it) => it.message ?? it.cause)).toEqual(newest.slice(0, 15))
    expect(chat.current?.data?.stats).toMatchObject({ total_events: 900, listed_events: 500, events_matching: 900 })
  })
})
