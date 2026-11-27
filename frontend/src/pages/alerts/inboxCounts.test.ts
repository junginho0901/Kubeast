import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { QueryClient, QueryClientProvider, type QueryKey } from '@tanstack/react-query'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import en from '@/i18n/locales/en.json'

// The Alerts tabs and the list footer say what an answer counted: - before the first one and after a read that
// brought none, never a 0 nobody counted; an answer of no alerts counts 0.

const read = vi.hoisted(() => ({ keys: [] as QueryKey[] }))
vi.mock('@tanstack/react-query', async (importOriginal) => {
  const real = await importOriginal<typeof import('@tanstack/react-query')>()
  return { ...real, useQuery: (options: any, client?: never) => (read.keys.push(options.queryKey), real.useQuery(options, client)) }
})
vi.mock('@/contexts/ClusterContext', () => ({ useCluster: () => ({ currentCluster: 'self' }) }))
vi.mock('@/hooks/useAIContext', () => ({ useAIContext: () => {} }))
vi.mock('@/hooks/usePrometheusQuery', () => ({
  useClusterFeatures: () => ({ data: { ai: { enabled: true }, alertInvestigation: { enabled: true }, prometheus: { enabled: false } }, isPlaceholderData: false }),
}))
vi.mock('@/components/ResourceDetailContext', () => ({ useResourceDetail: () => ({ open: () => {} }) }))
vi.mock('@/components/ModalOverlay', () => ({ ModalOverlay: ({ children }: { children: ReactNode }) => children }))
vi.mock('@/services/confirm', () => ({ useConfirm: () => async () => false }))

import AlertInbox from './AlertInbox'

const i18n = i18next.createInstance()
beforeAll(async () => {
  await i18n.use(initReactI18next).init({ lng: 'en', resources: { en: { translation: en } }, interpolation: { escapeValue: false } })
})

const draw = (qc: QueryClient) => renderToStaticMarkup(createElement(MemoryRouter, null,
  createElement(QueryClientProvider, { client: qc }, createElement(I18nextProvider, { i18n }, createElement(AlertInbox)))))

// the key the page reads its first page under
const listKey = () => {
  read.keys.length = 0
  draw(new QueryClient())
  const key = read.keys.find((k) => k[0] === 'alert-inbox' && k[1] === 'list')
  expect(key, 'the list read').toBeDefined()
  return key!
}

const answer = (key: QueryKey, total: number, counts: { firing: number; stale: number; resolved: number }) =>
  ({ items: [], total, counts, stale_hours: 24, severities: [], filter: key[3], page: 1 })

const failure = () => Object.assign(new Error('Request failed with status code 500'), { response: { status: 500, data: { detail: 'store down' } } })

const shown = (html: string) => ({
  tabs: Object.fromEntries(['firing', 'stale', 'resolved', 'all'].map((t) =>
    [t, new RegExp(`data-testid="alert-tab-${t}"[^>]*>[^<]*<span[^>]*>([^<]*)</span>`).exec(html)?.[1]])),
  footer: /data-testid="list-pager"[^>]*>.*?(Showing [^<]*)</.exec(html)?.[1],
})

describe('the Alerts tabs and footer', () => {
  it('say - before the first answer', () => {
    listKey()
    expect(shown(draw(new QueryClient()))).toEqual({ tabs: { firing: '-', stale: '-', resolved: '-', all: '-' }, footer: en.common.paginationNotCounted })
  })

  it('say - after a read that failed with no answer before it', () => {
    const qc = new QueryClient()
    const query = qc.getQueryCache().build(qc, { queryKey: listKey() })
    query.setState({ ...query.state, status: 'error', error: failure(), errorUpdatedAt: Date.now(), fetchFailureCount: 1 })
    expect(shown(draw(qc))).toEqual({ tabs: { firing: '-', stale: '-', resolved: '-', all: '-' }, footer: en.common.paginationNotCounted })
  })

  it('count an answer, an answer of no alerts as 0', () => {
    const key = listKey()
    const qc = new QueryClient()
    qc.setQueryData(key, answer(key, 0, { firing: 0, stale: 0, resolved: 0 }))
    expect(shown(draw(qc))).toEqual({ tabs: { firing: '0', stale: '0', resolved: '0', all: '0' }, footer: en.common.paginationEmpty })
  })

  it("keep the last answer's counts while a later read fails", () => {
    const key = listKey()
    const qc = new QueryClient()
    qc.setQueryData(key, answer(key, 6, { firing: 3, stale: 1, resolved: 2 }))
    const query = qc.getQueryCache().find({ queryKey: key })!
    query.setState({ ...query.state, status: 'error', error: failure(), errorUpdatedAt: Date.now(), fetchFailureCount: 1 })
    expect(shown(draw(qc)).tabs).toEqual({ firing: '3', stale: '1', resolved: '2', all: '6' })
  })
})
