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
    const password = 'e2e-ws-gate-throwaway'
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

test.describe('ws multiplexer — the watches of one tab', () => {
  test('closed watches leave the limit of 50 free, open ones stop at it, and each frame names its cluster', async ({ page }) => {
    test.setTimeout(120_000)
    await page.goto('/')
    const got = await page.evaluate(async () => {
      const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/v1/cluster/wsMultiplexer?cluster=self`)
      await new Promise((resolve, reject) => {
        ws.onopen = resolve
        ws.onerror = () => reject(new Error('ws error'))
      })
      type Frame = { type: string; clusterId?: string; query?: string; error?: { message?: string } }
      const waiting = new Map<string, (f: Frame) => void>()
      ws.onmessage = (ev) => {
        const f = JSON.parse(ev.data) as Frame
        const deliver = waiting.get(f.query ?? '')
        if (deliver) {
          waiting.delete(f.query ?? '')
          deliver(f)
        }
      }
      const message = (type: string, query: string) => JSON.stringify({ type, clusterId: 'self', path: '/api/v1/namespaces', query })
      const firstFrame = (query: string) => new Promise<Frame>((resolve) => {
        const timer = setTimeout(() => {
          waiting.delete(query)
          resolve({ type: 'no frame' })
        }, 15_000)
        waiting.set(query, (f) => {
          clearTimeout(timer)
          resolve(f)
        })
        ws.send(message('REQUEST', query))
      })

      const closed: Frame[] = []
      for (let i = 0; i < 60; i += 1) {
        closed.push(await firstFrame(`watch=1&closed=${i}`))
        ws.send(message('CLOSE', `watch=1&closed=${i}`))
      }
      const open: Frame[] = []
      for (let i = 0; i < 50; i += 1) open.push(await firstFrame(`watch=1&open=${i}`))
      const pastTheLimit = await firstFrame('watch=1&past=1')
      ws.send(message('CLOSE', 'watch=1&open=0'))
      const afterOneClosed = await firstFrame('watch=1&past=1')
      ws.close()
      return {
        closed: closed.map((f) => `${f.type} ${f.clusterId}`),
        open: open.map((f) => f.type),
        pastTheLimit: pastTheLimit.error?.message,
        afterOneClosed: afterOneClosed.type,
      }
    })
    expect(got.closed).toEqual(Array(60).fill('DATA self'))
    expect(got.open).toEqual(Array(50).fill('DATA'))
    expect(got.pastTheLimit).toBe('max subscriptions reached for this connection (50), cannot create new watch')
    expect(got.afterOneClosed).toBe('DATA')
  })
})
