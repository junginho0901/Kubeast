import { test, expect, type APIRequestContext } from '@playwright/test'

// Three routes the Read-role sweep found misbehaving for everyone: a node delete never reached k8s-service through the
// gateway (chi's "404 page not found"), a Helm diff with a bad revision answered 500, and a YAML create with no YAML
// answered 200. Now the node route reaches the API server (Kubernetes' own NotFound for a missing node, 403 for a Read
// user with an audit row), and the two validation errors are 400.

const EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const PASSWORD = process.env.E2E_USER_PASSWORD || ''
const PW = 'E2e-routefix-pass1!'
const stamp = Date.now().toString(36)
const READER = `e2e-routefix-reader-${stamp}@example.com`
const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })

async function login(request: APIRequestContext, email: string, password: string): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email, password } })
  expect(res.ok(), `login ${email}: ${res.status()}`).toBeTruthy()
  return (await res.json()).access_token
}

test.describe('routes found in the Read sweep', () => {
  let admin = ''
  let readerId = ''

  test.beforeAll(async ({ request }) => {
    admin = await login(request, EMAIL, PASSWORD)
  })
  test.afterAll(async ({ request }) => {
    if (readerId) await request.delete(`/api/v1/auth/admin/users/${readerId}`, { headers: bearer(admin), failOnStatusCode: false })
  })

  test('a node delete reaches k8s-service: Kubernetes answers for a missing node, a Read user is refused and audited', async ({ request }) => {
    const missing = await request.delete('/api/v1/cluster/nodes/e2e-no-such-node?cluster=self', { headers: bearer(admin), failOnStatusCode: false })
    expect(missing.status()).toBe(404)
    const body = await missing.text()
    expect(body, 'the API server, not the router, says the node is missing').toContain('not found')
    expect(body).not.toContain('404 page not found')

    const raw = await (await request.get('/api/v1/auth/roles', { headers: bearer(admin) })).json()
    const member = (Array.isArray(raw) ? raw : raw.roles || raw.items || []).find((r: { name: string }) => r.name.toLowerCase() === 'member')
    const created = await request.post('/api/v1/auth/admin/users', { headers: bearer(admin), data: { name: 'E2E route fix', email: READER, password: PW, role_id: member.id } })
    expect(created.status(), await created.text()).toBe(201)
    readerId = (await created.json()).id
    expect((await request.put(`/api/v1/auth/admin/users/${readerId}/cluster-roles/self`, { headers: bearer(admin), data: { role: 'Read' } })).ok()).toBeTruthy()
    const reader = await login(request, READER, PW)
    const refused = await request.delete('/api/v1/cluster/nodes/e2e-no-such-node?cluster=self', { headers: bearer(reader), failOnStatusCode: false })
    expect(refused.status()).toBe(403)
    const rows = ((await (await request.get('/api/v1/auth/admin/audit-logs?action=k8s.access.denied&limit=50', { headers: bearer(admin) })).json()).items ?? []) as any[]
    expect(rows.find((r) => (r.ActorEmail ?? r.actor_email) === READER && (r.TargetID ?? r.target_id) === 'resource.node.delete'), 'k8s.access.denied row for the reader').toBeTruthy()
  })

  test('a Helm diff with a non-positive revision is a 400', async ({ request }) => {
    const res = await request.post('/api/v1/cluster/helm/releases/kubeast/kubeast/diff?cluster=self', { headers: bearer(admin), data: { from: 0, to: 1 }, failOnStatusCode: false })
    expect(res.status(), await res.text()).toBe(400)
    expect((await res.json()).detail).toContain('revisions must be positive')
  })

  test('a YAML create with no YAML is a 400 and creates nothing', async ({ request }) => {
    for (const data of [{}, { yaml: '  \n' }]) {
      const res = await request.post('/api/v1/cluster/resources/yaml/create?cluster=self', { headers: bearer(admin), data, failOnStatusCode: false })
      expect(res.status(), JSON.stringify(data)).toBe(400)
      expect((await res.json()).detail).toContain('yaml is required')
    }
  })
})
