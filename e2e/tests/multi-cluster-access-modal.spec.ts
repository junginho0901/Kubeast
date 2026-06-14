import { test, expect, type APIRequestContext } from '@playwright/test'

// Per-cluster Access modal (cluster-management page): the inverse of the
// user-detail ClusterRoleMatrix — open a cluster's "Access" modal, grant a user
// a role, and confirm the grant is persisted (and revoke it).

const EMAIL = process.env.E2E_USER_EMAIL || 'admin'
const PASSWORD = process.env.E2E_USER_PASSWORD || ''

async function adminToken(request: APIRequestContext): Promise<string> {
  const res = await request.post('/api/v1/auth/login', { data: { email: EMAIL, password: PASSWORD } })
  expect(res.ok()).toBeTruthy()
  return (await res.json()).access_token
}

test('cluster Access modal grants + revokes a per-cluster role', async ({ page, request }) => {
  const auth = { Authorization: `Bearer ${await adminToken(request)}` }
  const email = `e2e-access-${Date.now()}@kubeast.local`
  let userId = ''
  try {
    const created = await request.post('/api/v1/auth/admin/users', {
      headers: auth,
      data: { name: 'E2E Access Modal', email, password: 'access1234' },
    })
    expect(created.status(), 'create throwaway user').toBe(201)
    userId = (await created.json()).id

    await page.goto('/admin/clusters')
    await page.waitForLoadState('domcontentloaded')

    // Open the Access modal for the default cluster.
    await page.getByTestId('access-cluster-default').click()
    await expect(page.getByTestId('cluster-access-list')).toBeVisible({ timeout: 10000 })

    // Add the throwaway user with the Read role (custom dropdowns: open → pick).
    await page.getByTestId('cluster-access-add-user').click()
    await page.getByTestId(`cluster-access-add-user-opt-${userId}`).click()
    await page.getByTestId('cluster-access-add-role').click()
    await page.getByTestId('cluster-access-add-role-opt-Read').click()
    await page.getByTestId('cluster-access-add-btn').click()

    // The grant is persisted on the user's per-cluster roles.
    await expect
      .poll(
        async () => {
          const r = await request.get(`/api/v1/auth/admin/users/${userId}/cluster-roles`, { headers: auth })
          return (await r.json()).default
        },
        { timeout: 10000 },
      )
      .toBe('Read')

    // And the cluster's reverse access list now includes the user.
    const listRes = await request.get('/api/v1/auth/admin/clusters/default/user-roles', { headers: auth })
    expect(listRes.ok()).toBeTruthy()
    const list = (await listRes.json()) as Array<{ user_id: string; role: string }>
    expect(list.some((g) => g.user_id === userId && g.role === 'Read')).toBeTruthy()

    // Revoke via the row's trash button.
    await page.getByTestId(`cluster-access-revoke-${userId}`).click()
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
