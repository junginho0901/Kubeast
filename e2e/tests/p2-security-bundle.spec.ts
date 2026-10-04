import { test, expect, type APIRequestContext } from '@playwright/test'

// Second-review P2 bundle, the parts observable through the API:
// - /auth/login accepts only application/json bodies (login CSRF, L17)
// - request bodies are capped (M30)
// - a pending account's session reaches only its own state (L15)
// - a registered kubeconfig may not disable TLS verification (M28)

const EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const PASSWORD = process.env.E2E_USER_PASSWORD || ''

async function adminToken(request: APIRequestContext): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email: EMAIL, password: PASSWORD } })
  expect(res.ok(), 'admin login should succeed — set E2E_USER_EMAIL / E2E_USER_PASSWORD').toBeTruthy()
  return (await res.json()).access_token
}
const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })

test.describe('P2 security bundle', () => {
  test('login refuses a body that is not application/json', async ({ request }) => {
    const res = await request.post('/api/v1/auth/login', {
      headers: { 'Content-Type': 'text/plain' },
      data: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    })
    expect(res.status()).toBe(415)
    expect((await res.json()).detail).toContain('application/json')
  })

  test('an oversized request body is refused, not processed', async ({ request }) => {
    const res = await request.post('/api/v1/auth/login', {
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({ email: EMAIL, password: 'x'.repeat(2 * 1024 * 1024) }),
    })
    // auth-service answers 400 when the capped reader cuts the JSON short (the
    // body is never buffered past the cap); a proxy may answer 413 first.
    expect([400, 413]).toContain(res.status())
  })

  test('a pending account can see itself and nothing else', async ({ request }) => {
    const admin = await adminToken(request)
    const roles = await (await request.get('/api/v1/auth/roles', { headers: bearer(admin) })).json()
    const pending = (Array.isArray(roles) ? roles : roles.roles || roles.items || []).find((r: any) => String(r.name).toLowerCase() === 'pending')
    expect(pending, 'a Pending role exists').toBeTruthy()

    const email = `e2e-pending-${Date.now().toString(36)}@example.com`
    const password = 'E2e-pending-pass1!'
    const created = await request.post('/api/v1/auth/admin/users', { headers: bearer(admin), data: { name: 'E2E pending', email, password, role_id: pending.id } })
    expect(created.ok(), await created.text()).toBeTruthy()
    const userId = (await created.json()).id
    try {
      const login = await request.post('/api/v1/auth/login', { data: { email, password } })
      expect(login.status(), 'a pending account can still sign in').toBe(200)
      const token = (await login.json()).access_token

      expect((await request.get('/api/v1/auth/me', { headers: bearer(token) })).status()).toBe(200)
      expect((await request.get('/api/v1/sessions', { headers: bearer(token) })).status()).toBe(403)
      expect((await request.post('/api/v1/audit/cluster-switch', { headers: bearer(token), data: { previous_cluster: 'self', new_cluster: 'self' } })).status()).toBe(403)
      expect((await request.get('/api/v1/cluster/namespaces?cluster=self', { headers: bearer(token) })).status()).toBe(403)
      expect((await request.get('/api/v1/ai/tool-approvals?session_id=x', { headers: bearer(token) })).status()).toBe(403)
    } finally {
      await request.delete(`/api/v1/auth/admin/users/${userId}`, { headers: bearer(admin) })
    }
  })

  test('kubeconfig validation rejects insecure-skip-tls-verify and file references', async ({ request }) => {
    const admin = await adminToken(request)
    const head = 'apiVersion: v1\nkind: Config\ncontexts:\n- name: c\n  context: {cluster: c, user: u}\ncurrent-context: c\n'
    for (const [field, kubeconfig] of [
      ['insecure-skip-tls-verify', head + 'clusters:\n- name: c\n  cluster:\n    server: https://example:6443\n    insecure-skip-tls-verify: true\nusers:\n- name: u\n  user:\n    token: abc\n'],
      ['client-key', head + 'clusters:\n- name: c\n  cluster:\n    server: https://example:6443\nusers:\n- name: u\n  user:\n    client-certificate: /tmp/c.crt\n    client-key: /tmp/c.key\n'],
    ] as const) {
      const res = await request.post('/api/v1/clusters/validate', { headers: bearer(admin), data: { mode: 'external', kubeconfig } })
      expect(res.status(), field).toBe(400)
      expect((await res.text()).toLowerCase(), field).toContain(field.split('-')[0])
    }
  })
})
