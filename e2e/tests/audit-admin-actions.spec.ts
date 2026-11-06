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
  test('a bulk creation names the accounts it left out and creates the rest', async ({ request }) => {
    const admin = await adminHeaders(request)
    const stamp = Date.now()
    const [fine, noTeam, weak] = [`e2e-bulkc-fine-${stamp}@kubeast.local`, `e2e-bulkc-team-${stamp}@kubeast.local`, `e2e-bulkc-weak-${stamp}@kubeast.local`]
    const row = (email: string, extra: object = {}) => ({ name: email.split('@')[0], email, password: 'e2e-bulk-throwaway-1', ...extra })
    const made: string[] = []
    try {
      const res = await request.post('/api/v1/auth/admin/users/bulk', { headers: admin, data: { users: [row(fine), row(noTeam, { team: `no-such-team-${stamp}` }), row(weak, { password: 'short' }), row(fine)] } })
      expect(res.status(), await res.text()).toBe(207)
      const body = await res.json()
      made.push(...body.created.map((u: any) => u.id))
      expect(body.created.map((u: any) => u.email)).toEqual([fine])
      expect(body.failed.map((f: any) => [f.email, f.reason])).toEqual([[noTeam, 'team'], [weak, 'password'], [fine, 'exists']])
      expect(body.failed[0].detail).toBe(`no-such-team-${stamp}`)
      // Whoever read errors before still reads every account left out.
      expect(body.errors.map((e: any) => e.email)).toEqual([noTeam, weak, fine])
      expect(await res.text()).not.toContain('e2e-bulk-throwaway-1')
      const rows = await auditRows(request, admin, 'user.create')
      // newest first: the second try of the address left out, then the account made
      const ofFine = rows.filter((r) => r.TargetEmail === fine)
      expect(ofFine.map((r) => r.Result)).toEqual(['failure', 'success'])
      expect(ofFine[0].After?.reason).toBe('exists')
      expect(ofFine[1].After?.bulk).toBe(true)
      expect(rows.find((r) => r.TargetEmail === noTeam)?.After?.reason).toBe('team')
      expect(JSON.stringify(rows.filter((r) => [fine, noTeam, weak].includes(r.TargetEmail)))).not.toContain('e2e-bulk-throwaway-1')

      const nobody = await request.post('/api/v1/auth/admin/users/bulk', { headers: admin, data: { users: [row(fine)] } })
      expect(nobody.status(), await nobody.text()).toBe(207)
      expect((await nobody.json()).created).toEqual([])

      const everyone = `e2e-bulkc-all-${stamp}@kubeast.local`
      const all = await request.post('/api/v1/auth/admin/users/bulk', { headers: admin, data: { users: [row(everyone)] } })
      expect(all.status(), await all.text()).toBe(200)
      const allBody = await all.json()
      made.push(...allBody.created.map((u: any) => u.id))
      expect(allBody.failed).toEqual([])
    } finally {
      for (const id of made) await request.delete(`/api/v1/auth/admin/users/${id}`, { headers: admin, failOnStatusCode: false })
    }
  })

  test('the bulk upload window says which rows it could not create and why', async ({ page, request }) => {
    const admin = await adminHeaders(request)
    const stamp = Date.now()
    const [fine, taken, odd, empty] = ['fine', 'taken', 'odd', 'empty'].map((w) => `e2e-bulkw-${w}-${stamp}@kubeast.local`)
    const existing = await request.post('/api/v1/auth/admin/users', { headers: admin, data: { name: 'E2E bulk taken', email: taken, password: 'e2e-bulk-throwaway-1' } })
    expect(existing.status(), await existing.text()).toBe(201)
    const made = [(await existing.json()).id as string]
    try {
      await page.goto('/admin/users')
      await page.getByRole('button', { name: /Bulk upload|일괄 업로드/ }).first().click()
      const csv = [
        'name,email,password,role,team',
        `E2E fine,${fine},e2e-bulk-throwaway-1,Member,`,
        `E2E taken,${taken},e2e-bulk-throwaway-1,Member,`,
        `E2E odd,${odd},e2e-bulk-throwaway-1,NoSuchRole${stamp},`,
        `E2E empty,${empty},,Member,`,
        '',
      ].join('\n')
      await page.locator('input[type="file"][accept=".csv"]').setInputFiles({ name: 'users.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) })
      const failed = page.getByTestId('admin-users-bulk-create-failed')
      await expect(failed).toContainText(/Not created: 3 of 4 accounts|만들지 못한 계정: 4개 중 3개/, { timeout: 15_000 })
      await expect(failed).toContainText(new RegExp(`${taken}: (this email already has an account|이미 계정이 있는 이메일입니다)`))
      await expect(failed).toContainText(new RegExp(`${odd}: (no such role|없는 역할입니다): NoSuchRole${stamp}`))
      await expect(failed).toContainText(new RegExp(`${empty}: (name, email and password are required|이름, 이메일, 비밀번호가 필요합니다)`))
      await expect(page.getByText(/1 user created\.|1명의 사용자가 생성되었습니다\./)).toHaveCount(1)
      const users: any[] = []
      for (let offset = 0, more = true; more; offset += 200) {
        const onePage = await (await request.get(`/api/v1/auth/admin/users?limit=200&offset=${offset}`, { headers: admin })).json()
        users.push(...onePage)
        more = onePage.length === 200
      }
      const created = users.filter((u) => [fine, odd, empty].includes(u.email))
      made.push(...created.map((u) => u.id))
      expect(created.map((u) => u.email)).toEqual([fine])
    } finally {
      for (const id of made) await request.delete(`/api/v1/auth/admin/users/${id}`, { headers: admin, failOnStatusCode: false })
    }
  })

  test('the bulk template goes up as it is, and the window\'s format line names its columns', async ({ page, request }) => {
    const admin = await adminHeaders(request)
    const example = 'hong@example.com'
    const allUsers = async () => {
      const users: any[] = []
      for (let offset = 0, more = true; more; offset += 200) {
        const onePage = await (await request.get(`/api/v1/auth/admin/users?limit=200&offset=${offset}`, { headers: admin })).json()
        users.push(...onePage)
        more = onePage.length === 200
      }
      return users
    }
    const removeExample = async () => {
      for (const u of (await allUsers()).filter((x) => x.email === example)) await request.delete(`/api/v1/auth/admin/users/${u.id}`, { headers: admin, failOnStatusCode: false })
    }
    await removeExample()
    try {
      await page.goto('/admin/users')
      await page.getByRole('button', { name: /Bulk upload|일괄 업로드/ }).first().click()
      const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /^(Download|다운로드)$/ }).click()])
      const chunks: Buffer[] = []
      for await (const chunk of await download.createReadStream()) chunks.push(chunk as Buffer)
      const buffer = Buffer.concat(chunks)
      const lines = buffer.toString('utf8').split('\n')
      await expect(page.getByTestId('admin-users-bulk-format')).toHaveText(lines.filter((l) => !l.includes('#'))[0])
      await page.locator('input[type="file"][accept=".csv"]').setInputFiles({ name: 'user_template.csv', mimeType: 'text/csv', buffer })
      await expect(page.getByText(/1 user created\.|1명의 사용자가 생성되었습니다\./)).toHaveCount(1, { timeout: 15_000 })
      await expect(page.getByTestId('admin-users-bulk-create-failed')).toHaveCount(0)
      const made = (await allUsers()).filter((u) => u.email === example)
      expect(made.map((u) => u.role?.name)).toEqual(['Member'])
    } finally {
      await removeExample()
    }
  })

  test('the window that creates a user says why the server refused, and a new form starts clean', async ({ page, request }) => {
    const admin = await adminHeaders(request)
    const taken = `e2e-create-taken-${Date.now()}@kubeast.local`
    const existing = await request.post('/api/v1/auth/admin/users', { headers: admin, data: { name: 'E2E create taken', email: taken, password: 'e2e-bulk-throwaway-1' } })
    expect(existing.status(), await existing.text()).toBe(201)
    const id = (await existing.json()).id as string
    try {
      await page.goto('/admin/users')
      await page.getByRole('button', { name: /^(Add user|사용자 추가)$/ }).first().click()
      const dialog = page.getByTestId('create-user-dialog')
      await dialog.locator('input').first().fill('E2E create taken')
      await dialog.locator('input[type="email"]').fill(taken)
      await dialog.locator('input[type="password"]').fill('e2e-bulk-throwaway-1')
      await page.getByTestId('create-user-role').click()
      await dialog.getByRole('button', { name: 'Member', exact: true }).click()
      await dialog.locator('button[type="submit"]').click()
      await expect(page.getByTestId('create-user-error')).toHaveText(/(Failed to create user|사용자 생성에 실패했습니다): Email already exists/, { timeout: 15_000 })
      await expect(dialog.locator('input[type="email"]'), 'what was typed stays').toHaveValue(taken)

      await dialog.getByRole('button', { name: /^(Cancel|취소)$/ }).click()
      await page.getByRole('button', { name: /^(Add user|사용자 추가)$/ }).first().click()
      await expect(dialog.locator('input[type="email"]')).toHaveValue('')
      await expect(page.getByTestId('create-user-error')).toHaveCount(0)
    } finally {
      await request.delete(`/api/v1/auth/admin/users/${id}`, { headers: admin, failOnStatusCode: false })
    }
  })

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
