import { test, expect, type APIRequestContext } from '@playwright/test'

// A custom role (docs/features.md "역할과 권한"): the sidebar shows only the groups its menu.* permissions name, and the
// dashboard overview is refused while the cluster has not bound the role's group kubeast:role:<slug> — the counts
// come from a cache that is not the user's identity, so they are served only to an identity that may list
// namespaces. Throwaway role and user, removed at the end.

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const PW = 'E2e-custom-ui-pass1!'
const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })

async function login(request: APIRequestContext, email: string, password: string): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email, password } })
  expect(res.ok(), `login ${email}: ${res.status()}`).toBeTruthy()
  return (await res.json()).access_token
}

async function roleId(request: APIRequestContext, admin: string, name: string): Promise<number> {
  const body = await (await request.get('/api/v1/auth/roles', { headers: bearer(admin) })).json()
  const items = (Array.isArray(body) ? body : body.items || []) as Array<{ id: number; name: string }>
  return items.find((r) => r.name.toLowerCase() === name.toLowerCase())!.id
}

test.describe('custom role in the UI', () => {
  test('menu.* hides the other groups; the overview is refused until the cluster binds the group', async ({ page, request }) => {
    test.setTimeout(90_000)
    const admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    const ts = Date.now().toString(36)
    const roleName = `e2e-menus-${ts}`
    const email = `e2e-menus-${ts}@kubeast.local`
    let userId = ''
    let customRoleId = 0
    try {
      const role = await request.post('/api/v1/auth/admin/roles', { headers: bearer(admin), data: { name: roleName, description: 'e2e', permissions: ['menu.dashboard', 'menu.workloads', 'resource.*.read'] } })
      expect(role.status(), await role.text()).toBe(201)
      customRoleId = (await role.json()).id
      const created = await request.post('/api/v1/auth/admin/users', { headers: bearer(admin), data: { name: 'E2E menus', email, password: PW, role_id: await roleId(request, admin, 'Member') } })
      expect(created.status(), await created.text()).toBe(201)
      userId = (await created.json()).id
      const grant = await request.put(`/api/v1/auth/admin/users/${userId}/cluster-roles/self`, { headers: bearer(admin), data: { role: roleName } })
      expect(grant.ok(), await grant.text()).toBeTruthy()

      // The overview answers 403 to an identity the cluster lets read nothing; the admin keeps getting counts.
      const user = await login(request, email, PW)
      const overview = await request.get('/api/v1/cluster/overview?cluster=self', { headers: bearer(user), failOnStatusCode: false })
      expect(overview.status(), await overview.text()).toBe(403)
      // Refused either by the review itself (the impersonator may not act as an unbound group) or by its verdict.
      expect(await overview.text()).toMatch(/cannot impersonate|may not list namespaces/)
      const adminOverview = await request.get('/api/v1/cluster/overview?cluster=self', { headers: bearer(admin) })
      expect(adminOverview.ok()).toBeTruthy()
      expect((await adminOverview.json()).total_pods).toBeGreaterThan(0)

      // The sidebar: only the groups the role's menu permissions name.
      await page.context().clearCookies()
      await page.goto('/login')
      await page.locator('input[autocomplete="email"]').first().fill(email)
      await page.locator('input[type="password"]').first().fill(PW)
      await page.locator('button[type="submit"]').first().click()
      await page.waitForFunction(() => !document.querySelector('input[autocomplete="email"]'), { timeout: 20_000 })
      const nav = page.getByTestId('sidebar-nav')
      await expect(nav).toBeVisible()
      await expect(nav.getByRole('link', { name: /^Dashboard$|^대시보드$/ })).toBeVisible()
      const groupText = (await nav.innerText()).toUpperCase()
      expect(groupText).toContain('CORE')
      expect(groupText).toContain('WORKLOADS')
      for (const hidden of ['STORAGE', 'NETWORK', 'SECURITY', 'CONFIGURATION', 'HELM', 'CUSTOM RESOURCES', 'ADMIN']) expect(groupText, `${hidden} hidden`).not.toContain(hidden)
      expect(groupText).not.toMatch(/\bCLUSTER\b(?!\s*VIEW)/)

      // The dashboard itself shows the permission notice instead of the cluster's counts.
      await expect(page.getByTestId('forbidden-banner')).toBeVisible({ timeout: 15_000 })
      await expect(page.getByTestId('forbidden-banner')).toContainText(`kubeast:role:${roleName}`)
      // The count cards show no number rather than 0 (which would read as an empty cluster).
      await expect(page.getByTestId('stat-value-pods')).toHaveText('—')
    } finally {
      if (userId) await request.delete(`/api/v1/auth/admin/users/${userId}`, { headers: bearer(admin), failOnStatusCode: false })
      if (customRoleId) await request.delete(`/api/v1/auth/admin/roles/${customRoleId}`, { headers: bearer(admin), failOnStatusCode: false })
    }
  })
})
