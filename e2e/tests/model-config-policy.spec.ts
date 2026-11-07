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

      const mappedMetadata = await post({ name: `e2e-m19-f-${ts}`, api_key_env: 'OPENAI_API_KEY', base_url: 'http://[::ffff:169.254.169.254]/v1' })
      expect(mappedMetadata.status, 'metadata address in an IPv6 form').toBe(400)
      expect(mappedMetadata.detail).toContain('not allowed')

      const mappedPrivate = await post({ name: `e2e-m19-g-${ts}`, api_key_env: 'OPENAI_API_KEY', base_url: 'http://[::ffff:10.0.0.1]:8080/v1' })
      expect(mappedPrivate.status, 'private address in an IPv6 form').toBe(400)
      expect(mappedPrivate.detail).toContain('AI_BASE_URL_ALLOWED_HOSTS')

      const benchmarking = await post({ name: `e2e-m19-h-${ts}`, api_key_env: 'OPENAI_API_KEY', base_url: 'http://198.18.0.1/v1' })
      expect(benchmarking.status, 'the benchmarking range').toBe(400)
      expect(benchmarking.detail).toContain('AI_BASE_URL_ALLOWED_HOSTS')

      const mappedPublic = await post({ name: `e2e-m19-i-${ts}`, api_key_env: 'OPENAI_API_KEY', base_url: 'http://[::ffff:93.184.216.34]/v1' })
      expect(mappedPublic.status, `a public address in an IPv6 form: ${mappedPublic.detail}`).toBe(200)
      expect(mappedPublic.body.base_url, 'the address is stored as it was given').toBe('http://[::ffff:93.184.216.34]/v1')

      for (const [letter, form, baseUrl] of [
        ['j', 'an IPv4-translated form', 'http://[::ffff:0:169.254.169.254]/v1'],
        ['k', 'a Teredo form', 'http://[2001:0:4136:e378:8000:63bf:5601:5601]/v1'],
        ['l', 'a site NAT64 form', 'http://[64:ff9b:1::169.254.169.254]/v1'],
        ['u', 'an ISATAP form', 'http://[2606:4700::5efe:169.254.169.254]/v1'],
        ['ac', "Alibaba Cloud's address", 'http://100.100.100.200/v1'],
        ['ad', "Azure's platform address", 'http://168.63.129.16/v1'],
      ]) {
        const refused = await post({ name: `e2e-m19-${letter}-${ts}`, api_key_env: 'OPENAI_API_KEY', base_url: baseUrl })
        expect(refused.status, `metadata address in ${form}`).toBe(400)
        expect(refused.detail).toContain('not allowed')
      }

      for (const [letter, form, baseUrl] of [
        ['m', 'a private address in an IPv4-translated form', 'http://[::ffff:0:10.0.0.1]:8080/v1'],
        ['n', 'a private address in a Teredo form', 'http://[2001:0:4136:e378:8000:63bf:f5ff:fffe]/v1'],
        ['o', 'a private address in a site NAT64 form', 'http://[64:ff9b:1::10.0.0.1]/v1'],
        ['p', 'site-local', 'http://[fec0::1]:8080/v1'],
        ['q', 'IPv6 multicast', 'http://[ff02::1]/v1'],
        ['r', 'IPv4 multicast', 'http://224.0.0.1/v1'],
        ['v', 'a private address in an ISATAP form', 'http://[2606:4700::5efe:10.0.0.1]/v1'],
        ['w', 'class E', 'http://240.0.0.1/v1'],
        ['x', 'limited broadcast', 'http://255.255.255.255/v1'],
        ['y', 'IETF protocol assignments', 'http://192.0.0.1/v1'],
        ['z', 'the IPv6 documentation range', 'http://[2001:db8::1]/v1'],
        ['aa', 'the IPv6 discard prefix', 'http://[100::1]/v1'],
      ]) {
        const refused = await post({ name: `e2e-m19-${letter}-${ts}`, api_key_env: 'OPENAI_API_KEY', base_url: baseUrl })
        expect(refused.status, form).toBe(400)
        expect(refused.detail, form).toContain('AI_BASE_URL_ALLOWED_HOSTS')
      }

      const translatedPublic = await post({ name: `e2e-m19-s-${ts}`, api_key_env: 'OPENAI_API_KEY', base_url: 'http://[::ffff:0:93.184.216.34]/v1' })
      expect(translatedPublic.status, `a public address in an IPv4-translated form: ${translatedPublic.detail}`).toBe(200)
      expect(translatedPublic.body.base_url, 'the address is stored as it was given').toBe('http://[::ffff:0:93.184.216.34]/v1')

      const sitePublic = await post({ name: `e2e-m19-t-${ts}`, api_key_env: 'OPENAI_API_KEY', base_url: 'http://[64:ff9b:1::5db8:d822]/v1' })
      expect(sitePublic.status, `a public address in a site NAT64 form: ${sitePublic.detail}`).toBe(200)
      expect(sitePublic.body.base_url, 'the address is stored as it was given').toBe('http://[64:ff9b:1::5db8:d822]/v1')

      const isatapPublic = await post({ name: `e2e-m19-ab-${ts}`, api_key_env: 'OPENAI_API_KEY', base_url: 'http://[2606:4700::5efe:93.184.216.34]/v1' })
      expect(isatapPublic.status, `a public address in an ISATAP form: ${isatapPublic.detail}`).toBe(200)
      expect(isatapPublic.body.base_url, 'the address is stored as it was given').toBe('http://[2606:4700::5efe:93.184.216.34]/v1')

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
