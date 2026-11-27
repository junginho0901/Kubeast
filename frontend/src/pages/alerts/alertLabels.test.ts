import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { beforeAll, describe, expect, it } from 'vitest'

import en from '../../i18n/locales/en.json'
import ko from '../../i18n/locales/ko.json'
import source from './AlertInbox.tsx?raw'
import { AlertLabels } from './AlertLabels'

const i18n = i18next.createInstance()
beforeAll(async () => {
  await i18n.use(initReactI18next).init({ lng: 'en', resources: { en: { translation: en }, ko: { translation: ko } }, interpolation: { escapeValue: false } })
})

const render = async (labels: Record<string, string>, annotations: Record<string, string>, lng = 'en') => {
  await i18n.changeLanguage(lng)
  return renderToStaticMarkup(createElement(I18nextProvider, { i18n }, createElement(AlertLabels, { labels, annotations })))
}
const values = (html: string) => [...html.matchAll(/<dt[^>]*>([^<]*)<\/dt><dd[^>]*>([^<]*)<\/dd>/g)].map((m) => [m[1], m[2]])

describe("the alert window's labels and annotations", () => {
  it('draws each as Alertmanager sent it and an empty value as -', async () => {
    const html = await render({ alertname: 'KubePodCrashLooping', team: '' }, { summary: 'Pod restarts', runbook_url: '' })
    expect(values(html)).toEqual([['alertname', 'KubePodCrashLooping'], ['team', '-'], ['summary', 'Pod restarts'], ['runbook_url', '-']])
    expect(html).toContain('data-testid="alert-labels"')
  })

  it('says None for no annotations, in both languages', async () => {
    expect(await render({ alertname: 'A' }, {})).toContain('<div class="text-slate-500">None</div>')
    expect(await render({ alertname: 'A' }, {}, 'ko')).toContain(`<div class="text-slate-500">${ko.common.none}</div>`)
    expect(await render({ alertname: 'A' }, { summary: 's' })).not.toContain('None')
  })

  it('is what the window draws', () => {
    expect(source).toContain('<AlertLabels labels={data.labels} annotations={data.annotations} />')
  })
})
