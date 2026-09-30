import { test, expect, type APIRequestContext } from '@playwright/test'

// H11: bumping a user's token_version (cluster grant change, role change,
// password reset) revokes every token issued so far on every service, not
// only on auth-service. The other services cache the version for up to 30 s,
// so a revoked token may keep working there for that long; auth-service's
// own routes refuse it at once.

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const REVOKE_WITHIN_MS = 45_000

const PROBES = {
  'auth-service /auth/me': '/api/v1/auth/me',
  'k8s-service namespaces': '/api/v1/namespaces?cluster=self',
  'ai-service config': '/api/v1/ai/config',
} as const

async function login(request: APIRequestContext, email: string, password: string) {
  const res = await request.post('/api/v1/auth/login', { data: { email, password } })
  expect(res.ok(), `login ${email}`).toBeTruthy()
  return { Authorization: `Bearer ${(await res.json()).access_token as string}` }
}

test.describe('token revocation (H11)', () => {
  test('a cluster-grant change revokes the tokens already issued, on every service', async ({ request }) => {
    test.setTimeout(REVOKE_WITHIN_MS * 2 + 30_000)
    const admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    const email = `e2e-revoke-${Date.now()}@kubeast.local`
    const password = 'e2e-revoke-throwaway-1'
    const created = await request.post('/api/v1/auth/admin/users', { headers: admin, data: { name: 'E2E revoke', email, password } })
    expect(created.status()).toBe(201)
    const id = (await created.json()).id as string
    try {
      const grant = await request.put(`/api/v1/auth/admin/users/${id}/cluster-roles/self`, { headers: admin, data: { role: 'Read' } })
      expect(grant.ok(), 'grant Read on self').toBeTruthy()
      const user = await login(request, email, password)
      const status = async (path: string, headers = user) => (await request.get(path, { headers, failOnStatusCode: false })).status()

      for (const [name, path] of Object.entries(PROBES)) expect(await status(path), `${name} before the change`).toBe(200)

      // Admin changes the user's grant: the stored token_version moves on.
      const bump = await request.put(`/api/v1/auth/admin/users/${id}/cluster-roles/self`, { headers: admin, data: { role: 'Read' } })
      expect(bump.ok(), 'grant change').toBeTruthy()

      expect(await status(PROBES['auth-service /auth/me']), 'auth-service refuses at once').toBe(401)
      for (const name of ['k8s-service namespaces', 'ai-service config'] as const) {
        await expect
          .poll(() => status(PROBES[name]), { message: `${name} refuses the revoked token`, timeout: REVOKE_WITHIN_MS, intervals: [2_000] })
          .toBe(401)
      }

      // A fresh sign-in carries the new version and works everywhere.
      const fresh = await login(request, email, password)
      for (const [name, path] of Object.entries(PROBES)) expect(await status(path, fresh), `${name} with a new token`).toBe(200)
    } finally {
      await request.delete(`/api/v1/auth/admin/users/${id}`, { headers: admin })
    }
  })

  test('the service-to-service version lookup is not reachable through the gateway', async ({ request }) => {
    const res = await request.get('/api/v1/auth/internal/token-version/anyone', { failOnStatusCode: false })
    expect(res.status()).toBe(404)
  })
})
