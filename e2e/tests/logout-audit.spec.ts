import { test, expect, type APIRequestContext } from '@playwright/test'

// POST /auth/logout is a public route (a session that already expired must
// still be able to sign out), so the audit row's actor comes from the token
// the client sends, expiry ignored. API-client path (Bearer); the project's
// session cookie is dropped.
test.use({ storageState: { cookies: [], origins: [] } })

const EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const PASSWORD = process.env.E2E_USER_PASSWORD || ''

async function login(request: APIRequestContext): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email: EMAIL, password: PASSWORD } })
  expect(res.ok(), 'admin login should succeed — set E2E_USER_EMAIL / E2E_USER_PASSWORD').toBeTruthy()
  return (await res.json()).access_token
}

async function logoutRows(request: APIRequestContext, token: string, since: string) {
  const res = await request.get('/api/v1/auth/admin/audit-logs', {
    headers: { Authorization: `Bearer ${token}` },
    params: { action: 'user.logout', since, limit: 50 },
  })
  expect(res.ok()).toBeTruthy()
  const { items } = (await res.json()) as { items: Array<Record<string, unknown>> }
  return items
}

test.describe('logout audit', () => {
  test('signing out with a Bearer token leaves a user.logout row naming the actor', async ({ request }) => {
    const since = new Date(Date.now() - 5000).toISOString()
    const token = await login(request)
    const out = await request.post('/api/v1/auth/logout', { headers: { Authorization: `Bearer ${token}` } })
    expect(out.status()).toBe(200)

    const admin = await login(request)
    const rows = await logoutRows(request, admin, since)
    const mine = rows.filter((r) => JSON.stringify(r).includes(EMAIL))
    expect(mine.length).toBeGreaterThanOrEqual(1)
  })

  test('signing out with the session cookie also leaves a row', async ({ request }) => {
    const since = new Date(Date.now() - 5000).toISOString()
    await login(request) // the API context now holds the session cookie
    const out = await request.post('/api/v1/auth/logout', { headers: { 'X-Requested-With': 'XMLHttpRequest' } })
    expect(out.status()).toBe(200)

    const admin = await login(request)
    const rows = await logoutRows(request, admin, since)
    expect(rows.filter((r) => JSON.stringify(r).includes(EMAIL)).length).toBeGreaterThanOrEqual(1)
  })

  test('signing out without a valid token still succeeds and records no actor', async ({ request }) => {
    const since = new Date(Date.now() - 5000).toISOString()
    const out = await request.post('/api/v1/auth/logout', { headers: { Authorization: 'Bearer not-a-token' } })
    expect(out.status()).toBe(200)
    const admin = await login(request)
    const rows = await logoutRows(request, admin, since)
    expect(rows.filter((r) => JSON.stringify(r).includes('not-a-token')).length).toBe(0)
  })
})
