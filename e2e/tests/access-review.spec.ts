import { test, expect, type APIRequestContext } from '@playwright/test'

// Access review: the admin's report of who has what (accounts, per-cluster
// grants, API keys, temporary grants, roles), its CSV sections, and the
// sign-off that stores the report as it stood. The spec creates a user that
// never signs in, grants it a cluster role, has it issue an API key, then
// checks the report, the page, the CSV, a sign-off and the audit rows; the
// user is deleted at the end. Skips when ACCESS_REVIEW_ENABLED is off.

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const CLUSTER = 'default'
const PW = 'E2e-review-pass1!'
const stamp = Date.now().toString(36)
const EMAIL = `e2e-review-${stamp}@example.com`

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

async function enabled(request: APIRequestContext, admin: string): Promise<boolean> {
  const res = await request.get('/api/v1/auth/access-review/config', { headers: bearer(admin) })
  return res.ok() && !!(await res.json()).enabled
}

test.describe('Access review', () => {
  let admin = ''
  let userId = ''

  test.beforeAll(async ({ request }) => {
    admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    test.skip(!(await enabled(request, admin)), 'ACCESS_REVIEW_ENABLED is off on this installation')
    const created = await request.post('/api/v1/auth/admin/users', {
      headers: bearer(admin),
      data: { name: 'E2E review', email: EMAIL, password: PW, role_id: await roleId(request, admin, 'Member') },
    })
    expect(created.status(), await created.text()).toBe(201)
    userId = (await created.json()).id
    const grant = await request.put(`/api/v1/auth/admin/users/${userId}/cluster-roles/${CLUSTER}`, {
      headers: bearer(admin), data: { role: 'Read' },
    })
    expect(grant.ok(), await grant.text()).toBeTruthy()
    // The user issues a key for itself (admins cannot issue for others); the
    // sign-in also sets its last_login_at.
    const user = await login(request, EMAIL, PW)
    const keyRes = await request.post('/api/v1/auth/api-keys', { headers: bearer(user), data: { name: 'e2e-review', expires_in_days: 7 } })
    expect(keyRes.status(), await keyRes.text()).toBe(201)
  })

  test.afterAll(async ({ request }) => {
    if (userId) await request.delete(`/api/v1/auth/admin/users/${userId}`, { headers: bearer(admin), failOnStatusCode: false })
  })

  test('the report lists the account, its grant and its key with the right flags', async ({ request }) => {
    const res = await request.get('/api/v1/auth/admin/access-review', { headers: bearer(admin) })
    expect(res.ok(), await res.text()).toBeTruthy()
    const rep = await res.json()
    expect(rep.settings.dormant_days).toBeGreaterThan(0)
    expect(rep.summary.users).toBeGreaterThanOrEqual(2)
    expect(rep.summary.global_admins).toBeGreaterThanOrEqual(1)

    const me = rep.users.find((u: any) => u.email === EMAIL)
    expect(me, 'the account is listed').toBeTruthy()
    expect(me.global_role).toBe('Member')
    expect(me.last_login_at, 'last_login_at set by the sign-in above').toBeTruthy()
    expect(me.flags).not.toContain('never_logged_in')
    expect(me.cluster_roles).toBe(1)
    expect(me.api_keys).toBe(1)

    const adminRow = rep.users.find((u: any) => u.email === ADMIN_EMAIL || u.global_role === 'Admin')
    expect(adminRow.flags).toContain('global_admin')

    const grant = rep.cluster_roles.find((g: any) => g.user_email === EMAIL)
    expect(grant).toMatchObject({ role: 'Read', granted_via: 'permanent', flags: [] })

    const key = rep.api_keys.find((k: any) => k.owner_email === EMAIL)
    expect(key).toMatchObject({ name: 'e2e-review', role_ceiling: 'Read', flags: ['expiring_30d'] })
    expect(key.last_used_at).toBeNull()

    const adminRole = rep.roles.find((r: any) => r.name === 'Admin')
    expect(adminRole.flags).toContain('has_admin_permissions')
    expect(adminRole.users).toBeGreaterThanOrEqual(1)
    for (const section of ['users', 'cluster_roles', 'api_keys', 'access_requests', 'roles']) {
      expect(Array.isArray(rep[section]), `${section} is an array`).toBeTruthy()
    }

    const bad = await request.get('/api/v1/auth/admin/access-review?since=yesterday', { headers: bearer(admin), failOnStatusCode: false })
    expect(bad.status()).toBe(400)
    const user = await login(request, EMAIL, PW)
    const forbidden = await request.get('/api/v1/auth/admin/access-review', { headers: bearer(user), failOnStatusCode: false })
    expect(forbidden.status()).toBe(403)
  })

  test('each section exports as CSV with a BOM and a header row', async ({ request }) => {
    for (const [section, header] of [
      ['users', 'email,name,team,auth_source,global_role,created_at,last_login_at,locked_until,dormant_locked_at,cluster_roles,api_keys,temporary_grants,flags'],
      ['cluster_roles', 'user_email,cluster,role,granted_via,expires_at,restore_role,flags'],
      ['api_keys', 'owner_email,name,key_prefix,clusters,role_ceiling,created_at,expires_at,last_used_at,last_used_ip,flags'],
      ['access_requests', 'requester_email,cluster,role,duration_minutes,reason,status,created_at,decided_by_email,decided_at,decision_note,expires_at,ended_at,end_reason'],
      ['roles', 'name,is_system,description,permissions,users,cluster_bindings,flags'],
    ]) {
      const res = await request.get(`/api/v1/auth/admin/access-review/export?section=${section}`, { headers: bearer(admin) })
      expect(res.ok(), `${section}: ${res.status()}`).toBeTruthy()
      expect(res.headers()['content-type']).toContain('text/csv')
      expect(res.headers()['content-disposition']).toContain(`access-review-${section}-`)
      const body = await res.body()
      expect(body.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]))
      const lines = body.subarray(3).toString('utf8').split('\r\n')
      expect(lines[0]).toBe(header)
    }
    const users = (await (await request.get('/api/v1/auth/admin/access-review/export?section=users', { headers: bearer(admin) })).text())
    expect(users).toContain(EMAIL)
    const bad = await request.get('/api/v1/auth/admin/access-review/export?section=secrets', { headers: bearer(admin), failOnStatusCode: false })
    expect(bad.status()).toBe(400)
  })

  test('a sign-off stores the report, shows in the history and in the audit log', async ({ request }) => {
    const before = (await (await request.get('/api/v1/auth/admin/access-review/history', { headers: bearer(admin) })).json()).length
    const res = await request.post('/api/v1/auth/admin/access-review/signoff', { headers: bearer(admin), data: { note: `e2e ${stamp}` } })
    expect(res.status(), await res.text()).toBe(201)
    const rev = await res.json()
    expect(rev.id).toBeTruthy()
    expect(rev.reviewed_by_email).toBe(ADMIN_EMAIL)
    expect(rev.counts.users).toBeGreaterThanOrEqual(2)
    expect(rev.snapshot).toBeUndefined()

    const history = await (await request.get('/api/v1/auth/admin/access-review/history', { headers: bearer(admin) })).json()
    expect(history.length).toBe(before + 1)
    expect(history[0].id).toBe(rev.id)
    expect(history[0].note).toBe(`e2e ${stamp}`)

    const snapshot = await (await request.get(`/api/v1/auth/admin/access-review/history/${rev.id}`, { headers: bearer(admin) })).json()
    expect(snapshot.snapshot.users.some((u: any) => u.email === EMAIL)).toBeTruthy()
    expect(snapshot.snapshot.summary.users).toBe(rev.counts.users)

    const fromSnapshot = await (await request.get(`/api/v1/auth/admin/access-review/export?section=users&review_id=${rev.id}`, { headers: bearer(admin) })).text()
    expect(fromSnapshot).toContain(EMAIL)
    const missing = await request.get('/api/v1/auth/admin/access-review/history/does-not-exist', { headers: bearer(admin), failOnStatusCode: false })
    expect(missing.status()).toBe(404)

    // The next report counts from this sign-off.
    const rep = await (await request.get('/api/v1/auth/admin/access-review', { headers: bearer(admin) })).json()
    expect(rep.last_review.id).toBe(rev.id)
    expect(rep.next_due_at).toBeTruthy()
    expect(rep.overdue).toBe(false)

    for (const action of ['admin.review.read', 'admin.review.export', 'admin.review.signoff']) {
      const logs = await (await request.get(`/api/v1/auth/admin/audit-logs?action=${action}&limit=5`, { headers: bearer(admin) })).json()
      const rows = Array.isArray(logs) ? logs : logs.items || logs.logs || []
      expect(rows.length, `audit rows for ${action}`).toBeGreaterThan(0)
      expect(rows[0].ActorEmail).toBe(ADMIN_EMAIL) // audit entries serialise with Go field names
    }
  })

  test('the admin page shows the cards, tabs, CSV button and signs off', async ({ page }) => {
    await page.goto('/admin/access-review')
    await expect(page.getByRole('heading', { name: /Access review|접근 권한 검토/i })).toBeVisible()
    await expect(page.getByTestId('access-review-summary')).toBeVisible({ timeout: 15000 })
    await expect(page.getByTestId('access-review-card-users')).toContainText(/\d+/)
    await expect(page.getByTestId('access-review-last-review')).toBeVisible()

    await expect(page.getByTestId('access-review-table')).toBeVisible()
    await expect(page.getByTestId('access-review-table')).toContainText(EMAIL)

    await page.getByTestId('access-review-tab-api_keys').click()
    await expect(page.getByTestId('access-review-table')).toContainText('e2e-review')
    await page.getByTestId('access-review-tab-roles').click()
    await expect(page.getByTestId('access-review-table')).toContainText('Admin')
    await page.getByTestId('access-review-tab-users').click()

    const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('access-review-export').click()])
    expect(download.suggestedFilename()).toMatch(/^access-review-users-.*\.csv$/)

    await page.getByTestId('access-review-signoff-note').fill(`ui ${stamp}`)
    await page.getByTestId('access-review-signoff').click()
    await expect(page.getByTestId('access-review-signoff-message')).toBeVisible({ timeout: 15000 })

    await page.getByTestId('access-review-tab-history').click()
    await expect(page.getByTestId('access-review-history-row').first()).toContainText(`ui ${stamp}`)
    await page.getByTestId('access-review-history-row').first().getByRole('button').click()
    await expect(page.getByTestId('access-review-snapshot-banner')).toBeVisible()
    await expect(page.getByTestId('access-review-table')).toContainText(EMAIL)
    await expect(page.getByTestId('access-review-signoff-panel')).toHaveCount(0)

    // The menu item is there for admins.
    await expect(page.getByTestId('nav-access-review')).toBeVisible()
  })
})
