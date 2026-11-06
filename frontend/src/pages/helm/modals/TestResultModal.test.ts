import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import en from '@/i18n/locales/en.json'
import ko from '@/i18n/locales/ko.json'
import TestResultModal from './TestResultModal'

// A failed helm test says why it failed: "no test hooks" is only for a chart that really has none.

type Outcome = { onSuccess: (data: unknown) => void; onError: (err: unknown) => void }
let outcome: ((o: Outcome) => void) | undefined

// The server renderer runs no effects: the run's outcome arrives during the first render instead.
vi.mock('@tanstack/react-query', async (original) => ({
  ...(await original<typeof import('@tanstack/react-query')>()),
  useMutation: (options: Outcome) => {
    const arrive = outcome
    outcome = undefined
    arrive?.(options)
    return { isPending: false, mutate: () => {} }
  },
}))
vi.mock('@/components/ModalOverlay', () => ({ ModalOverlay: ({ children }: { children: ReactNode }) => children }))
const aiContext = vi.fn()
vi.mock('@/hooks/useAIContext', () => ({ useAIContext: (snapshot: unknown) => aiContext(snapshot) }))

const i18n = i18next.createInstance()
beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en', fallbackLng: 'en', resources: { en: { translation: en }, ko: { translation: ko } }, interpolation: { escapeValue: false },
  })
})

const render = (arrive: (o: Outcome) => void, lng = 'en') => {
  outcome = arrive
  return renderToStaticMarkup(createElement(I18nextProvider, { i18n: i18n.cloneInstance({ lng }) },
    createElement(TestResultModal, { namespace: 'demo', name: 'web', onClose: () => {} })))
}
const failing = (status: number, data: unknown) => (o: Outcome) => o.onError(Object.assign(new Error(`HTTP ${status}`), { response: { status, data } }))
const REASON = 'pod web-test failed'
const NO_HOOKS = 'This chart defines no test hooks.'
const NO_HOOKS_KO = '이 chart 에는 test hook 이 정의되어 있지 않습니다.'

describe('the Helm test window', () => {
  it('a failed run shows the reason, not that the chart has no hooks', () => {
    const html = render(failing(500, { detail: REASON }))
    expect(html).toContain(REASON)
    expect(html).not.toContain(NO_HOOKS)
  })

  it('a failed run says so in the other language too', () => {
    const html = render(failing(500, { detail: REASON }), 'ko')
    expect(html).toContain(REASON)
    expect(html).not.toContain(NO_HOOKS_KO)
  })

  it('a failed run that came back with its hooks shows the reason and each hook', () => {
    const html = render((o) => o.onSuccess({ error: REASON, success: false, hooks: [{ name: 'web-test', phase: 'Failed', failed: true }, { name: 'web-smoke', phase: 'Succeeded', failed: false }] }))
    expect(html).toContain(REASON)
    expect(html).toContain('web-test')
    expect(html).toContain('web-smoke')
    expect(html).not.toContain(NO_HOOKS)
  })

  it('a failure with no answer shows the message of the request', () => {
    const html = render((o) => o.onError(new Error('Network Error')))
    expect(html).toContain('Network Error')
    expect(html).not.toContain(NO_HOOKS)
  })

  it('a refused run shows the refusal, not that the chart has no hooks', () => {
    const html = render(failing(403, { detail: 'permission denied' }))
    expect(html).toContain('permission denied')
    expect(html).not.toContain(NO_HOOKS)
  })

  it('a run that answered failed without hooks does not say the chart has none', () => {
    const html = render((o) => o.onSuccess({ success: false, hooks: [] }))
    expect(html).toContain(en.helmReleaseDetail.test.failed)
    expect(html).not.toContain(NO_HOOKS)
  })

  it('a chart with no test hooks still says so, whatever way the empty list comes', () => {
    expect(render((o) => o.onSuccess({ success: true, hooks: [] }))).toContain(NO_HOOKS)
    expect(render((o) => o.onSuccess({ success: true, hooks: null }))).toContain(NO_HOOKS)
    expect(render((o) => o.onSuccess({ success: true }), 'ko')).toContain(NO_HOOKS_KO)
  })

  it('a passing run shows the banner and each hook', () => {
    const html = render((o) => o.onSuccess({ success: true, hooks: [{ name: 'web-smoke', phase: 'Succeeded', failed: false }] }))
    expect(html).toContain(en.helmReleaseDetail.test.passed)
    expect(html).toContain('web-smoke')
    expect(html).not.toContain(NO_HOOKS)
  })

  it('the AI context carries the failure and its reason', () => {
    aiContext.mockClear()
    render(failing(500, { detail: REASON }))
    const last = aiContext.mock.calls.at(-1)?.[0]
    expect(last.summary).toContain('실패')
    expect(last.data.error).toBe(REASON)
  })
})
