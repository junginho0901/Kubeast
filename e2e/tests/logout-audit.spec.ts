import { test, expect, type APIRequestContext } from '@playwright/test'

// POST /auth/logout is a public route (a session that already expired must
// still be able to sign out), so the audit row's actor comes from the token
// the client sends, expiry ignored. API-client path (Bearer); the project's
// session cookie is dropped. A sign-out ends that sign-in on the server, and
// a sign-in of the same account in the same second is the same sign-in, so
// the sign-outs here are of a throwaway account of the run, removed after.
test.use({ storageState: { cookies: [], origins: [] } })

const EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const PASSWORD = process.env.E2E_USER_PASSWORD || ''
const STAMP = Date.now().toString(36)
const PW = 'E2e-logout-audit-throwaway-1!'
let admin = ''
let memberRole = 0
const made: string[] = []

async function login(request: APIRequestContext, email = EMAIL, password = PASSWORD): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email, password } })
  expect(res.ok(), `login ${email} should succeed — set E2E_USER_EMAIL / E2E_USER_PASSWORD`).toBeTruthy()
  return (await res.json()).access_token
}

async function throwaway(request: APIRequestContext, name: string): Promise<string> {
  const email = `e2e-logout-${name}-${STAMP}@kubeast.local`
  const res = await request.post('/api/v1/auth/admin/users', {
    headers: { Authorization: `Bearer ${admin}` },
    data: { name: 'E2E logout audit', email, password: PW, role_id: memberRole },
  })
  expect(res.status(), `create ${email}`).toBe(201)
  made.push((await res.json()).id)
  return email
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

test.beforeAll(async ({ request }) => {
  admin = await login(request)
  const roles = (await (await request.get('/api/v1/auth/roles', { headers: { Authorization: `Bearer ${admin}` } })).json()) as { id: number; name: string }[]
  memberRole = roles.find((r) => r.name === 'Member')!.id
})

test.afterAll(async ({ request }) => {
  for (const id of made) await request.delete(`/api/v1/auth/admin/users/${id}`, { headers: { Authorization: `Bearer ${admin}` }, failOnStatusCode: false })
})

test.describe('logout audit', () => {
  test('signing out with a Bearer token leaves a user.logout row naming the actor, and the token is refused after', async ({ request }) => {
    const since = new Date(Date.now() - 5000).toISOString()
    const email = await throwaway(request, 'bearer')
    const token = await login(request, email, PW)
    const out = await request.post('/api/v1/auth/logout', { headers: { Authorization: `Bearer ${token}` } })
    expect(out.status()).toBe(200)
    expect((await request.get('/api/v1/auth/me', { headers: { Authorization: `Bearer ${token}` }, failOnStatusCode: false })).status(), 'the sign-in ended').toBe(401)

    const rows = await logoutRows(request, admin, since)
    const mine = rows.filter((r) => JSON.stringify(r).includes(email))
    expect(mine.length).toBeGreaterThanOrEqual(1)
  })

  test('signing out with the session cookie also leaves a row', async ({ request }) => {
    const since = new Date(Date.now() - 5000).toISOString()
    const email = await throwaway(request, 'cookie')
    const token = await login(request, email, PW) // the API context now holds the session cookie
    const out = await request.post('/api/v1/auth/logout', { headers: { 'X-Requested-With': 'XMLHttpRequest' } })
    expect(out.status()).toBe(200)
    expect((await request.get('/api/v1/auth/me', { headers: { Authorization: `Bearer ${token}` }, failOnStatusCode: false })).status(), 'the sign-in ended').toBe(401)

    const rows = await logoutRows(request, admin, since)
    expect(rows.filter((r) => JSON.stringify(r).includes(email)).length).toBeGreaterThanOrEqual(1)
  })

  test('signing out without a valid token still succeeds and records no actor', async ({ request }) => {
    const since = new Date(Date.now() - 5000).toISOString()
    const out = await request.post('/api/v1/auth/logout', { headers: { Authorization: 'Bearer not-a-token' } })
    expect(out.status()).toBe(200)
    const rows = await logoutRows(request, admin, since)
    expect(rows.filter((r) => JSON.stringify(r).includes('not-a-token')).length).toBe(0)
  })
})
