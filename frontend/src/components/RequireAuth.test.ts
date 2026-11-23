import { describe, expect, it, vi } from 'vitest'
import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import RequireAuth from './RequireAuth'
import RequirePermission from './RequirePermission'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options: { defaultValue: string } & Record<string, string>) =>
      options.defaultValue.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => options[name] ?? ''),
  }),
}))

// What the guards draw for the state the session read is in: the page they guard, the sign-in page (Navigate, which
// draws nothing), or, before any answer, a page saying the read is asked again. Only the server's 401 is a sign-out.
const me = { id: 'u1', email: 'u1@example.com', role: 'Admin', permissions_matrix: { '*': ['*'] }, token_ttl_minutes: 15 }
const answered = (status: number, detail = '') => ({ response: { status, data: { detail } }, message: `Request failed with status code ${status}` })
const unreadable = answered(503, 'Session could not be checked; try again')
const PAGE = '<main>the page</main>'

// The read as the page holds it after its failures; retryOnMount off so that drawing it does not start a new read,
// which would show it as loading again.
function sessionRead(state: { data?: unknown; error?: unknown; failures?: number }): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retryOnMount: false } } })
  const query = client.getQueryCache().build(client, { queryKey: ['me'] })
  query.setState({
    ...query.state,
    data: state.data,
    dataUpdatedAt: state.data === undefined ? 0 : Date.now(),
    status: state.error !== undefined ? 'error' : state.data === undefined ? 'pending' : 'success',
    error: (state.error ?? null) as Error | null,
    fetchFailureCount: state.failures ?? (state.error !== undefined ? 1 : 0),
    fetchFailureReason: (state.error ?? null) as Error | null,
  })
  return client
}

function draw(client: QueryClient, guard: (page: ReactElement) => ReactElement): string {
  return renderToStaticMarkup(
    createElement(MemoryRouter, { initialEntries: ['/workloads/pods'] },
      createElement(QueryClientProvider, { client }, guard(createElement('main', null, 'the page')))),
  )
}

const requireAuth = (page: ReactElement) => createElement(RequireAuth, null, page)
const requirePermission = (page: ReactElement) => createElement(RequirePermission, { permission: 'resource.objects.read', children: page })

describe('a guard of the console while the session cannot be checked', () => {
  for (const [name, guard] of [['RequireAuth', requireAuth], ['RequirePermission', requirePermission]] as const) {
    it(`${name} keeps the page when a read of the session answered 503, 500 or nothing`, () => {
      for (const failure of [unreadable, answered(500), answered(429), new Error('timeout of 10000ms exceeded')]) {
        expect(draw(sessionRead({ data: me, error: failure }), guard)).toBe(PAGE)
      }
    })

    it(`${name} goes to sign in on the server's 401`, () => {
      expect(draw(sessionRead({ data: me, error: answered(401, 'Token revoked') }), guard)).toBe('')
    })
  }

  it('RequireAuth, with no session read yet, says it is asking again with the server\'s reason, not that the session ended', () => {
    expect(draw(sessionRead({}), requireAuth)).toBe('<div class="min-h-screen bg-slate-900"></div>') // no failure yet
    const waiting = draw(sessionRead({ error: unreadable, failures: 2 }), requireAuth)
    expect(waiting).toContain('data-testid="session-check-waiting"')
    expect(waiting).toContain('Could not check your sign-in: Session could not be checked; try again. Asking again')
    expect(waiting).not.toContain('the page')
  })

  it('RequireAuth, with no session read yet, goes to sign in on the server\'s 401', () => {
    expect(draw(sessionRead({ error: answered(401) }), requireAuth)).toBe('')
  })
})
