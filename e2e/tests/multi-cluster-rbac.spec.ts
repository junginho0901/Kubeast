import { test, expect, type APIRequestContext } from '@playwright/test'

// Per-cluster RBAC UI (step 12): the ClusterRoleMatrix in a user's detail grants
// a per-cluster role (step-08 API), and AdminAudit can filter by cluster.

const EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const PASSWORD = process.env.E2E_USER_PASSWORD || ''

async function adminToken(request: APIRequestContext): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email: EMAIL, password: PASSWORD } })
  expect(res.ok()).toBeTruthy()
  return (await res.json()).access_token
}

test.describe('multi-cluster RBAC UI (step 12)', () => {
  test('AdminAudit shows a cluster filter', async ({ page }) => {
    await page.goto('/admin/audit')
    await page.waitForLoadState('domcontentloaded')
    await expect(page.getByTestId('audit-cluster-filter')).toBeVisible({ timeout: 15000 })
  })

  test('ClusterRoleMatrix grants a per-cluster role to a user', async ({ page, request }) => {
    const auth = { Authorization: `Bearer ${await adminToken(request)}` }
    const email = `e2e-rbacui-${Date.now()}@kubeast.local`
    let userId = ''
    try {
      // throwaway non-admin user (defaults to the Read role)
      const created = await request.post('/api/v1/auth/admin/users', {
        headers: auth,
        data: { name: 'E2E RBAC UI', email, password: 'rbac1234' },
      })
      expect(created.status(), 'create throwaway user').toBe(201)
      userId = (await created.json()).id

      await page.goto('/admin/users')
      await page.waitForLoadState('domcontentloaded')

      // open the user's detail → the per-cluster matrix is shown for non-admins
      await page.getByTestId(`user-detail-${email}`).click()
      await expect(page.getByTestId('cluster-role-matrix')).toBeVisible({ timeout: 10000 })

      // grant the Read role on the default cluster
      await page.getByTestId('cluster-role-default').selectOption('Read')

      // the grant is persisted (GET cluster-roles → { default: "Read" })
      await expect
        .poll(
          async () => {
            const r = await request.get(`/api/v1/auth/admin/users/${userId}/cluster-roles`, { headers: auth })
            return (await r.json()).default
          },
          { timeout: 10000 },
        )
        .toBe('Read')

      // revoke via the same select ("No access" = empty value)
      await page.getByTestId('cluster-role-default').selectOption('')
      await expect
        .poll(
          async () => {
            const r = await request.get(`/api/v1/auth/admin/users/${userId}/cluster-roles`, { headers: auth })
            return Object.keys(await r.json()).length
          },
          { timeout: 10000 },
        )
        .toBe(0)
    } finally {
      if (userId) {
        await request.delete(`/api/v1/auth/admin/users/${userId}`, { headers: auth, failOnStatusCode: false })
      }
    }
  })
})
