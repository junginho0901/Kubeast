import { test, expect, type APIRequestContext } from '@playwright/test'

// API keys: a user issues a key (scoped to clusters, capped at a role, with an
// expiry) and exchanges it for a short access token; the token never grants
// more than the user holds, revoking the key refuses the next exchange, and
// an admin can revoke anyone's key. A temporary user with Write on `default`
// does the API part (the admin's own session and token_version stay
// untouched); the admin session drives the Settings page.

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const CLUSTER = 'default'
const OTHER_CLUSTER = 'test2'
const PW = 'E2e-apikey-pass1!'
const stamp = () => Date.now().toString(36)

const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })
const onCluster = (token: string, cluster: string) => ({ Authorization: `Bearer ${token}`, 'X-Cluster-Name': cluster })

async function login(request: APIRequestContext, email: string, password: string): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email, password } })
  expect(res.ok(), `login ${email}: ${res.status()} ${await res.text()}`).toBeTruthy()
  return (await res.json()).access_token
}

async function roleId(request: APIRequestContext, admin: string, name: string): Promise<number> {
  const raw = await (await request.get('/api/v1/auth/roles', { headers: bearer(admin) })).json()
  const roles = Array.isArray(raw) ? raw : raw.roles || raw.items || []
  const role = roles.find((r: any) => String(r.name).toLowerCase() === name.toLowerCase())
  expect(role, `role ${name} exists`).toBeTruthy()
  return role.id
}

async function createUser(request: APIRequestContext, admin: string, email: string): Promise<string> {
  const res = await request.post('/api/v1/auth/admin/users', {
    headers: bearer(admin),
    data: { name: 'E2E api key', email, password: PW, role_id: await roleId(request, admin, 'Member') },
  })
  expect(res.status(), `create ${email}: ${await res.text()}`).toBe(201)
  return (await res.json()).id
}

async function deleteUser(request: APIRequestContext, admin: string, userId: string): Promise<void> {
  if (!userId) return
  await request.delete(`/api/v1/auth/admin/users/${userId}`, { headers: bearer(admin), failOnStatusCode: false })
}

async function exchange(request: APIRequestContext, key: string) {
  return request.post('/api/v1/auth/token', { headers: { Authorization: `Bearer ${key}` }, failOnStatusCode: false })
}

async function enabled(request: APIRequestContext, token: string): Promise<boolean> {
  const res = await request.get('/api/v1/auth/api-keys/config', { headers: bearer(token) })
  return res.ok() && !!(await res.json()).enabled
}

async function auditCount(request: APIRequestContext, admin: string, action: string, targetId: string): Promise<number> {
  const res = await request.get(`/api/v1/auth/admin/audit-logs?action=${action}&limit=50`, { headers: bearer(admin) })
  const items = (await res.json()).items ?? []
  return items.filter((i: any) => (i.TargetID ?? i.target_id) === targetId).length
}

test.describe('API keys', () => {
  test('issue → exchange → scope and ceiling → revoke → admin revoke → audit', async ({ request }) => {
    test.setTimeout(120_000)
    const admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    test.skip(!(await enabled(request, admin)), 'API keys are disabled on this installation')

    const email = `e2e-apikey-${stamp()}@example.com`
    let userId = ''
    // The write probe is a namespaced delete (what Write allows through the
    // cluster's `edit` binding; creating a Namespace stays forbidden for Write
    // by the cluster's own RBAC). The ConfigMaps come from the admin.
    const cmRead = `e2e-apikey-r-${stamp()}`
    const cmWrite = `e2e-apikey-w-${stamp()}`
    const createCM = (name: string) =>
      request.post(`/api/v1/cluster/resources/yaml/create?cluster=${CLUSTER}`, {
        headers: bearer(admin),
        data: { namespace: 'default', yaml: `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: ${name}\n  namespace: default\ndata:\n  k: v\n` },
      })
    const deleteCM = (token: string, name: string) =>
      request.delete(`/api/v1/cluster/namespaces/default/configmaps/${name}?cluster=${CLUSTER}`, { headers: bearer(token), failOnStatusCode: false })
    try {
      userId = await createUser(request, admin, email)
      // Write on default only; nothing on test2.
      const grant = await request.put(`/api/v1/auth/admin/users/${userId}/cluster-roles/${CLUSTER}`, { headers: bearer(admin), data: { role: 'Write' } })
      expect(grant.ok(), `grant: ${await grant.text()}`).toBeTruthy()
      const user = await login(request, email, PW)

      // Validation.
      const bad = await request.post('/api/v1/auth/api-keys', { headers: bearer(user), data: { name: 'x', expires_in_days: 0 }, failOnStatusCode: false })
      expect(bad.status(), 'expiry below 1 day').toBe(400)
      const badCluster = await request.post('/api/v1/auth/api-keys', { headers: bearer(user), data: { name: 'x', expires_in_days: 1, cluster_ids: [OTHER_CLUSTER] }, failOnStatusCode: false })
      expect(badCluster.status(), 'a cluster the user does not reach').toBe(400)

      // A Read key on default: the value appears once, the stored row never carries it.
      const created = await request.post('/api/v1/auth/api-keys', {
        headers: bearer(user),
        data: { name: 'e2e read', expires_in_days: 7, cluster_ids: [CLUSTER], role_ceiling: 'Read' },
      })
      expect(created.status(), `create: ${await created.text()}`).toBe(201)
      const readKey = await created.json()
      expect(readKey.key, 'key value').toMatch(/^kbk_[A-Za-z0-9_-]{43}$/)
      expect(readKey.role_ceiling).toBe('Read')
      const listed = await (await request.get('/api/v1/auth/api-keys', { headers: bearer(user) })).json()
      expect(listed.map((k: any) => k.id)).toContain(readKey.id)
      expect(JSON.stringify(listed)).not.toContain(readKey.key)

      // Exchange: a token with akid, scoped to default, capped at Read.
      const ex = await exchange(request, readKey.key)
      expect(ex.status(), `exchange: ${await ex.text()}`).toBe(200)
      const token = (await ex.json()).access_token as string
      const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())
      expect(claims.akid).toBe(readKey.id)
      expect(Object.keys(claims.permissions)).toEqual([CLUSTER])
      expect(claims.roles).toEqual({ [CLUSTER]: 'Read' })

      expect((await request.get(`/api/v1/cluster/overview?cluster=${CLUSTER}`, { headers: onCluster(token, CLUSTER) })).status(), 'read in scope').toBe(200)
      expect((await request.get(`/api/v1/cluster/overview?cluster=${OTHER_CLUSTER}`, { headers: onCluster(token, OTHER_CLUSTER), failOnStatusCode: false })).status(), 'outside the scope').toBe(403)
      expect((await createCM(cmRead)).ok(), 'admin creates the probe ConfigMap').toBeTruthy()
      expect((await deleteCM(token, cmRead)).status(), 'write under a Read ceiling').toBe(403)
      expect((await request.post('/api/v1/auth/refresh', { headers: bearer(token), failOnStatusCode: false })).status(), 'no refresh for a key token').toBe(401)
      const touched = await (await request.get('/api/v1/auth/api-keys', { headers: bearer(user) })).json()
      expect(touched.find((k: any) => k.id === readKey.id).last_used_at, 'last use recorded').toBeTruthy()

      // A Write key on default can write there (the user's own role); clean the namespace up.
      const createdW = await request.post('/api/v1/auth/api-keys', { headers: bearer(user), data: { name: 'e2e write', expires_in_days: 1, cluster_ids: [CLUSTER], role_ceiling: 'Write' } })
      expect(createdW.status()).toBe(201)
      const writeKey = await createdW.json()
      const tokenW = (await (await exchange(request, writeKey.key)).json()).access_token as string
      expect((await createCM(cmWrite)).ok()).toBeTruthy()
      const made = await deleteCM(tokenW, cmWrite)
      expect(made.status(), `write under a Write ceiling: ${await made.text()}`).toBe(200)

      // Revoke: the next exchange is refused; the admin revokes the other one.
      expect((await request.delete(`/api/v1/auth/api-keys/${readKey.id}`, { headers: bearer(user) })).status()).toBe(204)
      expect((await exchange(request, readKey.key)).status(), 'revoked key').toBe(401)
      const adminList = await (await request.get(`/api/v1/auth/admin/users/${userId}/api-keys`, { headers: bearer(admin) })).json()
      expect(adminList.map((k: any) => k.id)).toEqual([writeKey.id])
      expect((await request.delete(`/api/v1/auth/admin/users/${userId}/api-keys/${writeKey.id}`, { headers: bearer(admin) })).status()).toBe(204)
      expect((await exchange(request, writeKey.key)).status(), 'admin-revoked key').toBe(401)

      // Audit rows: create ×2, exchange (success ×2 + refusals), delete, admin delete.
      expect(await auditCount(request, admin, 'user.apikey.create', readKey.id)).toBe(1)
      expect(await auditCount(request, admin, 'user.apikey.exchange', readKey.id), 'the successful exchange').toBe(1)
      expect(await auditCount(request, admin, 'user.apikey.exchange', readKey.key_prefix), 'the refused exchange is logged under the presented prefix').toBeGreaterThanOrEqual(1)
      expect(await auditCount(request, admin, 'user.apikey.delete', readKey.id)).toBe(1)
      expect(await auditCount(request, admin, 'admin.apikey.delete', writeKey.id)).toBe(1)
    } finally {
      await deleteCM(admin, cmRead)
      await deleteCM(admin, cmWrite)
      await deleteUser(request, admin, userId)
    }
  })

  test('Settings → API keys: issue a key, see it once, revoke it', async ({ page, request }) => {
    const admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    test.skip(!(await enabled(request, admin)), 'API keys are disabled on this installation')

    await page.goto('/account')
    await page.waitForLoadState('networkidle')
    const section = page.getByTestId('account-api-keys')
    await expect(section).toBeVisible()

    const name = `e2e ui ${stamp()}`
    await page.getByTestId('api-key-create-open').click()
    await expect(page.getByTestId('api-key-modal')).toBeVisible()
    await page.getByTestId('api-key-name').fill(name)
    await page.getByTestId('api-key-days').fill('3')
    await page.getByTestId('api-key-submit').click()

    const value = page.getByTestId('api-key-value')
    await expect(value).toBeVisible({ timeout: 15000 })
    await expect(value).toHaveText(/^kbk_[A-Za-z0-9_-]{43}$/)
    await page.getByTestId('api-key-created-dismiss').click()
    await expect(value).toHaveCount(0)

    const row = section.locator('[data-testid^="api-key-row-"]', { hasText: name }).first()
    await expect(row).toBeVisible()
    const id = (await row.getAttribute('data-testid'))!.replace('api-key-row-', '')
    await page.getByTestId(`api-key-revoke-${id}`).click()
    await page.getByTestId(`api-key-revoke-confirm-${id}`).click()
    await expect(row).toHaveCount(0)

    const left = await (await request.get('/api/v1/auth/api-keys', { headers: bearer(admin) })).json()
    expect(left.map((k: any) => k.name)).not.toContain(name)
  })
})
