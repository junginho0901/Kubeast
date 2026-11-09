import { createElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { QueryClient, QueryClientProvider, type QueryKey } from '@tanstack/react-query'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import en from '../../i18n/locales/en.json'
import ClusterAccessModal from './ClusterAccessModal'
import ClusterAccessSection from '../account/ClusterAccessSection'
import { myRequestsKey, myRequestsQuery } from '../account/myRequestPages'
import type { ClusterMeta } from '@/services/api/clusters'
import type { Member } from '@/services/api/types'

// A window and a section of the Settings page page their rows ten at a time, as a drawer's tables do: the first
// page and the pager that reaches the rest, never every row at once.

// the window's overlay is a portal into the page, which a static render has not got
vi.mock('@/components/ModalOverlay', () => ({ ModalOverlay: ({ children }: { children: ReactNode }) => children }))

const i18n = i18next.createInstance()
beforeAll(async () => {
  await i18n.use(initReactI18next).init({ lng: 'en', resources: { en: { translation: en } }, interpolation: { escapeValue: false } })
})

const render = (el: ReactElement, data: [QueryKey, unknown][]) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } })
  for (const [key, value] of data) qc.setQueryData(key, value)
  return renderToStaticMarkup(createElement(I18nextProvider, { i18n }, createElement(QueryClientProvider, { client: qc }, el)))
}
const testIds = (html: string, prefix: string) => [...html.matchAll(new RegExp(`data-testid="${prefix}([^"]+)"`, 'g'))].map((m) => m[1])
const n = (i: number) => String(i).padStart(2, '0')

describe('the Cluster access window', () => {
  const cluster = { id: 'c1', display_name: 'one' } as ClusterMeta
  const grants = Array.from({ length: 12 }, (_, i) => ({ user_id: `u${n(i)}`, name: `User ${i}`, email: `user${n(i)}@example.com`, role: 'Read' }))

  it('shows the first ten of twelve grants and a pager to the other two', () => {
    const html = render(createElement(ClusterAccessModal, { cluster, onClose: () => {} }), [
      [['cluster-user-roles', 'c1'], grants], [['roles'], [{ name: 'Read' }]], [['admin-users', 'all'], []],
    ])
    expect(testIds(html, 'cluster-access-revoke-')).toEqual(grants.slice(0, 10).map((g) => g.user_id))
    expect(html).toContain('1-10 / 12')
    expect(html).toContain('data-testid="cluster-access-search"')
  })

  it('has no pager while the grants fit one page', () => {
    const html = render(createElement(ClusterAccessModal, { cluster, onClose: () => {} }), [
      [['cluster-user-roles', 'c1'], grants.slice(0, 3)], [['roles'], [{ name: 'Read' }]], [['admin-users', 'all'], []],
    ])
    expect(testIds(html, 'cluster-access-revoke-')).toEqual(['u00', 'u01', 'u02'])
    expect(html).toContain('<div data-testid="cluster-access-pages"></div>')
  })
})

describe('Settings → Cluster access', () => {
  const clusters = Array.from({ length: 12 }, (_, i) => ({ id: `c${n(i)}`, display_name: `cluster ${i}` }))
  const me = { id: 'me', cluster_roles: Object.fromEntries(clusters.map((c) => [c.id, 'Read'])) } as unknown as Member
  const requests = Array.from({ length: 10 }, (_, i) => ({ id: `r${n(i)}`, cluster_id: 'c00', cluster_name: 'cluster 0', role: 'Write', duration_minutes: 30, status: 'cancelled', created_at: '2026-11-09T00:00:00Z' }))
  const html = () => render(createElement(ClusterAccessSection, { me }), [
    [['access-requests', 'config'], { enabled: true, max_hours: 8, roles: ['Write'], help_text: '', help_url: '' }],
    [['clusters-accessible'], clusters],
    [['access-requests', 'mine'], requests],
    // the server's first page of ten and the count of all twelve
    [myRequestsKey(myRequestsQuery(1)), { items: requests, total: 12 }],
  ])

  it('shows the first ten of twelve clusters and a pager to the other two', () => {
    const ids = testIds(html(), 'account-cluster-').filter((id) => /^c\d+$/.test(id))
    expect(ids).toEqual(clusters.slice(0, 10).map((c) => c.id))
    expect(html()).toMatch(/data-testid="cluster-access-rows-pages"><div[^>]*><span>1-10 \/ 12<\/span>/)
  })

  it('My requests shows the page the server sent and counts every request', () => {
    expect(testIds(html(), 'my-access-request-')).toEqual(requests.map((r) => r.id))
    expect(html()).toMatch(/data-testid="my-access-requests-pages"><div[^>]*><span>1-10 \/ 12<\/span>/)
  })
})
