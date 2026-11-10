import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeAll, describe, expect, it } from 'vitest'
import en from '../../i18n/locales/en.json'
import AccessRequests from './AccessRequests'
import { accessRequestQuery } from './accessRequestPages'

const i18n = i18next.createInstance()
beforeAll(async () => {
  await i18n.use(initReactI18next).init({ lng: 'en', resources: { en: { translation: en } }, interpolation: { escapeValue: false } })
})

const FIT_START = 12

const request = (id: string, role: string) => ({
  id, user_id: 'requester', user_email: 'req@example.com', user_name: 'Req', cluster_id: 'c1', cluster_name: 'one',
  role, duration_minutes: 60, reason: 'needed', status: 'pending', created_at: '2026-11-08T00:00:00Z',
})

const render = (me: Record<string, unknown>) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } })
  qc.setQueryData(['me'], { id: 'approver', ...me })
  qc.setQueryData(['roles'], [{ name: 'ops', chart_bound: true }, { name: 'Write' }])
  qc.setQueryData(['access-requests', 'config'], { enabled: true, max_hours: 8, roles: ['Write', 'ops'] })
  // the page asks for the rows its table fits: 12 before it has measured the screen (useAdaptiveRowsPerPage)
  qc.setQueryData(['access-requests', 'admin', 'list', 'pending', accessRequestQuery('pending', '', 1, FIT_START)], { items: [request('r1', 'ops'), request('r2', 'Write')], total: 2, offset: 0, limit: FIT_START })
  qc.setQueryData(['access-requests', 'admin', 'list', 'history', accessRequestQuery('history', '', 1, FIT_START)], { items: [], total: 0, offset: 0, limit: FIT_START })
  return renderToStaticMarkup(createElement(I18nextProvider, { i18n }, createElement(QueryClientProvider, { client: qc }, createElement(AccessRequests))))
}

const approveButton = (html: string, id: string) => html.match(new RegExp(`<button[^>]*data-testid="access-request-approve-${id}"[^>]*>`))?.[0] ?? ''

// auth-service gives a role the chart binds only through a global admin or an Admin of its cluster; the button follows.
describe('approving a role the chart binds', () => {
  it('is closed to a user admin who holds less on the cluster, with why, and the other requests stay open', () => {
    const html = render({ permissions_matrix: { '*': ['admin.users.update'], c1: ['resource.*.read'] }, cluster_roles: { c1: 'Read' } })
    expect(approveButton(html, 'r1')).toContain('disabled=""')
    expect(html).toContain('data-testid="access-request-chart-bound-r1"')
    expect(html).toContain(en.accessRequests.admin.chartBound)
    expect(approveButton(html, 'r2')).not.toContain('disabled=""')
    expect(html).not.toContain('data-testid="access-request-chart-bound-r2"')
  })

  it('is open to an Admin of the cluster and to a global admin', () => {
    for (const me of [
      { permissions_matrix: { '*': ['admin.users.update'], c1: ['*'] }, cluster_roles: { c1: 'Admin' } },
      { permissions_matrix: { '*': ['*'] } },
    ]) {
      const html = render(me)
      expect(approveButton(html, 'r1')).not.toContain('disabled=""')
      expect(html).not.toContain('data-testid="access-request-chart-bound-r1"')
    }
  })

  it('stays closed to an Admin of the cluster limited to namespaces', () => {
    const html = render({ permissions_matrix: { '*': ['admin.users.update'], c1: ['*'] }, cluster_roles: { c1: 'Admin' }, cluster_namespaces: { c1: ['team-a'] } })
    expect(approveButton(html, 'r1')).toContain('disabled=""')
  })
})
