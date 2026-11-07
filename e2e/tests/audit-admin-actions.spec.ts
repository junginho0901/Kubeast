import { test, expect, type APIRequestContext } from '@playwright/test'

// M15/M27: permission changes are audited with their before/after state
// (roles, organizations, bulk role changes), and k8s rows carry the cluster.

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''

async function adminHeaders(request: APIRequestContext) {
  const res = await request.post('/api/v1/auth/login', { data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } })
  expect(res.ok(), 'admin login').toBeTruthy()
  return { Authorization: `Bearer ${(await res.json()).access_token as string}` }
}

// Audit rows are PascalCase (Action, TargetID, Before, After, Cluster).
async function auditRows(request: APIRequestContext, headers: Record<string, string>, action: string) {
  const res = await request.get(`/api/v1/auth/admin/audit-logs?action=${encodeURIComponent(action)}&limit=200`, { headers })
  expect(res.ok(), `audit list ${action}`).toBeTruthy()
  const body = await res.json()
  return (Array.isArray(body) ? body : body.items || []) as any[]
}

test.describe('audit — admin actions (M15, M27)', () => {
  test('role create/update/delete carry the permission lists', async ({ request }) => {
    const admin = await adminHeaders(request)
    const name = `e2e-role-${Date.now()}`
    const created = await request.post('/api/v1/auth/admin/roles', { headers: admin, data: { name, description: 'e2e', permissions: ['menu.dashboard'] } })
    expect(created.status()).toBe(201)
    const id = String((await created.json()).id)
    const updated = await request.put(`/api/v1/auth/admin/roles/${id}`, { headers: admin, data: { name, description: 'e2e', permissions: ['menu.dashboard', 'resource.*.read'] } })
    expect(updated.ok()).toBeTruthy()
    const deleted = await request.delete(`/api/v1/auth/admin/roles/${id}`, { headers: admin })
    expect(deleted.status()).toBe(204)

    const create = (await auditRows(request, admin, 'admin.roles.create')).find((r) => r.TargetID === id)
    expect(create, 'admin.roles.create row').toBeTruthy()
    expect(create.TargetType).toBe('role')
    expect(create.After?.name).toBe(name)
    expect(create.After?.permissions).toEqual(['menu.dashboard'])
    const update = (await auditRows(request, admin, 'admin.roles.update')).find((r) => r.TargetID === id)
    expect(update, 'admin.roles.update row').toBeTruthy()
    expect(update.Before?.permissions).toEqual(['menu.dashboard'])
    expect(update.After?.permissions).toEqual(['menu.dashboard', 'resource.*.read'])
    const del = (await auditRows(request, admin, 'admin.roles.delete')).find((r) => r.TargetID === id)
    expect(del, 'admin.roles.delete row').toBeTruthy()
    expect(del.Before?.permissions).toEqual(['menu.dashboard', 'resource.*.read'])
  })

  test('organization create/delete and bulk role changes are audited per object', async ({ request }) => {
    const admin = await adminHeaders(request)
    const team = `e2e-team-${Date.now()}`
    const org = await request.post('/api/v1/auth/admin/organizations', { headers: admin, data: { type: 'team', name: team } })
    expect(org.status()).toBe(201)
    const orgId = String((await org.json()).id)
    expect((await request.delete(`/api/v1/auth/admin/organizations/${orgId}`, { headers: admin })).status()).toBe(204)
    const orgCreate = (await auditRows(request, admin, 'admin.organizations.create')).find((r) => r.TargetID === orgId)
    expect(orgCreate?.After?.name).toBe(team)
    const orgDelete = (await auditRows(request, admin, 'admin.organizations.delete')).find((r) => r.TargetID === orgId)
    expect(orgDelete?.Before?.name).toBe(team)

    // Bulk role change: one user.role.update row per account, marked bulk.
    const email = `e2e-bulk-${Date.now()}@kubeast.local`
    const user = await request.post('/api/v1/auth/admin/users', { headers: admin, data: { name: 'E2E bulk', email, password: 'e2e-bulk-throwaway-1' } })
    expect(user.status()).toBe(201)
    const userId = (await user.json()).id as string
    try {
      const roles = await request.get('/api/v1/auth/roles', { headers: admin })
      const list = (await roles.json()) as any[]
      const items = Array.isArray(list) ? list : (list as any).items || []
      const member = items.find((r: any) => r.name === 'Member')
      expect(member, 'Member role').toBeTruthy()
      const bulk = await request.patch('/api/v1/auth/admin/users/bulk-role', { headers: admin, data: { user_ids: [userId], role_id: member.id } })
      expect(bulk.ok()).toBeTruthy()
      const row = (await auditRows(request, admin, 'user.role.update')).find((r) => r.TargetID === userId)
      expect(row, 'user.role.update row for the bulk change').toBeTruthy()
      expect(row.TargetEmail).toBe(email)
      expect(row.After?.role).toBe('Member')
      expect(row.After?.bulk).toBe(true)
    } finally {
      await request.delete(`/api/v1/auth/admin/users/${userId}`, { headers: admin })
    }
  })

  test('a bulk role change names the account it could not change and changes the rest', async ({ request }) => {
    const admin = await adminHeaders(request)
    const email = `e2e-bulk-part-${Date.now()}@kubeast.local`
    const gone = `e2e-gone-${Date.now()}`
    const user = await request.post('/api/v1/auth/admin/users', { headers: admin, data: { name: 'E2E bulk part', email, password: 'e2e-bulk-throwaway-1' } })
    expect(user.status()).toBe(201)
    const userId = (await user.json()).id as string
    try {
      const raw = await (await request.get('/api/v1/auth/roles', { headers: admin })).json()
      const member = (Array.isArray(raw) ? raw : raw.items || []).find((r: any) => r.name === 'Member')
      const bulk = await request.patch('/api/v1/auth/admin/users/bulk-role', { headers: admin, data: { user_ids: [userId, gone], role_id: member.id } })
      expect(bulk.status(), await bulk.text()).toBe(207)
      const body = await bulk.json()
      expect(body.updated.map((u: any) => u.id)).toEqual([userId])
      expect(body.failed).toEqual([{ user_id: gone, reason: 'not_found' }])
      const rows = await auditRows(request, admin, 'user.role.update')
      expect(rows.find((r) => r.TargetID === userId)?.Result).toBe('success')
      expect(rows.find((r) => r.TargetID === gone)?.Result).toBe('failure')
    } finally {
      await request.delete(`/api/v1/auth/admin/users/${userId}`, { headers: admin })
    }
  })

  test('the pending window says which account it could not approve', async ({ page, request }) => {
    const admin = await adminHeaders(request)
    const stamp = Date.now()
    const [staysEmail, goesEmail] = [`e2e-pend-stays-${stamp}@kubeast.local`, `e2e-pend-goes-${stamp}@kubeast.local`]
    const raw = await (await request.get('/api/v1/auth/roles', { headers: admin })).json()
    const pending = (Array.isArray(raw) ? raw : raw.items || []).find((r: any) => r.name === 'Pending')
    expect(pending, 'Pending role').toBeTruthy()
    const make = async (email: string) => {
      const res = await request.post('/api/v1/auth/admin/users', { headers: admin, data: { name: email.split('@')[0], email, password: 'e2e-bulk-throwaway-1', role_id: pending.id } })
      expect(res.status(), await res.text()).toBe(201)
      return (await res.json()).id as string
    }
    const stays = await make(staysEmail)
    const goes = await make(goesEmail)
    try {
      await page.goto('/admin/users')
      await page.getByRole('button', { name: /Pending|대기/ }).first().click()
      // The list behind the window has the same rows.
      const dialog = page.getByRole('dialog')
      await dialog.locator('tr', { hasText: staysEmail }).click()
      await dialog.locator('tr', { hasText: goesEmail }).click()
      await expect(dialog.locator('tr', { hasText: goesEmail }).locator('input[type="checkbox"]')).toBeChecked()
      // Another admin removes it while the window is open.
      expect((await request.delete(`/api/v1/auth/admin/users/${goes}`, { headers: admin })).status()).toBe(204)
      await dialog.getByRole('button', { name: /Approve as Member|Member로 승인/ }).click()
      // Some were approved, so the window closes and the page says what was not.
      const error = page.getByTestId('admin-users-action-error')
      await expect(error).toContainText(/1 of 2 accounts changed|계정 2개 중 1개를 바꿨습니다/, { timeout: 15_000 })
      await expect(error).toContainText(goes)
      await expect(error).toContainText(/no such account|없는 계정/)
      await expect(dialog.locator('tr', { hasText: staysEmail }), 'the approved account left the list').toHaveCount(0, { timeout: 15_000 })
      const row = (await auditRows(request, admin, 'user.role.update')).find((r) => r.TargetID === stays)
      expect(row?.Result).toBe('success')
      expect(row?.After?.role).toBe('Member')
    } finally {
      await request.delete(`/api/v1/auth/admin/users/${stays}`, { headers: admin, failOnStatusCode: false })
      await request.delete(`/api/v1/auth/admin/users/${goes}`, { headers: admin, failOnStatusCode: false })
    }
  })

  test('k8s write rows carry the cluster the object lives in', async ({ request }) => {
    const admin = await adminHeaders(request)
    const name = `e2e-audit-cm-${Date.now()}`
    const yaml = `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: ${name}\n  namespace: default\ndata:\n  k: v\n`
    // Same gateway path the UI uses (/api/v1/cluster/… → k8s-service /api/v1/…).
    const create = await request.post('/api/v1/cluster/resources/yaml/create?cluster=self', { headers: admin, data: { yaml, namespace: 'default' } })
    expect(create.ok(), `yaml create: ${create.status()} ${await create.text()}`).toBeTruthy()
    const del = await request.delete(`/api/v1/namespaces/default/configmaps/${name}?cluster=self`, { headers: admin })
    expect(del.ok(), `configmap delete: ${del.status()}`).toBeTruthy()
    const row = (await auditRows(request, admin, 'k8s.configmap.delete')).find((r) => r.TargetID === name)
    expect(row, 'k8s.configmap.delete row').toBeTruthy()
    expect(row.Cluster).toBe('self')
    expect(row.Namespace).toBe('default')
  })
})
