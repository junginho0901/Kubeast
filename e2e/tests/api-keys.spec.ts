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
      // the token already exchanged goes with the key once the services re-check (their token-version cache, 30 s)
      await expect.poll(async () => (await request.get(`/api/v1/cluster/overview?cluster=${CLUSTER}`, { headers: onCluster(token, CLUSTER), failOnStatusCode: false })).status(),
        { timeout: 45_000, intervals: [3_000] }).toBe(401)
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

  test('a token from a key cannot change the account', async ({ request }) => {
    const admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    test.skip(!(await enabled(request, admin)), 'API keys are disabled on this installation')
    const email = `e2e-apikey-acct-${stamp()}@example.com`
    let userId = ''
    try {
      userId = await createUser(request, admin, email)
      const granted = await request.put(`/api/v1/auth/admin/users/${userId}/cluster-roles/${CLUSTER}`, { headers: bearer(admin), data: { role: 'Write' } })
      expect(granted.ok(), `grant: ${await granted.text()}`).toBeTruthy()
      const user = await login(request, email, PW)
      const made = await request.post('/api/v1/auth/api-keys', { headers: bearer(user), data: { name: 'e2e account', expires_in_days: 1, cluster_ids: [CLUSTER], role_ceiling: 'Read' } })
      expect(made.status(), `create: ${await made.text()}`).toBe(201)
      const key = await made.json()
      const token = (await (await exchange(request, key.key)).json()).access_token as string

      const wider = await request.post('/api/v1/auth/api-keys', { headers: bearer(token), data: { name: 'e2e wider', expires_in_days: 1, role_ceiling: 'Admin' }, failOnStatusCode: false })
      expect(wider.status(), 'a new key').toBe(403)
      expect(await wider.text(), 'the answer names the key').toContain('API key')
      expect((await request.delete(`/api/v1/auth/api-keys/${key.id}`, { headers: bearer(token), failOnStatusCode: false })).status(), 'revoking a key').toBe(403)
      const changed = await request.post('/api/v1/auth/change-password', { headers: bearer(token), data: { current_password: PW, new_password: `${PW}2` }, failOnStatusCode: false })
      expect(changed.status(), 'the password').toBe(403)
      expect((await request.delete('/api/v1/auth/access-requests/no-such-request', { headers: bearer(token), failOnStatusCode: false })).status(), 'cancelling an access request').toBe(403)
      expect((await request.delete('/api/v1/auth/access-requests/no-such-request', { headers: bearer(user), failOnStatusCode: false })).status(), 'the signed-in owner reaches the route').toBe(404)
      const switched = { previous_cluster: CLUSTER, new_cluster: CLUSTER }
      expect((await request.post('/api/v1/audit/cluster-switch', { headers: bearer(token), data: switched, failOnStatusCode: false })).status(), 'a cluster switch row').toBe(403)
      expect((await request.post('/api/v1/audit/cluster-switch', { headers: bearer(user), data: switched, failOnStatusCode: false })).status(), 'the signed-in owner records one').toBe(204)

      // Nothing changed, and the token still does what a key is for.
      const listed = await (await request.get('/api/v1/auth/api-keys', { headers: bearer(user) })).json()
      expect(listed.map((k: any) => k.id), 'no new key, none revoked').toEqual([key.id])
      expect((await exchange(request, key.key)).status(), 'the key still exchanges').toBe(200)
      expect(await login(request, email, PW), 'the password is the old one').toBeTruthy()
      const self = await request.get('/api/v1/auth/me', { headers: bearer(token) })
      expect(self.status(), 'reading its own account').toBe(200)
      expect((await request.get(`/api/v1/cluster/overview?cluster=${CLUSTER}`, { headers: onCluster(token, CLUSTER) })).status(), 'reading the cluster').toBe(200)

      // Each refusal is a failure row against the owner (the rows of a key name the key).
      for (const action of ['user.apikey.create', 'user.apikey.delete', 'user.password.change', 'access.request.cancel', 'user.cluster.switch']) {
        await expect.poll(() => auditCount(request, admin, action, userId), { message: action, timeout: 10_000 }).toBe(1)
      }
    } finally {
      await deleteUser(request, admin, userId)
    }
  })

  test('a key stays within the role its owner holds on the cluster', async ({ request }) => {
    test.setTimeout(120_000)
    const admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    test.skip(!(await enabled(request, admin)), 'API keys are disabled on this installation')
    const run = stamp()
    const customRole = `e2e-apikey-custom-${run}`
    const auditorRole = `e2e-apikey-auditor-${run}`
    const roleIds: number[] = []
    const userIds: string[] = []
    const groupsFor = async (token: string): Promise<string[]> => {
      const res = await request.get(`/api/v1/cluster/namespaces/kube-system/pods?cluster=${CLUSTER}`, { headers: onCluster(token, CLUSTER), failOnStatusCode: false })
      const header = res.headers()['x-kubeast-access']
      expect(header, 'X-Kubeast-Access on a cluster answer').toBeTruthy()
      return (JSON.parse(Buffer.from(header, 'base64url').toString('utf8')).groups as string[]).slice().sort()
    }
    const mkRole = async (name: string, permissions: string[]) => {
      const res = await request.post('/api/v1/auth/admin/roles', { headers: bearer(admin), data: { name, permissions } })
      expect(res.status(), `role ${name}: ${await res.text()}`).toBeLessThan(300)
      roleIds.push((await res.json()).id)
    }
    const grantOn = async (userId: string, role: string) => {
      const res = await request.put(`/api/v1/auth/admin/users/${userId}/cluster-roles/${CLUSTER}`, { headers: bearer(admin), data: { role } })
      expect(res.ok(), `grant ${role}: ${await res.text()}`).toBeTruthy()
    }
    const adminCeilingKey = async (token: string) => {
      const res = await request.post('/api/v1/auth/api-keys', { headers: bearer(token), data: { name: 'e2e ceiling', expires_in_days: 1, cluster_ids: [CLUSTER], role_ceiling: 'Admin' } })
      expect(res.status(), `create: ${await res.text()}`).toBe(201)
      return (await res.json()).key as string
    }
    const decode = (token: string) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())
    try {
      // A custom role: the Admin ceiling lifts neither its permissions nor its identity on the cluster.
      await mkRole(customRole, ['menu.*', 'resource.*.read'])
      const customEmail = `e2e-apikey-c-${run}@example.com`
      const customId = await createUser(request, admin, customEmail)
      userIds.push(customId)
      await grantOn(customId, customRole)
      const session = await login(request, customEmail, PW)
      const customKey = await adminCeilingKey(session)
      const customToken = (await (await exchange(request, customKey)).json()).access_token as string
      expect(decode(customToken).roles, 'the role on the token').toEqual({ [CLUSTER]: customRole })
      const sessionGroups = await groupsFor(session)
      expect(sessionGroups, 'the session acts as the custom role').toContain(`kubeast:role:${customRole}`)
      expect(await groupsFor(customToken), 'the key acts as the session does').toEqual(sessionGroups)

      // Read under an Admin ceiling stays Read.
      const readEmail = `e2e-apikey-r-${run}@example.com`
      const readId = await createUser(request, admin, readEmail)
      userIds.push(readId)
      await grantOn(readId, 'Read')
      const readSession = await login(request, readEmail, PW)
      const readKey = await adminCeilingKey(readSession)
      const readToken = (await (await exchange(request, readKey)).json()).access_token as string
      expect(decode(readToken).roles, 'Read stays Read').toEqual({ [CLUSTER]: 'Read' })
      expect(await groupsFor(readToken), 'the key acts as Read').toEqual(await groupsFor(readSession))

      // A global admin.* permission is no ground for a cluster: the key goes with the grant it was made under.
      await mkRole(auditorRole, ['admin.audit.read', 'menu.*'])
      const raw = await (await request.get('/api/v1/auth/roles', { headers: bearer(admin) })).json()
      const auditorId = (Array.isArray(raw) ? raw : raw.roles || raw.items || []).find((r: any) => r.name === auditorRole).id
      const auditorEmail = `e2e-apikey-a-${run}@example.com`
      const created = await request.post('/api/v1/auth/admin/users', { headers: bearer(admin), data: { name: 'E2E api key', email: auditorEmail, password: PW, role_id: auditorId } })
      expect(created.status(), `create: ${await created.text()}`).toBe(201)
      const auditorUserId = (await created.json()).id as string
      userIds.push(auditorUserId)
      await grantOn(auditorUserId, 'Admin')
      const auditorKey = await adminCeilingKey(await login(request, auditorEmail, PW))
      const before = (await (await exchange(request, auditorKey)).json()).access_token as string
      expect(decode(before).roles, 'Admin while granted').toEqual({ [CLUSTER]: 'Admin' })
      const revoked = await request.delete(`/api/v1/auth/admin/users/${auditorUserId}/cluster-roles/${CLUSTER}`, { headers: bearer(admin) })
      expect(revoked.ok(), `revoke: ${await revoked.text()}`).toBeTruthy()
      const after = (await (await exchange(request, auditorKey)).json()).access_token as string
      expect(Object.keys(decode(after).permissions ?? {}), 'no cluster after the grant is gone').toEqual([])
      expect(decode(after).roles ?? {}, 'no role after the grant is gone').toEqual({})
      expect((await request.get(`/api/v1/cluster/overview?cluster=${CLUSTER}`, { headers: onCluster(after, CLUSTER), failOnStatusCode: false })).status(), 'the cluster refuses it').toBe(403)
    } finally {
      for (const id of userIds) await deleteUser(request, admin, id)
      for (const id of roleIds) await request.delete(`/api/v1/auth/admin/roles/${id}`, { headers: bearer(admin), failOnStatusCode: false })
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
