import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import en from '@/i18n/locales/en.json'
import ko from '@/i18n/locales/ko.json'
import { ChatHeader } from './ChatHeader'
import headerSrc from './ChatHeader.tsx?raw'
import sidebarSrc from './SessionSidebar.tsx?raw'
import { aiConfigRetry, aiConfigRetryDelay } from './utils'

// The AI Chat header says why the model could not be read, in the server's words, where the model's name would be.

const i18n = i18next.createInstance()
beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en', fallbackLng: 'en', resources: { en: { translation: en }, ko: { translation: ko } }, interpolation: { escapeValue: false },
  })
})

// ai-service's answer to GET /ai/config with no model stored and no key in the chart's values
const NO_MODEL = 'No AI model is set up yet: an administrator adds one in Admin → AI Models.'
const refused = (status: number, detail: string, headers: Record<string, string> = {}) =>
  Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, data: { detail }, headers } })
// ai-service's answer to a token whose session it could not check, its database unreadable (security._outage_verdict)
const SESSION_UNCHECKED = () => refused(503, 'Session could not be checked; try again', { 'retry-after': '5' })

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

describe('a long reason', () => {
  it('is cut at two lines with its whole text on hover, so the header stays as high as the conversation list\'s', () => {
    const long = `${NO_MODEL} ${'More of what the server said about it. '.repeat(10)}`.trim()
    const html = render({ error: refused(503, long) })
    const attrs = /<p role="alert" data-testid="ai-config-failed"([^>]*)>/.exec(html)?.[1] ?? ''
    expect(/title="([^"]*)"/.exec(attrs)?.[1].replace(/&#x27;/g, "'").replace(/&gt;/g, '>')).toBe(`Could not read the AI model: ${long}`)
    expect(attrs).toMatch(/class="[^"]*\bline-clamp-2\b/)
    // the title row (text-xl, 28 px), the subtitle and the reason (text-sm, 20 px a line, mt-1 each), two lines at most
    const tallest = 28 + (4 + 20) + (4 + 2 * 20)
    const header = Number(/min-h-\[(\d+)px\]/.exec(html)?.[1])
    const list = Number(/isMultiSelectMode \? 'h-\[\d+px\]' : 'h-\[(\d+)px\]'/.exec(sidebarSrc)?.[1])
    expect({ header, fits: tallest <= header }).toEqual({ header: list, fits: true })
  })
})

// "No model set up yet" is a 503 that answers the same a second later: the header asks once, and its reason shows at
// once instead of after the default retry's second. Another failure is tried once more, as before.
describe('the AI model read', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('is asked once on a 503 or a refusal, and twice on another failure', async () => {
    const failing = (error: unknown) => vi.fn(async () => { throw error })
    const reads = { noModel: failing(refused(503, NO_MODEL)), refused: failing(refused(403, 'no')), failed: failing(refused(500, 'boom')), network: failing(new Error('Network Error')) }
    const client = new QueryClient()
    const stops = Object.entries(reads).map(([name, queryFn]) => new QueryObserver(client, { queryKey: ['ai-config', name], queryFn, retry: aiConfigRetry, retryDelay: aiConfigRetryDelay }).subscribe(() => {}))
    await vi.advanceTimersByTimeAsync(10_000)
    expect(Object.fromEntries(Object.entries(reads).map(([name, read]) => [name, read.mock.calls.length])))
      .toEqual({ noModel: 1, refused: 1, failed: 2, network: 2 })
    stops.forEach((stop) => stop())
    expect(headerSrc).toMatch(/queryKey: \['ai-config'\],[\s\S]*?retry: aiConfigRetry,\s*retryDelay: aiConfigRetryDelay,/)
  })

  // The 503 of a session the server could not check carries Retry-After, the 503 of no model set up does not: the
  // first is asked again at the server's pace, as long as it answers so, and its words never show as the model's.
  it('asks a session the server could not check again at its Retry-After until it answers, showing no failure', async () => {
    let unchecked = 7
    const read = vi.fn(async () => {
      if (unchecked-- > 0) throw SESSION_UNCHECKED()
      return { model: 'gpt-6-luna', app_name: 'Kubeast', version: '0.7.8' }
    })
    const observer = new QueryObserver(new QueryClient(), { queryKey: ['ai-config'], queryFn: read, retry: aiConfigRetry, retryDelay: aiConfigRetryDelay })
    const errors: unknown[] = []
    const stop = observer.subscribe((r) => { if (r.error) errors.push(r.error) })
    await vi.advanceTimersByTimeAsync(4_900)
    expect(read, 'not before the 5 s of Retry-After').toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect({ reads: read.mock.calls.length, model: observer.getCurrentResult().data?.model, errors }).toEqual({ reads: 8, model: 'gpt-6-luna', errors: [] })
    stop()
  })

  it('tells the two 503s apart by Retry-After, and never tries a refusal again', () => {
    expect([
      aiConfigRetry(0, refused(503, NO_MODEL)),
      aiConfigRetry(0, SESSION_UNCHECKED()),
      aiConfigRetry(9, SESSION_UNCHECKED()),
      aiConfigRetry(0, refused(403, 'no', { 'retry-after': '5' })),
    ]).toEqual([false, true, true, false])
    expect([aiConfigRetryDelay(0, SESSION_UNCHECKED()), aiConfigRetryDelay(5, SESSION_UNCHECKED()), aiConfigRetryDelay(0, refused(500, 'boom'))])
      .toEqual([5_000, 30_000, 1_000])
  })
})
