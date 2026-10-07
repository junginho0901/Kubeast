import { test, expect, type APIRequestContext } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

// Dormant accounts: an account with no sign-in and no API key use for
// DORMANT_ACCOUNTS_DAYS is locked by the sweeper and refused at login and at
// API key exchange until an admin unlocks it; accounts with admin permissions
// are exempt. The spec creates a Member and an Admin, backdates their
// activity straight in the dev database (kubectl exec into the postgres pod of
// the kind cluster — never the shell's default kubeconfig), runs "sweep now"
// and checks the lock, the refusals, the audit rows, the unlock and the admin
// page. Skips when DORMANT_ACCOUNTS_ENABLED is off.

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const PW = 'E2e-dormant-pass1!'
const stamp = Date.now().toString(36)
const MEMBER = `e2e-dormant-${stamp}@example.com`
const ADMIN2 = `e2e-dormant-admin-${stamp}@example.com`

const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })

const LOCAL_KUBECONFIG = path.resolve(__dirname, '../../.kubeconfig-kind')
const KUBECONFIG = process.env.KUBECONFIG || (fs.existsSync(LOCAL_KUBECONFIG) ? LOCAL_KUBECONFIG : '')
function psql(sql: string): string {
  if (!KUBECONFIG) throw new Error('KUBECONFIG is unset and .kubeconfig-kind is missing: refusing to run kubectl against the default kubeconfig')
  return execFileSync('kubectl', ['-n', 'kubeast', 'exec', 'deploy/postgres', '--', 'psql', '-U', 'kubeast', '-d', 'kubeast', '-tAc', sql],
    { env: { ...process.env, KUBECONFIG }, encoding: 'utf8' }).trim()
}

async function login(request: APIRequestContext, email: string, password: string, ok = true): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email, password }, failOnStatusCode: false })
  if (!ok) {
    expect(res.status(), `login ${email} should be refused`).toBe(401)
    return ''
  }
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

async function createUser(request: APIRequestContext, admin: string, email: string, role: string): Promise<string> {
  const res = await request.post('/api/v1/auth/admin/users', { headers: bearer(admin), data: { name: `E2E ${role}`, email, password: PW, role_id: await roleId(request, admin, role) } })
  expect(res.status(), await res.text()).toBe(201)
  return (await res.json()).id
}

async function listed(request: APIRequestContext, admin: string, email: string): Promise<any> {
  const users = await (await request.get('/api/v1/auth/admin/users?limit=200', { headers: bearer(admin) })).json()
  return users.find((u: any) => u.email === email)
}

test.describe('Dormant accounts', () => {
  let admin = ''
  let memberId = ''
  let admin2Id = ''
  let apiKey = ''

  test.beforeAll(async ({ request }) => {
    admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    const cfg = await (await request.get('/api/v1/auth/dormant-accounts/config', { headers: bearer(admin) })).json()
    test.skip(!cfg.enabled, 'DORMANT_ACCOUNTS_ENABLED is off on this installation')
    memberId = await createUser(request, admin, MEMBER, 'Member')
    admin2Id = await createUser(request, admin, ADMIN2, 'Admin')
    // The member signs in and issues a key: both count as activity.
    const member = await login(request, MEMBER, PW)
    const key = await request.post('/api/v1/auth/api-keys', { headers: bearer(member), data: { name: 'e2e-dormant', expires_in_days: 7 } })
    expect(key.status(), await key.text()).toBe(201)
    apiKey = (await key.json()).key
  })

  test.afterAll(async ({ request }) => {
    for (const id of [memberId, admin2Id]) {
      if (id) await request.delete(`/api/v1/auth/admin/users/${id}`, { headers: bearer(admin), failOnStatusCode: false })
    }
  })

  test('a fresh account survives a sweep; a backdated one is locked, refused, then unlocked', async ({ request }) => {
    const first = await (await request.post('/api/v1/auth/admin/dormant-accounts/sweep', { headers: bearer(admin) })).json()
    expect(first.users).not.toContain(MEMBER)
    expect((await listed(request, admin, MEMBER)).dormant_locked_at).toBeUndefined()
    expect((await listed(request, admin, MEMBER)).last_login_at).toBeTruthy()

    // 200 days of silence: the sign-in, the key use and the creation.
    psql(`UPDATE auth_users SET last_login_at = NOW() - INTERVAL '200 days', created_at = NOW() - INTERVAL '200 days' WHERE email IN ('${MEMBER}', '${ADMIN2}')`)
    psql(`UPDATE api_keys SET last_used_at = NOW() - INTERVAL '150 days' WHERE user_id = '${memberId}'`)

    const sweep = await (await request.post('/api/v1/auth/admin/dormant-accounts/sweep', { headers: bearer(admin) })).json()
    expect(sweep.locked).toBeGreaterThanOrEqual(1)
    expect(sweep.users).toContain(MEMBER)
    expect(sweep.users, 'an Admin-role account is exempt').not.toContain(ADMIN2)

    const row = await listed(request, admin, MEMBER)
    expect(row.dormant_locked_at).toBeTruthy()
    expect((await listed(request, admin, ADMIN2)).dormant_locked_at).toBeUndefined()

    await login(request, MEMBER, PW, false)
    const exchange = await request.post('/api/v1/auth/token', { headers: { Authorization: `Bearer ${apiKey}` }, failOnStatusCode: false })
    expect(exchange.status(), 'a dormant owner cannot exchange a key').toBe(401)

    for (const [action, target] of [['user.account.dormant_lock', MEMBER], ['admin.dormant.sweep', '']]) {
      const logs = await (await request.get(`/api/v1/auth/admin/audit-logs?action=${action}&limit=5`, { headers: bearer(admin) })).json()
      const rows = logs.items || []
      expect(rows.length, `audit rows for ${action}`).toBeGreaterThan(0)
      if (target) expect(rows.some((r: any) => r.TargetEmail === target)).toBeTruthy()
    }
    const failed = await (await request.get('/api/v1/auth/admin/audit-logs?action=user.login.failed&limit=5', { headers: bearer(admin) })).json()
    expect(JSON.stringify(failed.items?.[0]?.After ?? '')).toContain('dormant')

    const unlock = await request.post(`/api/v1/auth/admin/users/${memberId}/unlock`, { headers: bearer(admin) })
    expect(unlock.status(), await unlock.text()).toBe(200)
    expect((await unlock.json()).dormant_locked_at).toBeUndefined()
    await login(request, MEMBER, PW)
    const unlockLog = await (await request.get('/api/v1/auth/admin/audit-logs?action=admin.users.unlock&limit=5', { headers: bearer(admin) })).json()
    expect(unlockLog.items?.[0]?.TargetEmail).toBe(MEMBER)

    const missing = await request.post('/api/v1/auth/admin/users/does-not-exist/unlock', { headers: bearer(admin), failOnStatusCode: false })
    expect(missing.status()).toBe(404)
  })

  test('the Users page shows the lock badge, unlocks, and runs a sweep', async ({ page, request }) => {
    psql(`UPDATE auth_users SET dormant_locked_at = NOW() WHERE email = '${MEMBER}'`)
    await page.goto('/admin/users')
    await expect(page.getByTestId(`user-detail-${MEMBER}`)).toBeVisible({ timeout: 15000 })
    const row = page.locator('tr').filter({ has: page.getByTestId(`user-detail-${MEMBER}`) })
    await expect(row.getByTestId('user-dormant-badge')).toBeVisible()

    page.once('dialog', (d) => d.accept())
    await row.getByTestId('user-unlock').click()
    await expect(row.getByTestId('user-dormant-badge')).toHaveCount(0, { timeout: 15000 })
    expect((await listed(request, admin, MEMBER)).dormant_locked_at).toBeUndefined()

    await page.getByTestId('dormant-sweep-now').click()
    await expect(page.getByTestId('dormant-sweep-result')).toBeVisible({ timeout: 15000 })
  })
})
