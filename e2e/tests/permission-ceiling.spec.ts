import { execFileSync, execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test, expect, type APIRequestContext } from '@playwright/test'

// M16: nobody may hand out more than they hold. A "limited admin" who can
// manage users and roles but is not a global admin cannot make anyone Admin,
// cannot create or widen a role beyond their own permissions, cannot edit a
// system role's permissions, cannot change their own role, and cannot grant a
// cluster role on a cluster they hold nothing on. Admin granted on one cluster
// counts on that cluster only, never for a global role. The refusals are audited.

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
// The dev values list it in auth.impersonation.customRoles, with no role of that name.
const CHART_BOUND = 'e2e-chart-bound'

// The role names the install's chart binds, as auth-service reads them.
function chartBoundRoles(): string[] {
  const kc = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-ceiling-')), 'kubeconfig')
  fs.writeFileSync(kc, execSync('kind get kubeconfig --name kubeast', { encoding: 'utf8' }), { mode: 0o600 })
  return execFileSync('kubectl', ['--kubeconfig', kc, '-n', 'kubeast', 'get', 'configmap', 'kubeast-config', '-o', 'jsonpath={.data.IMPERSONATION_CUSTOM_ROLES}'], { encoding: 'utf8' }).split(',')
}

async function login(request: APIRequestContext, email: string, password: string) {
  const res = await request.post('/api/v1/auth/login', { data: { email, password } })
  expect(res.ok(), `login ${email}`).toBeTruthy()
  return { Authorization: `Bearer ${(await res.json()).access_token as string}` }
}

async function roleId(request: APIRequestContext, headers: Record<string, string>, name: string) {
  const res = await request.get('/api/v1/auth/roles', { headers })
  const body = await res.json()
  const items = (Array.isArray(body) ? body : body.items || []) as any[]
  const role = items.find((r) => r.name === name)
  expect(role, `role ${name}`).toBeTruthy()
  return role.id as number
}

async function auditRows(request: APIRequestContext, headers: Record<string, string>, action: string) {
  const res = await request.get(`/api/v1/auth/admin/audit-logs?action=${encodeURIComponent(action)}&limit=200`, { headers })
  expect(res.ok()).toBeTruthy()
  const body = await res.json()
  return ((Array.isArray(body) ? body : body.items) || []) as any[]
}

test.describe('permission ceiling (M16)', () => {
  test('a limited admin cannot grant beyond their own permissions; a global admin can', async ({ request }) => {
    const admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    const ts = Date.now()
    const limitedRole = await request.post('/api/v1/auth/admin/roles', {
      headers: admin,
      data: { name: `e2e-limited-admin-${ts}`, description: 'e2e', permissions: ['admin.users.*', 'admin.roles.*', 'menu.*'] },
    })
    expect(limitedRole.status()).toBe(201)
    const limitedRoleId = (await limitedRole.json()).id as number
    const adminRoleId = await roleId(request, admin, 'Admin')
    const memberRoleId = await roleId(request, admin, 'Member')
    const readRoleId = await roleId(request, admin, 'Read')

    const laEmail = `e2e-la-${ts}@kubeast.local`
    const la = await request.post('/api/v1/auth/admin/users', { headers: admin, data: { name: 'E2E limited admin', email: laEmail, password: 'e2e-ceiling-throwaway-1', role_id: limitedRoleId } })
    expect(la.status(), await la.text()).toBe(201)
    const laId = (await la.json()).id as string
    const victim = await request.post('/api/v1/auth/admin/users', { headers: admin, data: { name: 'E2E victim', email: `e2e-victim-${ts}@kubeast.local`, password: 'e2e-ceiling-throwaway-2' } })
    expect(victim.status()).toBe(201)
    const victimId = (await victim.json()).id as string
    const created: number[] = []
    try {
      // The limited admin is a viewer on `self`: cluster-scoped permissions
      // are only ever held per cluster, and those count for authoring roles.
      const viewer = await request.put(`/api/v1/auth/admin/users/${laId}/cluster-roles/self`, { headers: admin, data: { role: 'Read' } })
      expect(viewer.ok(), 'grant Read on self to the limited admin').toBeTruthy()
      const limited = await login(request, laEmail, 'e2e-ceiling-throwaway-1')
      const status = async (method: 'put' | 'post' | 'patch', path: string, data: unknown, headers = limited) =>
        (await request[method](path, { headers, data, failOnStatusCode: false })).status()

      // (a) someone else → Admin: refused
      expect(await status('patch', `/api/v1/auth/admin/users/${victimId}`, { role_id: adminRoleId }), 'promote another user to Admin').toBe(403)
      // (b) a role wider than what the caller holds, and an unknown permission
      expect(await status('post', '/api/v1/auth/admin/roles', { name: `e2e-star-${ts}`, permissions: ['*'] }), 'create a * role').toBe(403)
      expect(await status('post', '/api/v1/auth/admin/roles', { name: `e2e-wider-${ts}`, permissions: ['admin.audit.read'] }), 'create a role with an admin permission the caller lacks').toBe(403)
      expect(await status('post', '/api/v1/auth/admin/roles', { name: `e2e-wider2-${ts}`, permissions: ['resource.*.read', 'resource.*.delete'] }), 'a viewer cannot author a role that deletes').toBe(403)
      expect(await status('post', '/api/v1/auth/admin/roles', { name: `e2e-bogus-${ts}`, permissions: ['made.up.permission'] }), 'unknown permission').toBe(400)
      // (c) a system role's permissions are fixed
      expect(await status('put', `/api/v1/auth/admin/roles/${readRoleId}`, { name: 'Read', description: 'x', permissions: ['*'] }), 'edit Read permissions').toBe(403)
      // (d) own role
      expect(await status('patch', `/api/v1/auth/admin/users/${laId}`, { role_id: adminRoleId }), 'change own role').toBe(403)
      // (e) a cluster role on a cluster the caller holds nothing on
      expect(await status('put', `/api/v1/auth/admin/users/${victimId}/cluster-roles/self`, { role: 'Admin' }), 'grant cluster Admin without holding it').toBe(403)

      // Within the ceiling: allowed.
      expect(await status('patch', `/api/v1/auth/admin/users/${victimId}`, { role_id: memberRoleId }), 'Member holds nothing').toBe(200)
      const ok = await request.post('/api/v1/auth/admin/roles', { headers: limited, data: { name: `e2e-within-${ts}`, permissions: ['menu.dashboard', 'resource.*.read', 'admin.users.read'] } })
      expect(ok.status(), `a role inside the caller's permissions: ${await ok.text()}`).toBe(201)
      created.push((await ok.json()).id as number)

      // The refusals are audited as failures.
      const refusedRole = (await auditRows(request, admin, 'admin.roles.create')).find((r) => r.ActorEmail === laEmail && r.Result === 'failure')
      expect(refusedRole, 'refused role creation audited').toBeTruthy()
      expect(String(refusedRole.Error)).toContain('permission ceiling')
      const refusedPromotion = (await auditRows(request, admin, 'user.role.update')).find((r) => r.ActorEmail === laEmail && r.TargetID === victimId && r.Result === 'failure')
      expect(refusedPromotion, 'refused promotion audited').toBeTruthy()

      // The global admin holds everything: the same promotion succeeds.
      expect(await status('patch', `/api/v1/auth/admin/users/${victimId}`, { role_id: adminRoleId }, admin), 'global admin promotes').toBe(200)
    } finally {
      await request.delete(`/api/v1/auth/admin/users/${victimId}`, { headers: admin, failOnStatusCode: false })
      await request.delete(`/api/v1/auth/admin/users/${laId}`, { headers: admin, failOnStatusCode: false })
      for (const id of created) await request.delete(`/api/v1/auth/admin/roles/${id}`, { headers: admin, failOnStatusCode: false })
      await request.delete(`/api/v1/auth/admin/roles/${limitedRoleId}`, { headers: admin, failOnStatusCode: false })
    }
  })

  test('Admin on one cluster does not lift the ceiling for global roles: no global Admin account, no * role; cluster keys still count', async ({ request }) => {
    const admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    const ts = Date.now().toString(36)
    const adminRoleId = await roleId(request, admin, 'Admin')
    const users: string[] = []
    const roles: number[] = []
    try {
      const managerRole = await request.post('/api/v1/auth/admin/roles', {
        headers: admin,
        data: { name: `e2e-ceiling-ca-${ts}`, description: 'e2e', permissions: ['admin.users.create', 'admin.roles.create'] },
      })
      expect(managerRole.status(), await managerRole.text()).toBe(201)
      roles.push((await managerRole.json()).id as number)
      const caEmail = `e2e-ceiling-ca-${ts}@kubeast.local`
      const ca = await request.post('/api/v1/auth/admin/users', { headers: admin, data: { name: 'E2E cluster admin', email: caEmail, password: 'e2e-ceiling-throwaway-3', role_id: roles[0] } })
      expect(ca.status(), await ca.text()).toBe(201)
      users.push((await ca.json()).id as string)
      expect((await request.put(`/api/v1/auth/admin/users/${users[0]}/cluster-roles/self`, { headers: admin, data: { role: 'Admin', namespaces: [] } })).status()).toBeLessThan(300)
      const mine = await login(request, caEmail, 'e2e-ceiling-throwaway-3')

      // whatever an old build lets through is removed in finally
      const post = async (path: string, data: object, keep: (id: string | number) => void) => {
        const res = await request.post(path, { headers: mine, data, failOnStatusCode: false })
        if (res.status() === 201) keep((await res.json()).id)
        return res.status()
      }
      const madeEmail = `e2e-ceiling-made-${ts}@kubeast.local`
      expect.soft(await post('/api/v1/auth/admin/users', { name: 'E2E made admin', email: madeEmail, password: 'e2e-ceiling-throwaway-4', role_id: adminRoleId }, (id) => users.push(String(id))), 'an account with the global Admin role').toBe(403)
      expect.soft(await post('/api/v1/auth/admin/roles', { name: `e2e-ceiling-star-${ts}`, permissions: ['*'] }, (id) => roles.push(Number(id))), 'a * role').toBe(403)
      expect.soft(await post('/api/v1/auth/admin/roles', { name: `e2e-ceiling-audit-${ts}`, permissions: ['admin.audit.read'] }, (id) => roles.push(Number(id))), 'a role with an admin key it does not hold globally').toBe(403)
      expect.soft(await post('/api/v1/auth/admin/roles', { name: `e2e-ceiling-cluster-${ts}`, permissions: ['menu.*', 'resource.*.read', 'resource.*.delete', 'ai.tool.*'] }, (id) => roles.push(Number(id))), 'a role of cluster keys it holds on self').toBe(201)

      // audited as before: the refusals as failures naming the ceiling, the role within it as a success
      const rows = async (action: string) =>
        (await auditRows(request, admin, action)).filter((r) => r.ActorEmail === caEmail).map((r) => `${r.Result} ${/permission ceiling/.test(String(r.Error ?? ''))}`).sort()
      expect.soft(await rows('user.create'), 'user.create rows').toEqual(['failure true'])
      expect.soft(await rows('admin.roles.create'), 'admin.roles.create rows').toEqual(['failure true', 'failure true', 'success false'])
    } finally {
      for (const id of users) await request.delete(`/api/v1/auth/admin/users/${id}`, { headers: admin, failOnStatusCode: false })
      for (const id of roles) await request.delete(`/api/v1/auth/admin/roles/${id}`, { headers: admin, failOnStatusCode: false })
    }
  })

  test('a limited admin resets only accounts within what they hold, and manages any without wider global permissions', async ({ request }) => {
    const admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    const ts = Date.now().toString(36)
    const users: string[] = []
    const roles: number[] = []
    const mkUser = async (tag: string, role: number) => {
      const email = `e2e-acct-${tag}-${ts}@kubeast.local`
      const password = `e2e-acct-${tag}-throwaway-1`
      const res = await request.post('/api/v1/auth/admin/users', { headers: admin, data: { name: `E2E ${tag}`, email, password, role_id: role } })
      expect(res.status(), await res.text()).toBe(201)
      const id = (await res.json()).id as string
      users.push(id)
      return { id, email, password }
    }
    const grant = async (id: string, role: string) =>
      expect((await request.put(`/api/v1/auth/admin/users/${id}/cluster-roles/self`, { headers: admin, data: { role } })).status(), `grant ${role}`).toBe(200)
    try {
      const adminRole = await roleId(request, admin, 'Admin')
      const memberRole = await roleId(request, admin, 'Member')
      const mgrRole = await request.post('/api/v1/auth/admin/roles', { headers: admin, data: { name: `e2e-acct-mgr-${ts}`, permissions: ['admin.users.read', 'admin.users.update', 'admin.users.delete', 'menu.*'] } })
      expect(mgrRole.status(), await mgrRole.text()).toBe(201)
      roles.push((await mgrRole.json()).id)

      const mgr = await mkUser('mgr', roles[0])
      await grant(mgr.id, 'Read')
      const globalAdmin = await mkUser('global', adminRole)
      const clusterAdmin = await mkUser('cluster', memberRole)
      await grant(clusterAdmin.id, 'Admin')
      const reader = await mkUser('reader', memberRole)
      await grant(reader.id, 'Read')
      const plain = await mkUser('plain', memberRole)
      const mine = await login(request, mgr.email, mgr.password)
      const call = (method: 'post' | 'patch' | 'delete' | 'put', path: string, data?: object, headers = mine) =>
        request[method](`/api/v1/auth/admin/users${path}`, { headers, data, failOnStatusCode: false })

      const failures = async (action: string, id: string) =>
        (await auditRows(request, admin, action)).filter((r) => r.ActorEmail === mgr.email && r.TargetID === id && r.Result === 'failure' && /permission ceiling/.test(String(r.Error ?? ''))).length

      // A reset hands the account over: refused for what it holds on a cluster too.
      for (const wide of [globalAdmin, clusterAdmin]) {
        const refused = await call('post', `/${wide.id}/reset-password`)
        expect.soft(refused.status(), `reset ${wide.email}`).toBe(403)
        expect.soft(await refused.text(), 'no password in the answer').not.toContain('temporary_password')
        expect.soft((await request.post('/api/v1/auth/login', { data: { email: wide.email, password: wide.password }, failOnStatusCode: false })).status(), `${wide.email} keeps its password`).toBe(200)
        expect.soft(await failures('user.password.reset', wide.id), `the refused reset of ${wide.email}`).toBeGreaterThan(0)
      }

      // Wider global permissions: managing is refused too, and nothing changes.
      expect.soft((await call('delete', `/${globalAdmin.id}`)).status(), 'delete a global admin').toBe(403)
      expect.soft((await call('patch', `/${globalAdmin.id}`, { role_id: memberRole })).status(), 'lower a global admin').toBe(403)
      expect.soft((await call('post', `/${globalAdmin.id}/unlock`)).status(), 'unlock a global admin').toBe(403)
      expect.soft((await call('patch', '/bulk-role', { user_ids: [plain.id, globalAdmin.id], role_id: memberRole })).status(), 'bulk with a global admin').toBe(403)
      expect.soft((await call('put', `/${globalAdmin.id}/cluster-roles/self`, { role: 'Read' })).status(), 'set the grant of a global admin').toBe(403)
      expect.soft((await call('delete', `/${globalAdmin.id}/cluster-roles/self`)).status(), 'revoke the grant of a global admin').toBe(403)
      for (const action of ['user.delete', 'user.role.update', 'admin.users.unlock', 'user.cluster_role.set', 'user.cluster_role.unset']) {
        expect.soft(await failures(action, globalAdmin.id), `${action} failures`).toBeGreaterThan(0)
      }
      const me = await (await request.get('/api/v1/auth/me', { headers: await login(request, globalAdmin.email, globalAdmin.password) })).json()
      expect.soft(me.role?.name, 'the global admin stays Admin').toBe('Admin')

      // A name or a team gives no power: not limited, whoever the account is.
      expect((await call('patch', `/${globalAdmin.id}`, { name: 'Renamed' })).status(), 'rename a global admin').toBe(200)
      expect((await call('patch', `/${clusterAdmin.id}`, { name: 'Renamed' })).status(), 'rename a cluster admin').toBe(200)

      // Admin on a cluster the manager only reads: managing goes through, handing out stays under the ceiling.
      expect((await call('post', `/${clusterAdmin.id}/unlock`)).status(), 'unlock it').toBe(200)
      expect((await call('put', `/${reader.id}/cluster-roles/self`, { role: 'Admin' })).status(), 'give what the manager does not hold').toBe(403)
      expect((await call('put', `/${clusterAdmin.id}/cluster-roles/self`, { role: 'Read' })).status(), 'lower its grant').toBe(200)
      await grant(clusterAdmin.id, 'Admin')
      expect((await call('delete', `/${clusterAdmin.id}/cluster-roles/self`)).status(), 'revoke its grant').toBe(204)
      await grant(clusterAdmin.id, 'Admin')
      expect((await call('patch', `/${clusterAdmin.id}`, { role_id: memberRole })).status(), 'change its role').toBe(200)
      expect((await call('patch', '/bulk-role', { user_ids: [plain.id, clusterAdmin.id], role_id: memberRole })).status(), 'bulk with it').toBe(200)
      expect((await call('delete', `/${clusterAdmin.id}`)).status(), 'delete it').toBe(204)
      expect((await call('delete', `/${plain.id}`)).status(), 'delete an account with nothing').toBe(204)

      // A reset within what the manager holds goes through.
      const reset = await call('post', `/${reader.id}/reset-password`)
      expect(reset.status(), await reset.text()).toBe(200)
      const temp = (await reset.json()).temporary_password as string
      expect((await request.post('/api/v1/auth/login', { data: { email: reader.email, password: temp }, failOnStatusCode: false })).status(), 'the new password signs in').toBe(200)

      // The global admin is not limited.
      expect((await call('post', `/${globalAdmin.id}/reset-password`, undefined, admin)).status(), 'a global admin resets a global admin').toBe(200)
      expect((await call('delete', `/${globalAdmin.id}`, undefined, admin)).status(), 'a global admin deletes a global admin').toBe(204)
    } finally {
      for (const id of users) await request.delete(`/api/v1/auth/admin/users/${id}`, { headers: admin, failOnStatusCode: false })
      for (const id of roles) await request.delete(`/api/v1/auth/admin/roles/${id}`, { headers: admin, failOnStatusCode: false })
    }
  })

  test('a role name acting as a built-in role or as another role is refused; a stored one stays', async ({ request }) => {
    const admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    const ts = Date.now().toString(36)
    const roles: number[] = []
    const create = (name: string) => request.post('/api/v1/auth/admin/roles', { headers: admin, data: { name, permissions: ['menu.dashboard'] }, failOnStatusCode: false })
    const update = (id: number, name: string) => request.put(`/api/v1/auth/admin/roles/${id}`, { headers: admin, data: { name, description: 'e2e', permissions: ['menu.dashboard'] }, failOnStatusCode: false })
    try {
      const before = await (await request.get('/api/v1/auth/roles', { headers: admin })).json()
      for (const name of ['ADMIN', 'admin', ' read ', 'WRITE', 'member', 'PENDING', 'Read']) {
        const res = await create(name)
        expect.soft(res.status(), `create ${JSON.stringify(name)}`).toBe(400)
        expect.soft(await res.text(), `${JSON.stringify(name)} says why`).toContain('built-in')
      }
      const first = await create(`e2e name ${ts}`)
      expect(first.status(), await first.text()).toBe(201)
      roles.push((await first.json()).id)
      const folded = await create(`e2e-name-${ts}`)
      expect.soft(folded.status(), 'the same group as another role').toBe(400)
      expect.soft(await folded.text(), 'it names that role').toContain(`e2e name ${ts}`)

      const normal = await create(`e2e-other-${ts}`)
      expect(normal.status(), await normal.text()).toBe(201)
      const otherId = (await normal.json()).id as number
      roles.push(otherId)
      expect.soft((await update(otherId, 'ADMIN')).status(), 'rename to a built-in in capitals').toBe(400)
      expect.soft((await update(otherId, `E2E-NAME-${ts}`)).status(), 'rename to another role\'s group').toBe(400)
      expect.soft((await update(otherId, `e2e-other-${ts}`)).status(), 'the same name').toBe(200)
      expect.soft((await update(otherId, `E2E-Other-${ts}`)).status(), 'its own name in capitals').toBe(200)

      const after = await (await request.get('/api/v1/auth/roles', { headers: admin })).json()
      const names = (raw: any) => (Array.isArray(raw) ? raw : raw.items || []).map((r: { name: string }) => r.name).sort()
      expect.soft(names(after), 'only the two roles were added').toEqual([...names(before), `E2E-Other-${ts}`, `e2e name ${ts}`].sort())
      const refused = (await auditRows(request, admin, 'admin.roles.create')).find((r) => r.Result === 'failure' && r.After?.name === `e2e-name-${ts}`)
      expect.soft(refused, 'the refusal is audited').toBeTruthy()
    } finally {
      for (const id of roles) await request.delete(`/api/v1/auth/admin/roles/${id}`, { headers: admin, failOnStatusCode: false })
    }
  })

  test('a role name the chart binds takes a global admin, before its role exists and after it is deleted; the role form says why', async ({ request, browser }) => {
    test.skip(!chartBoundRoles().includes(CHART_BOUND), `needs ${CHART_BOUND} in auth.impersonation.customRoles (deploy/kind/values.yaml)`)
    const admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    const ts = Date.now().toString(36)
    const email = `e2e-chartrole-${ts}@kubeast.local`
    const password = 'e2e-ceiling-throwaway-8'
    const roles: number[] = []
    let userId = ''
    let bound = 0
    // No permissions: a global role's token holds no menu or resource key to pass on, so only the name decides.
    const create = (headers: Record<string, string>, name: string) => request.post('/api/v1/auth/admin/roles', { headers, data: { name, permissions: [] }, failOnStatusCode: false })
    const update = (headers: Record<string, string>, id: number, name: string, description = '') => request.put(`/api/v1/auth/admin/roles/${id}`, { headers, data: { name, description, permissions: [] }, failOnStatusCode: false })
    const roleNamed = async (name: string) => {
      const raw = await (await request.get('/api/v1/auth/roles', { headers: admin })).json()
      return ((Array.isArray(raw) ? raw : raw.items || []) as { id: number; name: string }[]).find((r) => r.name === name)
    }
    const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } })
    try {
      const leftover = await roleNamed(CHART_BOUND)
      if (leftover) expect((await request.delete(`/api/v1/auth/admin/roles/${leftover.id}`, { headers: admin })).status()).toBe(204)

      const adminRole = await request.post('/api/v1/auth/admin/roles', { headers: admin, data: { name: `e2e-chartrole-admin-${ts}`, permissions: ['menu.*', 'admin.roles.*'] } })
      expect(adminRole.status(), await adminRole.text()).toBe(201)
      const adminRoleId = (await adminRole.json()).id as number
      roles.push(adminRoleId)
      const made = await request.post('/api/v1/auth/admin/users', { headers: admin, data: { name: 'E2E role admin', email, password, role_id: adminRoleId } })
      expect(made.status(), await made.text()).toBe(201)
      userId = (await made.json()).id
      expect((await request.put(`/api/v1/auth/admin/users/${userId}/cluster-roles/self`, { headers: admin, data: { role: 'Read' } })).status()).toBe(200)
      const roleAdmin = await login(request, email, password)

      for (const name of [CHART_BOUND, CHART_BOUND.toUpperCase(), 'E2E Chart Bound']) {
        const refused = await create(roleAdmin, name)
        expect.soft(refused.status(), `create ${name}`).toBe(403)
        expect.soft((await refused.json()).detail, `${name} says which group`).toContain(`permission ceiling: the chart binds kubeast:role:${CHART_BOUND}`)
      }
      expect.soft(await roleNamed(CHART_BOUND), 'nothing was made').toBeUndefined()
      const row = (await auditRows(request, admin, 'admin.roles.create')).find((r) => r.ActorEmail === email && r.Result === 'failure' && r.After?.name === CHART_BOUND)
      expect.soft(String(row?.Error ?? ''), 'the refusal is audited').toContain('permission ceiling')

      const plain = await create(roleAdmin, `e2e-chartrole-plain-${ts}`)
      expect(plain.status(), 'a name the chart does not list stays open').toBe(201)
      const plainId = (await plain.json()).id as number
      roles.push(plainId)
      expect.soft((await update(roleAdmin, plainId, CHART_BOUND)).status(), 'a rename onto the listed name').toBe(403)
      expect.soft((await roleNamed(`e2e-chartrole-plain-${ts}`))?.id, 'the rename did not happen').toBe(plainId)

      const page = await ctx.newPage()
      await page.goto('/login')
      await page.locator('input[autocomplete="email"]').first().fill(email)
      await page.locator('input[type="password"]').first().fill(password)
      await page.locator('button[type="submit"]').first().click()
      await page.waitForFunction(() => !document.querySelector('input[autocomplete="email"]'), { timeout: 20000 })
      await page.goto('/admin/roles')
      await page.getByRole('button', { name: /^(Create Role|역할 생성)$/ }).click()
      await page.getByPlaceholder(/InfraManager/).fill(CHART_BOUND)
      await page.getByRole('button', { name: /^(Create|생성)$/ }).click()
      await expect(page.getByText(`permission ceiling: the chart binds kubeast:role:${CHART_BOUND}`), 'the form says why').toHaveCount(1, { timeout: 15000 })

      const created = await create(admin, CHART_BOUND)
      expect(created.status(), `a global admin creates what the chart lists: ${await created.text()}`).toBe(201)
      bound = (await created.json()).id
      const edited = await update(roleAdmin, bound, CHART_BOUND, 'edited by the role admin')
      expect.soft(edited.status(), 'the role stays open to its editors').toBe(200)
      expect.soft((await edited.json()).description).toBe('edited by the role admin')

      expect((await request.delete(`/api/v1/auth/admin/roles/${bound}`, { headers: admin })).status()).toBe(204)
      bound = 0
      expect.soft((await create(roleAdmin, CHART_BOUND)).status(), 'after its role is deleted').toBe(403)
    } finally {
      await ctx.close()
      if (bound) await request.delete(`/api/v1/auth/admin/roles/${bound}`, { headers: admin, failOnStatusCode: false })
      if (userId) await request.delete(`/api/v1/auth/admin/users/${userId}`, { headers: admin, failOnStatusCode: false })
      for (const id of roles) await request.delete(`/api/v1/auth/admin/roles/${id}`, { headers: admin, failOnStatusCode: false })
    }
  })

  test('a role the chart binds is granted only by a global admin or an Admin of the cluster, and the role list says which', async ({ request }) => {
    test.skip(!chartBoundRoles().includes(CHART_BOUND), `needs ${CHART_BOUND} in auth.impersonation.customRoles (deploy/kind/values.yaml)`)
    const admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    const ts = Date.now().toString(36)
    const password = 'e2e-ceiling-throwaway-9'
    const roles: number[] = []
    const users: string[] = []
    const listed = async () => {
      const raw = await (await request.get('/api/v1/auth/roles', { headers: admin })).json()
      return (Array.isArray(raw) ? raw : raw.items || []) as { id: number; name: string; chart_bound?: boolean }[]
    }
    const makeUser = async (name: string, roleId: number) => {
      const made = await request.post('/api/v1/auth/admin/users', { headers: admin, data: { name, email: `${name}@kubeast.local`, password, role_id: roleId } })
      expect(made.status(), await made.text()).toBe(201)
      const id = (await made.json()).id as string
      users.push(id)
      return id
    }
    try {
      const leftover = (await listed()).find((r) => r.name === CHART_BOUND)
      if (leftover) expect((await request.delete(`/api/v1/auth/admin/roles/${leftover.id}`, { headers: admin })).status()).toBe(204)
      const bound = await request.post('/api/v1/auth/admin/roles', { headers: admin, data: { name: CHART_BOUND, permissions: ['resource.objects.read'] } })
      expect(bound.status(), await bound.text()).toBe(201)
      roles.push((await bound.json()).id)
      const now = await listed()
      expect(now.find((r) => r.name === CHART_BOUND)?.chart_bound, 'the list marks the role the chart binds').toBe(true)
      expect(now.filter((r) => r.chart_bound).map((r) => r.name), 'and no other').toEqual([CHART_BOUND])

      const userAdmin = await request.post('/api/v1/auth/admin/roles', { headers: admin, data: { name: `e2e-chartgrant-users-${ts}`, permissions: ['menu.*', 'admin.users.*'] } })
      expect(userAdmin.status(), await userAdmin.text()).toBe(201)
      roles.push((await userAdmin.json()).id)
      const delegate = await makeUser(`e2e-chartgrant-d-${ts}`, roles[1])
      const target = await makeUser(`e2e-chartgrant-t-${ts}`, await roleId(request, admin, 'Member'))
      const grantDelegate = async (role: string) =>
        expect((await request.put(`/api/v1/auth/admin/users/${delegate}/cluster-roles/self`, { headers: admin, data: { role } })).status()).toBe(200)
      const grantAs = async (role: string) => {
        const headers = await login(request, `e2e-chartgrant-d-${ts}@kubeast.local`, password)
        return request.put(`/api/v1/auth/admin/users/${target}/cluster-roles/self`, { headers, data: { role: CHART_BOUND }, failOnStatusCode: false }).then(async (r) => ({ role, status: r.status(), body: await r.text() }))
      }

      await grantDelegate('Read')
      const refused = await grantAs('Read')
      expect(refused.status, refused.body).toBe(403)
      expect(refused.body).toContain('auth.impersonation.customRoles')
      expect((await (await request.get(`/api/v1/auth/admin/users/${target}/cluster-roles`, { headers: admin })).json()).self, 'nothing was granted').toBeUndefined()
      const row = (await auditRows(request, admin, 'user.cluster_role.set')).find((r) => r.TargetID === target && r.Result === 'failure')
      expect(String(row?.Error ?? ''), 'the refusal is audited').toContain('permission ceiling')

      await grantDelegate('Admin')
      const granted = await grantAs('Admin')
      expect(granted.status, granted.body).toBe(200)
      expect((await (await request.get(`/api/v1/auth/admin/users/${target}/cluster-roles`, { headers: admin })).json()).self).toBe(CHART_BOUND)
    } finally {
      for (const id of users) await request.delete(`/api/v1/auth/admin/users/${id}`, { headers: admin, failOnStatusCode: false })
      for (const id of roles) await request.delete(`/api/v1/auth/admin/roles/${id}`, { headers: admin, failOnStatusCode: false })
    }
  })

  test('a role edit stays within what the editor holds on the clusters the role is granted on', async ({ request }) => {
    const admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    const ts = Date.now().toString(36)
    const users: string[] = []
    const roles: number[] = []
    const mkUser = async (tag: string, role: number) => {
      const email = `e2e-edit-${tag}-${ts}@kubeast.local`
      const res = await request.post('/api/v1/auth/admin/users', { headers: admin, data: { name: `E2E ${tag}`, email, password: `e2e-edit-${tag}-throwaway-1`, role_id: role } })
      expect(res.status(), await res.text()).toBe(201)
      const id = (await res.json()).id as string
      users.push(id)
      return { id, email, password: `e2e-edit-${tag}-throwaway-1` }
    }
    const setGrant = async (id: string, cluster: string, role: string) =>
      expect((await request.put(`/api/v1/auth/admin/users/${id}/cluster-roles/${cluster}`, { headers: admin, data: { role } })).status(), `grant ${role} on ${cluster}`).toBe(200)
    try {
      const memberRole = await roleId(request, admin, 'Member')
      const editorRole = await request.post('/api/v1/auth/admin/roles', { headers: admin, data: { name: `e2e-edit-editor-${ts}`, permissions: ['admin.roles.update', 'menu.*'] } })
      expect(editorRole.status(), await editorRole.text()).toBe(201)
      roles.push((await editorRole.json()).id)
      const name = `e2e-edit-role-${ts}`
      const edited = await request.post('/api/v1/auth/admin/roles', { headers: admin, data: { name, permissions: ['menu.dashboard'] } })
      expect(edited.status(), await edited.text()).toBe(201)
      const editedId = (await edited.json()).id as number
      roles.push(editedId)

      // Admin on self, a reader on default.
      const editor = await mkUser('editor', roles[0])
      await setGrant(editor.id, 'self', 'Admin')
      await setGrant(editor.id, 'default', 'Read')
      const holder = await mkUser('holder', memberRole)
      const mine = await login(request, editor.email, editor.password)
      const wider = { name, description: 'e2e', permissions: ['menu.dashboard', 'resource.*.delete'] }
      const permsOf = async () => {
        const raw = await (await request.get('/api/v1/auth/roles', { headers: admin })).json()
        return ((Array.isArray(raw) ? raw : raw.items || []).find((r: { id: number }) => r.id === editedId)?.permissions as string[]).sort()
      }

      await setGrant(holder.id, 'default', name)
      const refused = await request.put(`/api/v1/auth/admin/roles/${editedId}`, { headers: mine, data: wider, failOnStatusCode: false })
      expect(refused.status(), 'a key the editor lacks where the role is granted').toBe(403)
      expect(await refused.text(), 'the answer names the cluster and the key').toContain('default: resource.*.delete')
      expect(await permsOf(), 'the role is as it was').toEqual(['menu.dashboard'])
      const row = (await auditRows(request, admin, 'admin.roles.update')).find((r) => r.ActorEmail === editor.email && r.TargetID === String(editedId) && r.Result === 'failure')
      expect(String(row?.Error), 'the refusal is audited').toContain('permission ceiling')

      expect((await request.delete(`/api/v1/auth/admin/users/${holder.id}/cluster-roles/default`, { headers: admin })).status(), 'revoke on default').toBe(204)
      await setGrant(holder.id, 'self', name)
      const allowed = await request.put(`/api/v1/auth/admin/roles/${editedId}`, { headers: mine, data: wider, failOnStatusCode: false })
      expect(allowed.status(), `granted only where the editor is Admin: ${await allowed.text()}`).toBe(200)
      expect(await permsOf(), 'the key was added').toEqual(['menu.dashboard', 'resource.*.delete'])

      await setGrant(holder.id, 'default', name)
      const taken = await request.put(`/api/v1/auth/admin/roles/${editedId}`, { headers: mine, data: { name, description: 'edited', permissions: ['menu.dashboard'] }, failOnStatusCode: false })
      expect(taken.status(), `taking a key away is no widening: ${await taken.text()}`).toBe(200)
      const byGlobal = await request.put(`/api/v1/auth/admin/roles/${editedId}`, { headers: admin, data: wider, failOnStatusCode: false })
      expect(byGlobal.status(), `a global admin adds it: ${await byGlobal.text()}`).toBe(200)
    } finally {
      for (const id of users) await request.delete(`/api/v1/auth/admin/users/${id}`, { headers: admin, failOnStatusCode: false })
      for (const id of roles) await request.delete(`/api/v1/auth/admin/roles/${id}`, { headers: admin, failOnStatusCode: false })
    }
  })

  test('a new account cannot be named as a cluster identity; an ordinary address and the admin keep working', async ({ request }) => {
    const admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    const ts = Date.now().toString(36)
    const made: string[] = []
    const account = (email: string) => ({ name: 'E2E name', email, password: 'e2e-ceiling-throwaway-9' })
    try {
      for (const email of [`system:anonymous-${ts}@kubeast.local`, `kubeast:cache-${ts}@kubeast.local`, ` e2e-space-${ts}@kubeast.local`, `e2e-space-${ts}@kubeast.local `, `e2e space-${ts}@kubeast.local`]) {
        const res = await request.post('/api/v1/auth/admin/users', { headers: admin, data: account(email), failOnStatusCode: false })
        // a build that takes the name leaves no account behind
        if (res.ok()) made.push((await res.json()).id)
        expect.soft(res.status(), `create ${JSON.stringify(email)}`).toBe(400)
        expect.soft(await res.text(), `${JSON.stringify(email)} says why`).toContain('colon')
        const bulk = await request.post('/api/v1/auth/admin/users/bulk', { headers: admin, data: { users: [account(email)] }, failOnStatusCode: false })
        const body = await bulk.json()
        for (const u of body.created ?? []) if (u?.id) made.push(u.id)
        expect.soft(body.errors?.length, `bulk ${JSON.stringify(email)}`).toBe(1)
        expect.soft(body.created ?? [], `bulk ${JSON.stringify(email)} made nothing`).toEqual([])
      }
      const row = (await auditRows(request, admin, 'user.create')).find((r) => r.TargetEmail === `system:anonymous-${ts}@kubeast.local` && r.Result === 'failure')
      expect(row, 'the refusal is audited').toBeTruthy()

      for (const email of [`e2e.first+tag-${ts}@kubeast.local`, `e2e-홍길동-${ts}@kubeast.local`]) {
        const res = await request.post('/api/v1/auth/admin/users', { headers: admin, data: account(email), failOnStatusCode: false })
        expect(res.status(), `${email}: ${await res.text()}`).toBe(201)
        made.push((await res.json()).id)
        expect((await request.post('/api/v1/auth/login', { data: { email, password: 'e2e-ceiling-throwaway-9' } })).status(), `${email} signs in`).toBe(200)
      }
      expect((await request.get('/api/v1/auth/me', { headers: admin })).status(), 'the default admin signs in as before').toBe(200)
    } finally {
      for (const id of made) await request.delete(`/api/v1/auth/admin/users/${id}`, { headers: admin, failOnStatusCode: false })
    }
  })

  test('taking a permission from a role ends what its holders hold; adding one or a description ends nothing', async ({ request }) => {
    const admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    const ts = Date.now().toString(36)
    const password = 'e2e-ceiling-throwaway-8'
    const memberRole = await roleId(request, admin, 'Member')
    const roles: number[] = []
    const users: string[] = []
    const newRole = async (name: string, permissions: string[]) => {
      const res = await request.post('/api/v1/auth/admin/roles', { headers: admin, data: { name, permissions } })
      expect(res.status(), await res.text()).toBe(201)
      const id = (await res.json()).id as number
      roles.push(id)
      return id
    }
    const newUser = async (email: string, role: number) => {
      const res = await request.post('/api/v1/auth/admin/users', { headers: admin, data: { name: 'E2E holder', email, password, role_id: role } })
      expect(res.status(), await res.text()).toBe(201)
      const id = (await res.json()).id as string
      users.push(id)
      return id
    }
    const alive = async (headers: Record<string, string>) => (await request.get('/api/v1/auth/me', { headers, failOnStatusCode: false })).status()
    try {
      const clusterName = `e2e-held-${ts}`
      const clusterRole = await newRole(clusterName, ['menu.dashboard', 'resource.*.read'])
      const edit = (id: number, name: string, description: string, permissions: string[]) => request.put(`/api/v1/auth/admin/roles/${id}`, { headers: admin, data: { name, description, permissions } })
      const granted = `e2e-held-grant-${ts}@kubeast.local`
      const grantedId = await newUser(granted, memberRole)
      expect((await request.put(`/api/v1/auth/admin/users/${grantedId}/cluster-roles/self`, { headers: admin, data: { role: clusterName } })).ok(), 'grant').toBeTruthy()
      const globalOnly = `e2e-held-global-${ts}@kubeast.local`
      await newUser(globalOnly, clusterRole)
      const bystander = `e2e-held-none-${ts}@kubeast.local`
      await newUser(bystander, memberRole)

      let grantToken = await login(request, granted, password)
      const globalToken = await login(request, globalOnly, password)
      const otherToken = await login(request, bystander, password)

      expect((await edit(clusterRole, clusterName, 'edited', ['menu.dashboard', 'resource.*.read'])).status(), 'the description alone').toBe(200)
      expect(await alive(grantToken), 'a description ends nothing').toBe(200)
      expect((await edit(clusterRole, clusterName, 'edited', ['menu.*', 'resource.*.read'])).status(), 'a wider key').toBe(200)
      expect(await alive(grantToken), 'a wider key ends nothing').toBe(200)

      expect((await edit(clusterRole, clusterName, 'edited', ['menu.*'])).status(), 'a cluster key taken away').toBe(200)
      expect(await alive(grantToken), 'the holder on a cluster').toBe(401)
      expect(await alive(globalToken), 'a global role\'s token never held that key').toBe(200)
      expect(await alive(otherToken), 'someone without the role').toBe(200)
      grantToken = await login(request, granted, password)
      expect(await alive(grantToken), 'signing in again works').toBe(200)

      const adminName = `e2e-held-admin-${ts}`
      const adminRole = await newRole(adminName, ['admin.audit.read', 'menu.*'])
      const adminHolder = `e2e-held-admin-${ts}@kubeast.local`
      await newUser(adminHolder, adminRole)
      const adminToken = await login(request, adminHolder, password)
      expect((await edit(adminRole, adminName, '', ['menu.*'])).status(), 'an admin key taken away').toBe(200)
      expect(await alive(adminToken), 'a global role\'s token held that key').toBe(401)
    } finally {
      for (const id of users) await request.delete(`/api/v1/auth/admin/users/${id}`, { headers: admin, failOnStatusCode: false })
      for (const id of roles) await request.delete(`/api/v1/auth/admin/roles/${id}`, { headers: admin, failOnStatusCode: false })
    }
  })

  test('the setup rollout status answers only what the wizard needs permission for', async ({ request }) => {
    const admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    const ts = Date.now().toString(36)
    const email = `e2e-rollout-${ts}@kubeast.local`
    const made = await request.post('/api/v1/auth/admin/users', { headers: admin, data: { name: 'E2E rollout', email, password: 'e2e-ceiling-throwaway-7', role_id: await roleId(request, admin, 'Member') } })
    expect(made.status(), await made.text()).toBe(201)
    const id = (await made.json()).id as string
    try {
      const res = await request.get('/api/v1/auth/setup/rollout-status', { headers: await login(request, email, 'e2e-ceiling-throwaway-7'), failOnStatusCode: false })
      expect(res.status(), 'without admin.clusters.create').toBe(403)
      const ok = await request.get('/api/v1/auth/setup/rollout-status', { headers: admin })
      expect(ok.status(), 'the wizard\'s user').toBe(200)
      expect(typeof (await ok.json()).ready).toBe('boolean')
    } finally {
      await request.delete(`/api/v1/auth/admin/users/${id}`, { headers: admin, failOnStatusCode: false })
    }
  })

  test('AI model settings follow the permission in the token, not the role name', async ({ request }) => {
    const admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    const ts = Date.now().toString(36)
    const users: string[] = []
    const roles: number[] = []
    let keyId = ''
    const settings = (headers: Record<string, string>) => request.get('/api/v1/ai/model-configs', { headers, failOnStatusCode: false })
    try {
      expect((await settings(admin)).status(), 'a global admin\'s session').toBe(200)

      const holderRole = await request.post('/api/v1/auth/admin/roles', { headers: admin, data: { name: `e2e-ai-models-${ts}`, permissions: ['admin.ai_models.*'] } })
      expect(holderRole.status(), await holderRole.text()).toBe(201)
      roles.push((await holderRole.json()).id)
      const holderEmail = `e2e-ai-holder-${ts}@kubeast.local`
      const holder = await request.post('/api/v1/auth/admin/users', { headers: admin, data: { name: 'E2E holder', email: holderEmail, password: 'e2e-ai-throwaway-1', role_id: roles[0] } })
      expect(holder.status(), await holder.text()).toBe(201)
      users.push((await holder.json()).id)
      expect((await settings(await login(request, holderEmail, 'e2e-ai-throwaway-1'))).status(), 'a role holding the permission').toBe(200)

      const clusterEmail = `e2e-ai-cluster-${ts}@kubeast.local`
      const clusterUser = await request.post('/api/v1/auth/admin/users', { headers: admin, data: { name: 'E2E cluster admin', email: clusterEmail, password: 'e2e-ai-throwaway-2', role_id: await roleId(request, admin, 'Member') } })
      expect(clusterUser.status(), await clusterUser.text()).toBe(201)
      users.push((await clusterUser.json()).id)
      expect((await request.put(`/api/v1/auth/admin/users/${users[1]}/cluster-roles/self`, { headers: admin, data: { role: 'Admin' } })).status()).toBe(200)
      expect((await settings(await login(request, clusterEmail, 'e2e-ai-throwaway-2'))).status(), 'Admin on one cluster').toBe(403)

      // A key's token carries no global permissions, whatever its owner's role is called.
      const keyConfig = await request.get('/api/v1/auth/api-keys/config', { headers: admin })
      if (keyConfig.ok() && (await keyConfig.json()).enabled) {
        const created = await request.post('/api/v1/auth/api-keys', { headers: admin, data: { name: `e2e-ai-${ts}`, expires_in_days: 1, cluster_ids: ['self'], role_ceiling: 'Read' } })
        expect(created.status(), await created.text()).toBe(201)
        const key = await created.json()
        keyId = key.id
        const exchanged = await request.post('/api/v1/auth/token', { headers: { Authorization: `Bearer ${key.key}` } })
        expect(exchanged.status(), 'the key is exchanged').toBe(200)
        expect((await settings({ Authorization: `Bearer ${(await exchanged.json()).access_token}` })).status(), 'a token from a global admin\'s key').toBe(403)
      }
    } finally {
      if (keyId) await request.delete(`/api/v1/auth/api-keys/${keyId}`, { headers: admin, failOnStatusCode: false })
      for (const id of users) await request.delete(`/api/v1/auth/admin/users/${id}`, { headers: admin, failOnStatusCode: false })
      for (const id of roles) await request.delete(`/api/v1/auth/admin/roles/${id}`, { headers: admin, failOnStatusCode: false })
    }
  })
})
