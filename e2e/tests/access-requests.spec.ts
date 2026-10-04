import { test, expect, type APIRequestContext, type Page } from '@playwright/test'

// Access requests: a user with a role on a cluster asks for a higher one for a
// bounded time; an admin (never the requester) approves. The approval revokes
// the requester's session and the next sign-in carries the role until it
// expires, when the sweeper restores the previous role and revokes again.
// Runs only when the installation has ACCESS_REQUESTS_ENABLED (the dev kind
// manifest turns it on with a 5 s sweep).

const EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const PASSWORD = process.env.E2E_USER_PASSWORD || ''
const CLUSTER = 'default'
const PW = 'E2e-access-pass1!'
const stamp = () => Date.now().toString(36)

const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })

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

async function createUser(request: APIRequestContext, admin: string, email: string, roleName: string): Promise<string> {
  const res = await request.post('/api/v1/auth/admin/users', {
    headers: bearer(admin),
    data: { name: `E2E ${roleName}`, email, password: PW, role_id: await roleId(request, admin, roleName) },
  })
  expect(res.status(), `create ${email}: ${await res.text()}`).toBe(201)
  return (await res.json()).id
}

async function grant(request: APIRequestContext, admin: string, userId: string, role: string): Promise<void> {
  const res = await request.put(`/api/v1/auth/admin/users/${userId}/cluster-roles/${CLUSTER}`, { headers: bearer(admin), data: { role } })
  expect(res.ok(), `grant ${role}: ${await res.text()}`).toBeTruthy()
}

async function clusterRole(request: APIRequestContext, admin: string, userId: string): Promise<string | undefined> {
  const res = await request.get(`/api/v1/auth/admin/users/${userId}/cluster-roles`, { headers: bearer(admin) })
  return (await res.json())[CLUSTER]
}

async function deleteUser(request: APIRequestContext, admin: string, userId: string): Promise<void> {
  if (!userId) return
  await request.delete(`/api/v1/auth/admin/users/${userId}`, { headers: bearer(admin), failOnStatusCode: false })
}

async function enabled(request: APIRequestContext, admin: string): Promise<boolean> {
  const res = await request.get('/api/v1/auth/access-requests/config', { headers: bearer(admin) })
  return res.ok() && !!(await res.json()).enabled
}

async function loginUI(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/login')
  await page.locator('input[autocomplete="email"]').first().fill(email)
  await page.locator('input[type="password"]').first().fill(password)
  await page.locator('button[type="submit"]').first().click()
  await page.waitForFunction(() => !document.querySelector('input[autocomplete="email"]'), { timeout: 20000 })
}

test.describe('access requests', () => {
  test('request → approve → elevated sign-in → automatic expiry', async ({ request }) => {
    test.setTimeout(240_000)
    const admin = await login(request, EMAIL, PASSWORD)
    test.skip(!(await enabled(request, admin)), 'ACCESS_REQUESTS_ENABLED is off on this installation')

    const s = stamp()
    const cm = `e2e-access-${s}`
    const reqEmail = `e2e-ar-req-${s}@example.com`
    const aprEmail = `e2e-ar-apr-${s}@example.com`
    let requester = ''
    let approver = ''
    // The write probe is a namespaced delete (resource.*.delete is in Write;
    // the cluster's `edit` binding allows it). A cluster-scoped write such as
    // creating a Namespace stays forbidden for Write — the cluster's RBAC, not
    // the Kubeast role, is the final authority.
    const createCM = (name: string) =>
      request.post(`/api/v1/cluster/resources/yaml/create?cluster=${CLUSTER}`, {
        headers: bearer(admin),
        data: { namespace: 'default', yaml: `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: ${name}\n  namespace: default\ndata:\n  k: v\n` },
      })
    const deleteCM = (token: string, name: string) =>
      request.delete(`/api/v1/cluster/namespaces/default/configmaps/${name}?cluster=${CLUSTER}`, { headers: bearer(token) })
    try {
      requester = await createUser(request, admin, reqEmail, 'Member')
      approver = await createUser(request, admin, aprEmail, 'Admin')
      await grant(request, admin, requester, 'Read')
      for (const name of [cm, `${cm}-2`]) {
        const made = await createCM(name)
        expect([200, 201], await made.text()).toContain(made.status())
      }

      const r1 = await login(request, reqEmail, PW)
      // Read cannot delete.
      expect((await deleteCM(r1, cm)).status()).toBe(403)

      // One minute of Write, with a reason.
      const created = await request.post('/api/v1/auth/access-requests', {
        headers: bearer(r1),
        data: { cluster_id: CLUSTER, role: 'Write', duration_minutes: 1, reason: 'e2e: temporary write' },
      })
      expect(created.status(), await created.text()).toBe(201)
      const req = await created.json()
      expect(req.status).toBe('pending')
      expect(req.cluster_id).toBe(CLUSTER)

      // One pending request per cluster; no admin permission → no decision.
      expect((await request.post('/api/v1/auth/access-requests', {
        headers: bearer(r1), data: { cluster_id: CLUSTER, role: 'Write', duration_minutes: 5, reason: 'again' },
      })).status()).toBe(409)
      expect((await request.post(`/api/v1/auth/admin/access-requests/${req.id}/approve`, { headers: bearer(r1), data: {} })).status()).toBe(403)
      const mine = await (await request.get('/api/v1/auth/access-requests', { headers: bearer(r1) })).json()
      expect(mine.some((x: any) => x.id === req.id && x.status === 'pending')).toBeTruthy()

      // Another admin approves with a note.
      const a = await login(request, aprEmail, PW)
      const approved = await request.post(`/api/v1/auth/admin/access-requests/${req.id}/approve`, { headers: bearer(a), data: { note: 'e2e ok' } })
      expect(approved.status(), await approved.text()).toBe(200)
      const decided = await approved.json()
      expect(decided.status).toBe('approved')
      expect(decided.decision_note).toBe('e2e ok')
      expect(decided.expires_at).toBeTruthy()

      // The requester's earlier session is revoked; a fresh one carries Write.
      expect((await request.get('/api/v1/auth/me', { headers: bearer(r1) })).status()).toBe(401)
      const r2 = await login(request, reqEmail, PW)
      const me = await (await request.get('/api/v1/auth/me', { headers: bearer(r2) })).json()
      expect(me.cluster_roles?.[CLUSTER]).toBe('Write')
      const deleted = await deleteCM(r2, cm)
      expect([200, 202, 204], await deleted.text()).toContain(deleted.status())

      // The cluster access list shows the grant as temporary.
      const list = await (await request.get(`/api/v1/auth/admin/clusters/${CLUSTER}/user-roles`, { headers: bearer(admin) })).json()
      const row = list.find((g: any) => g.user_id === requester)
      expect(row?.role).toBe('Write')
      expect(row?.expires_at).toBeTruthy()

      // After the minute the sweeper restores Read and closes the request.
      await expect.poll(() => clusterRole(request, admin, requester), { timeout: 150_000, intervals: [3000] }).toBe('Read')
      const ended = await (await request.get('/api/v1/auth/admin/access-requests?status=expired', { headers: bearer(admin) })).json()
      const closed = ended.find((x: any) => x.id === req.id)
      expect(closed?.end_reason).toBe('expired')

      // The elevated session is revoked too; the next sign-in is Read again.
      expect((await request.get('/api/v1/auth/me', { headers: bearer(r2) })).status()).toBe(401)
      const r3 = await login(request, reqEmail, PW)
      expect((await (await request.get('/api/v1/auth/me', { headers: bearer(r3) })).json()).cluster_roles?.[CLUSTER]).toBe('Read')
      expect((await deleteCM(r3, `${cm}-2`)).status()).toBe(403)

      // The audit trail names every step.
      for (const action of ['access.request.create', 'access.request.approve', 'access.grant.expire']) {
        const logs = await (await request.get(`/api/v1/auth/admin/audit-logs?action=${action}&limit=20`, { headers: bearer(admin) })).json()
        const items = Array.isArray(logs) ? logs : logs.items || []
        // The list serializes audit.Record as-is (Go field names).
        expect(items.some((i: any) => (i.Action ?? i.action) === action && ((i.TargetID ?? i.target_id) === requester || (i.TargetEmail ?? i.target_email) === reqEmail)), action).toBeTruthy()
      }
    } finally {
      for (const name of [cm, `${cm}-2`]) {
        await request.delete(`/api/v1/cluster/namespaces/default/configmaps/${name}?cluster=${CLUSTER}`, { headers: bearer(admin), failOnStatusCode: false })
      }
      await deleteUser(request, admin, requester)
      await deleteUser(request, admin, approver)
    }
  })

  test('reject, cancel, escalation-only and own-request guards', async ({ request }) => {
    const admin = await login(request, EMAIL, PASSWORD)
    test.skip(!(await enabled(request, admin)), 'ACCESS_REQUESTS_ENABLED is off on this installation')

    const s = stamp()
    const reqEmail = `e2e-ar-req2-${s}@example.com`
    const aprEmail = `e2e-ar-apr2-${s}@example.com`
    const noneEmail = `e2e-ar-none-${s}@example.com`
    let requester = ''
    let approver = ''
    let nobody = ''
    try {
      requester = await createUser(request, admin, reqEmail, 'Member')
      approver = await createUser(request, admin, aprEmail, 'Admin')
      nobody = await createUser(request, admin, noneEmail, 'Member')
      await grant(request, admin, requester, 'Read')
      await grant(request, admin, approver, 'Read')
      const r = await login(request, reqEmail, PW)
      const a = await login(request, aprEmail, PW)
      const file = (token: string, data: Record<string, unknown>) =>
        request.post('/api/v1/auth/access-requests', { headers: bearer(token), data: { cluster_id: CLUSTER, role: 'Write', duration_minutes: 30, reason: 'e2e guards', ...data } })

      // Policy refusals.
      expect((await file(r, { role: 'Admin' })).status(), 'Admin is above the Write ceiling').toBe(400)
      expect((await file(r, { duration_minutes: 0 })).status(), 'zero minutes').toBe(400)
      expect((await file(r, { duration_minutes: 9 * 60 })).status(), 'over the maximum').toBe(400)
      expect((await file(r, { reason: '  ' })).status(), 'a reason is required').toBe(400)
      expect((await file(r, { cluster_id: 'no-such-cluster' })).status(), 'no grant on an unknown cluster').toBe(403)
      const n = await login(request, noneEmail, PW)
      expect((await file(n, {})).status(), 'no grant to escalate from').toBe(403)

      // Reject keeps the session and the role.
      const first = await (await file(r, {})).json()
      const rejected = await request.post(`/api/v1/auth/admin/access-requests/${first.id}/reject`, { headers: bearer(a), data: { note: 'not now' } })
      expect(rejected.status(), await rejected.text()).toBe(200)
      expect((await rejected.json()).status).toBe('rejected')
      expect((await request.get('/api/v1/auth/me', { headers: bearer(r) })).status()).toBe(200)
      expect(await clusterRole(request, admin, requester)).toBe('Read')
      expect((await request.post(`/api/v1/auth/admin/access-requests/${first.id}/approve`, { headers: bearer(a), data: {} })).status(), 'decided twice').toBe(409)

      // Cancel is the requester's own, once.
      const second = await (await file(r, {})).json()
      expect((await request.delete(`/api/v1/auth/access-requests/${second.id}`, { headers: bearer(a) })).status(), 'not the owner').toBe(404)
      expect((await request.delete(`/api/v1/auth/access-requests/${second.id}`, { headers: bearer(r) })).status()).toBe(204)
      expect((await request.delete(`/api/v1/auth/access-requests/${second.id}`, { headers: bearer(r) })).status()).toBe(409)
      const mine = await (await request.get('/api/v1/auth/access-requests', { headers: bearer(r) })).json()
      expect(mine.find((x: any) => x.id === second.id)?.status).toBe('cancelled')

      // An admin cannot approve their own request; another admin can, and a
      // revocation by hand closes the request as revoked.
      const own = await (await file(a, {})).json()
      const self = await request.post(`/api/v1/auth/admin/access-requests/${own.id}/approve`, { headers: bearer(a), data: {} })
      expect(self.status()).toBe(403)
      expect((await self.text()).toLowerCase()).toContain('own')
      expect((await request.post(`/api/v1/auth/admin/access-requests/${own.id}/approve`, { headers: bearer(admin), data: {} })).status()).toBe(200)
      expect(await clusterRole(request, admin, approver)).toBe('Write')
      expect((await request.delete(`/api/v1/auth/admin/users/${approver}/cluster-roles/${CLUSTER}`, { headers: bearer(admin) })).status()).toBe(204)
      const all = await (await request.get('/api/v1/auth/admin/access-requests?status=expired', { headers: bearer(admin) })).json()
      expect(all.find((x: any) => x.id === own.id)?.end_reason).toBe('revoked')
    } finally {
      await deleteUser(request, admin, requester)
      await deleteUser(request, admin, approver)
      await deleteUser(request, admin, nobody)
    }
  })

  test('UI: the account section files a request, the admin page approves, the badge counts', async ({ page, browser, request }) => {
    test.setTimeout(180_000)
    const admin = await login(request, EMAIL, PASSWORD)
    test.skip(!(await enabled(request, admin)), 'ACCESS_REQUESTS_ENABLED is off on this installation')

    const s = stamp()
    const reqEmail = `e2e-ar-ui-${s}@example.com`
    let requester = ''
    const ctx = await browser.newContext()
    try {
      requester = await createUser(request, admin, reqEmail, 'Member')
      await grant(request, admin, requester, 'Read')

      // The requester, in their own session, asks from Settings → Cluster access.
      const p = await ctx.newPage()
      await loginUI(p, reqEmail, PW)
      await p.goto('/account')
      await expect(p.getByTestId('account-cluster-access')).toBeVisible({ timeout: 15000 })
      await p.getByTestId(`access-request-open-${CLUSTER}`).click()
      await expect(p.getByTestId('access-request-modal')).toBeVisible()
      await p.getByTestId('access-request-reason').fill('e2e: ui request')
      await p.getByTestId('access-request-submit').click()
      await expect(p.getByTestId('access-request-notice')).toBeVisible({ timeout: 10000 })
      await expect(p.getByTestId(`account-cluster-pending-${CLUSTER}`)).toBeVisible()

      // The admin (shared session) sees the pending row and the badge, approves.
      const pending = await (await request.get('/api/v1/auth/admin/access-requests?status=pending', { headers: bearer(admin) })).json()
      const id = pending.find((x: any) => x.user_id === requester)?.id
      expect(id, 'the request is pending').toBeTruthy()
      await page.goto('/admin/access-requests')
      await expect(page.getByTestId(`access-request-row-${id}`)).toBeVisible({ timeout: 15000 })
      await expect(page.getByTestId('nav-access-requests-badge')).toHaveText(/^[1-9]\d*$/)
      await page.getByTestId(`access-request-note-${id}`).fill('ui ok')
      await page.getByTestId(`access-request-approve-${id}`).click()
      await expect(page.getByTestId(`access-request-row-${id}`)).toHaveCount(0, { timeout: 10000 })
      await page.getByTestId('access-requests-tab-history').click()
      await expect(page.getByTestId(`access-request-status-${id}`)).toBeVisible({ timeout: 10000 })
      expect(await clusterRole(request, admin, requester)).toBe('Write')

      // The requester's session was revoked: the next navigation lands on the
      // sign-in form; signing in again shows the temporary grant.
      await p.goto('/account')
      await expect(p.locator('input[autocomplete="email"]').first()).toBeVisible({ timeout: 20000 })
      await loginUI(p, reqEmail, PW)
      await p.goto('/account')
      await expect(p.getByTestId(`account-cluster-until-${CLUSTER}`)).toBeVisible({ timeout: 15000 })
      await expect(p.getByTestId(`access-request-status-${id}`)).toBeVisible()
    } finally {
      await ctx.close()
      await deleteUser(request, admin, requester)
    }
  })
})
