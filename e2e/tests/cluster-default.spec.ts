import { test, expect, type APIRequestContext, type Page } from '@playwright/test'

// A request without ?cluster= targets the registry's default cluster (self
// when one is registered) and is authorized against that same cluster: a grant
// on a cluster that happens to be called "default" does not open it, and what
// the request records (recording, audit) names it. The dev registry holds the
// in-cluster `self` (the default) and a second cluster registered as `default`.

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const PASSWORD = 'e2e-cluster-default-throwaway'

type Headers = Record<string, string>

async function login(request: APIRequestContext, email: string, password: string): Promise<Headers> {
  const res = await request.post('/api/v1/auth/login', { data: { email, password } })
  expect(res.ok(), `login ${email}`).toBeTruthy()
  return { Authorization: `Bearer ${(await res.json()).access_token as string}`, 'X-Requested-With': 'XMLHttpRequest' }
}

async function clusters(request: APIRequestContext, admin: Headers): Promise<{ self?: string; hasDefault: boolean }> {
  const body = await (await request.get('/api/v1/clusters', { headers: admin })).json()
  const items = (Array.isArray(body) ? body : body.items || []) as Array<{ id: string; is_self_cluster?: boolean }>
  return { self: items.find((c) => c.is_self_cluster)?.id, hasDefault: items.some((c) => c.id === 'default') }
}

test.describe('cluster resolved once when ?cluster= is omitted', () => {
  test('the default cluster is resolved and gated as itself', async ({ request }) => {
    const admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    const reg = await clusters(request, admin)
    test.skip(!reg.self || !reg.hasDefault || reg.self === 'default', 'needs a self cluster and a separate cluster registered as "default"')

    const current = async (headers: Headers, query = '') =>
      request.get(`/api/v1/cluster/current${query}`, { headers, failOnStatusCode: false })
    expect((await (await current(admin)).json()).id, 'admin without ?cluster=').toBe(reg.self)
    expect((await (await current(admin, '?cluster=default')).json()).id, 'admin with ?cluster=default').toBe('default')

    const roles = await (await request.get('/api/v1/auth/roles', { headers: admin })).json()
    const member = ((Array.isArray(roles) ? roles : roles.items) as Array<{ id: number; name: string }>).find((r) => r.name === 'Member')!.id
    const email = `e2e-cluster-default-${Date.now()}@kubeast.local`
    let userId = ''
    try {
      const created = await request.post('/api/v1/auth/admin/users', { headers: admin, data: { name: 'E2E cluster default', email, password: PASSWORD, role_id: member } })
      expect(created.status(), await created.text()).toBe(201)
      userId = (await created.json()).id as string
      const grant = await request.put(`/api/v1/auth/admin/users/${userId}/cluster-roles/default`, { headers: admin, data: { role: 'Read' } })
      expect(grant.ok(), `grant Read on default: ${await grant.text()}`).toBeTruthy()
      const user = await login(request, email, PASSWORD)

      // Read on "default" only: the omitted cluster is self, which this user may not read.
      for (const path of ['/api/v1/cluster/overview', '/api/v1/cluster/cluster-config', '/api/v1/cluster/metrics/top-resources', '/api/v1/cluster/current']) {
        const res = await request.get(path, { headers: user, failOnStatusCode: false })
        expect(res.status(), `${path} without ?cluster= (self)`).toBe(403)
      }
      // Naming the cluster the user holds works as before.
      for (const path of ['/api/v1/cluster/overview', '/api/v1/cluster/cluster-config', '/api/v1/cluster/current']) {
        const res = await request.get(`${path}?cluster=default`, { headers: user, failOnStatusCode: false })
        expect(res.status(), `${path}?cluster=default`).toBe(200)
      }
    } finally {
      if (userId) await request.delete(`/api/v1/auth/admin/users/${userId}`, { headers: admin })
    }
  })

  test('an exec opened without ?cluster= is recorded under the resolved cluster', async ({ page, request }) => {
    test.setTimeout(90_000)
    const admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    const reg = await clusters(request, admin)
    const recording = await request.get('/api/v1/cluster/recordings/config', { headers: admin })
    test.skip(!reg.self || !recording.ok() || !(await recording.json()).enabled, 'needs a self cluster and session recording on')

    const pods = await (await request.get(`/api/v1/cluster/namespaces/kubeast/pods?cluster=${reg.self}`, { headers: admin })).json()
    const pod = ((Array.isArray(pods) ? pods : pods.items || []) as Array<{ name: string }>).map((p) => p.name).find((n) => n.startsWith('frontend-'))
    expect(pod, 'a frontend pod in kubeast').toBeTruthy()

    await page.goto('/')
    const marker = `e2e-cluster-default-${Date.now().toString(36)}`
    const out = await execAndExit(page, `/api/v1/cluster/namespaces/kubeast/pods/${pod}/exec/ws?command=/bin/sh&cols=80&rows=24`, marker)
    const id = out.match(/This session is recorded \(([0-9a-f-]{36})\)/)?.[1]
    expect(id, `recording notice in: ${out.slice(0, 200)}`).toBeTruthy()
    expect(out, 'the shell ran the command').toContain(marker)

    const meta = await (await request.get(`/api/v1/cluster/recordings/${id}`, { headers: admin })).json()
    expect(meta.cluster, 'recorded cluster').toBe(reg.self)
  })
})

// Runs one command in an exec terminal and ends it with `exit`, so no shell is
// left in the container (a process started through exec outlives the socket).
async function execAndExit(page: Page, path: string, marker: string): Promise<string> {
  return page.evaluate(
    ({ path, marker }) =>
      new Promise<string>((resolve) => {
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
        const ws = new WebSocket(`${proto}//${location.host}${path}`)
        ws.binaryType = 'arraybuffer'
        let text = ''
        let sent = false
        let exited = false
        ws.onmessage = (ev) => {
          const stdout = typeof ev.data !== 'string'
          text += stdout ? new TextDecoder().decode(new Uint8Array(ev.data as ArrayBuffer).slice(1)) : ev.data
          if (!sent && stdout) {
            // the shell is attached once its first output arrives
            sent = true
            ws.send(`echo ${marker}\r`)
          } else if (sent && !exited && text.split(marker).length > 2) {
            exited = true
            ws.send('exit\r')
          }
        }
        ws.onclose = () => resolve(text)
        ws.onerror = () => resolve(text)
        setTimeout(() => { try { ws.close() } catch { /* ignore */ } resolve(text) }, 30_000)
      }),
    { path, marker },
  )
}
