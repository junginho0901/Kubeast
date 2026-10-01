import { test, expect, type APIRequestContext } from '@playwright/test'

// M19: a model config may only read the key variables meant for it, send
// them to public endpoints (or allow-listed hosts) and carry no auth
// headers; header values are masked in responses.

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''

async function adminHeaders(request: APIRequestContext) {
  const res = await request.post('/api/v1/auth/login', { data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } })
  expect(res.ok(), 'admin login').toBeTruthy()
  return { Authorization: `Bearer ${(await res.json()).access_token as string}` }
}

test.describe('model config policy (M19)', () => {
  test('refuses other secrets, private or metadata endpoints and auth headers; masks header values', async ({ request }) => {
    const admin = await adminHeaders(request)
    const ts = Date.now()
    const created: number[] = []
    const post = async (data: Record<string, unknown>) => {
      const res = await request.post('/api/v1/ai/model-configs', { headers: admin, data: { provider: 'openai', model: 'gpt-4o-mini', ...data }, failOnStatusCode: false })
      const body = await res.json().catch(() => ({}))
      if (res.ok()) created.push(body.id as number)
      return { status: res.status(), detail: String(body.detail ?? ''), body }
    }
    try {
      const otherSecret = await post({ name: `e2e-m19-a-${ts}`, api_key_env: 'DATABASE_URL' })
      expect(otherSecret.status, 'api_key_env must not name another secret').toBe(400)
      expect(otherSecret.detail).toContain('api_key_env')

      const metadata = await post({ name: `e2e-m19-b-${ts}`, api_key_env: 'OPENAI_API_KEY', base_url: 'http://169.254.169.254.nip.io/v1' })
      expect(metadata.status, 'metadata address behind a DNS name').toBe(400)

      const privateHost = await post({ name: `e2e-m19-c-${ts}`, api_key_env: 'OPENAI_API_KEY', base_url: 'http://10.0.0.5.nip.io:8080/v1' })
      expect(privateHost.status, 'private address behind a DNS name').toBe(400)
      expect(privateHost.detail).toContain('AI_BASE_URL_ALLOWED_HOSTS')

      const authHeader = await post({ name: `e2e-m19-d-${ts}`, api_key_env: 'OPENAI_API_KEY', extra_headers: { Authorization: 'Bearer x' } })
      expect(authHeader.status, 'auth header in extra_headers').toBe(400)

      const ok = await post({ name: `e2e-m19-e-${ts}`, api_key_env: 'KUBEAST_AI_KEY_E2E', base_url: 'https://api.openai.com/v1', extra_headers: { 'X-Tenant': 'ops-secret' } })
      expect(ok.status, `a proper config: ${ok.detail}`).toBe(200)
      expect(ok.body.extra_headers, 'header values are masked in the response').toEqual({ 'X-Tenant': '***' })

      // Echoing the masked value back keeps the stored one.
      const patched = await request.patch(`/api/v1/ai/model-configs/${ok.body.id}`, { headers: admin, data: { extra_headers: { 'X-Tenant': '***' } } })
      expect(patched.ok()).toBeTruthy()
      const list = await request.get('/api/v1/ai/model-configs', { headers: admin })
      const row = ((await list.json()) as any[]).find((c) => c.id === ok.body.id)
      expect(row.extra_headers).toEqual({ 'X-Tenant': '***' })
    } finally {
      for (const id of created) await request.delete(`/api/v1/ai/model-configs/${id}`, { headers: admin, failOnStatusCode: false })
    }
  })
})
