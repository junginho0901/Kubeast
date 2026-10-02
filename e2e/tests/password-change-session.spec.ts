import { test, expect, type APIRequestContext } from '@playwright/test'

// Changing your own password bumps token_version so every other session is
// revoked (H11). The caller must not be logged out by it: the response carries
// a fresh session cookie, so the next /auth/me succeeds; the token the request
// came with is dead like any other.
//
// A throw-away user is used (not the admin of auth.setup): bumping the admin's
// token_version would revoke the stored session every later spec runs with.

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const COOKIE = 'kubeast.token'

async function login(request: APIRequestContext, email: string, password: string) {
  const res = await request.post('/api/v1/auth/login', { data: { email, password } })
  expect(res.ok(), `login ${email}`).toBeTruthy()
  return { Authorization: `Bearer ${(await res.json()).access_token as string}` }
}

function sessionCookie(setCookie: string[]): string | null {
  for (const line of setCookie) {
    const m = line.match(new RegExp(`^${COOKIE.replace('.', '\\.')}=([^;]*)`))
    if (m && m[1]) return m[1]
  }
  return null
}

test.describe('password change keeps the current session', () => {
  test.skip(!ADMIN_PASSWORD, 'E2E_USER_PASSWORD not set')

  test('the response sets a new session cookie; the old token is revoked; the cookie works', async ({ request }) => {
    const admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    const email = `e2e-pwchange-${Date.now()}@example.com`
    const password = 'E2e-pwchange-pass1!'
    const created = await request.post('/api/v1/auth/admin/users', { headers: admin, data: { name: 'E2E password change', email, password } })
    expect(created.status(), await created.text()).toBe(201)
    const id = (await created.json()).id as string

    try {
      const user = await login(request, email, password)
      const changed = await request.post('/api/v1/auth/change-password', {
        headers: user,
        data: { current_password: password, new_password: `${password}-2` },
      })
      expect(changed.status(), await changed.text()).toBe(200)
      const cookie = sessionCookie(changed.headersArray().filter((h) => h.name.toLowerCase() === 'set-cookie').map((h) => h.value))
      expect(cookie, 'change-password must set the session cookie').toBeTruthy()

      // the request's own bearer token is gone with the other sessions …
      const old = await request.get('/api/v1/auth/me', { headers: user, failOnStatusCode: false })
      expect(old.status()).toBe(401)
      // … and the cookie from the response is the live session
      const me = await request.get('/api/v1/auth/me', { headers: { Cookie: `${COOKIE}=${cookie}` }, failOnStatusCode: false })
      expect(me.status()).toBe(200)
      expect((await me.json()).email).toBe(email)
      // the new password works for a fresh login; the old one does not
      expect((await request.post('/api/v1/auth/login', { data: { email, password: `${password}-2` }, failOnStatusCode: false })).status()).toBe(200)
      expect((await request.post('/api/v1/auth/login', { data: { email, password }, failOnStatusCode: false })).status()).toBe(401)
    } finally {
      await request.delete(`/api/v1/auth/admin/users/${id}`, { headers: admin, failOnStatusCode: false })
    }
  })
})
