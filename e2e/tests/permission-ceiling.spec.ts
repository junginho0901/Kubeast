import { test, expect, type APIRequestContext } from '@playwright/test'

// M16: nobody may hand out more than they hold. A "limited admin" who can
// manage users and roles but is not a global admin cannot make anyone Admin,
// cannot create or widen a role beyond their own permissions, cannot edit a
// system role's permissions, cannot change their own role, and cannot grant a
// cluster role on a cluster they hold nothing on. Admin granted on one cluster
// counts on that cluster only, never for a global role. The refusals are audited.

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''

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
})
