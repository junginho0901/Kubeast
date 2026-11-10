import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { beforeAll, describe, expect, it } from 'vitest'

import en from '../i18n/locales/en.json'
import ko from '../i18n/locales/ko.json'
import { RefreshFailure } from '@/components/RefreshFailure'
import { readFailure } from './useRefresh'

const i18n = i18next.createInstance()
beforeAll(async () => {
  await i18n.use(initReactI18next).init({ lng: 'en', resources: { en: { translation: en }, ko: { translation: ko } }, interpolation: { escapeValue: false } })
})
const at = new Date('2026-11-10T05:00:07Z')

describe("a page's Refresh", () => {
  it("keeps why the read failed — the server's reason — and when", async () => {
    const refused = { response: { status: 503, data: { detail: 'k8s-service unreachable' } }, message: 'Request failed with status code 503' }
    expect(await readFailure(() => Promise.reject(refused), () => at)).toEqual({ reason: 'k8s-service unreachable', at: '2026-11-10T05:00:07.000Z' })
    expect(await readFailure(() => Promise.reject(new Error('Network Error')), () => at)).toEqual({ reason: 'Network Error', at: '2026-11-10T05:00:07.000Z' })
  })

  it('is nothing when the read worked', async () => {
    expect(await readFailure(() => Promise.resolve([1, 2]), () => at)).toBeNull()
  })

  it('says under the header when it failed, why, and that what is shown is older', () => {
    const html = renderToStaticMarkup(createElement(I18nextProvider, { i18n }, createElement(RefreshFailure, { failure: { reason: 'k8s-service unreachable', at: at.toISOString() } })))
    expect(html).toMatch(/Refresh failed at 2026-11-10 \d{2}:00:07: k8s-service unreachable\. What is shown is from the read before\./)
    expect(html).toContain('role="alert"')
    expect(renderToStaticMarkup(createElement(I18nextProvider, { i18n }, createElement(RefreshFailure, { failure: null })))).toBe('')
  })
})
