import { test, expect, type APIRequestContext, type Page } from '@playwright/test'

// OIDC sign-in through a real Keycloak (e2e/scripts/oidc-keycloak.sh up: Keycloak 26.8.1 on the host, realm
// deploy/kind/keycloak-realm.json, Kubeast pointed at it with deploy/kind/keycloak-oidc-values.yaml). The groups
// are the company Keycloak's: sre → Admin, dev → Member + Write on default, viewer → Member + Read on default,
// none → Pending. Keycloak is reached as host.docker.internal:8180 by auth-service and, through the resolver rule
// below, by the browser, so the issuer is one string. Skipped unless the server reports Keycloak.

test.use({
  storageState: { cookies: [], origins: [] },
  launchOptions: { args: ['--host-resolver-rules=MAP host.docker.internal 127.0.0.1'] },
})

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const KEYCLOAK = 'http://localhost:8180'
const REALM = 'kubeast'
const CLUSTER = 'default'
const USERS = ['kc-sre', 'kc-dev', 'kc-viewer', 'kc-newbie']

test.beforeEach(async ({ request }) => {
  const cfg = await (await request.get('/api/v1/auth/oidc/config')).json()
  test.skip(!cfg.enabled || cfg.display_name !== 'Keycloak', 'OIDC does not point at Keycloak — run e2e/scripts/oidc-keycloak.sh up')
})

// Signed out from a blank page (cookies of both Kubeast and Keycloak cleared), through Keycloak's own form.
async function signIn(page: Page, username: string): Promise<string> {
  await page.goto('about:blank')
  await page.context().clearCookies()
  await page.goto('/login')
  await page.getByTestId('sso-login').click()
  await page.waitForURL(/host\.docker\.internal:8180\/realms\/kubeast\/protocol\/openid-connect\/auth/)
  const authorize = page.url()
  await page.locator('#username').fill(username)
  await page.locator('#password').fill(username)
  await page.locator('#kc-login').click()
  await page.waitForURL((u) => !u.pathname.startsWith('/login') && !u.host.includes('host.docker.internal'))
  return authorize
}

async function me(page: Page) {
  const res = await page.request.get('/api/v1/auth/me')
  expect(res.status()).toBe(200)
  return res.json()
}

async function admin(request: APIRequestContext) {
  const res = await request.post('/api/v1/auth/login', { data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } })
  expect(res.ok(), 'admin login').toBeTruthy()
  return { Authorization: `Bearer ${(await res.json()).access_token}`, 'X-Requested-With': 'XMLHttpRequest' }
}

// Keycloak's admin REST API as the bootstrap admin of the dev container.
async function keycloakAdmin(request: APIRequestContext) {
  const res = await request.post(`${KEYCLOAK}/realms/master/protocol/openid-connect/token`, {
    form: { grant_type: 'password', client_id: 'admin-cli', username: 'admin', password: 'kubeast-dev' },
  })
  expect(res.ok(), 'Keycloak admin token').toBeTruthy()
  const headers = { Authorization: `Bearer ${(await res.json()).access_token}` }
  const id = async (path: string, name: string) => {
    const list = await (await request.get(`${KEYCLOAK}/admin/realms/${REALM}/${path}`, { headers })).json()
    return (list as { id: string }[])[0].id
  }
  const userId = (username: string) => id(`users?username=${username}&exact=true`, username)
  const groupId = (name: string) => id(`groups?search=${name}&exact=true`, name)
  const member = async (username: string, group: string, add: boolean) => {
    const res = await request[add ? 'put' : 'delete'](`${KEYCLOAK}/admin/realms/${REALM}/users/${await userId(username)}/groups/${await groupId(group)}`, { headers })
    expect(res.status(), `${add ? 'add' : 'remove'} ${username} ${group}`).toBe(204)
  }
  return { member }
}

test.describe('OIDC sign-in through Keycloak', () => {
  test.afterAll(async ({ request }) => {
    const headers = await admin(request)
    const users = await (await request.get('/api/v1/auth/admin/users?limit=500', { headers })).json()
    for (const u of (users as { id: string; email: string }[]).filter((x) => USERS.some((n) => x.email === `${n}@example.com`))) {
      await request.delete(`/api/v1/auth/admin/users/${u.id}`, { headers, failOnStatusCode: false })
    }
  })

  test('the login page offers Keycloak and the realm issues for the issuer Kubeast is set to', async ({ page, request }) => {
    const discovery = await (await request.get(`${KEYCLOAK}/realms/${REALM}/.well-known/openid-configuration`)).json()
    expect(discovery.issuer).toBe(`http://host.docker.internal:8180/realms/${REALM}`)
    expect(discovery.code_challenge_methods_supported).toContain('S256')
    await page.goto('/login')
    await expect(page.getByTestId('sso-login')).toContainText('Keycloak')
    // syncRoles with the groups claim: a role set in Kubeast would not last past the next sign-in
    expect((await (await request.get('/api/v1/auth/oidc/config')).json()).roles_from_groups).toBe(true)
  })

  test('the company groups give each person the account level and cluster role they map to', async ({ page }) => {
    const expected: Record<string, { role: string; cluster?: string }> = {
      'kc-sre': { role: 'Admin' },
      'kc-dev': { role: 'Member', cluster: 'Write' },
      'kc-viewer': { role: 'Member', cluster: 'Read' },
      'kc-newbie': { role: 'Pending' },
    }
    for (const [username, want] of Object.entries(expected)) {
      const authorize = await signIn(page, username)
      expect(new URL(authorize).searchParams.get('code_challenge_method'), 'PKCE').toBe('S256')
      const body = await me(page)
      expect([body.email, body.auth_source, body.role?.name], username).toEqual([`${username}@example.com`, 'oidc', want.role])
      expect(body.cluster_roles?.[CLUSTER], `${username} on ${CLUSTER}`).toBe(want.cluster)
      if (want.role === 'Pending') {
        // the pending page sends them to the group, not to an admin's role in Kubeast (it would be reset at sign-in)
        await page.goto('/')
        await expect(page.getByText(/your role comes from your groups|역할은 인증 제공자\(IdP\)의 그룹/)).toBeVisible({ timeout: 15_000 })
      }
    }
  })

  test('a group change in Keycloak changes the cluster role at the next sign-in, and it is audited', async ({ page, request }) => {
    const kc = await keycloakAdmin(request)
    const headers = await admin(request)
    type Row = { Action: string; Result: string; TargetID: string; ActorEmail: string; After: Record<string, unknown> | null }
    const since = new Date(Date.now() - 60_000).toISOString()
    const rows = async (action: string): Promise<Row[]> =>
      (await (await request.get('/api/v1/auth/admin/audit-logs', { headers, params: { action, since, limit: '100' } })).json()).items || []
    const logins = async () => (await rows('user.login.success')).filter((r) => r.ActorEmail === 'kc-viewer@example.com').length
    const grantsBefore = (await rows('user.cluster_role.set')).filter((r) => r.After?.via === 'oidc').length
    const loginsBefore = await logins()
    await signIn(page, 'kc-viewer')
    expect((await me(page)).cluster_roles?.[CLUSTER]).toBe('Read')
    try {
      await kc.member('kc-viewer', 'viewer', false)
      await kc.member('kc-viewer', 'dev', true)
      await signIn(page, 'kc-viewer')
      expect((await me(page)).cluster_roles?.[CLUSTER]).toBe('Write')
    } finally {
      await kc.member('kc-viewer', 'dev', false)
      await kc.member('kc-viewer', 'viewer', true)
    }
    await signIn(page, 'kc-viewer')
    expect((await me(page)).cluster_roles?.[CLUSTER]).toBe('Read')

    await expect.poll(logins, { timeout: 10_000 }).toBe(loginsBefore + 3)
    const grants = (await rows('user.cluster_role.set')).filter((r) => r.After?.via === 'oidc')
    expect(grants.length).toBe(grantsBefore + 2)
    expect(grants.slice(0, 2).map((r) => `${r.After?.previous} -> ${r.After?.role}`).sort()).toEqual(['Read -> Write', 'Write -> Read']) // newest first
  })
})
