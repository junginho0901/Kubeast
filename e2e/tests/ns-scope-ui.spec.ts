import { test, expect, type APIRequestContext, type Page } from '@playwright/test'

// A-4 (records/ns-scope-20261012.md §6-9): the screens for namespace-scoped grants. An admin limits a grant to
// namespaces from the user's cluster-role matrix; the scoped user sees the limit in the permission notice, and the
// access-request form is prefilled with (and kept within) the scope. Throwaway user removed at the end.

const ADMIN_EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const ADMIN_PASSWORD = process.env.E2E_USER_PASSWORD || ''
const PW = 'E2e-nsui-throwaway-1!'
const CLUSTER = 'self'
const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' })

async function login(request: APIRequestContext, email: string, password: string): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email, password } })
  expect(res.ok(), `login ${email}: ${res.status()}`).toBeTruthy()
  return (await res.json()).access_token
}

async function createUser(request: APIRequestContext, admin: string, email: string): Promise<string> {
  const raw = await (await request.get('/api/v1/auth/roles', { headers: bearer(admin) })).json()
  const member = (Array.isArray(raw) ? raw : raw.roles || raw.items || []).find((r: { name: string }) => r.name.toLowerCase() === 'member')
  const res = await request.post('/api/v1/auth/admin/users', { headers: bearer(admin), data: { name: 'E2E ns ui', email, password: PW, role_id: member.id } })
  expect(res.status(), `create ${email}`).toBe(201)
  return (await res.json()).id
}

async function loginUI(page: Page, email: string, password: string): Promise<void> {
  await page.context().clearCookies()
  await page.goto('/login')
  await page.locator('input[autocomplete="email"]').first().fill(email)
  await page.locator('input[type="password"]').first().fill(password)
  await page.locator('button[type="submit"]').first().click()
  await page.waitForFunction(() => !document.querySelector('input[autocomplete="email"]'), { timeout: 20_000 })
}

test.describe('namespace-scoped grants in the UI', () => {
  test('the cluster-role matrix limits a grant to namespaces, and the grant list shows it', async ({ page, request }) => {
    const admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    const email = `e2e-nsui-${Date.now().toString(36)}@kubeast.local`
    let userId = ''
    try {
      userId = await createUser(request, admin, email)
      await page.goto('/admin/users')
      await page.getByTestId(`user-detail-${email}`).click()
      await expect(page.getByTestId('cluster-role-matrix')).toBeVisible({ timeout: 10_000 })

      // Role first; the namespace box appears next to a granted role.
      await page.getByTestId(`cluster-role-${CLUSTER}`).click()
      await page.getByTestId(`cluster-role-${CLUSTER}-opt-Read`).click()
      const box = page.getByTestId(`cluster-role-${CLUSTER}-namespaces`)
      await expect(box).toBeVisible({ timeout: 10_000 })
      await box.fill('Web, api, web')
      await box.press('Enter')

      await expect.poll(async () => {
        const grants = await (await request.get(`/api/v1/auth/admin/users/${userId}/cluster-grants`, { headers: bearer(admin) })).json()
        return (grants as { cluster_id: string; role: string; namespaces?: string[] }[]).find((g) => g.cluster_id === CLUSTER)
      }, { timeout: 10_000 }).toEqual({ cluster_id: CLUSTER, role: 'Read', namespaces: ['api', 'web'] })
      // The box shows the normalized list after the grant is read back.
      await expect(box).toHaveValue('api, web')

      // Clearing the box widens the grant back to the whole cluster.
      await box.fill('')
      await box.press('Enter')
      await expect.poll(async () => {
        const grants = await (await request.get(`/api/v1/auth/admin/users/${userId}/cluster-grants`, { headers: bearer(admin) })).json()
        return (grants as { cluster_id: string; namespaces?: string[] }[]).find((g) => g.cluster_id === CLUSTER)?.namespaces
      }, { timeout: 10_000 }).toBeUndefined()

      // The per-cluster access list carries the scope too.
      expect((await request.put(`/api/v1/auth/admin/users/${userId}/cluster-roles/${CLUSTER}`, { headers: bearer(admin), data: { role: 'Read', namespaces: ['web'] } })).ok()).toBeTruthy()
      const list = await (await request.get(`/api/v1/auth/admin/clusters/${CLUSTER}/user-roles`, { headers: bearer(admin) })).json()
      expect((list as { email: string; namespaces?: string[] }[]).find((r) => r.email === email)?.namespaces).toEqual(['web'])

      // And the access review's cluster-roles section names the scope on the grant's row.
      await page.goto('/admin/access-review')
      await page.getByTestId('access-review-tab-cluster_roles').click()
      await expect(page.getByTestId('access-review-row').filter({ hasText: email })).toContainText('web')
    } finally {
      if (userId) await request.delete(`/api/v1/auth/admin/users/${userId}`, { headers: bearer(admin), failOnStatusCode: false })
    }
  })

  test('a scoped user sees the limit in the notice and requests access within it', async ({ page, request }) => {
    test.setTimeout(90_000)
    const admin = await login(request, ADMIN_EMAIL, ADMIN_PASSWORD)
    const cfg = await request.get('/api/v1/auth/access-requests/config', { headers: bearer(admin) })
    test.skip(!cfg.ok() || !(await cfg.json()).enabled, 'access requests are off (auth.accessRequests.enabled)')
    const email = `e2e-nsui-${Date.now().toString(36)}@kubeast.local`
    let userId = ''
    try {
      userId = await createUser(request, admin, email)
      expect((await request.put(`/api/v1/auth/admin/users/${userId}/cluster-roles/${CLUSTER}`, { headers: bearer(admin), data: { role: 'Read', namespaces: ['api', 'web'] } })).ok()).toBeTruthy()

      // The dashboard: cluster-wide reads are refused for the scoped group, and the notice names the scope.
      await loginUI(page, email, PW)
      await page.goto('/')
      await expect(page.getByTestId('forbidden-banner')).toBeVisible({ timeout: 20_000 })
      await expect(page.getByTestId('forbidden-namespace-hint')).toContainText('api, web')

      // The request form is prefilled with the scope and cannot leave it empty.
      await page.goto('/account')
      await page.getByTestId(`access-request-open-${CLUSTER}`).click()
      await expect(page.getByTestId('access-request-modal')).toBeVisible()
      const ns = page.getByTestId('access-request-namespaces')
      await expect(ns).toHaveValue('api, web')
      await expect(page.getByTestId('access-request-namespaces-hint')).toContainText('api, web')
      await page.getByTestId('access-request-reason').fill('e2e: namespace-scoped request')
      await ns.fill('')
      await expect(page.getByTestId('access-request-submit')).toBeDisabled()
      await ns.fill('web')
      await expect(page.getByTestId('access-request-submit')).toBeEnabled()
      await page.getByTestId('access-request-submit').click()
      await expect(page.getByTestId('access-request-modal')).toBeHidden({ timeout: 10_000 })

      const user = await login(request, email, PW)
      const mine = await (await request.get('/api/v1/auth/access-requests', { headers: bearer(user) })).json()
      const req = (mine as { id: string; status: string; namespaces?: string[] }[]).find((r) => r.status === 'pending')
      expect(req?.namespaces).toEqual(['web'])
      expect((await request.delete(`/api/v1/auth/access-requests/${req!.id}`, { headers: bearer(user) })).status()).toBe(204)
    } finally {
      if (userId) await request.delete(`/api/v1/auth/admin/users/${userId}`, { headers: bearer(admin), failOnStatusCode: false })
    }
  })
})
