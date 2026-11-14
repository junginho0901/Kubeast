import { createElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { hashKey, QueryClient, QueryClientProvider, type QueryKey } from '@tanstack/react-query'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import en from '@/i18n/locales/en.json'

// Each screen's list query handed the last answer of any key to the next one while it loaded (keepPreviousData, or a
// function keeping it within a cluster), and TanStack Query reports that as a success: the screens drew one tab's,
// filter's, search's, namespace's, grouping's or toggle's rows as the next one's answer. Each screen's own options,
// read as it renders, now give the previous answer only for another page, page size or order of the same read.

const read = vi.hoisted(() => ({ options: [] as any[], badDate: false }))
vi.mock('@tanstack/react-query', async (importOriginal) => {
  const real = await importOriginal<typeof import('@tanstack/react-query')>()
  return { ...real, useQuery: (options: any, client?: never) => (read.options.push(options), real.useQuery(options, client)) }
})
vi.mock('@/utils/time', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/utils/time')>()
  return { ...real, parseTypedTime: (...args: Parameters<typeof real.parseTypedTime>) => (read.badDate ? null : real.parseTypedTime(...args)) }
})
vi.mock('@/contexts/ClusterContext', () => ({ useCluster: () => ({ currentCluster: 'self' }) }))
vi.mock('@/hooks/useAIContext', () => ({ useAIContext: () => {} }))
vi.mock('@/hooks/usePrometheusQuery', () => ({
  useClusterFeatures: () => ({ data: { ai: { enabled: true }, alertInvestigation: { enabled: true }, prometheus: { enabled: false } }, isPlaceholderData: false }),
}))
vi.mock('@/components/ResourceDetailContext', () => ({ useResourceDetail: () => ({ open: () => {} }) }))
vi.mock('@/components/ModalOverlay', () => ({ ModalOverlay: ({ children }: { children: ReactNode }) => children }))
vi.mock('@/services/useHelmWatchList', () => ({ useHelmWatchList: () => {} }))
vi.mock('@/services/useWatchChanges', () => ({ useWatchChanges: () => {} }))
vi.mock('@/services/confirm', () => ({ useConfirm: () => async () => false }))

import AlertInbox from './alerts/AlertInbox'
import AdminAIUsage from './AdminAIUsage'
import HelmReleasesPage from './helm/Releases'
import AccessRequests from './admin/AccessRequests'
import AccessReview from './admin/AccessReview'
import Investigations from './admin/Investigations'
import SessionRecordings from './admin/SessionRecordings'
import ClusterHygiene from './admin/ClusterHygiene'
import ClusterAccessSection from './account/ClusterAccessSection'
import { PodRbacTab } from './cluster-view/PodRbacTab'

const i18n = i18next.createInstance()
beforeAll(async () => {
  await i18n.use(initReactI18next).init({ lng: 'en', resources: { en: { translation: en } }, interpolation: { escapeValue: false } })
})

// The options of the screen's query whose key starts with `prefix`, as the screen renders.
function optionsOf(screen: ReactElement, prefix: unknown[]) {
  read.options.length = 0
  renderToStaticMarkup(createElement(MemoryRouter, null,
    createElement(QueryClientProvider, { client: new QueryClient() },
      createElement(I18nextProvider, { i18n }, screen))))
  const found = read.options.filter((o) => prefix.every((p, i) => hashKey([o.queryKey[i]]) === hashKey([p])))
  expect(found.length, `a query under ${JSON.stringify(prefix)}`).toBeGreaterThan(0)
  return found
}

// What the query shows while `key` loads after the answer of `previousKey`: the previous rows, or none (pending,
// isLoading, as on first open).
function placeholderAfter(options: { placeholderData?: unknown }, previousKey: QueryKey): unknown {
  const previous = { rows: ['of the read before'] }
  const p = options.placeholderData
  return typeof p === 'function' ? p(previous, { queryKey: previousKey }) : p
}
const KEEPS = { rows: ['of the read before'] }

// a screen rendered once, when a test first asks (after i18n is ready)
function once<T>(make: () => T): () => T {
  let made: { value: T } | null = null
  return () => (made ??= { value: make() }).value
}

// the key with one part replaced (a place, or a field of the object at a place)
function withPart(key: readonly unknown[], at: number, value: unknown, field?: string): unknown[] {
  return key.map((part, i) => (i !== at ? part : field === undefined ? value : { ...(part as object), [field]: value }))
}

describe('the Alerts inbox', () => {
  const inbox = once(() => optionsOf(createElement(AlertInbox), ['alert-inbox', 'list'])[0])

  it('shows no row of another tab, severity, Mine, Open only, search or cluster while it loads', () => {
    const list = inbox()
    const key = list.queryKey as unknown[]
    for (const [field, value] of [['status', 'resolved'], ['severity', 'critical'], ['mine', true], ['open', true], ['q', 'web']] as const) {
      expect(placeholderAfter(list, withPart(key, 3, value, field)), field).toBeUndefined()
    }
    expect(placeholderAfter(list, withPart(key, 2, 'default')), 'cluster').toBeUndefined()
  })

  it('keeps the rows while another page or page size of the same read loads', () => {
    const list = inbox()
    const key = list.queryKey as unknown[]
    const filter = key[3] as Record<string, unknown>
    expect(placeholderAfter(list, withPart(key, 3, Number(filter.limit) * 2, 'offset'))).toEqual(KEEPS)
    expect(placeholderAfter(list, withPart(key, 3, 50, 'limit'))).toEqual(KEEPS)
  })
})

describe('AI Usage', () => {
  it('shows no row or total of another grouping or date range while it loads', () => {
    read.badDate = false
    const [usage] = optionsOf(createElement(AdminAIUsage), ['admin-ai-usage'])
    const key = usage.queryKey as unknown[]
    expect(placeholderAfter(usage, withPart(key, 1, 'model', 'group')), 'another grouping').toBeUndefined()
    expect(placeholderAfter(usage, withPart(key, 1, '2026-01-01T00:00:00.000Z', 'since')), 'another range').toBeUndefined()
  })

  it('keeps the report of the same grouping while a day is typed and not whole yet (nothing is asked)', () => {
    read.badDate = true
    try {
      const [usage] = optionsOf(createElement(AdminAIUsage), ['admin-ai-usage'])
      const key = usage.queryKey as unknown[]
      expect(usage.enabled).toBe(false)
      expect(placeholderAfter(usage, withPart(key, 1, '2026-10-15T00:00:00.000Z', 'since'))).toEqual(KEEPS)
      expect(placeholderAfter(usage, withPart(key, 1, 'model', 'group')), 'another grouping').toBeUndefined()
    } finally {
      read.badDate = false
    }
  })
})

describe('Helm releases', () => {
  it('shows no release of another namespace or cluster while it loads', () => {
    const [releases] = optionsOf(createElement(HelmReleasesPage), ['helm-releases'])
    const key = releases.queryKey as unknown[]
    expect(placeholderAfter(releases, withPart(key, 2, 'shop')), 'another namespace').toBeUndefined()
    expect(placeholderAfter(releases, withPart(key, 1, 'default')), 'another cluster').toBeUndefined()
  })
})

describe('Access requests', () => {
  const both = once(() => optionsOf(createElement(AccessRequests), ['access-requests', 'admin', 'list']))

  it('reads both tabs', () => {
    expect(both().map((o) => o.queryKey[3]).sort()).toEqual(['history', 'pending'])
  })

  it('shows no row of another search while either tab loads', () => {
    for (const list of both()) expect(placeholderAfter(list, withPart(list.queryKey, 4, 'alice', 'q')), list.queryKey[3]).toBeUndefined()
  })

  it('keeps each tab\'s rows while its next page or page size loads', () => {
    for (const list of both()) {
      expect(placeholderAfter(list, withPart(list.queryKey, 4, 100, 'offset')), list.queryKey[3]).toEqual(KEEPS)
      expect(placeholderAfter(list, withPart(list.queryKey, 4, 10, 'limit')), list.queryKey[3]).toEqual(KEEPS)
    }
  })
})

describe('Investigations and Session recordings', () => {
  const screens = [
    { name: 'Investigations', element: createElement(Investigations), prefix: ['investigations', 'list'], filter: { status: 'done', cluster: '' } },
    { name: 'Session recordings', element: createElement(SessionRecordings), prefix: ['recordings', 'list'], filter: { user: 'alice@example.com', kind: '' } },
  ]

  it('show no row of another filter while it loads', () => {
    for (const s of screens) {
      const [list] = optionsOf(s.element, s.prefix)
      expect(placeholderAfter(list, withPart(list.queryKey, 2, s.filter)), s.name).toBeUndefined()
    }
  })

  it('keep the rows while another page or page size loads', () => {
    for (const s of screens) {
      const [list] = optionsOf(s.element, s.prefix)
      const pageKey = withPart(withPart(list.queryKey, 3, 2), 4, { offset: 25, limit: 25 })
      expect(placeholderAfter(list, pageKey), s.name).toEqual(KEEPS)
    }
  })
})

describe('the pages of one read that only turn', () => {
  it('Access review\'s Past reviews, Cluster hygiene\'s past sign-offs and Settings → My requests keep their rows for another page', () => {
    const [past] = optionsOf(createElement(AccessReview), ['access-review', 'history'])
    expect(placeholderAfter(past, withPart(past.queryKey, 2, { limit: 25, offset: 25 }))).toEqual(KEEPS)

    const [hygiene] = optionsOf(createElement(ClusterHygiene), ['hygiene'])
      .filter((o) => o.queryKey[2] === 'history')
    expect(placeholderAfter(hygiene, withPart(withPart(hygiene.queryKey, 3, 2), 4, 50))).toEqual(KEEPS)
    expect(placeholderAfter(hygiene, withPart(hygiene.queryKey, 1, 'default')), 'another cluster').toBeUndefined()

    const [mine] = optionsOf(createElement(ClusterAccessSection, { me: undefined }), ['access-requests', 'mine', 'page'])
    expect(placeholderAfter(mine, withPart(mine.queryKey, 3, { limit: 10, offset: 10 }))).toEqual(KEEPS)
  })
})

describe('a pod\'s RBAC tab', () => {
  it('shows no binding read without the broad group while the answer with it loads, nor another pod\'s', () => {
    const tr = (_: string, fallback: string) => fallback
    const [rbac] = optionsOf(createElement(PodRbacTab, { pod: { name: 'web-0', namespace: 'shop' }, tr }), ['pod-rbac'])
    expect(placeholderAfter(rbac, withPart(rbac.queryKey, 3, true)), 'the other choice').toBeUndefined()
    expect(placeholderAfter(rbac, withPart(rbac.queryKey, 2, 'web-1')), 'another pod').toBeUndefined()
  })
})
