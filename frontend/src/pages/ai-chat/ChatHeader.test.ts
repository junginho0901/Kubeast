import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeAll, describe, expect, it } from 'vitest'

import en from '@/i18n/locales/en.json'
import ko from '@/i18n/locales/ko.json'
import { ChatHeader } from './ChatHeader'

// The AI Chat header says why the model could not be read, in the server's words, where the model's name would be.

const i18n = i18next.createInstance()
beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en', fallbackLng: 'en', resources: { en: { translation: en }, ko: { translation: ko } }, interpolation: { escapeValue: false },
  })
})

// ai-service's answer to GET /ai/config with no model stored and no key in the chart's values
const NO_MODEL = 'No AI model is set up yet: an administrator adds one in Admin → AI Models.'
const refused = (status: number, detail: string) =>
  Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, data: { detail } } })

type Read = { data: { model: string; app_name: string; version: string } } | { error: unknown }

const render = (read: Read, lng = 'en') => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } })
  if ('data' in read) qc.setQueryData(['ai-config'], read.data)
  else {
    const q = qc.getQueryCache().build(qc, { queryKey: ['ai-config'] })
    q.setState({ ...q.state, status: 'error', error: read.error as Error, errorUpdatedAt: Date.now(), errorUpdateCount: 1 })
  }
  return renderToStaticMarkup(createElement(I18nextProvider, { i18n: i18n.cloneInstance({ lng }) },
    createElement(QueryClientProvider, { client: qc }, createElement(ChatHeader))))
}

const alertOf = (html: string) =>
  /<p role="alert" data-testid="ai-config-failed"[^>]*>([^<]*)<\/p>/.exec(html)?.[1].replace(/&#x27;/g, "'").replace(/&gt;/g, '>') ?? null

describe('the AI Chat header, when the model cannot be read', () => {
  it('says no model is set up yet, in the server\'s words, and shows no model name', () => {
    const html = render({ error: refused(503, NO_MODEL) })
    expect(alertOf(html)).toBe(`Could not read the AI model: ${NO_MODEL}`)
    expect(html).not.toContain('rounded-full')
  })

  it('says it in Korean around the server\'s reason', () => {
    expect(alertOf(render({ error: refused(503, NO_MODEL) }, 'ko'))).toBe(`AI 모델을 읽지 못했습니다: ${NO_MODEL}`)
  })

  it('says the request\'s own error when no answer came', () => {
    expect(alertOf(render({ error: new Error('Network Error') }))).toBe('Could not read the AI model: Network Error')
  })

  it('shows the model\'s name and no reason when the read answered', () => {
    const html = render({ data: { model: 'gpt-6-luna', app_name: 'Kubeast', version: '0.7.8' } })
    expect(alertOf(html)).toBeNull()
    expect(html).toMatch(/<span class="[^"]*rounded-full[^"]*">gpt-6-luna<\/span>/)
  })
})
