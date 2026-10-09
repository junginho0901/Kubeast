import { test, expect, type APIRequestContext, type Browser } from '@playwright/test'

// Two notices for non-admin users found by walking the UI as a Read user:
//  - a viewer may list most kinds but not Secrets (cluster RBAC 403): the page
//    says so instead of "No secrets found"
//  - a user with no cluster grant sees the "no accessible cluster" notice, the
//    footer says so, and no resource page mounts (no cluster API 403 storm)
//  - a custom role the cluster has not bound is told which group it acts as
//    (banner) and the role form shows that group while the name is typed

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const BASE = process.env.E2E_BASE_URL || 'http://localhost:30080'

async function adminHeaders(request: APIRequestContext) {
  const res = await request.post('/api/v1/auth/login', { data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } })
  expect(res.ok(), 'admin login').toBeTruthy()
  return { Authorization: `Bearer ${(await res.json()).access_token as string}` }
}

async function createUser(request: APIRequestContext, admin: Record<string, string>, tag: string) {
  const email = `e2e-${tag}-${Date.now()}@kubeast.local`
  const password = 'e2e-reader-throwaway'
  const created = await request.post('/api/v1/auth/admin/users', { headers: admin, data: { name: `E2E ${tag}`, email, password } })
  expect(created.status()).toBe(201)
  return { id: (await created.json()).id as string, email, password }
}

// A fresh browser context whose session cookie belongs to the user.
async function userPage(browser: Browser, email: string, password: string) {
  const ctx = await browser.newContext({ baseURL: BASE })
  const login = await ctx.request.post('/api/v1/auth/login', { data: { email, password } })
  expect(login.ok(), `login ${email}`).toBeTruthy()
  return { ctx, page: await ctx.newPage() }
}

test.describe('non-admin UI notices', () => {
  test('a viewer sees a permission notice on the Secrets page', async ({ browser, request }) => {
    const admin = await adminHeaders(request)
    const user = await createUser(request, admin, 'viewer')
    try {
      const grant = await request.put(`/api/v1/auth/admin/users/${user.id}/cluster-roles/self`, { headers: admin, data: { role: 'Read' } })
      expect(grant.status()).toBe(200)
      const { ctx, page } = await userPage(browser, user.email, user.password)
      await page.goto('/configuration/secrets?cluster=self')
      await expect(page.getByTestId('secrets-forbidden')).toBeVisible({ timeout: 20000 })
      await expect(page.getByTestId('secrets-forbidden')).toContainText('permission')
      await ctx.close()
    } finally {
      await request.delete(`/api/v1/auth/admin/users/${user.id}`, { headers: admin })
    }
  })

  // Every other list page has no notice of its own: the banner above the page
  // (fed by the API client's 403 event) names the kinds the viewer cannot list,
  // instead of the page passing a 403 off as "No roles found.".
  test('a viewer sees the permission banner on a page without its own notice (Roles)', async ({ browser, request }) => {
    const admin = await adminHeaders(request)
    const user = await createUser(request, admin, 'viewer-roles')
    try {
      const grant = await request.put(`/api/v1/auth/admin/users/${user.id}/cluster-roles/self`, { headers: admin, data: { role: 'Read' } })
      expect(grant.status()).toBe(200)
      const { ctx, page } = await userPage(browser, user.email, user.password)
      await page.goto('/security/roles?cluster=self')
      const banner = page.getByTestId('forbidden-banner')
      await expect(banner).toBeVisible({ timeout: 20000 })
      await expect(banner).toContainText(/permission|권한/)
      // the Kubernetes kind name (re-QA #42), not "roles"
      await expect(banner).toContainText('Role')
      await expect(banner).not.toContainText('roles')
      // a built-in role acts as a group the chart binds: no custom-role hint
      await expect(page.getByTestId('forbidden-custom-role-hint')).toHaveCount(0)
      // another page resets the banner; a page the viewer may read shows none
      await page.goto('/workloads/pods?cluster=self')
      await expect(page.getByRole('heading', { level: 1, name: /^(Pods|파드)$/ })).toBeVisible()
      await expect(page.getByTestId('forbidden-banner')).toHaveCount(0)
      await ctx.close()
    } finally {
      await request.delete(`/api/v1/auth/admin/users/${user.id}`, { headers: admin })
    }
  })

  // Helm keeps releases in Secrets, so the same viewer gets 403 on the release
  // list once the Helm calls run as the user.
  test('a viewer sees a permission notice on the Helm releases page', async ({ browser, request }) => {
    const admin = await adminHeaders(request)
    const user = await createUser(request, admin, 'viewer-helm')
    try {
      const grant = await request.put(`/api/v1/auth/admin/users/${user.id}/cluster-roles/self`, { headers: admin, data: { role: 'Read' } })
      expect(grant.status()).toBe(200)
      const { ctx, page } = await userPage(browser, user.email, user.password)
      const list = await ctx.request.get('/api/v1/helm/releases?cluster=self')
      expect(list.status(), 'viewer helm list').toBe(403)
      await page.goto('/helm/releases?cluster=self')
      await expect(page.getByTestId('helm-forbidden')).toBeVisible({ timeout: 20000 })
      await expect(page.getByTestId('helm-forbidden')).toContainText('permission')
      await ctx.close()
    } finally {
      await request.delete(`/api/v1/auth/admin/users/${user.id}`, { headers: admin })
    }
  })

  // A custom role acts on the cluster as kubeast:role:<slug>; the dev cluster
  // neither allows nor binds that group, so every list is refused — the banner
  // names the group and the chart setting instead of a bare "no permission".
  test('a custom role without a cluster binding sees which group the cluster refuses', async ({ browser, request }) => {
    const admin = await adminHeaders(request)
    const user = await createUser(request, admin, 'customrole')
    const roleName = `E2E Hint ${Date.now()}`
    let roleId: number | undefined
    try {
      const role = await request.post('/api/v1/auth/admin/roles', {
        headers: admin,
        data: { name: roleName, description: 'e2e', permissions: ['menu.workloads', 'resource.*.read'] },
      })
      expect(role.status(), await role.text()).toBe(201)
      roleId = (await role.json()).id as number
      const grant = await request.put(`/api/v1/auth/admin/users/${user.id}/cluster-roles/self`, { headers: admin, data: { role: roleName } })
      expect(grant.status()).toBe(200)
      const { ctx, page } = await userPage(browser, user.email, user.password)
      const pods = await ctx.request.get('/api/v1/cluster/namespaces/default/pods?cluster=self')
      expect(pods.status(), 'the cluster refuses the unbound group').toBe(403)
      await page.goto('/workloads/pods?cluster=self')
      await expect(page.getByTestId('forbidden-banner')).toBeVisible({ timeout: 20000 })
      const hint = page.getByTestId('forbidden-custom-role-hint')
      await expect(hint).toContainText(`kubeast:role:${roleName.toLowerCase().replace(/ /g, '-')}`)
      await expect(hint).toContainText('auth.impersonation.customRoles')
      await ctx.close()
    } finally {
      await request.delete(`/api/v1/auth/admin/users/${user.id}`, { headers: admin })
      if (roleId) await request.delete(`/api/v1/auth/admin/roles/${roleId}`, { headers: admin, failOnStatusCode: false })
    }
  })

  test('the role form shows the group a custom role will act as', async ({ page }) => {
    await page.goto('/admin/roles')
    await page.getByRole('button', { name: /^(Create Role|역할 생성)$/ }).click()
    const name = page.getByPlaceholder(/InfraManager/)
    await expect(page.getByTestId('role-group-hint')).toHaveCount(0)
    await name.fill('Infra Manager')
    await expect(page.getByTestId('role-group-hint')).toContainText('kubeast:role:infra-manager')
    await name.fill('Read')
    await expect(page.getByTestId('role-group-hint')).toHaveCount(0)
  })

  test('a user with no cluster grant gets the notice and no cluster requests', async ({ browser, request }) => {
    const admin = await adminHeaders(request)
    const user = await createUser(request, admin, 'nogrant')
    try {
      const { ctx, page } = await userPage(browser, user.email, user.password)
      const clusterRequests: string[] = []
      page.on('request', (r) => {
        const path = r.url().replace(BASE, '')
        if (/^\/api\/v1\/cluster\/(overview|namespaces|nodes|metrics|pods|deployments)/.test(path)) clusterRequests.push(path)
      })
      await page.goto('/')
      await expect(page.getByTestId('no-accessible-cluster')).toBeVisible({ timeout: 20000 })
      await expect(page.getByTestId('cluster-status')).toContainText('No accessible cluster')
      await page.waitForTimeout(2000)
      expect(clusterRequests, 'no resource page mounted').toEqual([])
      await ctx.close()
    } finally {
      await request.delete(`/api/v1/auth/admin/users/${user.id}`, { headers: admin })
    }
  })
})
