import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import en from '@/i18n/locales/en.json'
import ko from '@/i18n/locales/ko.json'
import type { PodPage } from '@/services/api'
import { ListPager } from '@/components/ListPager'

// The Pods list's footer counts the answer on screen. While the first read comes it said "Showing 0 of 0" under the
// Loading row, a 0 nobody counted; after a cluster switch it kept the cluster before's total under the Loading row,
// and the new cluster's rows came with that total for a frame, since the total followed the answer in an effect.

vi.mock('@/contexts/ClusterContext', () => ({ useCluster: () => ({ currentCluster: 'self' }) }))
vi.mock('@/hooks/usePrometheusQuery', () => ({ useClusterFeatures: () => ({ data: undefined, isPlaceholderData: false }) }))
vi.mock('@/hooks/useAIContext', () => ({ useAIContext: () => {} }))
vi.mock('@/components/ResourceDetailContext', () => ({ useResourceDetail: () => ({ open: () => {}, target: null }) }))
vi.mock('@/components/ModalOverlay', () => ({ ModalOverlay: ({ children }: { children: ReactNode }) => children }))

import Pods from './Pods'

const i18n = { en: i18next.createInstance(), ko: i18next.createInstance() }
beforeAll(async () => {
  await i18n.en.use(initReactI18next).init({ lng: 'en', resources: { en: { translation: en } }, interpolation: { escapeValue: false } })
  await i18n.ko.use(initReactI18next).init({ lng: 'ko', resources: { ko: { translation: ko } }, interpolation: { escapeValue: false } })
})

// the range the footer says
const rangeText = (html: string) => {
  const pager = html.slice(html.indexOf('data-testid="list-pager"'))
  return [en.common.paginationNotCounted, en.common.paginationEmpty, ko.common.paginationNotCounted, ko.common.paginationEmpty]
    .find((s) => pager.includes(s)) ?? pager.match(/Showing \d+-\d+ of \d+/)?.[0]
}

const pagerOf = (lng: 'en' | 'ko', props: { total: number; counted?: boolean }) =>
  renderToStaticMarkup(createElement(I18nextProvider, { i18n: i18n[lng] },
    createElement(ListPager, { currentPage: 1, totalPages: 1, rowsPerPage: 12, onPageChange: () => {}, showPageSize: false, ...props })))

const answer = (total: number, names: string[]): PodPage => ({
  items: names.map((name) => ({ name, namespace: 'shop', status: 'Running', phase: 'Running', ready: '1/1', restart_count: 0, node_name: 'node-1', pod_ip: '10.0.0.1', created_at: '2026-11-14T00:00:00Z' })),
  total,
  stats: { total, ready: total, not_ready: 0, pending: 0, terminating: 0, error: 0, restarted: 0, completed: 0, top_reasons: [] },
  revision: 'r1',
  source: 'index',
})

// the Pods page as it draws in one render, with the first block's answer in the cache or none yet
function podsPage(cached?: PodPage) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  if (cached) client.setQueryData(['workloads', 'pods-page', { offset: 0, limit: 50 }], cached)
  return renderToStaticMarkup(createElement(MemoryRouter, null,
    createElement(QueryClientProvider, { client },
      createElement(I18nextProvider, { i18n: i18n.en }, createElement(Pods)))))
}

describe('a list footer with no answer to count', () => {
  it('says it has not counted, in English and Korean', () => {
    expect(rangeText(pagerOf('en', { total: 0, counted: false }))).toBe('Showing - of -')
    expect(rangeText(pagerOf('ko', { total: 0, counted: false }))).toBe('-개 중 - 표시')
    expect(rangeText(pagerOf('en', { total: 38, counted: false }))).toBe('Showing - of -')
  })

  it('counts as before once it has an answer', () => {
    expect(rangeText(pagerOf('en', { total: 0 }))).toBe('Showing 0 of 0')
    expect(rangeText(pagerOf('en', { total: 35 }))).toBe('Showing 1-12 of 35')
  })
})

describe('the Pods list footer', () => {
  it('says it has not counted under the Loading row while the first answer comes', () => {
    const html = podsPage()
    expect(html).toContain(en.common.loading)
    expect(rangeText(html)).toBe(en.common.paginationNotCounted)
  })

  it('counts the answer in the render it comes, not the total before it', () => {
    const html = podsPage(answer(35, ['web-0', 'web-1']))
    expect(html).toContain('web-0')
    expect(rangeText(html)).toBe('Showing 1-12 of 35')
  })
})
