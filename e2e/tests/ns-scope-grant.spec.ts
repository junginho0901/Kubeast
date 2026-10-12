import { test, expect, type APIRequestContext } from '@playwright/test'

// Namespace-scoped grants (A-1, records/ns-scope-20261012.md): a per-cluster role limited to a list of namespaces.
// The grant API validates the list, /auth/me and the token carry it, an access request can carry one too, an
// approval applies it and the expiry restores the previous list. API only; throwaway users are removed at the end.
// The cluster-side gate (k8s-service, tool-server) and the chart bindings come in A-2/A-3.

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const PW = 'E2e-nsscope-pass1!'
const CLUSTER = 'self'
const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })

async function login(request: APIRequestContext, email: string, password: string): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email, password } })
  expect(res.ok(), `login ${email}: ${res.status()}`).toBeTruthy()
  return (await res.json()).access_token
}

async function createUser(request: APIRequestContext, admin: string, email: string): Promise<string> {
  const raw = await (await request.get('/api/v1/auth/roles', { headers: bearer(admin) })).json()
  const member = (Array.isArray(raw) ? raw : raw.roles || raw.items || []).find((r: { name: string }) => r.name.toLowerCase() === 'member')
  const res = await request.post('/api/v1/auth/admin/users', { headers: bearer(admin), data: { name: 'E2E ns scope', email, password: PW, role_id: member.id } })
  expect(res.status(), `create ${email}`).toBe(201)
  return (await res.json()).id
}

async function grant(request: APIRequestContext, admin: string, userId: string, role: string, namespaces?: string[]) {
  return request.put(`/api/v1/auth/admin/users/${userId}/cluster-roles/${CLUSTER}`, { headers: bearer(admin), data: { role, ...(namespaces ? { namespaces } : {}) }, failOnStatusCode: false })
}

async function me(request: APIRequestContext, token: string) {
  return (await request.get('/api/v1/auth/me', { headers: bearer(token) })).json()
}

function claims(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'))
}

test.describe('namespace-scoped grants', () => {
  test('a grant with namespaces is validated, lands in /auth/me and in the token, and an unscoped grant clears it', async ({ request }) => {
    const admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    const email = `e2e-ns-${Date.now().toString(36)}@kubeast.local`
    let userId = ''
    try {
      userId = await createUser(request, admin, email)

      // Validation: name shape, duplicates and the cap.
      expect((await grant(request, admin, userId, 'Read', ['Bad Name'])).status(), 'invalid name').toBe(400)
      expect((await grant(request, admin, userId, 'Read', Array.from({ length: 51 }, (_, i) => `ns-${i}`))).status(), 'cap 50').toBe(400)
      const ok = await grant(request, admin, userId, 'Read', ['web', 'api', 'web', ' api '])
      expect(ok.status(), await ok.text()).toBe(200)
      expect((await ok.json()).namespaces).toEqual(['api', 'web'])

      // /auth/me and the token carry the scope; the role itself is unchanged.
      const token = await login(request, email, PW)
      const m = await me(request, token)
      expect(m.cluster_roles?.[CLUSTER]).toBe('Read')
      expect(m.cluster_namespaces?.[CLUSTER]).toEqual(['api', 'web'])
      expect(m.permissions_matrix?.[CLUSTER]).toContain('resource.*.read')
      const c = claims(token)
      expect((c.ns as Record<string, string[]>)?.[CLUSTER]).toEqual(['api', 'web'])

      // The grants list and the cluster's access list show it; the audit row records it.
      const list = await (await request.get(`/api/v1/auth/admin/clusters/${CLUSTER}/user-roles`, { headers: bearer(admin) })).json()
      const row = (list as { email: string; namespaces?: string[] }[]).find((r) => r.email === email)
      expect(row?.namespaces).toEqual(['api', 'web'])
      await expect.poll(async () => {
        const rows = (await (await request.get('/api/v1/auth/admin/audit-logs?action=user.cluster_role.set&limit=50', { headers: bearer(admin) })).json()).items as any[]
        const mine = rows.find((r) => (r.TargetEmail ?? r.target_email) === email && (r.Result ?? r.result) === 'success')
        return (mine?.After ?? mine?.after)?.namespaces
      }, { timeout: 10_000 }).toEqual(['api', 'web'])

      // Re-granting without namespaces widens back to the whole cluster.
      expect((await grant(request, admin, userId, 'Read')).status()).toBe(200)
      const whole = await me(request, await login(request, email, PW))
      expect(whole.cluster_namespaces?.[CLUSTER]).toBeUndefined()
      expect(claims(await login(request, email, PW)).ns).toBeUndefined()
    } finally {
      if (userId) await request.delete(`/api/v1/auth/admin/users/${userId}`, { headers: bearer(admin), failOnStatusCode: false })
    }
  })

  test('an access request carries namespaces: within the grant only, applied on approval, restored on expiry', async ({ request }) => {
    test.setTimeout(240_000)
    const admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    const cfg = await request.get('/api/v1/auth/access-requests/config', { headers: bearer(admin) })
    test.skip(!cfg.ok() || !(await cfg.json()).enabled, 'access requests are off (auth.accessRequests.enabled)')
    const email = `e2e-ns-ar-${Date.now().toString(36)}@kubeast.local`
    let userId = ''
    try {
      userId = await createUser(request, admin, email)
      expect((await grant(request, admin, userId, 'Read', ['web', 'api'])).status()).toBe(200)
      const user = await login(request, email, PW)
      const ask = (data: object) => request.post('/api/v1/auth/access-requests', { headers: bearer(user), data: { cluster_id: CLUSTER, role: 'Write', duration_minutes: 1, reason: 'e2e ns scope', ...data }, failOnStatusCode: false })

      // A scoped grant may ask only within its namespaces, and must name them.
      expect((await ask({})).status(), 'the whole cluster from a scoped grant').toBe(400)
      expect((await ask({ namespaces: ['web', 'db'] })).status(), 'outside the grant').toBe(400)
      const created = await ask({ namespaces: ['web'] })
      expect(created.status(), await created.text()).toBe(201)
      const req = await created.json()
      expect(req.namespaces).toEqual(['web'])

      // Approval: Write on web only for a minute, then Read on web+api again.
      const approved = await request.post(`/api/v1/auth/admin/access-requests/${req.id}/approve`, { headers: bearer(admin), data: { note: 'e2e' } })
      expect(approved.status(), await approved.text()).toBe(200)
      const elevated = await me(request, await login(request, email, PW))
      expect(elevated.cluster_roles?.[CLUSTER]).toBe('Write')
      expect(elevated.cluster_namespaces?.[CLUSTER]).toEqual(['web'])

      await expect.poll(async () => {
        const all = await (await request.get('/api/v1/auth/admin/access-requests?status=expired', { headers: bearer(admin) })).json()
        return (all as { id: string }[]).some((x) => x.id === req.id)
      }, { timeout: 150_000, intervals: [5_000] }).toBe(true)
      const restored = await me(request, await login(request, email, PW))
      expect(restored.cluster_roles?.[CLUSTER]).toBe('Read')
      expect(restored.cluster_namespaces?.[CLUSTER]).toEqual(['api', 'web'])
    } finally {
      if (userId) await request.delete(`/api/v1/auth/admin/users/${userId}`, { headers: bearer(admin), failOnStatusCode: false })
    }
  })
})
