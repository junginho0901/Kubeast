import { test, expect } from '@playwright/test'

// Setup and model-config endpoints must not be reachable without a session
// (C3/M7). The project's storageState carries the admin session cookie, which
// the API now accepts, so these tests run with an empty state: no cookie, no
// header.
test.describe('setup / model-config endpoints require authentication', () => {
  test.use({ storageState: { cookies: [], origins: [] } })

  test('GET /auth/setup is public and exposes only `configured`', async ({ request }) => {
    const res = await request.get('/api/v1/auth/setup')
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(Object.keys(body).sort()).toEqual(['configured'])
  })

  test('POST /auth/setup without a token → 401', async ({ request }) => {
    const res = await request.post('/api/v1/auth/setup', { data: { mode: 'in_cluster' } })
    expect(res.status()).toBe(401)
  })

  test('GET /auth/setup/status and rollout-status without a token → 401', async ({ request }) => {
    expect((await request.get('/api/v1/auth/setup/status')).status()).toBe(401)
    expect((await request.get('/api/v1/auth/setup/rollout-status')).status()).toBe(401)
  })

  test('POST /ai/model-configs/test without a token → 401', async ({ request }) => {
    const res = await request.post('/api/v1/ai/model-configs/test', {
      data: { provider: 'ollama', model: 'x', base_url: 'http://127.0.0.1:1' },
    })
    expect(res.status()).toBe(401)
  })

  test('POST /ai/model-configs/setup no longer exists', async ({ request }) => {
    const res = await request.post('/api/v1/ai/model-configs/setup', { data: { name: 'x', model: 'y' } })
    expect([404, 405]).toContain(res.status())
  })

  test('GET /ai/health is public and minimal', async ({ request }) => {
    const res = await request.get('/api/v1/ai/health')
    expect(res.status()).toBe(200)
    expect(await res.json()).toEqual({ status: 'healthy' })
  })
})

// The browser session: an HttpOnly cookie (M6-c). page.request shares it.
test.describe('browser session cookie', () => {
  test('metadata endpoint is rejected as base_url even for admin', async ({ page }) => {
    // A cookie-authenticated write needs the CSRF header the app sends.
    const res = await page.request.post('/api/v1/ai/model-configs/test', {
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
      data: { provider: 'ollama', model: 'x', base_url: 'http://169.254.169.254/latest' },
    })
    expect(res.status()).toBe(400)
  })

  test('a cookie-authenticated write without X-Requested-With is refused (CSRF)', async ({ page }) => {
    const res = await page.request.post('/api/v1/ai/model-configs/test', {
      data: { provider: 'ollama', model: 'x', base_url: 'http://127.0.0.1:1' },
      failOnStatusCode: false,
    })
    expect(res.status()).toBe(403)
    const k8s = await page.request.post('/api/v1/namespaces', {
      data: { name: 'csrf-probe' },
      failOnStatusCode: false,
    })
    expect(k8s.status()).toBe(403)
    const auth = await page.request.post('/api/v1/auth/refresh', { failOnStatusCode: false })
    expect(auth.status()).toBe(403)
  })

  test('the session cookie is HttpOnly and the page keeps no token', async ({ page }) => {
    await page.goto('/')
    const cookie = (await page.context().cookies()).find((c) => c.name === 'kubeast.token')
    expect(cookie?.httpOnly, 'session cookie is HttpOnly').toBe(true)
    expect(cookie?.sameSite).toBe('Strict')
    const stored = await page.evaluate(() =>
      Object.keys(localStorage).filter((k) => /token/i.test(k)),
    )
    expect(stored).toEqual([])
  })
})
