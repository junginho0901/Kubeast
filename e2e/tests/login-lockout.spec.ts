import { test, expect, type APIRequestContext } from '@playwright/test'

// H13: repeated password failures lock the account for a while. The response
// stays the generic 401 whether the password was wrong or the account is
// locked; the audit log says which. A successful login clears the counter.

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const MAX_FAILURES = 5

async function adminHeaders(request: APIRequestContext) {
  const res = await request.post('/api/v1/auth/login', { data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } })
  expect(res.ok(), 'admin login').toBeTruthy()
  return { Authorization: `Bearer ${(await res.json()).access_token as string}` }
}

async function login(request: APIRequestContext, email: string, password: string) {
  const res = await request.post('/api/v1/auth/login', { data: { email, password }, failOnStatusCode: false })
  return { status: res.status(), body: await res.text() }
}

test.describe('login lockout (H13)', () => {
  test('the account locks after repeated wrong passwords and the audit log records it', async ({ request }) => {
    const admin = await adminHeaders(request)
    const email = `e2e-lockout-${Date.now()}@kubeast.local`
    const password = 'e2e-lockout-throwaway-1'
    const created = await request.post('/api/v1/auth/admin/users', { headers: admin, data: { name: 'E2E lockout', email, password } })
    expect(created.status()).toBe(201)
    const id = (await created.json()).id as string
    try {
      // Sanity: the right password works before any failure.
      expect((await login(request, email, password)).status).toBe(200)

      // MAX_FAILURES wrong passwords: every one is the same generic 401.
      for (let i = 1; i <= MAX_FAILURES; i++) {
        const r = await login(request, email, 'wrong-password')
        expect(r.status, `failure ${i}`).toBe(401)
        expect(r.body).toContain('Invalid credentials')
      }
      // Now even the right password is refused, with the same message.
      const locked = await login(request, email, password)
      expect(locked.status).toBe(401)
      expect(locked.body).toContain('Invalid credentials')
      expect(locked.body).not.toMatch(/lock/i)

      // The audit log carries the lock and the refused attempt (rows are
      // PascalCase: Action, ActorEmail, After).
      const rows = async (action: string) => {
        const res = await request.get(`/api/v1/auth/admin/audit-logs?action=${action}&limit=200`, { headers: admin })
        expect(res.ok(), `audit list ${action}`).toBeTruthy()
        const body = await res.json()
        const items: any[] = Array.isArray(body) ? body : body.items || []
        return items.filter((r) => r.ActorEmail === email || r.TargetEmail === email)
      }
      const lockedRows = await rows('user.login.locked')
      expect(lockedRows.length, 'one user.login.locked row').toBe(1)
      expect(lockedRows[0].After?.failures).toBe(MAX_FAILURES)
      expect(typeof lockedRows[0].After?.locked_until).toBe('string')
      const failed = await rows('user.login.failed')
      expect(failed.some((r) => r.After?.reason === 'locked'), 'the attempt while locked is audited with reason locked').toBeTruthy()
      expect(failed.filter((r) => r.After?.reason === 'password_mismatch').length).toBe(MAX_FAILURES)
    } finally {
      await request.delete(`/api/v1/auth/admin/users/${id}`, { headers: admin })
    }
  })

  test('a successful login clears the failure count', async ({ request }) => {
    const admin = await adminHeaders(request)
    const email = `e2e-lockout-reset-${Date.now()}@kubeast.local`
    const password = 'e2e-lockout-throwaway-2'
    const created = await request.post('/api/v1/auth/admin/users', { headers: admin, data: { name: 'E2E lockout reset', email, password } })
    expect(created.status()).toBe(201)
    const id = (await created.json()).id as string
    try {
      for (let i = 1; i < MAX_FAILURES; i++) expect((await login(request, email, 'wrong-password')).status).toBe(401)
      expect((await login(request, email, password)).status, 'one below the threshold still signs in').toBe(200)
      // The streak restarted: another MAX_FAILURES-1 failures do not lock.
      for (let i = 1; i < MAX_FAILURES; i++) expect((await login(request, email, 'wrong-password')).status).toBe(401)
      expect((await login(request, email, password)).status, 'counter was reset by the success').toBe(200)
    } finally {
      await request.delete(`/api/v1/auth/admin/users/${id}`, { headers: admin })
    }
  })
})
