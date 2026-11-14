import { createElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { QueryClient, QueryClientProvider, type QueryKey } from '@tanstack/react-query'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import en from '../../i18n/locales/en.json'
import ko from '../../i18n/locales/ko.json'
import type { ClusterMeta } from '@/services/api/clusters'
import type { Member, Organization, RoleWithDetails } from '@/services/api'
import { clustersMatching, rolesMatching, teamsMatching, usersMatching } from './adminListSearch'
import AdminOrganizations from '../AdminOrganizations'
import AdminRoles from '../AdminRoles'
import AdminClusters from './Clusters'

// Teams, Roles, Clusters and the Users page's Pending window page their rows, so the browser's find reaches only the
// page shown: each has a search box whose text names the fields it reads, and the search reads those fields of every
// row — a team on the twentieth page, a role by a permission past the five its row shows, the cluster Kubeast runs in
// by the "In-cluster" its row shows.

vi.mock('@/components/ModalOverlay', () => ({ ModalOverlay: ({ children }: { children: ReactNode }) => children }))
vi.mock('@/contexts/ClusterContext', () => ({ useCluster: () => ({ currentCluster: 'self' }) }))
vi.mock('@/services/confirm', () => ({ useConfirm: () => async () => false }))

const i18n = i18next.createInstance()
beforeAll(async () => {
  await i18n.use(initReactI18next).init({ lng: 'en', fallbackLng: 'en', resources: { en: { translation: en }, ko: { translation: ko } }, interpolation: { escapeValue: false } })
})

const n = (i: number) => String(i).padStart(3, '0')
const team = (i: number): Organization => ({ id: i, type: 'team', name: `team-${n(i)}`, created_at: '2026-11-01T00:00:00Z' })
const role = (i: number, over: Partial<RoleWithDetails> = {}): RoleWithDetails => ({
  id: i, name: `role-${n(i)}`, description: `custom ${i}`, is_system: false, permissions: ['resource.objects.read'],
  created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z', ...over,
})
const cluster = (i: number, over: Partial<ClusterMeta> = {}): ClusterMeta => ({
  id: `c${n(i)}`, display_name: `cluster-${n(i)}`, mode: 'external', api_server_url: `https://10.0.${i}.1:6443`, is_self_cluster: false,
  health_status: 'healthy', created_by: i % 2 ? 'ops@example.com' : 'dev@example.com', created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z', ...over,
})
const user = (i: number, over: Partial<Member> = {}): Member => ({
  id: `u${n(i)}`, name: `User ${i}`, email: `user${n(i)}@example.com`, team: i % 3 ? 'platform' : 'data', role: null,
  created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z', ...over,
})

describe('the admin list searches', () => {
  it('Teams: finds a team by name among five hundred, wherever its page is, without regard to case or spaces', () => {
    const teams = Array.from({ length: 500 }, (_, i) => team(i))
    expect(teamsMatching(teams, '  TEAM-487 ').map((t) => t.id)).toEqual([487])
    expect(teamsMatching(teams, '')).toEqual(teams)
    expect(teamsMatching(teams, '   ')).toEqual(teams)
    expect(teamsMatching(teams, 'nobody')).toEqual([])
  })

  it('Roles: finds by name, by the description the row shows and by any permission, past the five on the row too', () => {
    const roles = [
      role(1, { permissions: ['a.read', 'b.read', 'c.read', 'd.read', 'e.read', 'admin.audit.read'] }),
      role(2, { name: 'Read', is_system: true, description: 'Read-only on every cluster' }),
      role(3, { description: 'On-call operators' }),
    ]
    const shown = (r: RoleWithDetails) => (r.is_system ? `shown:${r.name}` : r.description)
    expect(rolesMatching(roles, 'admin.audit', shown).map((r) => r.id)).toEqual([1])
    expect(rolesMatching(roles, 'on-call', shown).map((r) => r.id)).toEqual([3])
    // a system role's row shows its description in the viewer's language: that is what the search reads
    expect(rolesMatching(roles, 'shown:read', shown).map((r) => r.id)).toEqual([2])
    expect(rolesMatching(roles, 'every cluster', shown)).toEqual([])
    expect(rolesMatching(roles, 'role-003', shown).map((r) => r.id)).toEqual([3])
  })

  it('Clusters: finds by name, by the API server the row shows and by who registered it', () => {
    const clusters = [...Array.from({ length: 120 }, (_, i) => cluster(i + 1)), cluster(0, { display_name: 'kubeast', api_server_url: undefined, is_self_cluster: true, mode: 'self' })]
    const shown = (c: ClusterMeta) => c.api_server_url || (c.is_self_cluster ? 'In-cluster' : '-')
    expect(clustersMatching(clusters, 'cluster-117', shown).map((c) => c.id)).toEqual(['c117'])
    expect(clustersMatching(clusters, '10.0.42.1', shown).map((c) => c.id)).toEqual(['c042'])
    expect(clustersMatching(clusters, 'in-cluster', shown).map((c) => c.id)).toEqual(['c000'])
    expect(clustersMatching(clusters, 'dev@', shown)).toHaveLength(61)
    expect(clustersMatching(clusters, '', shown)).toEqual(clusters)
  })

  it('Users and the Pending window: find by name, email or team, across every account', () => {
    const users = Array.from({ length: 300 }, (_, i) => user(i))
    expect(usersMatching(users, 'user287@').map((u) => u.id)).toEqual(['u287'])
    expect(usersMatching(users, 'User 12').map((u) => u.id)).toEqual(['u012', 'u120', 'u121', 'u122', 'u123', 'u124', 'u125', 'u126', 'u127', 'u128', 'u129'])
    expect(usersMatching(users, 'DATA')).toHaveLength(100)
    expect(usersMatching([user(1, { email: undefined, team: null })], 'x')).toEqual([])
  })
})

const render = (el: ReactElement, data: [QueryKey, unknown][]) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false, enabled: false } } })
  for (const [key, value] of data) qc.setQueryData(key, value)
  return renderToStaticMarkup(createElement(I18nextProvider, { i18n }, createElement(QueryClientProvider, { client: qc }, el)))
}
const admin = { id: 'me', name: 'admin', permissions_matrix: { '*': ['*'] } } as unknown as Member
const placeholder = (html: string, testId: string) => html.match(new RegExp(`<input[^>]*data-testid="${testId}"[^>]*>`))?.[0].match(/placeholder="([^"]*)"/)?.[1]

describe('the admin list pages', () => {
  it('Teams has a search box that names what it reads', () => {
    const html = render(createElement(AdminOrganizations), [[['organizations', 'team'], [team(1), team(2)]], [['admin-users', 'all'], []], [['me'], admin]])
    expect(placeholder(html, 'teams-search')).toBe('Search teams by name...')
  })

  it('Roles has a search box that names what it reads', () => {
    const html = render(createElement(AdminRoles), [[['roles'], [role(1), role(2)]], [['admin-users', 'all'], []], [['permissions'], []], [['me'], admin]])
    expect(placeholder(html, 'roles-search')).toBe('Search roles by name, description or permission...')
  })

  it('Clusters has a search box that names what it reads', () => {
    const html = render(createElement(AdminClusters), [[['clusters-all'], [cluster(1), cluster(2)]], [['me'], admin]])
    expect(placeholder(html, 'clusters-search')).toBe('Search clusters by name, API server or creator...')
  })

  // The Pending window opens on a click, which a static render does not make: its rows, its pager and its header box
  // are held here to the search, and e2e admin-lists-fit types into it.
  it('the Pending window pages and chooses what its search finds', () => {
    const src = readFileSync(join(process.cwd(), 'src/pages/AdminUsers.tsx'), 'utf8')
    expect(src).toMatch(/const pendingFound = useMemo\(\(\) => usersMatching\(pendingRows, pendingSearch\)/)
    expect(src).toMatch(/usePagination\(pendingFound, 10\)/)
    expect(src).toMatch(/allPendingSelected\(pendingSelectedIds, pendingSearching \? pendingFoundIds : pendingIds\)/)
    expect(src).toMatch(/pendingSearching \? toggleAllFound\(prev, pendingFoundIds\) : toggleAllPendingIds\(prev, pendingIds\)/)
    expect(src).toMatch(/data-testid="admin-users-pending-search"/)
  })
})
