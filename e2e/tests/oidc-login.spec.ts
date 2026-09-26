import { test, expect, type APIRequestContext, type Page } from '@playwright/test'

// OpenID Connect sign-in against a mock provider (e2e/scripts/oidc-mock.sh up).
// The provider is reached as host.docker.internal:8080 by both auth-service
// (from inside kind) and the browser (mapped to 127.0.0.1 here), so the issuer
// matches. Skipped when the server reports no provider.
test.use({
  storageState: { cookies: [], origins: [] },
  launchOptions: { args: ['--host-resolver-rules=MAP host.docker.internal 127.0.0.1'] },
})

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''

test.beforeEach(async ({ request }) => {
  const cfg = await (await request.get('/api/v1/auth/oidc/config')).json()
  test.skip(!cfg.enabled, 'OIDC not enabled on auth-service — run e2e/scripts/oidc-mock.sh up')
})

// Drive the mock provider's login form: any username, plus the claims the ID
// token should carry.
async function signInWithMock(page: Page, claims: Record<string, unknown>) {
  await page.goto('/login')
  await page.getByTestId('sso-login').click()
  await page.waitForURL(/host\.docker\.internal:8080\/default\/authorize/)
  await page.locator('input[name="username"]').fill(String(claims.email))
  await page.locator('textarea[name="claims"]').fill(JSON.stringify(claims))
  await page.locator('input[type="submit"]').click()
}

async function me(page: Page) {
  const res = await page.request.get('/api/v1/auth/me')
  return { status: res.status(), body: res.ok() ? await res.json() : null }
}

async function adminToken(request: APIRequestContext): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } })
  expect(res.ok(), 'admin login should succeed — set E2E_USER_EMAIL / E2E_USER_PASSWORD').toBeTruthy()
  return (await res.json()).access_token
}

test.describe('OIDC sign-in', () => {
  test('login page shows the provider button and the config is public', async ({ page, request }) => {
    const cfg = await (await request.get('/api/v1/auth/oidc/config')).json()
    expect(cfg).toMatchObject({ enabled: true, display_name: 'Mock IdP' })
    await page.goto('/login')
    await expect(page.getByTestId('sso-login')).toContainText('Mock IdP')
  })

  test('first sign-in provisions the user with the mapped role and sets the session cookie', async ({ page }) => {
    const email = `alice-${Date.now()}@example.com`
    await signInWithMock(page, {
      email,
      email_verified: true,
      name: 'Alice',
      groups: ['kubeast-readers', 'unrelated-team'],
    })
    // Back in the app, signed in: the login form is gone and /auth/me answers.
    await page.waitForURL((u) => !u.pathname.startsWith('/login') && !u.host.includes('host.docker.internal'))
    await page.waitForFunction(() => !document.querySelector('input[autocomplete="email"]'), { timeout: 20000 })
    const { status, body } = await me(page)
    expect(status).toBe(200)
    expect(body.email).toBe(email)
    expect(body.name).toBe('Alice')
    expect(body.role?.name).toBe('Read')
    expect(body.auth_source).toBe('oidc')

    const cookies = await page.context().cookies()
    const session = cookies.find((c) => c.name === 'kubeast.token')
    expect(session?.httpOnly).toBe(true)
    // The one-shot login state cookie is consumed by the callback.
    expect(cookies.find((c) => c.name === 'kubeast.oidc')).toBeUndefined()
  })

  test('groups drive the role on every sign-in (sync up, then down)', async ({ page }) => {
    const email = `bob-${Date.now()}@example.com`
    await signInWithMock(page, { email, email_verified: true, groups: ['kubeast-readers'] })
    await page.waitForURL((u) => !u.pathname.startsWith('/login') && !u.host.includes('host.docker.internal'))
    expect((await me(page)).body.role?.name).toBe('Read')

    await page.context().clearCookies()
    await signInWithMock(page, { email, email_verified: true, groups: ['kubeast-admins'] })
    await page.waitForURL((u) => !u.pathname.startsWith('/login') && !u.host.includes('host.docker.internal'))
    expect((await me(page)).body.role?.name).toBe('Admin')

    // Removed from every mapped group: back to the default role (Pending).
    await page.context().clearCookies()
    await signInWithMock(page, { email, email_verified: true, groups: ['unrelated-team'] })
    await page.waitForURL((u) => !u.pathname.startsWith('/login') && !u.host.includes('host.docker.internal'))
    expect((await me(page)).body.role?.name).toBe('Pending')
  })

  test('an email outside the allowed domains is refused', async ({ page }) => {
    await signInWithMock(page, { email: `eve-${Date.now()}@evil.example`, email_verified: true, groups: [] })
    await page.waitForURL(/\/login\?error=oidc_domain/)
    await expect(page.getByTestId('sso-error')).toBeVisible()
    expect((await me(page)).status).toBe(401)
  })

  test('an unverified email is refused', async ({ page }) => {
    await signInWithMock(page, { email: `mallory-${Date.now()}@example.com`, email_verified: false })
    await page.waitForURL(/\/login\?error=oidc_email_unverified/)
    expect((await me(page)).status).toBe(401)
  })

  test('a callback without the login state cookie is refused', async ({ page }) => {
    await page.goto('/api/v1/auth/oidc/callback?code=x&state=y')
    await page.waitForURL(/\/login\?error=oidc_state/)
    expect((await me(page)).status).toBe(401)
  })

  test('a provisioned account cannot sign in with a password', async ({ page, request }) => {
    const email = `carol-${Date.now()}@example.com`
    await signInWithMock(page, { email, email_verified: true, groups: ['kubeast-readers'] })
    await page.waitForURL((u) => !u.pathname.startsWith('/login') && !u.host.includes('host.docker.internal'))
    const res = await request.post('/api/v1/auth/login', { data: { email, password: '' } })
    expect(res.status()).toBe(401)
    const res2 = await request.post('/api/v1/auth/login', { data: { email, password: 'anything-at-all-123' } })
    expect(res2.status()).toBe(401)
  })

  test('audit rows: provision, role sync, and login success/failure name the OIDC path', async ({ page, request }) => {
    const email = `dave-${Date.now()}@example.com`
    await signInWithMock(page, { email, email_verified: true, groups: ['kubeast-readers'] })
    await page.waitForURL((u) => !u.pathname.startsWith('/login') && !u.host.includes('host.docker.internal'))
    await page.context().clearCookies()
    await signInWithMock(page, { email, email_verified: true, groups: ['kubeast-writers'] })
    await page.waitForURL((u) => !u.pathname.startsWith('/login') && !u.host.includes('host.docker.internal'))

    const token = await adminToken(request)
    // The list filters by action; rows for this user are picked out by email.
    const list = async (action: string) => {
      const res = await request.get('/api/v1/auth/admin/audit-logs', {
        headers: { Authorization: `Bearer ${token}` },
        params: { action, limit: 200 },
      })
      expect(res.ok()).toBeTruthy()
      const { items } = (await res.json()) as { items: Array<Record<string, unknown>> }
      return items.filter((e) => JSON.stringify(e).includes(email))
    }
    expect((await list('user.account.provision')).length).toBe(1)
    expect((await list('user.role.sync')).length).toBe(1)
    expect((await list('user.login.success')).length).toBeGreaterThanOrEqual(2)
  })
})
