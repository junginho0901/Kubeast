import { test, expect } from '@playwright/test'

// Setup and model-config endpoints must not be reachable without a token
// (C3/M7). `request` here carries no Authorization header — storageState only
// holds the browser's localStorage token, which the API does not read.
test.describe('setup / model-config endpoints require authentication', () => {
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

  test('metadata endpoint is rejected as base_url even for admin', async ({ page, request }) => {
    await page.goto('/')
    const token = await page.evaluate(() => localStorage.getItem('kubeast:access-token'))
    expect(token, 'admin token from storage state').toBeTruthy()
    const res = await request.post('/api/v1/ai/model-configs/test', {
      headers: { Authorization: `Bearer ${token}` },
      data: { provider: 'ollama', model: 'x', base_url: 'http://169.254.169.254/latest' },
    })
    expect(res.status()).toBe(400)
  })
})
