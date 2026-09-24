import { test, expect, type APIRequestContext } from '@playwright/test'

// M1: every watch subscription is authorized against the clusterId it names,
// not only the ?cluster= the socket was opened with. A user granted only on
// `self` must get ERROR for `default` even over a socket opened for `self`.

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''

async function login(request: APIRequestContext, email: string, password: string) {
  const res = await request.post('/api/v1/auth/login', { data: { email, password } })
  expect(res.ok(), `login ${email}`).toBeTruthy()
  return (await res.json()).access_token as string
}

test.describe('ws multiplexer — per-subscription cluster gate (M1)', () => {
  test('a self-only user cannot subscribe to default over a self socket', async ({ browser, request }) => {
    const admin = { Authorization: `Bearer ${await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)}` }
    const email = `e2e-wsgate-${Date.now()}@kubeast.local`
    const password = 'wsgate1234'
    let userId = ''
    try {
      const created = await request.post('/api/v1/auth/admin/users', {
        headers: admin,
        data: { name: 'E2E WS gate', email, password },
      })
      expect(created.status()).toBe(201)
      userId = (await created.json()).id
      const grant = await request.put(`/api/v1/auth/admin/users/${userId}/cluster-roles/self`, {
        headers: admin,
        data: { role: 'Read' },
      })
      expect(grant.status()).toBe(200)

      // Fresh browser context: the login response sets the HttpOnly cookie the
      // WebSocket handshake carries (no token in the URL).
      const ctx = await browser.newContext({ baseURL: process.env.E2E_BASE_URL || 'http://localhost:30080' })
      const page = await ctx.newPage()
      const loginRes = await ctx.request.post('/api/v1/auth/login', { data: { email, password } })
      expect(loginRes.ok()).toBeTruthy()
      await page.goto('/login')

      const results = await page.evaluate(async () => {
        const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/v1/cluster/wsMultiplexer?cluster=self`
        const ws = new WebSocket(wsUrl)
        const got: Record<string, string> = {}
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => resolve(), 8000)
          ws.onerror = () => {
            clearTimeout(timer)
            reject(new Error('ws error'))
          }
          ws.onmessage = (ev) => {
            const msg = JSON.parse(ev.data)
            const cluster = msg.query?.includes('probe=default') ? 'default' : msg.query?.includes('probe=self') ? 'self' : '?'
            if (!got[cluster]) got[cluster] = msg.type === 'ERROR' ? `ERROR:${msg.error?.message || ''}` : msg.type
            if (got.default && got.self) {
              clearTimeout(timer)
              resolve()
            }
          }
          ws.onopen = () => {
            ws.send(JSON.stringify({ type: 'REQUEST', clusterId: 'default', path: '/api/v1/namespaces', query: 'probe=default' }))
            ws.send(JSON.stringify({ type: 'REQUEST', clusterId: 'self', path: '/api/v1/namespaces', query: 'probe=self' }))
          }
        })
        ws.close()
        return got
      })
      await ctx.close()

      expect(results.default, 'default must be refused').toMatch(/^ERROR:forbidden/)
      expect(results.self, 'self must stream').toBe('DATA')
    } finally {
      if (userId) await request.delete(`/api/v1/auth/admin/users/${userId}`, { headers: admin })
    }
  })
})
