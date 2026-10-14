import { test, expect, type APIRequestContext } from '@playwright/test'

// GET /api/v1/auth/admin/oidc/groups?email= — the Google Workspace groups a user would bring at sign-in and what
// they map to (auth.oidc.googleGroups). With the lookup off the API says so (404); with it on it answers the
// mapping preview (only mapped groups named, the rest counted) or 502 when Google cannot be read. A Read user
// is refused either way.

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })

async function login(request: APIRequestContext, email: string, password: string): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email, password } })
  expect(res.ok(), `login ${email}: ${res.status()}`).toBeTruthy()
  return (await res.json()).access_token
}

test('the group preview answers by the lookup state, and refuses a Read user', async ({ request }) => {
  const admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
  const probe = await request.get('/api/v1/auth/admin/oidc/groups?email=someone@example.com', { headers: bearer(admin) })
  if (probe.status() === 404) {
    expect((await probe.json()).detail ?? (await probe.text())).toMatch(/not enabled/)
  } else {
    const missing = await request.get('/api/v1/auth/admin/oidc/groups', { headers: bearer(admin) })
    expect(missing.status()).toBe(400)
    expect([200, 502]).toContain(probe.status())
    if (probe.status() === 200) {
      const body = await probe.json()
      expect(Object.keys(body).sort()).toEqual(['cluster_grants', 'email', 'mapped_groups', 'other_groups', 'role', 'role_from'])
      expect(['mapping', 'default']).toContain(body.role_from)
    }
  }

  const roles = await (await request.get('/api/v1/auth/roles', { headers: bearer(admin) })).json()
  const member = (Array.isArray(roles) ? roles : roles.roles || roles.items || []).find((r: { name: string }) => r.name.toLowerCase() === 'member')
  const email = `e2e-oidcgroups-${Date.now().toString(36)}@kubeast.local`
  const password = 'E2e-oidcgroups-throwaway-1!'
  const created = await request.post('/api/v1/auth/admin/users', { headers: bearer(admin), data: { name: 'E2E oidc groups', email, password, role_id: member.id } })
  expect(created.status()).toBe(201)
  const userId = (await created.json()).id as string
  try {
    const reader = await login(request, email, password)
    const refused = await request.get('/api/v1/auth/admin/oidc/groups?email=someone@example.com', { headers: bearer(reader) })
    expect(refused.status()).toBe(403)
  } finally {
    await request.delete(`/api/v1/auth/admin/users/${userId}`, { headers: bearer(admin), failOnStatusCode: false })
  }
})
