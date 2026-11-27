import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import en from '../../i18n/locales/en.json'
import ko from '../../i18n/locales/ko.json'
import { client } from '../../services/api/client'
import { alertInboxApi, type PastInvestigation } from '../../services/api/alertInbox'
import source from './AlertInbox.tsx?raw'
import { PastInvestigations } from './PastInvestigations'

const i18n = i18next.createInstance()
beforeAll(async () => {
  await i18n.use(initReactI18next).init({ lng: 'en', resources: { en: { translation: en }, ko: { translation: ko } }, interpolation: { escapeValue: false } })
})

const ITEMS: PastInvestigation[] = [
  {
    id: 'inv-2', received_at: '2026-11-23T02:00:00Z', outcome: 'cause_found', causes_total: 4,
    causes: [
      { resource: 'CronJob/shop/notify', kind: 'dependency_slow', verified: true },
      { resource: 'Pod/shop/<EMAIL_1>', kind: 'crash', verified: false },
      { resource: 'ConfigMap/shop/<b>x</b>', kind: '', verified: null },
    ],
  },
  { id: 'inv-1', received_at: '2026-11-20T02:00:00Z', outcome: 'cannot_tell', causes_total: 0, causes: [] },
  { id: 'inv-0', received_at: '2026-11-18T02:00:00Z', outcome: null, causes_total: 0, causes: [] },
]

const render = async (items: PastInvestigation[] | null, lng = 'en') => {
  await i18n.changeLanguage(lng)
  return renderToStaticMarkup(createElement(I18nextProvider, { i18n }, createElement(PastInvestigations, { items, onOpen: () => {} })))
}

describe("the alert window's past investigations", () => {
  it('draws each with when, its outcome, its causes and a button for its report, in the order the server gives', async () => {
    const html = await render(ITEMS)
    const rows = html.split('<li ').slice(1)
    expect(rows.map((r) => r.match(/data-testid="alert-past-(inv-\d)"/)?.[1])).toEqual(['inv-2', 'inv-1', 'inv-0'])
    expect(rows[0]).toContain('data-outcome="cause_found">Cause found<')
    expect(rows[0]).toContain('CronJob/shop/notify')
    expect(rows[0]).toContain('dependency_slow')
    expect(rows[0].match(/Checked by the server/g)).toHaveLength(1)
    expect(rows[0].match(/Not verified/g)).toHaveLength(1)
    expect(rows[0]).toContain('+1 more')
    expect(rows[1]).toContain('data-outcome="cannot_tell">Cannot tell<')
    expect(rows[1]).not.toContain('alert-past-cause')
    expect(rows[2]).not.toContain('data-outcome')
    expect(html.match(/data-testid="alert-past-report"/g)).toHaveLength(3)
    expect(html).toContain('data-list-bounded=')
    expect(html).toContain('confirmed by no person')
  })

  it('says None for a result that names no cause, and adds nothing to one with no result or with causes', async () => {
    const rows = (await render(ITEMS)).split('<li ').slice(1)
    expect(rows[0]).not.toContain('alert-past-no-causes')
    expect(rows[1]).toContain('data-testid="alert-past-no-causes">None<')
    expect(rows[2]).not.toContain('alert-past-no-causes')
    expect(rows[2]).toContain('<span class="shrink-0 text-slate-500">-</span>')
    expect(await render([ITEMS[1]], 'ko')).toContain(`data-testid="alert-past-no-causes">${ko.common.none}<`)
  })

  it('keeps a masked value its placeholder and draws the model\'s text as text', async () => {
    const html = await render(ITEMS)
    expect(html).toContain('Pod/shop/&lt;EMAIL_1&gt;')
    expect(html).toContain('ConfigMap/shop/&lt;b&gt;x&lt;/b&gt;')
    expect(html).not.toContain('<b>x</b>')
  })

  it('says None for no earlier one and that they could not be read when the server says so, in both languages', async () => {
    expect(await render([])).toContain('data-testid="alert-past-none">None<')
    expect(await render(null)).toContain('data-testid="alert-past-failed">The past investigations could not be read.<')
    expect(await render([], 'ko')).toContain(`data-testid="alert-past-none">${ko.common.none}<`)
    const korean = await render(ITEMS, 'ko')
    expect(korean).toContain(ko.alertInbox.past.title)
    expect(korean).toContain('>원인 찾음<')
    expect(korean).toContain('외 1개')
    expect(await render(null, 'ko')).toContain(`>${ko.alertInbox.past.failed}<`)
  })

  it('is in the window only when the server sent the list, and opens the report of the one pressed', () => {
    expect(source).toContain('{data.past_investigations !== undefined && <PastInvestigations items={data.past_investigations} onOpen={setPastOpen} />}')
    expect(source).toContain('<InvestigationReportModal key={pastOpen} id={pastOpen} load={() => api.getAlertInboxInvestigation(id, pastOpen)}')
    // the floating chat is told what it was told: the list is not in the window's layer
    const layer = source.slice(source.indexOf("source: 'AlertDetailModal'"), source.indexOf('const failed = save.error'))
    expect(layer).not.toContain('past')
  })
})

describe('what the window asks', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('asks for the earlier investigations with the alert, a mark and Investigate now, and one report by its ID', async () => {
    const get = vi.spyOn(client, 'get').mockResolvedValue({ data: {} })
    const patch = vi.spyOn(client, 'patch').mockResolvedValue({ data: {} })
    const post = vi.spyOn(client, 'post').mockResolvedValue({ data: {} })
    await alertInboxApi.getAlertInboxItem('a/1')
    expect(get).toHaveBeenLastCalledWith('/alerts/inbox/a%2F1', { params: { past: 'true' } })
    await alertInboxApi.setAlertInboxMarks('a1', { done: true })
    expect(patch).toHaveBeenLastCalledWith('/alerts/inbox/a1', { done: true }, { params: { past: 'true' } })
    await alertInboxApi.investigateAlertInboxItem('a1')
    expect(post).toHaveBeenLastCalledWith('/alerts/inbox/a1/investigate', undefined, { params: { past: 'true' } })
    await alertInboxApi.getAlertInboxInvestigation('a1')
    expect(get).toHaveBeenLastCalledWith('/alerts/inbox/a1/investigation', undefined)
    get.mockResolvedValue({ data: { id: 'inv-2', report: 'r' } })
    expect(await alertInboxApi.getAlertInboxInvestigation('a1', 'inv-2')).toEqual({ id: 'inv-2', report: 'r' })
    expect(get).toHaveBeenLastCalledWith('/alerts/inbox/a1/investigation', { params: { past: 'inv-2' } })
  })

  it('opens no other report in its place: a server that does not know the earlier ones answers this firing\'s', async () => {
    const get = vi.spyOn(client, 'get').mockResolvedValue({ data: { id: 'inv-9', report: 'this firing' } })
    await expect(alertInboxApi.getAlertInboxInvestigation('a1', 'inv-2')).rejects.toThrow('not the investigation asked for')
    get.mockResolvedValue({ data: null })
    await expect(alertInboxApi.getAlertInboxInvestigation('a1', 'inv-2')).rejects.toThrow()
    // this firing's own report is whatever the server has for it
    get.mockResolvedValue({ data: { id: 'inv-9' } })
    expect(await alertInboxApi.getAlertInboxInvestigation('a1')).toEqual({ id: 'inv-9' })
  })
})
