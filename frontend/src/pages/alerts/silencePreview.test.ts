import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'
import en from '@/i18n/locales/en.json'
import { client } from '@/services/api/client'
import { alertInboxApi, type SilencePreview } from '@/services/api/alertInbox'
import { storeCut } from '@/utils/alertInbox'
import { SilencePreviewAlerts } from './SilenceModal'

beforeAll(async () => {
  await i18n.changeLanguage('en')
})

const preview = (listed: number, total = listed): SilencePreview => ({
  total,
  truncated: total > listed,
  alerts: Array.from({ length: listed }, (_, i) => ({ fingerprint: `f${String(i).padStart(3, '0')}`, alertname: `Alert${String(i).padStart(3, '0')}`, state: 'active', labels: { namespace: 'shop' } })),
})
const html = (p: SilencePreview) => renderToStaticMarkup(createElement(SilencePreviewAlerts, { preview: p }))
const rows = (out: string) => out.match(/<li\b/g)?.length ?? 0
const cutText = (listed: number, total: number) =>
  en.alertInbox.silence.storeCut.replace('{{listed}}', String(listed)).replace('{{total}}', String(total))

describe('what a silence would mute', () => {
  it('lists every alert ten to a page, with the range of all of them, under the count of all', () => {
    const out = html(preview(11))
    expect(out).toContain('11 alert(s)')
    expect(rows(out)).toBe(10)
    expect(out).toContain('<span>1-10 / 11</span>')
    expect(out).toContain('Alert009')
    expect(out).not.toContain('Alert010')
  })

  it('draws ten without a pager', () => {
    const out = html(preview(10))
    expect(rows(out)).toBe(10)
    expect(out).not.toContain(' / 10<')
    expect(out).not.toContain(cutText(10, 10))
  })

  it("says so when the store cut the list at its limit, with the store's own numbers", () => {
    const out = html(preview(100, 105))
    expect(out).toContain('105 alert(s)')
    expect(out).toContain('<span>1-10 / 100</span>')
    expect(out).toContain(cutText(100, 105))
  })
})

describe("the alert store's list for the Alerts page", () => {
  afterEach(() => vi.restoreAllMocks())

  it('keeps the total of all, so a cut list can say how many it left out', async () => {
    const alerts = Array.from({ length: 100 }, (_, i) => ({ fingerprint: `f${i}`, state: 'active' }))
    vi.spyOn(client, 'get').mockResolvedValue({ data: { alerts, total: 130, truncated: true } })
    const store = await alertInboxApi.listAlertStoreAlerts()
    expect(storeCut(store)).toEqual({ listed: 100, total: 130 })
  })

  it('says nothing was cut when the store sent everything', () => {
    expect(storeCut({ alerts: [1, 2, 3], total: 3, truncated: false })).toBeNull()
    expect(storeCut(undefined)).toBeNull()
  })
})
