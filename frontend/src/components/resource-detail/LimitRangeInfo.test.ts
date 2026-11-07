import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import en from '@/i18n/locales/en.json'
import ko from '@/i18n/locales/ko.json'
import LimitRangeInfo from './LimitRangeInfo'

// "No pod violates" is what the list said, not what a window says because it could not read the list.

const layers: { summary?: string; data?: Record<string, unknown> }[] = []
vi.mock('@/hooks/useAIContext', () => ({ useAIContext: (input: { summary?: string; data?: Record<string, unknown> } | null) => { if (input) layers.push(input) } }))

const i18n = i18next.createInstance()
beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en', fallbackLng: 'en', ns: ['translation', 'detail'], defaultNS: 'translation',
    resources: { en: { translation: en, detail: {} }, ko: { translation: ko, detail: ko.detail } }, interpolation: { escapeValue: false },
  })
})
beforeEach(() => {
  layers.length = 0
})

const NONE = 'No pod in this namespace currently violates this LimitRange.'
const REFUSED = 'You may not read the pods of this namespace, so this window cannot say which of them violate this LimitRange.'
const FAILED = 'Could not read the pods of this namespace, so this window cannot say which of them violate this LimitRange.'
const KEY = ['limitrange-violations', 'ns', 'caps']
const httpError = (status: number, detail?: string) => Object.assign(new Error(`HTTP ${status}`), { response: { status, data: detail ? { detail } : {} } })

const render = (violations: unknown, error?: unknown, lng = 'en') => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } })
  qc.setQueryData(['limitrange-describe', 'ns', 'caps'], { limits: [], uid: 'u', labels: {}, annotations: {}, events: [] })
  if (violations !== undefined) qc.setQueryData(KEY, violations)
  if (error) {
    const q = qc.getQueryCache().build(qc, { queryKey: KEY })
    q.setState({ ...q.state, status: 'error', error: error as Error, errorUpdatedAt: Date.now(), errorUpdateCount: 1 })
  }
  return renderToStaticMarkup(createElement(I18nextProvider, { i18n: i18n.cloneInstance({ lng }) }, createElement(QueryClientProvider, { client: qc },
    createElement(LimitRangeInfo, { name: 'caps', namespace: 'ns' }))))
}
const lastLayer = () => layers[layers.length - 1]

describe('the Violating Pods of a LimitRange', () => {
  it('a refused list says so and why, not that no pod violates', () => {
    const html = render(undefined, httpError(403, 'pods is forbidden'))
    expect(html).not.toContain(NONE)
    expect(html).toContain(REFUSED)
    expect(html).toContain('pods is forbidden')
  })

  it('a list that failed says so, not that no pod violates', () => {
    const html = render(undefined, httpError(500, 'internal server error'))
    expect(html).not.toContain(NONE)
    expect(html).toContain(FAILED)
    expect(html).toContain('internal server error')
  })

  it('says it in Korean', () => {
    expect(render(undefined, httpError(403), 'ko')).toContain('이 Namespace의 Pod를 읽을 권한이 없어 이 LimitRange를 위반하는 Pod를 알 수 없습니다.')
    expect(render(undefined, httpError(500), 'ko')).toContain('이 Namespace의 Pod를 읽지 못해 이 LimitRange를 위반하는 Pod를 알 수 없습니다.')
  })

  it('counts nothing it did not read: the badge and the title show -', () => {
    const html = render(undefined, httpError(403))
    expect(html).toContain('Violating Pods: -')
    expect(html).toContain('Violating Pods (-)')
    expect(html).not.toContain('Violating Pods: 0')
    expect(html).not.toContain('border-emerald-500/60')
  })

  it('says neither while the list has not answered', () => {
    const html = render(undefined)
    expect(html).not.toContain(NONE)
    expect(html).toContain('Violating Pods: -')
  })

  it('an empty answer says no pod violates and counts 0', () => {
    const html = render([])
    expect(html).toContain(NONE)
    expect(html).toContain('Violating Pods: 0')
    expect(html).toContain('Violating Pods (0)')
  })

  it('an answer with rows shows them', () => {
    const html = render([{ pod: 'too-big', namespace: 'ns', container: 'c', field: 'cpu max', actual: '2', limit: '1' }])
    expect(html).toContain('too-big')
    expect(html).toContain('Violating Pods: 1')
    expect(html).not.toContain(NONE)
  })

  it('keeps the rows it has when a later read fails', () => {
    const html = render([{ pod: 'too-big', namespace: 'ns', container: 'c', field: 'cpu max', actual: '2', limit: '1' }], httpError(500))
    expect(html).toContain('too-big')
    expect(html).toContain('Violating Pods: 1')
    expect(html).not.toContain(FAILED)
  })

  it('tells the floating chat the list was not read and why', () => {
    render(undefined, httpError(403, 'pods is forbidden'))
    expect(lastLayer().data).not.toHaveProperty('violating_pods')
    expect(lastLayer().data?.violations_unread).toEqual({ status: 403, detail: 'pods is forbidden' })
    expect(lastLayer().summary).toContain('위반 Pod 목록을 읽지 못함')
  })
})
